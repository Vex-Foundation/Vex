/**
 * The repair sweep's production receipt lookup must resolve an RPC for EVERY
 * chain Vex can execute on, not only the ones the Khalani registry carries.
 * Three chain SOURCES, tried in order: Khalani's live list → the LOCAL
 * `evm-chains` registry → the Pendle registry.
 *
 * Robinhood Chain (4663) lives ONLY in the local registry, so a pending
 * Robinhood row could not even obtain a client before — the resolver threw and
 * the bare catch reported "no answer yet" forever. Monad (143) is the same
 * class of hole one source further down: absent from Khalani, present in
 * Pendle's registry.
 *
 * Only the chain SOURCE widens. A genuine RPC failure must still come back
 * `null` (row stays pending).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetChains = vi.fn();
const mockGetChain = vi.fn();
const mockCreateDynamicPublicClient = vi.fn();
const mockGetLocalChain = vi.fn();
const mockGetLocalPublicClient = vi.fn();
const mockGetPendlePublicClient = vi.fn();
const mockGetTransactionReceipt = vi.fn();

vi.mock("@tools/khalani/client.js", () => ({ getKhalaniClient: () => ({ getChains: mockGetChains }) }));
vi.mock("@tools/khalani/chains.js", () => ({ getChain: (...a: unknown[]) => mockGetChain(...a) }));
vi.mock("@tools/khalani/evm-client.js", () => ({
  createDynamicPublicClient: (...a: unknown[]) => mockCreateDynamicPublicClient(...a),
}));
vi.mock("@tools/evm-chains/registry.js", () => ({
  getLocalChain: (...a: unknown[]) => mockGetLocalChain(...a),
}));
vi.mock("@tools/evm-chains/evm-client.js", () => ({
  getLocalPublicClient: (...a: unknown[]) => mockGetLocalPublicClient(...a),
}));
vi.mock("@tools/pendle/evm-client.js", () => ({
  getPendlePublicClient: (...a: unknown[]) => mockGetPendlePublicClient(...a),
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
    throw new Error("Chain not supported by Khalani");
  });
  mockGetLocalChain.mockReturnValue(undefined);
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
    // Status only — the raw receipt is deliberately NOT carried any more.
    expect(result).toEqual({ status: "success" });
  });

  it("resolves a Robinhood (4663) receipt through the LOCAL evm-chains registry — the stuck-row case", async () => {
    const robinhood = { id: ROBINHOOD_CHAIN_ID, name: "Robinhood Chain" };
    mockGetLocalChain.mockReturnValue(robinhood);
    mockGetLocalPublicClient.mockReturnValue({
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", logs: [] }),
    });

    const result = await buildProductionRepairDeps().checkReceiptByHash({
      chainId: ROBINHOOD_CHAIN_ID,
      txHash: TX,
    });

    expect(mockGetLocalPublicClient).toHaveBeenCalledWith(robinhood);
    expect(mockGetPendlePublicClient).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "success" });
  });

  it("memoizes the resolved client per chain for the lifetime of ONE sweep run", async () => {
    mockGetTransactionReceipt.mockResolvedValue({ status: "success", logs: [] });
    const deps = buildProductionRepairDeps();

    await deps.checkReceiptByHash({ chainId: MONAD_CHAIN_ID, txHash: TX });
    await deps.checkReceiptByHash({ chainId: MONAD_CHAIN_ID, txHash: "0xdef" });

    // Chain discovery happens once per distinct chain per run, not per row.
    expect(mockGetChains).toHaveBeenCalledTimes(1);
    expect(mockGetPendlePublicClient).toHaveBeenCalledTimes(1);
    expect(mockGetTransactionReceipt).toHaveBeenCalledTimes(2);

    // A NEW run re-resolves, so a chain-list change is picked up next tick.
    await buildProductionRepairDeps().checkReceiptByHash({ chainId: MONAD_CHAIN_ID, txHash: TX });
    expect(mockGetChains).toHaveBeenCalledTimes(2);
  });

  it("reports a mined revert through the fallback source too", async () => {
    mockGetTransactionReceipt.mockResolvedValue({ status: "reverted" });

    await expect(
      buildProductionRepairDeps().checkReceiptByHash({ chainId: MONAD_CHAIN_ID, txHash: TX }),
    ).resolves.toEqual({ status: "reverted" });
  });

  // A receipt whose status we cannot READ must never be reported as a revert:
  // `definitively_failed` is irreversible, and viem's own receipt formatter
  // yields `null` for a status value it does not recognize. Only the literal
  // "reverted" is proof of a revert; everything else is ambiguity.
  it.each([
    ["an unrecognized status string", { status: "0x1" }],
    ["a null status", { status: null }],
    ["an absent status", {}],
  ])("treats %s as 'no answer yet', never as a revert", async (_label, receipt) => {
    mockGetTransactionReceipt.mockResolvedValue(receipt);

    await expect(
      buildProductionRepairDeps().checkReceiptByHash({ chainId: MONAD_CHAIN_ID, txHash: TX }),
    ).resolves.toBeNull();
  });

  it("still reports the literal 'reverted' status as a revert", async () => {
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

  it("returns null when no chain source knows the chain", async () => {
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

    expect(result).toEqual({ status: "success" });
    expect(mockGetLocalPublicClient).not.toHaveBeenCalled();
    expect(mockGetPendlePublicClient).not.toHaveBeenCalled();
  });
});
