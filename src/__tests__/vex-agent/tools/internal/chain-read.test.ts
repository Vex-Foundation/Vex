/**
 * chain_read internal tool tests — action dispatch, input validation, mock reads.
 *
 * Scope is on-chain forensics only: tx_receipt + erc721_mint. Native balances
 * are owned by wallet_balances; token metadata by token_find.
 */

import { describe, it, expect, vi } from "vitest";
import { HttpRequestError, TransactionReceiptNotFoundError } from "viem";
import { VexError, ErrorCodes } from "../../../../errors.js";
import { makeTestContext } from "../_test-context.js";

// Mock khalani chain resolution
const MOCK_CHAIN = {
  id: 137, name: "Polygon", type: "eip155" as const,
  nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
  rpcUrls: { default: { http: ["https://polygon-rpc.example.com"] } },
};

// Only the Khalani registry seam is mocked: the INCLUSIVE resolver and the local
// EVM registry run for real, so the local-chain branch below is genuine evidence
// that Robinhood Chain (4663) resolves without any Khalani coverage.
vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: vi.fn().mockResolvedValue([MOCK_CHAIN]),
  resolveChainId: vi.fn().mockImplementation((input: string) => {
    if (input === "137" || input === "polygon") return 137;
    throw new VexError(ErrorCodes.KHALANI_UNSUPPORTED_CHAIN, `Chain "${input}" is not supported.`);
  }),
}));

const mockGetTransactionReceipt = vi.fn();

vi.mock("@tools/khalani/evm-client.js", () => ({
  createDynamicPublicClient: () => ({
    getTransactionReceipt: mockGetTransactionReceipt,
  }),
}));

vi.mock("@tools/evm-chains/evm-client.js", () => ({
  getLocalPublicClient: () => ({
    getTransactionReceipt: mockGetTransactionReceipt,
  }),
}));

vi.mock("@tools/kyberswap/evm-utils.js", () => ({
  extractMintedNftId: vi.fn().mockReturnValue("2879807"),
}));

const { handleChainRead } = await import("../../../../vex-agent/tools/internal/chain-read.js");

const ctx = makeTestContext({ sessionId: "test" });

describe("chain_read", () => {
  it("rejects missing action", async () => {
    const result = await handleChainRead({ chainId: "137" }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required: action");
  });

  it("rejects missing chainId", async () => {
    const result = await handleChainRead({ action: "tx_receipt" }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required: chainId");
  });

  it("rejects unknown action", async () => {
    const result = await handleChainRead({ action: "hack_contract", chainId: "137" }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown action");
  });
});

describe("chain_read — tx_receipt", () => {
  it("returns receipt data", async () => {
    mockGetTransactionReceipt.mockResolvedValue({
      status: "success", blockNumber: 12345678n, gasUsed: 150000n,
      logs: [{ address: "0x1", topics: [], data: "0x" }],
      from: "0xabc", to: "0xdef", contractAddress: null,
    });
    const result = await handleChainRead({ action: "tx_receipt", chainId: "137", txHash: "0xabc123" }, ctx);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.status).toBe("success");
    expect(data.gasUsed).toBe("150000");
    expect(data.logsCount).toBe(1);
  });

  it("rejects missing txHash", async () => {
    const result = await handleChainRead({ action: "tx_receipt", chainId: "137" }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required: txHash");
  });

  // Robinhood Chain (4663) is not in the Khalani registry — it lives only in the
  // local EVM registry. Forensics must still read it, by alias and by numeric id.
  it.each(["robinhood", "4663"])(
    "reads a receipt on a local-registry chain (%s)",
    async (chainId) => {
      mockGetTransactionReceipt.mockResolvedValue({
        status: "success", blockNumber: 42n, gasUsed: 21000n,
        logs: [], from: "0xabc", to: "0xdef", contractAddress: null,
      });
      const result = await handleChainRead(
        { action: "tx_receipt", chainId, txHash: "0xabc123" }, ctx,
      );
      expect(result.success).toBe(true);
      const data = JSON.parse(result.output);
      expect(data.chainId).toBe(4663);
      expect(data.chain).toBe("Robinhood Chain");
      expect(data.status).toBe("success");
    },
  );
});

describe("chain_read — erc721_mint", () => {
  it("extracts minted NFTs from receipt", async () => {
    const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";
    const WALLET = "0x00000000000000000000000018b467cb28fc07ca6e17a964b3319051b3072b79";

    mockGetTransactionReceipt.mockResolvedValue({
      status: "success", blockNumber: 100n, gasUsed: 500000n,
      logs: [
        { address: "0xc36442b4a4522e871399cd717abdd847ab11fe88", topics: [TRANSFER, ZERO, WALLET, "0x00000000000000000000000000000000000000000000000000000000002bf43f"], data: "0x" },
      ],
      from: "0x18b467Cb28FC07Ca6E17A964b3319051B3072B79", to: "0xrouter", contractAddress: null,
    });

    const result = await handleChainRead({ action: "erc721_mint", chainId: "137", txHash: "0xabc", address: "0x18b467Cb28FC07Ca6E17A964b3319051B3072B79" }, ctx);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.mintsFound).toBe(1);
    expect(data.mints[0].tokenId).toBe("2880575");
    expect(data.mints[0].contract).toBe("0xc36442b4a4522e871399cd717abdd847ab11fe88");
  });

  it("rejects missing txHash", async () => {
    const result = await handleChainRead({ action: "erc721_mint", chainId: "137" }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required: txHash");
  });
});

// ── Error-redaction guards (P1-6 / B-003) ────────────────────────────────────
//
// Raw viem/RPC text can embed RPC URLs (often carrying api keys), request /
// response bodies, and auth — none of which may reach the model output. These
// tests prove every throwing seam (chain resolution + both getTransactionReceipt
// calls) is reduced to the redacted, bounded summary owned by
// summarizeProtocolError, and that the original secret/URL never survives.

// The mocked khalani/chains module is reused here so we can make resolveChainId
// throw a real VexError (KHALANI_UNSUPPORTED_CHAIN) for one test, then restore.
const khalaniChains = await import("@tools/khalani/chains.js");

describe("chain_read — error redaction", () => {
  it("redacts an unsupported-chain VexError from chain resolution", async () => {
    // resolveChainId throws the same VexError shape khalani uses for an unknown
    // chain. The hint is folded through the SAME redaction pipeline as the
    // message, so it is safe to surface; what must NOT leak is provider internals.
    const err = new VexError(
      ErrorCodes.KHALANI_UNSUPPORTED_CHAIN,
      'Chain "not-a-real-chain" is not supported.',
      "Check the supported chain list first.",
    );
    vi.mocked(khalaniChains.resolveChainId).mockImplementationOnce(() => {
      throw err;
    });
    // Clear accumulated calls from the happy-path tests above so the
    // "never reached the receipt seam" assertion below reflects THIS call only.
    mockGetTransactionReceipt.mockClear();

    const result = await handleChainRead(
      { action: "tx_receipt", chainId: "not-a-real-chain", txHash: "0xabc123" },
      ctx,
    );

    expect(result.success).toBe(false);
    // Redacted summary is non-empty and bounded (length cap is 200 + ellipsis).
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.output.length).toBeLessThanOrEqual(201);
    // The on-chain receipt path must never run when resolution failed.
    expect(mockGetTransactionReceipt).not.toHaveBeenCalled();
    // resolveChainId restored to its default (returns 137) for later tests.
    expect(vi.mocked(khalaniChains.resolveChainId)("137", [])).toBe(137);
  });

  it("redacts a viem TransactionReceiptNotFoundError from tx_receipt", async () => {
    mockGetTransactionReceipt.mockRejectedValueOnce(
      new TransactionReceiptNotFoundError({ hash: "0xdeadbeef" }),
    );

    const result = await handleChainRead(
      { action: "tx_receipt", chainId: "137", txHash: "0xdeadbeef" },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.output.length).toBeLessThanOrEqual(201);
    // No raw JSON receipt object leaked through the catch.
    expect(() => JSON.parse(result.output)).toThrow();
  });

  it("strips RPC url + body from a viem HttpRequestError (no secret leak)", async () => {
    // This error embeds a fake RPC endpoint carrying a key and a request body —
    // precisely the provider internals B-003 forbids surfacing.
    const SECRET_HOST = "secret-rpc.example.com";
    const SECRET_KEY = "KEY123abcSECRET";
    mockGetTransactionReceipt.mockRejectedValueOnce(
      new HttpRequestError({
        url: `https://${SECRET_HOST}/${SECRET_KEY}`,
        body: { method: "eth_getTransactionReceipt", params: ["0xabc"] },
        status: 429,
        details: "rate limited",
      }),
    );

    const result = await handleChainRead(
      { action: "erc721_mint", chainId: "137", txHash: "0xabc" },
      ctx,
    );

    expect(result.success).toBe(false);
    // The raw RPC URL, host, and key must NOT survive redaction.
    expect(result.output).not.toContain(SECRET_HOST);
    expect(result.output).not.toContain(SECRET_KEY);
    expect(result.output).not.toContain("https://");
    // Bounded, non-empty summary.
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.output.length).toBeLessThanOrEqual(201);
  });
});
