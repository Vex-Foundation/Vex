/**
 * `BridgeStatus` rejects a contradictory call BY NAME (SPEC §2.4 item 22).
 *
 * The alias forwarded `orderId` and silently dropped every list filter supplied
 * with it, so the agent got one order back and no way to learn its
 * `limit`/`fromChain`/`txHashSearch` were never applied.
 */

import { describe, expect, it } from "vitest";
import {
  BRIDGE_STATUS_LIST_ONLY_PARAMS,
  rejectBridgeStatusModeConflict,
} from "@vex-agent/tools/protocols/khalani/bridge-status-mode.js";

describe("BridgeStatus mode conflict", () => {
  it("allows a pure by-id call", () => {
    expect(rejectBridgeStatusModeConflict({ orderId: "order_abc123" })).toBeNull();
  });

  it("allows a pure list call", () => {
    expect(rejectBridgeStatusModeConflict({ limit: 5, fromChain: "ethereum" })).toBeNull();
  });

  it("allows an empty call", () => {
    expect(rejectBridgeStatusModeConflict({})).toBeNull();
  });

  it("names the discarded parameter when one is combined with orderId", () => {
    const reason = rejectBridgeStatusModeConflict({ orderId: "order_abc123", limit: 5 });
    expect(reason).toBe(
      "BridgeStatus takes EITHER orderId (one order) OR the list filters, never both — "
      + "limit was supplied alongside orderId and would have been silently discarded. "
      + "Drop orderId to filter a list, or drop limit to read that one order.",
    );
  });

  it("names EVERY discarded parameter, in declaration order", () => {
    const reason = rejectBridgeStatusModeConflict({
      orderId: "order_abc123",
      txHashSearch: "0xdead",
      limit: 5,
      fromChain: "ethereum",
    });
    expect(reason).toContain("limit, fromChain, txHashSearch were supplied alongside orderId");
  });

  it("treats an explicit undefined/null as absent, not as a conflict", () => {
    expect(rejectBridgeStatusModeConflict({ orderId: "o", limit: undefined, cursor: null })).toBeNull();
  });

  it("covers every list-only parameter the alias accepts", () => {
    for (const key of BRIDGE_STATUS_LIST_ONLY_PARAMS) {
      expect(rejectBridgeStatusModeConflict({ orderId: "o", [key]: "x" })).toContain(key);
    }
  });
});
