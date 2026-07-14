/**
 * W14 addendum: a failed Hyperliquid exchange result must surface a BOUNDED
 * venue error string. "batch_error" alone (or a bare rejected status) is
 * undiagnosable for the model and wastes calls — e.g. hl_leverage(cross) on an
 * isolated-only market failed twice before the model guessed isolated.
 */

import { describe, expect, it } from "vitest";

import { exchangeResult } from "@vex-agent/tools/protocols/hyperliquid/handler-shared.js";
import type { HyperliquidExchangeResult } from "@tools/hyperliquid/types.js";

describe("exchangeResult venue error surfacing", () => {
  it("includes the batch_error message, bounded to 120 chars", () => {
    const result: HyperliquidExchangeResult = {
      kind: "batch_error",
      message: "Cannot switch margin mode: market only supports isolated.",
      raw: null,
    };
    const out = exchangeResult(result, { coin: "CASHCAT" });
    expect(out.success).toBe(false);
    expect((out.data as Record<string, unknown>).venueError).toBe("Cannot switch margin mode: market only supports isolated.");
  });

  it("truncates a long venue error to 120 characters", () => {
    const long = "x".repeat(400);
    const result: HyperliquidExchangeResult = { kind: "batch_error", message: long, raw: null };
    const venueError = (exchangeResult(result, {}).data as Record<string, unknown>).venueError;
    expect(typeof venueError).toBe("string");
    expect((venueError as string).length).toBe(120);
  });

  it("surfaces a rejected order status message", () => {
    const result: HyperliquidExchangeResult = {
      kind: "orders",
      statuses: [{ kind: "rejected", message: "Order must have minimum value of 10." }],
      raw: null,
    };
    const out = exchangeResult(result, { coin: "BTC" });
    expect(out.success).toBe(false);
    expect((out.data as Record<string, unknown>).venueError).toBe("Order must have minimum value of 10.");
  });

  it("omits venueError on a successful result", () => {
    const result: HyperliquidExchangeResult = {
      kind: "orders",
      statuses: [{ kind: "accepted_resting", oid: 1 }],
      raw: null,
    };
    const out = exchangeResult(result, { coin: "BTC" });
    expect(out.success).toBe(true);
    expect((out.data as Record<string, unknown>).venueError).toBeUndefined();
  });

  it("masks an EVM address in the venue error", () => {
    const address = "0x1111111111111111111111111111111111111111";
    const result: HyperliquidExchangeResult = { kind: "batch_error", message: `Rejected for ${address}`, raw: null };
    const venueError = (exchangeResult(result, {}).data as Record<string, unknown>).venueError as string;
    expect(venueError).not.toContain(address);
  });

  it("redacts an api-key-shaped auth fragment", () => {
    const result: HyperliquidExchangeResult = { kind: "batch_error", message: "auth failed sk-or-abcdefghij0123456789ABCDEFGHIJ token", raw: null };
    const venueError = (exchangeResult(result, {}).data as Record<string, unknown>).venueError as string;
    expect(venueError).toContain("[REDACTED:");
    expect(venueError).not.toContain("sk-or-abcdefghij0123456789ABCDEFGHIJ");
  });

  it("collapses control whitespace in the venue error", () => {
    const result: HyperliquidExchangeResult = { kind: "batch_error", message: "line1\n\n\tline2", raw: null };
    expect((exchangeResult(result, {}).data as Record<string, unknown>).venueError).toBe("line1 line2");
  });

  it("does not let a handler-supplied data.venueError override the computed one", () => {
    const result: HyperliquidExchangeResult = { kind: "batch_error", message: "real venue error", raw: null };
    const out = exchangeResult(result, { venueError: "FAKE injected by data" });
    expect((out.data as Record<string, unknown>).venueError).toBe("real venue error");
  });
});
