/**
 * W1: the codes that must stop being swallowed (SPEC §1.5 audit list) plus the
 * missing-required rejection text.
 *
 * Each of these three catches used to discard the only evidence that said WHY —
 * on a chain-registry outage, on an already-broadcast transaction, and on a
 * send/confirm ambiguity. The agent was handed a permanent-sounding verdict for
 * a transient failure and retried (or gave up) blind.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { resolveInclusiveEvmChain } from "@tools/evm-chains/resolver.js";
import { waitForSuccessfulReceipt, type ReceiptWaitClient } from "@tools/evm-chains/receipt-guard.js";
import * as khalaniChains from "@tools/khalani/chains.js";
import { describeFailureForAgent } from "@vex-agent/tools/protocols/runtime/errors.js";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";
import type { VexError } from "../../../../errors.js";

vi.mock("@tools/khalani/chains.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/khalani/chains.js")>()),
  getCachedKhalaniChains: vi.fn(),
  resolveChainId: vi.fn(),
}));

const MANIFEST: ProtocolToolManifest = {
  toolId: "dexscreener.search",
  publicName: "dexscreener__search",
  namespace: "dexscreener",
  lifecycle: "active",
  description: "search",
  mutating: false,
  actionKind: "read",
  params: [
    { key: "query", type: "string", required: true, description: "search text" },
    { key: "limit", type: "number", description: "max rows" },
  ],
  exampleParams: { query: "PEPE", limit: 5 },
};

describe("missing-required rejection text", () => {
  it("names the key, the required/optional sets, a working example and what we received", () => {
    const result = validateProtocolParams(MANIFEST, { limit: 5 });
    expect(result.ok).toBe(false);
    const reason = result.ok ? "" : result.reason;
    expect(reason).toContain('Missing required parameter "query" (string) for dexscreener.search');
    expect(reason).toContain("Required: query.");
    expect(reason).toContain("Optional: limit.");
    expect(reason).toContain('Send: {"toolId":"dexscreener.search","params":{"query":"PEPE"}}');
    expect(reason).toContain("You sent params keys: [limit]");
    expect(reason).toContain("Do not repeat the previous call");
  });

  it("never echoes a param VALUE the model supplied", () => {
    const result = validateProtocolParams(MANIFEST, { query: "", limit: 5 });
    expect(result.ok).toBe(false);
    // `limit`'s value (5) may appear only via the authored example, never via
    // the "you sent" lane; assert the lane itself carries keys only.
    const reason = result.ok ? "" : result.reason;
    expect(reason).toContain("You sent params keys: [query, limit]");
  });
});

describe("resolveInclusiveEvmChain — registry outage is not an unknown chain", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("attaches the cause and marks the failure retryable when the registry is unreachable", async () => {
    vi.mocked(khalaniChains.getCachedKhalaniChains).mockRejectedValue(
      new Error("khalani registry: ECONNREFUSED"),
    );

    const err = await resolveInclusiveEvmChain("hyperliquid").catch((e: unknown) => e);
    const vexErr = err as VexError;
    expect(vexErr.name).toBe("VexError");
    expect(vexErr.retryable).toBe(true);
    expect((vexErr.cause as Error).message).toContain("ECONNREFUSED");
    // The real cause reaches the agent, sanitized.
    expect(describeFailureForAgent(vexErr)).toContain("ECONNREFUSED");
  });

  it("still reports a genuinely unknown chain as unsupported when the registry answered", async () => {
    vi.mocked(khalaniChains.getCachedKhalaniChains).mockResolvedValue([]);
    vi.mocked(khalaniChains.resolveChainId).mockImplementation(() => {
      throw new Error("no such chain");
    });

    const err = await resolveInclusiveEvmChain("notachain").catch((e: unknown) => e);
    expect((err as VexError).message).toContain("Unsupported chain: notachain");
    expect((err as VexError).retryable).toBeUndefined();
  });
});

describe("waitForSuccessfulReceipt — the confirmation-unknown cause survives", () => {
  it("keeps the RPC's own words on an already-broadcast transaction", async () => {
    const client: ReceiptWaitClient = {
      waitForTransactionReceipt: vi.fn().mockRejectedValue(new Error("rpc: 429 slow down")),
    };

    const err = await waitForSuccessfulReceipt(
      client,
      "0xabc",
      { code: "SWAP_FAILED", what: "Swap" },
      { delayMs: 0 },
    ).catch((e: unknown) => e);

    expect((err as VexError).name).toBe("VexError");
    expect((err as VexError).code).toBe("CONFIRMATION_UNKNOWN");
    expect(String(((err as VexError).cause as Error).message)).toContain("429");
    expect(describeFailureForAgent(err)).toContain("429");
  });
});
