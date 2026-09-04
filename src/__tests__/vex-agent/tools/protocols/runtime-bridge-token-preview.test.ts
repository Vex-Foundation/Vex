import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProtocolExecutionContext, ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";
import type { BridgeTokenIdentityPreview } from "@vex-agent/tools/protocols/bridge-token-identity-contract.js";

const mocks = vi.hoisted(() => ({
  handler: vi.fn(),
  resolvePreview: vi.fn(),
}));

vi.mock("@vex-agent/tools/protocols/catalog.js", () => ({
  getProtocolManifest: vi.fn(),
  getProtocolHandler: vi.fn(),
}));
vi.mock("@vex-agent/tools/protocols/capture-validator.js", () => ({
  isPreviewExecution: () => false,
}));
vi.mock("@vex-agent/tools/protocols/runtime/capture.js", () => ({
  captureExecution: vi.fn(),
}));
vi.mock("@vex-agent/tools/protocols/swap-prequote.js", () => ({
  EXECUTE_GATE_TOOLS: { "relay.bridge": { kind: "bridge", provider: "relay" } },
  PREQUOTE_QUOTE_TOOLS: {},
  evaluatePrequoteGate: async () => ({ kind: "allow", verdict: "unknown", prequoteId: "bridge-prequote" }),
  recordPrequoteFromQuote: vi.fn(),
}));
vi.mock("@vex-agent/tools/protocols/bridge-token-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/protocols/bridge-token-identity.js")>();
  return {
    ...actual,
    resolveBridgeTokenPreview: (...args: unknown[]) => mocks.resolvePreview(...args),
  };
});

const { executeProtocolTool } = await import("@vex-agent/tools/protocols/runtime.js");
const catalog = await import("@vex-agent/tools/protocols/catalog.js");

const SOURCE = "0x1111111111111111111111111111111111111111";
const DESTINATION = "0x2222222222222222222222222222222222222222";
const PREVIEW: BridgeTokenIdentityPreview = {
  source: {
    family: "eip155", kind: "erc20", chainId: 8453, tokenAddress: SOURCE,
    symbol: "USDC", decimals: 6, metadataSource: "rpc_contract", symbolSanitized: false,
  },
  destination: {
    family: "eip155", kind: "erc20", chainId: 4663, tokenAddress: DESTINATION,
    symbol: "VEX", decimals: 18, metadataSource: "rpc_contract", symbolSanitized: false,
  },
  amountRaw: "1500000",
  amountHuman: "1.5",
};
const PARAMS = {
  fromChain: "8453",
  fromToken: SOURCE,
  toChain: "4663",
  toToken: DESTINATION,
  amountRaw: "1500000",
};
const MANIFEST: ProtocolToolManifest = {
  toolId: "relay.bridge",
  publicName: "relay__bridge_execute",
  namespace: "relay",
  lifecycle: "active",
  description: "Execute a bridge.",
  mutating: true,
  actionKind: "user_wallet_broadcast",
  params: Object.keys(PARAMS).map((key) => ({ key, type: "string", required: true, description: key })),
  exampleParams: PARAMS,
};
const CONTEXT: ProtocolExecutionContext = {
  sessionPermission: "full",
  approved: true,
  sessionId: "session-1",
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.getProtocolManifest).mockReturnValue(MANIFEST);
  vi.mocked(catalog.getProtocolHandler).mockReturnValue(mocks.handler);
  mocks.resolvePreview.mockResolvedValue(PREVIEW);
  mocks.handler.mockImplementation(async (_params: unknown, context: ProtocolExecutionContext) => ({
    success: true,
    output: "handled",
    data: { bridgeTokenPreview: context.bridgeTokenPreview },
  }));
});

describe("protocol runtime bridge token preview handoff", () => {
  it("passes the exact gate-produced preview to the full-mode bridge handler", async () => {
    const result = await executeProtocolTool({ toolId: "relay.bridge", params: PARAMS }, CONTEXT);

    expect(result.success).toBe(true);
    expect(mocks.handler).toHaveBeenCalledTimes(1);
    expect(mocks.handler.mock.calls[0]?.[1]).toMatchObject({ bridgeTokenPreview: PREVIEW });
    expect(result.data?.bridgeTokenPreview).toBe(PREVIEW);
  });
});
