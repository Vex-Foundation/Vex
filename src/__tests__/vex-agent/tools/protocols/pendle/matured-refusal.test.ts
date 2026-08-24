/**
 * The NAMED matured refusal for active-only actions (R5b matrix rows 4 and 5).
 *
 * `pt.buy`, `yt.buy`, `yt.sell`, `py.mint`, `lp.add` — and, per the round-3
 * correction, `pt.sell` and `py.redeem` — keep an ACTIVE-ONLY financial
 * resolver. So on a matured market their lookup returns nothing, and the old
 * answer was "No active Pendle market for this PT", which tells a context-free
 * agent the wrong thing: it reads as "this PT does not exist" and sends the
 * agent looking for a different address, when the truth is "it exists, it
 * matured, and here is the tool that CAN act on it".
 *
 * The fix names the reason from the READ-ONLY classification lane
 * (`market-read.ts`), which sees both maturities. The hard constraint — the
 * reason the matrix separates the lanes at all — is that this lane must NEVER
 * feed a quote output, a prequote identity, or an execution parameter. It is
 * enforced by TYPE here: the function returns a `string`. There is no market
 * object, no expiry field, no address for a caller to reach for, so "only names
 * the refusal" is a property of the signature rather than a rule someone has to
 * remember.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendleReadMarketLookup } from "@vex-agent/tools/protocols/pendle/market-read.js";

const mockResolveMarketForRead = vi.fn();
vi.mock("@vex-agent/tools/protocols/pendle/market-read.js", () => ({
  resolveMarketForRead: (...a: unknown[]) => mockResolveMarketForRead(...a),
}));

const { explainUnresolvedPendleMarket } = await import(
  "@vex-agent/tools/protocols/pendle/matured-refusal.js"
);

const CHAIN_ID = 1;
const NOW_MS = Date.parse("2026-07-27T12:00:00.000Z");
const MATURED_PT = "0x9bf45ab47747f4b4dd09b3c2c73953484b4eb375";

/** srUSDe, expiry 2026-04-02 — matured; the exact live row the corpus names. */
function maturedLookup(): PendleReadMarketLookup {
  return {
    status: "found",
    matured: true,
    matchedBy: "pt",
    catalogScope: "inactive",
    market: {
      address: "0xafb7d6d1e9bca5b675adc9b4f52f0cdfddec9654",
      name: "srUSDe",
      expiry: "2026-04-02T00:00:00.000Z",
      pt: MATURED_PT,
      yt: "0x31f9e6692e87d81ff8d64de1f475fce6880a030f",
    } as PendleReadMarketLookup extends { market: infer M } ? M : never,
  } as PendleReadMarketLookup;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveMarketForRead.mockResolvedValue(maturedLookup());
});

describe("a matured market is named as matured, not as absent", () => {
  it("says the market MATURED and gives the date", async () => {
    const text = await explainUnresolvedPendleMarket(
      CHAIN_ID, "ethereum", MATURED_PT, { action: "pt.buy", leg: "PT" }, NOW_MS,
    );
    expect(text).toMatch(/matured/i);
    expect(text).toContain("2026-04-02");
    // The old answer, which sent the agent hunting for a different address.
    expect(text).not.toMatch(/is not an active Pendle PT/i);
  });

  it("never tells the agent the market does not exist", async () => {
    const text = await explainUnresolvedPendleMarket(
      CHAIN_ID, "ethereum", MATURED_PT, { action: "pt.buy", leg: "PT" }, NOW_MS,
    );
    expect(text).not.toMatch(/no such market|does not exist/i);
  });

  it.each([
    ["pt.buy", /pendle__pt_redeem/],
    ["yt.buy", /matured/i],
    ["py.mint", /pendle__pt_redeem/],
    ["lp.add", /pendle__lp_remove/],
    ["pt.sell", /pendle__pt_redeem/],
    ["yt.sell", /matured/i],
    ["py.redeem", /pendle__pt_redeem/],
  ] as const)("%s points at the tool that CAN act on a matured position", async (action, expected) => {
    const text = await explainUnresolvedPendleMarket(
      CHAIN_ID, "ethereum", MATURED_PT, { action, leg: "PT" }, NOW_MS,
    );
    expect(text).toMatch(expected);
  });

  it("tells a seller that selling is over, not that the PT is unknown", async () => {
    const text = await explainUnresolvedPendleMarket(
      CHAIN_ID, "ethereum", MATURED_PT, { action: "pt.sell", leg: "PT" }, NOW_MS,
    );
    expect(text).toMatch(/sell/i);
    expect(text).toMatch(/pendle__pt_redeem/);
  });
});

describe("the other classifications stay honest", () => {
  it("a proven absence says so, and says the matured catalogue was read too", async () => {
    mockResolveMarketForRead.mockResolvedValue({ status: "not_found" });
    const text = await explainUnresolvedPendleMarket(
      CHAIN_ID, "ethereum", MATURED_PT, { action: "pt.buy", leg: "PT" }, NOW_MS,
    );
    expect(text).toMatch(/matured markets were included|including matured/i);
    expect(text).not.toMatch(/^This Pendle market matured/);
  });

  it("an UNPROVEN absence refuses to claim absence (rules/90 decline-not-guess)", async () => {
    mockResolveMarketForRead.mockResolvedValue({ status: "indeterminate", reason: "catalog_page_budget_exhausted" });
    const text = await explainUnresolvedPendleMarket(
      CHAIN_ID, "ethereum", MATURED_PT, { action: "pt.buy", leg: "PT" }, NOW_MS,
    );
    expect(text).toMatch(/could not (prove|confirm)|not established/i);
    // It may WARN against concluding non-existence ("before concluding the
    // market does not exist"); what it must never do is make that claim itself.
    // The distinguishing evidence is the determined branch's own phrase.
    expect(text).not.toMatch(/the full catalogue was read/i);
    expect(text).not.toMatch(/No Pendle market on \w+ has/i);
  });

  it("a market found but STILL ACTIVE is not called matured", async () => {
    // The active-only resolver missed it for some other reason (a PT/YT leg
    // mismatch, say). Claiming maturity here would be a fabricated cause.
    mockResolveMarketForRead.mockResolvedValue({ ...maturedLookup(), matured: false });
    const text = await explainUnresolvedPendleMarket(
      CHAIN_ID, "ethereum", MATURED_PT, { action: "pt.buy", leg: "PT" }, NOW_MS,
    );
    expect(text).not.toMatch(/matured/i);
  });

  it("a FAILING classification lane still returns a usable sentence, never throws", async () => {
    // The refusal path must not turn a lookup miss into an unhandled error: the
    // caller is already failing and needs words, not a second exception.
    mockResolveMarketForRead.mockRejectedValue(new Error("catalogue unreachable"));
    const text = await explainUnresolvedPendleMarket(
      CHAIN_ID, "ethereum", MATURED_PT, { action: "pt.buy", leg: "PT" }, NOW_MS,
    );
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/catalogue unreachable/);
  });
});

describe("the classification lane cannot leak into a money path", () => {
  it("returns a STRING and nothing else — no market, no expiry, no address to trade on", async () => {
    const result = await explainUnresolvedPendleMarket(
      CHAIN_ID, "ethereum", MATURED_PT, { action: "pt.buy", leg: "PT" }, NOW_MS,
    );
    expect(typeof result).toBe("string");
  });

  it("the module exports ONLY the explainer — no resolver escapes with it", async () => {
    const mod = await import("@vex-agent/tools/protocols/pendle/matured-refusal.js");
    expect(Object.keys(mod).sort()).toEqual(["explainUnresolvedPendleMarket"]);
  });

  it("passes the injected clock through, so maturity is never read from a live clock", async () => {
    await explainUnresolvedPendleMarket(CHAIN_ID, "ethereum", MATURED_PT, { action: "pt.buy", leg: "PT" }, NOW_MS);
    expect(mockResolveMarketForRead).toHaveBeenCalledWith(CHAIN_ID, MATURED_PT, NOW_MS);
  });
});
