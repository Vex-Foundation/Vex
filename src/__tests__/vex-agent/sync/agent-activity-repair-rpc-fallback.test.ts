/**
 * The repair sweep's production receipt lookup must resolve an RPC for EVERY
 * chain Vex can execute on, not only the ones the Khalani registry carries.
 *
 * Pendle executes on 11 chains; Monad (143) is not in Khalani's chain list, so
 * `getChain` threw and the bare catch reported "no answer yet" — a pending
 * Pendle row on that chain could never be repaired, forever. The Khalani
 * source still answers first; only the chain SOURCE widens. Robinhood Chain
 * (4663) is the same defect one registry further out: it exists only in the
 * local EVM registry. A genuine RPC failure must still come back `null` (row
 * stays pending).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetChains = vi.fn();
const mockGetChain = vi.fn();
const mockCreateDynamicPublicClient = vi.fn();
const mockGetPendlePublicClient = vi.fn();
const mockGetTransactionReceipt = vi.fn();
const mockGetLocalTransactionReceipt = vi.fn();

vi.mock("@tools/khalani/client.js", () => ({ getKhalaniClient: () => ({ getChains: mockGetChains }) }));
vi.mock("@tools/khalani/chains.js", () => ({ getChain: (...a: unknown[]) => mockGetChain(...a) }));
vi.mock("@tools/khalani/evm-client.js", () => ({
  createDynamicPublicClient: (...a: unknown[]) => mockCreateDynamicPublicClient(...a),
}));
vi.mock("@tools/pendle/evm-client.js", () => ({
  getPendlePublicClient: (...a: unknown[]) => mockGetPendlePublicClient(...a),
}));
// The local EVM registry itself stays REAL, so 4663 resolving (and 999999 not)
// is genuine evidence; only the viem client factory is stubbed.
vi.mock("@tools/evm-chains/evm-client.js", () => ({
  getLocalPublicClient: () => ({ getTransactionReceipt: mockGetLocalTransactionReceipt }),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { buildProductionRepairDeps } = await import("@vex-agent/sync/agent-activity-repair.js");

const MONAD_CHAIN_ID = 143;
const ROBINHOOD_CHAIN_ID = 4663;
const TX = "0xabc";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetChains.mockResolvedValue([]);
  mockGetChain.mockImplementation(() => {
    throw new Error("Chain 143 not supported by Khalani");
  });
  mockGetPendlePublicClient.mockReturnValue({ getTransactionReceipt: mockGetTransactionReceipt });
});

describe("buildProductionRepairDeps chain-source fallback", () => {
  it("resolves a Monad receipt through the Pendle registry when Khalani lacks the chain", async () => {
    mockGetTransactionReceipt.mockResolvedValue({ status: "success", logs: [] });

    const result = await buildProductionRepairDeps().checkReceiptByHash({
      chainId: MONAD_CHAIN_ID,
      txHash: TX,
    });

    expect(mockGetPendlePublicClient).toHaveBeenCalledWith(MONAD_CHAIN_ID);
    expect(result).toEqual({ status: "success", receipt: { status: "success", logs: [] } });
  });

  it("reports a mined revert through the fallback source too", async () => {
    mockGetTransactionReceipt.mockResolvedValue({ status: "reverted" });

    await expect(
      buildProductionRepairDeps().checkReceiptByHash({ chainId: MONAD_CHAIN_ID, txHash: TX }),
    ).resolves.toEqual({ status: "reverted" });
  });

  it("keeps the existing error posture: an RPC failure is still 'no answer yet'", async () => {
    mockGetTransactionReceipt.mockRejectedValue(new Error("transport timeout"));

    await expect(
      buildProductionRepairDeps().checkReceiptByHash({ chainId: MONAD_CHAIN_ID, txHash: TX }),
    ).resolves.toBeNull();
  });

  it("resolves a Robinhood (4663) receipt through the local EVM registry", async () => {
    // Neither Khalani nor Pendle carries 4663, but Vex executes there — the
    // local registry is the last chain source before "no answer yet".
    mockGetLocalTransactionReceipt.mockResolvedValue({ status: "success", logs: [] });

    const result = await buildProductionRepairDeps().checkReceiptByHash({
      chainId: ROBINHOOD_CHAIN_ID,
      txHash: TX,
    });

    expect(mockGetPendlePublicClient).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "success", receipt: { status: "success", logs: [] } });
  });

  it("returns null when no registry knows the chain", async () => {
    await expect(
      buildProductionRepairDeps().checkReceiptByHash({ chainId: 999_999, txHash: TX }),
    ).resolves.toBeNull();
    expect(mockGetPendlePublicClient).not.toHaveBeenCalled();
  });

  it("still prefers the Khalani client when that registry does carry the chain", async () => {
    mockGetChain.mockReturnValue({ chainId: 8453 });
    mockCreateDynamicPublicClient.mockReturnValue({
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", logs: [] }),
    });

    const result = await buildProductionRepairDeps().checkReceiptByHash({ chainId: 8453, txHash: TX });

    expect(result).toEqual({ status: "success", receipt: { status: "success", logs: [] } });
    expect(mockGetPendlePublicClient).not.toHaveBeenCalled();
  });
});
