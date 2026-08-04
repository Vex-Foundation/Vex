/**
 * agent-activity-repair — provider exception scrubbing (FIX5-SPINE, Codex
 * final-review round 4 finding 2).
 *
 * The receipt lookup's error text used to be logged as a bare
 * `redact(err.message)`, which strips only KNOWN SECRET SHAPES
 * (keys/JWTs/mnemonics/addresses) and not the structured provider internals —
 * URLs, request/response bodies, auth headers — that `summarizeProtocolError`
 * exists to remove.
 *
 * THE BOUNDARY MOVED, THE CANARY DID NOT. The lookup is now an OBSERVATION
 * (`observation.ts`), so the scrub happens where the throw is caught, and the
 * `rpc_error` reason that flows onward is already sanitized: it reaches a log
 * line, and a reason string is the kind of value that ends up in front of the
 * agent. So the assertion is made on the observation's own reason, one step
 * closer to the throw than the old log-line assertion was.
 *
 * This is a mocked-dependency unit test (no DB, no signer). The DB-level
 * behaviour is covered by `src/__tests__/integration/agent-scan/`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetChains = vi.fn();
const mockGetChain = vi.fn();
const mockGetLocalChain = vi.fn();
const mockGetLocalPublicClient = vi.fn();

vi.mock("@tools/khalani/client.js", () => ({ getKhalaniClient: () => ({ getChains: mockGetChains }) }));
vi.mock("@tools/khalani/chains.js", () => ({ getChain: (...a: unknown[]) => mockGetChain(...a) }));
vi.mock("@tools/khalani/evm-client.js", () => ({ createDynamicPublicClient: vi.fn() }));
vi.mock("@tools/evm-chains/registry.js", () => ({
  getLocalChain: (...a: unknown[]) => mockGetLocalChain(...a),
}));
vi.mock("@tools/evm-chains/evm-client.js", () => ({
  getLocalPublicClient: (...a: unknown[]) => mockGetLocalPublicClient(...a),
}));

const { buildProductionRepairDeps } = await import("@vex-agent/sync/agent-activity-repair.js");

// Canary text carrying every shape summarizeProtocolError must strip: a
// credential-bearing URL, an Authorization/Bearer header, and a JSON body.
const CANARY_MESSAGE =
  'Provider 500 https://user:p4ssw0rd@api.provider.io/v1?key=SECRET123 '
  + 'Authorization: Bearer ROUND_CANARY_9f2a body={"error":{"code":401}}';
const CANARY_FRAGMENTS = [
  "p4ssw0rd", "SECRET123", "api.provider.io", "https://",
  "ROUND_CANARY_9f2a", "Bearer", '"error"', '"code"',
];

const ROBINHOOD_CHAIN_ID = 4663;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetChains.mockResolvedValue([]);
  mockGetChain.mockImplementation(() => {
    throw new Error("Chain not supported by Khalani");
  });
  mockGetLocalChain.mockReturnValue({ id: ROBINHOOD_CHAIN_ID, name: "Robinhood Chain" });
});

describe("agent-activity-repair — provider error scrubbing (FIX5-SPINE)", () => {
  it("a thrown RPC error becomes a SCRUBBED rpc_error observation, never raw provider text", async () => {
    mockGetLocalPublicClient.mockReturnValue({
      request: vi.fn().mockRejectedValue(new Error(CANARY_MESSAGE)),
    });

    const observation = await buildProductionRepairDeps().observeTransaction({
      chainId: ROBINHOOD_CHAIN_ID,
      txHash: "0xHASH",
      fromAddress: "0xFROM",
      nonce: 1,
    });

    expect(observation.kind).toBe("rpc_error");
    const reason = observation.kind === "rpc_error" ? observation.reason : "";
    expect(typeof reason).toBe("string");
    for (const fragment of CANARY_FRAGMENTS) {
      expect(reason).not.toContain(fragment);
    }
  });

  it("an unresolvable chain says so by name, and its message carries no provider text either", async () => {
    mockGetLocalChain.mockReturnValue(undefined);

    const observation = await buildProductionRepairDeps().observeTransaction({
      chainId: 999_999,
      txHash: "0xHASH",
      fromAddress: "0xFROM",
      nonce: 1,
    });

    expect(observation).toEqual({
      kind: "rpc_error",
      reason: "no read-only RPC is configured for chain 999999",
    });
  });
});
