/**
 * Watchlist and PriceAlert (F01): the two chat tools over the alerts service.
 *
 * Pins: every action reaches the service with exactly what the model said, a
 * refusal comes back as one sentence naming its reason, `list` reports itself
 * as a read, a chat-set alert carries `origin: 'chat'` and the session, and a
 * malformed call is refused before the service is touched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";

const mockRead = vi.fn();
const mockAdd = vi.fn();
const mockRemove = vi.fn();
const mockSet = vi.fn();
const mockCancel = vi.fn();
vi.mock("@vex-agent/alerts/service.js", () => ({
  readWatchlist: (...a: unknown[]) => mockRead(...a),
  addToWatchlist: (...a: unknown[]) => mockAdd(...a),
  removeFromWatchlist: (...a: unknown[]) => mockRemove(...a),
  setPriceAlert: (...a: unknown[]) => mockSet(...a),
  cancelPriceAlert: (...a: unknown[]) => mockCancel(...a),
}));

const { handleWatchlist } = await import("@vex-agent/tools/internal/alerts/watchlist.js");
const { handlePriceAlert } = await import("@vex-agent/tools/internal/alerts/price-alert.js");

const SESSION = "session-1";
const context = { sessionId: SESSION } as InternalToolContext;
const WETH = "0x4200000000000000000000000000000000000006";

const ALERT = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "WETH",
  condition: "above",
  value: "4000",
  triggerPrice: "4000",
  direction: "above",
  status: "active",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Watchlist", () => {
  it("lists the snapshot and reports the call as a read", async () => {
    const snapshot = { items: [], activeAlerts: [], firedAlerts: [], limits: { watchlist: 30, activeAlerts: 20 }, pricedAt: "x" };
    mockRead.mockResolvedValue(snapshot);
    const result = await handleWatchlist({ action: "list" }, context);
    expect(result.success).toBe(true);
    expect(result.actionKind).toBe("read");
    expect(JSON.parse(result.output)).toEqual(snapshot);
  });

  it("passes the turn's abort signal to the price read", async () => {
    mockRead.mockResolvedValue({});
    const controller = new AbortController();
    await handleWatchlist({ action: "list" }, { ...context, abortSignal: controller.signal });
    expect(mockRead).toHaveBeenCalledWith({ signal: controller.signal });
  });

  it("adds a token with the user's label", async () => {
    mockAdd.mockResolvedValue({ ok: true, item: { assetKey: `base:${WETH}` }, created: true });
    const result = await handleWatchlist({ action: "add", chain: "base", tokenAddress: WETH, label: "My WETH" }, context);
    expect(mockAdd).toHaveBeenCalledWith({ chain: "base", tokenAddress: WETH, label: "My WETH" });
    expect(JSON.parse(result.output)).toEqual({ item: { assetKey: `base:${WETH}` }, created: true });
    expect(result.actionKind).toBeUndefined();
  });

  it("renders a refusal as one sentence naming its reason", async () => {
    mockAdd.mockResolvedValue({ ok: false, reason: "watchlist_full", message: "The watchlist holds at most 30 tokens." });
    const result = await handleWatchlist({ action: "add", chain: "base", tokenAddress: WETH }, context);
    expect(result.success).toBe(false);
    expect(result.output).toBe("Watchlist: watchlist_full. The watchlist holds at most 30 tokens.");
  });

  it("removes by asset key", async () => {
    mockRemove.mockResolvedValue({ ok: true, assetKey: `base:${WETH}` });
    const result = await handleWatchlist({ action: "remove", assetKey: `base:${WETH}` }, context);
    expect(mockRemove).toHaveBeenCalledWith({ assetKey: `base:${WETH}` });
    expect(result.success).toBe(true);
  });

  it("refuses add without a token address before touching the service", async () => {
    const result = await handleWatchlist({ action: "add", chain: "base" }, context);
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/^Watchlist: /);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("refuses an unknown action", async () => {
    const result = await handleWatchlist({ action: "clear" }, context);
    expect(result.success).toBe(false);
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe("PriceAlert", () => {
  it("sets an alert from chat with the session it came from", async () => {
    mockSet.mockResolvedValue({ ok: true, status: "created", alert: ALERT, priceUsd: "3950" });
    const result = await handlePriceAlert(
      { action: "set", chain: "base", tokenAddress: WETH, condition: "above", value: "4000", note: "sell some" },
      context,
    );
    expect(mockSet).toHaveBeenCalledWith({
      chain: "base",
      tokenAddress: WETH,
      condition: "above",
      value: "4000",
      note: "sell some",
      origin: "chat",
      sessionId: SESSION,
    });
    expect(JSON.parse(result.output)).toEqual({ status: "created", alert: ALERT, priceUsd: "3950" });
  });

  it("returns the waiting alert on a repeat", async () => {
    mockSet.mockResolvedValue({ ok: true, status: "already_set", alert: ALERT, priceUsd: "3950" });
    const result = await handlePriceAlert(
      { action: "set", chain: "base", tokenAddress: WETH, condition: "above", value: "4000" },
      context,
    );
    expect(JSON.parse(result.output).status).toBe("already_set");
  });

  it("renders a refusal as one sentence naming its reason", async () => {
    mockSet.mockResolvedValue({ ok: false, reason: "already_past", message: "WETH is already above 4000." });
    const result = await handlePriceAlert(
      { action: "set", chain: "base", tokenAddress: WETH, condition: "above", value: "4000" },
      context,
    );
    expect(result.success).toBe(false);
    expect(result.output).toBe("PriceAlert: already_past. WETH is already above 4000.");
  });

  it("refuses a condition outside the four", async () => {
    const result = await handlePriceAlert(
      { action: "set", chain: "base", tokenAddress: WETH, condition: "crosses", value: "4000" },
      context,
    );
    expect(result.success).toBe(false);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("cancels by id", async () => {
    mockCancel.mockResolvedValue({ ok: true, alert: { ...ALERT, status: "cancelled" } });
    const result = await handlePriceAlert({ action: "cancel", alertId: ALERT.id }, context);
    expect(mockCancel).toHaveBeenCalledWith({ alertId: ALERT.id });
    expect(result.success).toBe(true);
  });

  it("renders an unknown id as not_found", async () => {
    mockCancel.mockResolvedValue({ ok: false, reason: "not_found", message: "No waiting alert has that id." });
    const result = await handlePriceAlert({ action: "cancel", alertId: "nope" }, context);
    expect(result.output).toBe("PriceAlert: not_found. No waiting alert has that id.");
  });
});
