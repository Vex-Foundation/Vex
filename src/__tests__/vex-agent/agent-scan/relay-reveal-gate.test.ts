/**
 * Canonical `executeProtocolTool` reveal gate for the hidden Relay bridge pair
 * (bridge factory W5; plan R7/R8). `execute_tool` forwards `relay.quote.get` /
 * `relay.bridge` straight to `executeProtocolTool`, bypassing the alias-level
 * checks — so the un-bypassable route-bound gate must live at that chokepoint.
 *
 * Proves, through the REAL `executeProtocolTool` (catalog mocked to a fake relay
 * manifest + spy handler, so this exercises the GATE, not Relay network/RPC):
 *   - a non-local UNREVEALED route is rejected BEFORE the handler runs;
 *   - the SAME route, once revealed, reaches the handler;
 *   - a DIFFERENT route stays blocked even when another route is revealed
 *     (route-boundness at the chokepoint);
 *   - a local-chain (Robinhood) route ALWAYS reaches the handler with no reveal.
 */
import { describe, it, expect, vi } from "vitest";

import type { ProtocolExecutionContext } from "../../../vex-agent/tools/protocols/types.js";
import {
  revealRelayRoute,
  resolveRelayRevealRoute,
} from "../../../vex-agent/tools/registry/relay-reveal.js";

// The gate test imports the full runtime module graph — first-import cost far
// exceeds the 10s default.
vi.setConfig({ testTimeout: 120_000 });

const relayQuoteHandler = vi.fn().mockResolvedValue({ success: true, output: "quoted" });
const mockGetProtocolManifest = vi.fn();
const mockGetProtocolHandler = vi.fn();
vi.mock("@vex-agent/tools/protocols/catalog.js", async (importActual) => {
  const actual = await importActual<typeof import("@vex-agent/tools/protocols/catalog.js")>();
  return {
    ...actual,
    getProtocolManifest: (...a: Parameters<typeof actual.getProtocolManifest>) => mockGetProtocolManifest(...a),
    getProtocolHandler: (...a: Parameters<typeof actual.getProtocolHandler>) => mockGetProtocolHandler(...a),
  };
});

const FAKE_RELAY_QUOTE_MANIFEST = {
  toolId: "relay.quote.get",
  namespace: "relay" as const,
  lifecycle: "active" as const,
  description: "fake relay quote manifest for the reveal-gate test",
  mutating: false,
  actionKind: "read" as const,
  params: [
    { key: "fromChain", type: "string" as const, required: true, description: "" },
    { key: "fromToken", type: "string" as const, required: true, description: "" },
    { key: "toChain", type: "string" as const, required: true, description: "" },
    { key: "toToken", type: "string" as const, required: true, description: "" },
    { key: "amount", type: "string" as const, required: true, description: "" },
  ],
  exampleParams: {},
};

const BASE_OP = { fromChain: "8453", fromToken: "native", toChain: "10", toToken: "native", amount: "1000000000000000" };
const BASE_ARB = { fromChain: "8453", fromToken: "native", toChain: "42161", toToken: "native", amount: "1000000000000000" };
const BASE_ROBINHOOD = { fromChain: "8453", fromToken: "native", toChain: "robinhood", toToken: "native", amount: "1000000000000000" };

function ctx(sessionId: string): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    sessionId,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
  };
}

function revealRoute(sessionId: string, params: Record<string, unknown>): void {
  const route = resolveRelayRevealRoute(params);
  if (!route) throw new Error("gate test route did not resolve");
  revealRelayRoute(sessionId, route);
}

describe("executeProtocolTool route-bound Relay reveal gate (relay.quote.get)", () => {
  it("rejects a non-local UNREVEALED route BEFORE the handler runs", async () => {
    mockGetProtocolManifest.mockReturnValue(FAKE_RELAY_QUOTE_MANIFEST);
    mockGetProtocolHandler.mockReturnValue(relayQuoteHandler);
    relayQuoteHandler.mockClear();

    const { executeProtocolTool } = await import("../../../vex-agent/tools/protocols/runtime.js");
    const result = await executeProtocolTool({ toolId: "relay.quote.get", params: BASE_OP }, ctx("relay-gate-unrevealed"));

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/not available for this route/i);
    expect(relayQuoteHandler).not.toHaveBeenCalled();
  });

  it("allows the SAME route once it is revealed (reaches the handler)", async () => {
    mockGetProtocolManifest.mockReturnValue(FAKE_RELAY_QUOTE_MANIFEST);
    mockGetProtocolHandler.mockReturnValue(relayQuoteHandler);
    relayQuoteHandler.mockClear();

    const sessionId = "relay-gate-revealed";
    revealRoute(sessionId, BASE_OP);

    const { executeProtocolTool } = await import("../../../vex-agent/tools/protocols/runtime.js");
    const result = await executeProtocolTool({ toolId: "relay.quote.get", params: BASE_OP }, ctx(sessionId));

    expect(relayQuoteHandler).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it("keeps a DIFFERENT route blocked even when another route is revealed (route-boundness)", async () => {
    mockGetProtocolManifest.mockReturnValue(FAKE_RELAY_QUOTE_MANIFEST);
    mockGetProtocolHandler.mockReturnValue(relayQuoteHandler);
    relayQuoteHandler.mockClear();

    const sessionId = "relay-gate-different-route";
    revealRoute(sessionId, BASE_OP); // reveal base→optimism only

    const { executeProtocolTool } = await import("../../../vex-agent/tools/protocols/runtime.js");
    const result = await executeProtocolTool({ toolId: "relay.quote.get", params: BASE_ARB }, ctx(sessionId));

    expect(result.success).toBe(false);
    expect(relayQuoteHandler).not.toHaveBeenCalled();
  });

  it("ALWAYS allows a local-chain (Robinhood) route with no reveal (static carve-out)", async () => {
    mockGetProtocolManifest.mockReturnValue(FAKE_RELAY_QUOTE_MANIFEST);
    mockGetProtocolHandler.mockReturnValue(relayQuoteHandler);
    relayQuoteHandler.mockClear();

    const { executeProtocolTool } = await import("../../../vex-agent/tools/protocols/runtime.js");
    const result = await executeProtocolTool({ toolId: "relay.quote.get", params: BASE_ROBINHOOD }, ctx("relay-gate-local"));

    expect(relayQuoteHandler).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});
