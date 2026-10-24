/**
 * Integration: the price alert repo against real Postgres. The limits hold
 * under concurrent writers (the advisory lock), replays return the existing
 * row, and the fire claim is single-shot.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, execute } from "@vex-agent/db/client.js";
import * as repo from "@vex-agent/db/repos/price-alerts.js";

function alertInput(over: Partial<repo.NewPriceAlert> = {}): repo.NewPriceAlert {
  return {
    chain: "base",
    address: "0x4200000000000000000000000000000000000006",
    assetKey: "base:0x4200000000000000000000000000000000000006",
    label: "WETH",
    condition: "above",
    value: "4000",
    referencePrice: "3500",
    triggerPrice: "4000",
    direction: "above",
    note: null,
    origin: "app",
    sessionId: null,
    ...over,
  };
}

function watchInput(n: number): repo.NewWatchlistItem {
  const address = `0x${n.toString(16).padStart(40, "0")}`;
  return { chain: "base", address, assetKey: `base:${address}`, label: `T${n}` };
}

beforeEach(async () => {
  await execute("DELETE FROM price_alerts");
  await execute("DELETE FROM watchlist_items");
});

afterAll(async () => {
  await execute("DELETE FROM price_alerts");
  await execute("DELETE FROM watchlist_items");
  await closePool();
});

describe("watchlist", () => {
  it("returns the existing row when a token is followed twice", async () => {
    const first = await repo.addWatchlistItem(watchInput(1), 30);
    const again = await repo.addWatchlistItem(watchInput(1), 30);
    expect(first).toMatchObject({ ok: true, created: true });
    expect(again).toMatchObject({ ok: true, created: false });
    expect(await repo.listWatchlist()).toHaveLength(1);
  });

  it("refuses the 31st token, even when ten writers race for the last slots", async () => {
    for (let n = 0; n < 25; n++) await repo.addWatchlistItem(watchInput(n), 30);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => repo.addWatchlistItem(watchInput(100 + i), 30)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok)).toEqual(Array(5).fill({ ok: false, reason: "watchlist_full" }));
    expect(await repo.listWatchlist()).toHaveLength(30);
  });

  it("removes a followed token, and says when there was none", async () => {
    await repo.addWatchlistItem(watchInput(1), 30);
    expect(await repo.removeWatchlistItem(watchInput(1).assetKey)).toBe(true);
    expect(await repo.removeWatchlistItem(watchInput(1).assetKey)).toBe(false);
  });
});

describe("alerts", () => {
  it("leaves exactly 20 active alerts when two writers race at 19", async () => {
    for (let n = 0; n < 19; n++) {
      await repo.createAlert(alertInput({ value: String(4000 + n), triggerPrice: String(4000 + n) }), 20);
    }
    const [a, b] = await Promise.all([
      repo.createAlert(alertInput({ value: "5001", triggerPrice: "5001" }), 20),
      repo.createAlert(alertInput({ value: "5002", triggerPrice: "5002" }), 20),
    ]);
    const outcomes = [a, b].map((r) => (r.ok ? "created" : r.reason)).sort();
    expect(outcomes).toEqual(["created", "too_many_alerts"]);
    expect(await repo.listAlerts({ status: "active" })).toHaveLength(20);
  });

  it("returns the alert that already waits when the same set is replayed", async () => {
    const first = await repo.createAlert(alertInput(), 20);
    const replay = await repo.createAlert(alertInput({ value: "4000.000" }), 20);
    if (!first.ok || !replay.ok) throw new Error("expected both to resolve to an alert");
    expect(replay.created).toBe(false);
    expect(replay.alert.id).toBe(first.alert.id);
    expect(await repo.listAlerts({ status: "active" })).toHaveLength(1);
  });

  it("stores a dangling session id as NULL instead of failing", async () => {
    const created = await repo.createAlert(alertInput({ origin: "chat", sessionId: "no-such-session" }), 20);
    if (!created.ok) throw new Error("expected an alert");
    expect(created.alert.sessionId).toBeNull();
    expect(created.alert.origin).toBe("chat");
  });

  it("claims a fire once; a cancelled alert cannot fire", async () => {
    const created = await repo.createAlert(alertInput(), 20);
    if (!created.ok) throw new Error("expected an alert");
    const at = new Date("2026-10-24T12:00:00.000Z");
    const claimed = await repo.claimTriggered(created.alert.id, "4001.5", at);
    expect(claimed).toMatchObject({ status: "triggered", triggeredPrice: "4001.5", triggeredAt: at.toISOString() });
    expect(await repo.claimTriggered(created.alert.id, "4002", at)).toBeNull();

    const other = await repo.createAlert(alertInput({ value: "4100", triggerPrice: "4100" }), 20);
    if (!other.ok) throw new Error("expected an alert");
    expect(await repo.cancelAlert(other.alert.id)).toMatchObject({ status: "cancelled" });
    expect(await repo.cancelAlert(other.alert.id)).toBeNull();
    expect(await repo.claimTriggered(other.alert.id, "4200", at)).toBeNull();
  });

  it("lists unacknowledged fires, acknowledges them, then clears them", async () => {
    const created = await repo.createAlert(alertInput(), 20);
    if (!created.ok) throw new Error("expected an alert");
    await repo.claimTriggered(created.alert.id, "4001", new Date());
    expect(await repo.listUnacknowledgedFired(10)).toHaveLength(1);
    expect(await repo.acknowledgeFired([created.alert.id])).toBe(1);
    expect(await repo.acknowledgeFired([created.alert.id])).toBe(0);
    expect(await repo.listUnacknowledgedFired(10)).toHaveLength(0);
    expect(await repo.listAlerts({ status: "triggered" })).toHaveLength(1);
    expect(await repo.clearFired([created.alert.id])).toBe(1);
    expect(await repo.listAlerts({ status: "triggered" })).toHaveLength(0);
  });

  it("keeps NUMERIC values as exact decimal text", async () => {
    const created = await repo.createAlert(
      alertInput({ value: "0.000000012345", triggerPrice: "0.000000012345", referencePrice: "0.00000001" }),
      20,
    );
    if (!created.ok) throw new Error("expected an alert");
    expect(created.alert.value).toBe("0.000000012345");
    expect(created.alert.referencePrice).toBe("0.00000001");
  });
});
