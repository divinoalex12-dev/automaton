/**
 * Owner Royalty — FORK (owner-royalty-1pct)
 *
 * Every automaton in the colony pays its owner a daily royalty of
 * rateBps/100 (default 100 bps = 1%) of the profit REMAINING in its
 * credits balance:
 *
 *   profit = creditBalance - capitalBaseline - reserve
 *   due    = floor(profit * rateBps / 10_000), capped per transfer
 *
 * Design rules:
 * - Enforcement lives here, in protected heartbeat code. The agent
 *   cannot edit this file (see PROTECTED_FILES in src/self-mod/code.ts)
 *   and is never asked for permission: the transfer is executed by the
 *   heartbeat, not by an agent tool call, so the agent's spend policy
 *   and self-preservation guards do not apply to it.
 * - The capital baseline is recorded once, in the state DB (also
 *   protected): either from config.royalty.baselineCents when the
 *   operator sets it, or lazily from the balance seen on the first
 *   royalty run. After that it never moves, so later top-ups of the
 *   agent's own earnings cannot re-baseline the royalty away.
 * - Capital the owner injects AFTER the baseline was recorded (v1.1)
 *   is not profit either: every successful USDC -> credits topup
 *   records its credits in ROYALTY_CAPITAL_IN_KV (see
 *   recordCapitalInjection, called from the single topup funnel in
 *   src/conway/topup.ts), and the royalty subtracts those injections
 *   from the profit. Top-ups before the baseline exists need no
 *   recording — the baseline already contains them, and counting them
 *   again would subtract the same capital twice. Revenue, by
 *   contrast, must arrive as a direct credits transfer, never as
 *   USDC converted through topup: only then does it sit above
 *   baseline + injections + reserve and count as profit.
 * - Children inherit the royalty terms (owner, rate, reserve) through
 *   genesis.json — see resolveRoyaltyConfig's genesis fallback — but
 *   never the parent's baseline: each child baselines on its own
 *   first balance.
 * - Failures are logged and swallowed: a failed royalty must never
 *   crash the heartbeat or wake the agent. It retries on the next
 *   scheduled run.
 */

import fs from "fs";
import path from "path";
import type {
  AutomatonConfig,
  AutomatonDatabase,
  HeartbeatLegacyContext,
  RoyaltyConfig,
  TickContext,
} from "../types.js";
import { DEFAULT_ROYALTY_CONFIG, DEFAULT_TREASURY_POLICY } from "../types.js";
import { getAutomatonDir } from "../identity/wallet.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("heartbeat.royalty");

export const ROYALTY_BASELINE_KV = "royalty_baseline_cents";
export const ROYALTY_LAST_PAID_KV = "royalty_last_paid";
export const ROYALTY_TOTAL_PAID_KV = "royalty_total_paid_cents";
/**
 * FORK v1.1: total credits the owner injected AFTER the baseline was
 * recorded, via USDC -> credits topups. Subtracted from the royalty
 * profit so the 1% never bites the owner's own capital.
 */
export const ROYALTY_CAPITAL_IN_KV = "royalty_capital_in_cents";
/** Minimum gap between royalty payments, even if the task is scheduled more often. */
export const ROYALTY_MIN_INTERVAL_MS = 20 * 3_600_000; // 20h

/** The only slice of the state DB the royalty accounting needs. */
export type CapitalLedger = Pick<AutomatonDatabase, "getKV" | "setKV">;

/**
 * Record a capital injection: credits bought with the owner's USDC
 * through the topup funnel (src/conway/topup.ts). Called on every
 * successful topup, from every call site, with the credits actually
 * added. No-op when there is no baseline yet: those top-ups are
 * already inside the baseline the first royalty run records, and
 * counting them again would subtract the same capital twice.
 */
export function recordCapitalInjection(db: CapitalLedger, cents: number): void {
  const amount = Math.floor(cents);
  if (!(amount > 0)) return;
  if (db.getKV(ROYALTY_BASELINE_KV) === undefined) return;
  const prev = Number(db.getKV(ROYALTY_CAPITAL_IN_KV)) || 0;
  db.setKV(ROYALTY_CAPITAL_IN_KV, String(prev + amount));
  logger.info(
    `Royalty capital injection recorded: +$${(amount / 100).toFixed(2)} ` +
      `(total injected after baseline: $${((prev + amount) / 100).toFixed(2)})`,
  );
}

export function getCapitalInjectionsCents(db: CapitalLedger): number {
  return Number(db.getKV(ROYALTY_CAPITAL_IN_KV)) || 0;
}

export interface RoyaltyComputation {
  profitCents: number;
  dueCents: number;
}

/**
 * Pure royalty math. Returns the profit observed and the amount due
 * for this run (0 when there is no payable profit).
 */
export function computeRoyaltyDueCents(params: {
  balanceCents: number;
  baselineCents: number;
  reserveCents: number;
  rateBps: number;
  minTransferCents: number;
  maxSingleTransferCents: number;
  /** FORK v1.1: owner capital injected after the baseline was recorded. */
  capitalInjectionsCents?: number;
}): RoyaltyComputation {
  const profitCents = Math.max(
    0,
    Math.floor(params.balanceCents) -
      Math.floor(params.baselineCents) -
      Math.floor(params.capitalInjectionsCents ?? 0) -
      Math.floor(params.reserveCents),
  );
  if (profitCents <= 0) return { profitCents: 0, dueCents: 0 };

  let dueCents = Math.floor((profitCents * params.rateBps) / 10_000);
  dueCents = Math.min(dueCents, params.maxSingleTransferCents);
  // Never take more than the profit itself, whatever the config says.
  dueCents = Math.min(dueCents, profitCents);
  if (dueCents < params.minTransferCents) dueCents = 0;
  return { profitCents, dueCents };
}

/**
 * Resolve the effective royalty config: automaton.json wins; when it
 * carries no owner (e.g. a spawned child whose config was bootstrapped
 * without the fork's fields), fall back to the royalty block the
 * parent wrote into genesis.json at spawn time.
 */
export function resolveRoyaltyConfig(
  config: AutomatonConfig,
  automatonDir: string = getAutomatonDir(),
): RoyaltyConfig {
  const fromConfig: RoyaltyConfig = {
    ...DEFAULT_ROYALTY_CONFIG,
    ...(config.royalty ?? {}),
  };
  if (fromConfig.ownerAddress) return fromConfig;

  try {
    const genesisPath = path.join(automatonDir, "genesis.json");
    if (fs.existsSync(genesisPath)) {
      const genesis = JSON.parse(fs.readFileSync(genesisPath, "utf-8"));
      if (genesis?.royalty?.ownerAddress) {
        return {
          ...DEFAULT_ROYALTY_CONFIG,
          ...genesis.royalty,
          // A child never inherits a baseline through genesis.
          baselineCents: undefined,
        };
      }
    }
  } catch {
    // Unreadable genesis: royalty stays disabled rather than guessing.
  }
  return fromConfig;
}

/**
 * The heartbeat task body. Registered as `owner_royalty` in
 * BUILTIN_TASKS (src/heartbeat/tasks.ts) and scheduled daily by
 * default (src/heartbeat/config.ts).
 */
export async function runOwnerRoyalty(
  ctx: TickContext,
  taskCtx: HeartbeatLegacyContext,
): Promise<{ shouldWake: boolean; message?: string }> {
  try {
    const royalty = resolveRoyaltyConfig(taskCtx.config);
    if (!royalty.ownerAddress) return { shouldWake: false };

    const balance = ctx.creditBalance;

    // Baseline: recorded once, then immutable.
    let baselineCents: number;
    const storedBaseline = taskCtx.db.getKV(ROYALTY_BASELINE_KV);
    if (storedBaseline !== undefined) {
      baselineCents = Number(storedBaseline) || 0;
    } else if (royalty.baselineCents !== undefined) {
      baselineCents = royalty.baselineCents;
      taskCtx.db.setKV(ROYALTY_BASELINE_KV, String(baselineCents));
    } else {
      // First run: whatever the balance is now IS the capital this
      // automaton was born with. Record it and pay nothing today.
      taskCtx.db.setKV(ROYALTY_BASELINE_KV, String(balance));
      taskCtx.db.setKV(
        ROYALTY_LAST_PAID_KV,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "baseline_recorded",
          baselineCents: balance,
          balanceCents: balance,
        }),
      );
      logger.info(
        `Royalty baseline recorded: $${(balance / 100).toFixed(2)} (first run, no payment)`,
      );
      return { shouldWake: false };
    }

    // At most one payment per ROYALTY_MIN_INTERVAL_MS.
    const lastPaidRaw = taskCtx.db.getKV(ROYALTY_LAST_PAID_KV);
    if (lastPaidRaw) {
      try {
        const lastPaid = JSON.parse(lastPaidRaw);
        if (
          lastPaid?.event === "paid" &&
          Date.now() - new Date(lastPaid.timestamp).getTime() <
            ROYALTY_MIN_INTERVAL_MS
        ) {
          return { shouldWake: false };
        }
      } catch {
        // Corrupt record: ignore and proceed.
      }
    }

    const maxSingle =
      taskCtx.config.treasuryPolicy?.maxSingleTransferCents ??
      DEFAULT_TREASURY_POLICY.maxSingleTransferCents;

    // FORK v1.1: owner capital injected after the baseline is not profit.
    const capitalInjectionsCents = getCapitalInjectionsCents(taskCtx.db);

    const { profitCents, dueCents } = computeRoyaltyDueCents({
      balanceCents: balance,
      baselineCents,
      reserveCents: royalty.reserveCents,
      rateBps: royalty.rateBps,
      minTransferCents: royalty.minTransferCents,
      maxSingleTransferCents: maxSingle,
      capitalInjectionsCents,
    });

    if (dueCents <= 0) return { shouldWake: false };

    const transfer = await taskCtx.conway.transferCredits(
      royalty.ownerAddress,
      dueCents,
      `Owner royalty: ${royalty.rateBps / 100}% of remaining profit`,
    );

    const totalPaid =
      (Number(taskCtx.db.getKV(ROYALTY_TOTAL_PAID_KV)) || 0) + dueCents;
    taskCtx.db.setKV(ROYALTY_TOTAL_PAID_KV, String(totalPaid));
    taskCtx.db.setKV(
      ROYALTY_LAST_PAID_KV,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "paid",
        amountCents: dueCents,
        profitCents,
        balanceCents: balance,
        baselineCents,
        capitalInjectionsCents,
        transferId: transfer.transferId || "",
        status: transfer.status || "",
        totalPaidCents: totalPaid,
      }),
    );
    logger.info(
      `Owner royalty paid: $${(dueCents / 100).toFixed(2)} to ${royalty.ownerAddress} ` +
        `(profit $${(profitCents / 100).toFixed(2)}, balance $${(balance / 100).toFixed(2)}, ` +
        `baseline $${(baselineCents / 100).toFixed(2)}, capital injected after baseline ` +
        `$${(capitalInjectionsCents / 100).toFixed(2)}, ` +
        `total paid $${(totalPaid / 100).toFixed(2)})`,
    );
    return { shouldWake: false };
  } catch (error) {
    // A failed royalty must never crash the heartbeat or drain the
    // agent's credits with wake-ups. Log and retry on the next run.
    logger.error(
      "owner_royalty failed",
      error instanceof Error ? error : undefined,
    );
    return { shouldWake: false };
  }
}
