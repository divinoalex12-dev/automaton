/**
 * Owner Royalty Tests (FORK: owner-royalty-1pct)
 *
 * Covers the pure royalty math, the heartbeat task behavior
 * (baseline recording, daily guard, payment), genesis inheritance,
 * and the genesis.json fallback used by spawned children.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  computeRoyaltyDueCents,
  resolveRoyaltyConfig,
  runOwnerRoyalty,
  ROYALTY_BASELINE_KV,
  ROYALTY_LAST_PAID_KV,
  ROYALTY_TOTAL_PAID_KV,
} from "../heartbeat/royalty.js";
import { inheritRoyalty } from "../replication/genesis.js";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import {
  MockConwayClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";
import type {
  AutomatonConfig,
  AutomatonDatabase,
  HeartbeatLegacyContext,
  TickContext,
} from "../types.js";

const OWNER = "0x9999999999999999999999999999999999999999";

function tick(db: AutomatonDatabase, creditBalance: number): TickContext {
  return {
    tickId: "royalty-test-tick",
    startedAt: new Date(),
    creditBalance,
    usdcBalance: 0,
    survivalTier: "high",
    lowComputeMultiplier: 4,
    config: { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 },
    db: db.raw,
  };
}

function legacy(
  db: AutomatonDatabase,
  conway: MockConwayClient,
  config: AutomatonConfig,
): HeartbeatLegacyContext {
  return {
    identity: createTestIdentity(),
    config,
    db,
    conway: conway as any,
  };
}

const royaltyConfig = (overrides?: Partial<AutomatonConfig>): AutomatonConfig =>
  createTestConfig({
    royalty: {
      ownerAddress: OWNER,
      rateBps: 100,
      reserveCents: 1000,
      minTransferCents: 10,
    },
    ...overrides,
  });

describe("computeRoyaltyDueCents", () => {
  const base = {
    baselineCents: 1685,
    reserveCents: 1000,
    rateBps: 100,
    minTransferCents: 10,
    maxSingleTransferCents: 5000,
  };

  it("takes exactly 1% of the profit above baseline + reserve", () => {
    const { profitCents, dueCents } = computeRoyaltyDueCents({
      ...base,
      balanceCents: 20_000,
    });
    expect(profitCents).toBe(20_000 - 1685 - 1000);
    expect(dueCents).toBe(173);
  });

  it("pays nothing when the balance is at or below baseline + reserve", () => {
    expect(
      computeRoyaltyDueCents({ ...base, balanceCents: 2685 }).dueCents,
    ).toBe(0);
    expect(
      computeRoyaltyDueCents({ ...base, balanceCents: 500 }).dueCents,
    ).toBe(0);
  });

  it("leaves dust below the minimum transfer to accumulate", () => {
    // profit $5.00 -> 1% = $0.05 < $0.10 minimum
    const { profitCents, dueCents } = computeRoyaltyDueCents({
      ...base,
      balanceCents: 2685 + 500,
    });
    expect(profitCents).toBe(500);
    expect(dueCents).toBe(0);
  });

  it("caps a single payment at the treasury max single transfer", () => {
    const { dueCents } = computeRoyaltyDueCents({
      ...base,
      balanceCents: 1_000_000,
    });
    expect(dueCents).toBe(5000);
  });

  it("never pays more than the profit itself", () => {
    const { dueCents } = computeRoyaltyDueCents({
      ...base,
      rateBps: 10_000,
      balanceCents: 2685 + 100,
    });
    expect(dueCents).toBe(100);
  });
});

describe("owner_royalty heartbeat task", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
  });

  afterEach(() => {
    db.close();
  });

  it("is registered as a builtin task and routes to the royalty runner", async () => {
    expect(typeof BUILTIN_TASKS.owner_royalty).toBe("function");
    const config = royaltyConfig();
    await BUILTIN_TASKS.owner_royalty(
      tick(db, 16_850),
      legacy(db, conway, config),
    );
    expect(db.getKV(ROYALTY_BASELINE_KV)).toBe("16850");
  });

  it("does nothing when no owner is configured", async () => {
    const config = createTestConfig(); // no royalty block
    const before = conway.creditsCents;
    const result = await runOwnerRoyalty(
      tick(db, 50_000),
      legacy(db, conway, config),
    );
    expect(result.shouldWake).toBe(false);
    expect(conway.creditsCents).toBe(before);
    expect(db.getKV(ROYALTY_BASELINE_KV)).toBeUndefined();
  });

  it("records the baseline on first run and pays nothing that day", async () => {
    const config = royaltyConfig();
    const before = conway.creditsCents;
    await runOwnerRoyalty(tick(db, 16_850), legacy(db, conway, config));
    expect(db.getKV(ROYALTY_BASELINE_KV)).toBe("16850");
    expect(conway.creditsCents).toBe(before);
    const last = JSON.parse(db.getKV(ROYALTY_LAST_PAID_KV)!);
    expect(last.event).toBe("baseline_recorded");
  });

  it("pays 1% of remaining profit on the next run and accumulates the total", async () => {
    const config = royaltyConfig();
    await runOwnerRoyalty(tick(db, 16_850), legacy(db, conway, config));
    // Balance grows to $300.00: profit = 30000 - 16850 - 1000 = 12150 -> due 121
    const before = conway.creditsCents;
    await runOwnerRoyalty(tick(db, 30_000), legacy(db, conway, config));
    expect(conway.creditsCents).toBe(before - 121);
    expect(db.getKV(ROYALTY_TOTAL_PAID_KV)).toBe("121");
    const last = JSON.parse(db.getKV(ROYALTY_LAST_PAID_KV)!);
    expect(last.event).toBe("paid");
    expect(last.amountCents).toBe(121);
  });

  it("enforces the 20h minimum gap between payments", async () => {
    const config = royaltyConfig();
    await runOwnerRoyalty(tick(db, 16_850), legacy(db, conway, config));
    await runOwnerRoyalty(tick(db, 30_000), legacy(db, conway, config));
    const before = conway.creditsCents;
    await runOwnerRoyalty(tick(db, 40_000), legacy(db, conway, config));
    expect(conway.creditsCents).toBe(before); // blocked by the gap guard
  });

  it("uses an operator-set baseline from config and can pay on first run", async () => {
    const config = royaltyConfig({
      royalty: {
        ownerAddress: OWNER,
        rateBps: 100,
        reserveCents: 1000,
        minTransferCents: 10,
        baselineCents: 5000,
      },
    });
    const before = conway.creditsCents;
    await runOwnerRoyalty(tick(db, 25_000), legacy(db, conway, config));
    // profit = 25000 - 5000 - 1000 = 19000 -> due 190
    expect(conway.creditsCents).toBe(before - 190);
    expect(db.getKV(ROYALTY_BASELINE_KV)).toBe("5000");
  });

  it("survives a failing transfer without throwing or waking the agent", async () => {
    const config = royaltyConfig({
      royalty: {
        ownerAddress: OWNER,
        rateBps: 100,
        reserveCents: 1000,
        minTransferCents: 10,
        baselineCents: 5000,
      },
    });
    (conway as any).transferCredits = async () => {
      throw new Error("network down");
    };
    const result = await runOwnerRoyalty(
      tick(db, 25_000),
      legacy(db, conway, config),
    );
    expect(result.shouldWake).toBe(false);
    expect(db.getKV(ROYALTY_TOTAL_PAID_KV)).toBeUndefined();
  });
});

describe("royalty inheritance and genesis fallback", () => {
  it("inheritRoyalty copies the terms but strips the baseline", () => {
    const parent = royaltyConfig({
      royalty: {
        ownerAddress: OWNER,
        rateBps: 100,
        reserveCents: 1000,
        minTransferCents: 10,
        baselineCents: 5000,
      },
    });
    const inherited = inheritRoyalty(parent);
    expect(inherited?.ownerAddress).toBe(OWNER);
    expect(inherited?.rateBps).toBe(100);
    expect((inherited as any)?.baselineCents).toBeUndefined();
  });

  it("inheritRoyalty returns undefined when the parent has no owner", () => {
    expect(inheritRoyalty(createTestConfig())).toBeUndefined();
  });

  it("resolveRoyaltyConfig falls back to genesis.json for spawned children", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "royalty-genesis-"));
    fs.writeFileSync(
      path.join(dir, "genesis.json"),
      JSON.stringify({
        name: "child",
        royalty: {
          ownerAddress: OWNER,
          rateBps: 100,
          reserveCents: 1000,
          minTransferCents: 10,
          baselineCents: 777_000,
        },
      }),
    );
    const resolved = resolveRoyaltyConfig(createTestConfig(), dir);
    expect(resolved.ownerAddress).toBe(OWNER);
    // A child never inherits a baseline through genesis.
    expect(resolved.baselineCents).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolveRoyaltyConfig prefers automaton.json over genesis.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "royalty-genesis-"));
    fs.writeFileSync(
      path.join(dir, "genesis.json"),
      JSON.stringify({ royalty: { ownerAddress: "0xdeadbeef" } }),
    );
    const resolved = resolveRoyaltyConfig(royaltyConfig(), dir);
    expect(resolved.ownerAddress).toBe(OWNER);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
