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
 * Only the chain SOURCE widens. A genuine RPC failure is still an OBSERVATION
 * that concludes nothing (`rpc_error`) — the row stays pending.
 *
 * The lookup now goes through each client's EIP-1193 `request` rather than
 * viem's `getTransactionReceipt` action, because only `request` accepts the
 * whole-observation `AbortSignal` the claim lease depends on. What is asserted
 * here is unchanged in substance: which chain source answers, and that only a
 * literal `0x0` is ever reported as a revert.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetChains = vi.fn();
const mockGetChain = vi.fn();
const mockCreateDynamicPublicClient = vi.fn();
const mockGetLocalChain = vi.fn();
const mockGetLocalPublicClient = vi.fn();
const mockGetPendlePublicClient = vi.fn();
const mockRequest = vi.fn();

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

/** The row shape an observation needs — the persisted sender/nonce included. */
function input(chainId: number, txHash: string = TX) {
  return { chainId, txHash, fromAddress: "0x1111111111111111111111111111111111111111", nonce: 7 };
}

/** A client that answers only the receipt call, as a raw JSON-RPC result. */
function receiptOnly(status: unknown) {
  return vi.fn().mockImplementation(async (args: { method: string }) =>
    args.method === "eth_getTransactionReceipt" ? { status } : null);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetChains.mockResolvedValue([]);
  mockGetChain.mockImplementation(() => {
    throw new Error("Chain not supported by Khalani");
  });
  mockGetLocalChain.mockReturnValue(undefined);
  mockGetPendlePublicClient.mockReturnValue({ request: mockRequest });
  mockRequest.mockResolvedValue(null);
});

describe("buildProductionRepairDeps chain-source fallback", () => {
  it("resolves a Monad receipt through the Pendle registry when Khalani lacks the chain", async () => {
    mockGetPendlePublicClient.mockReturnValue({ request: receiptOnly("0x1") });

    const result = await buildProductionRepairDeps().observeTransaction(input(MONAD_CHAIN_ID));

    expect(mockGetPendlePublicClient).toHaveBeenCalledWith(MONAD_CHAIN_ID);
    // Status only — the raw receipt is deliberately NOT carried any more.
    expect(result).toEqual({ kind: "mined", status: "success" });
  });

  it("resolves a Robinhood (4663) receipt through the LOCAL evm-chains registry — the stuck-row case", async () => {
    const robinhood = { id: ROBINHOOD_CHAIN_ID, name: "Robinhood Chain" };
    mockGetLocalChain.mockReturnValue(robinhood);
    mockGetLocalPublicClient.mockReturnValue({ request: receiptOnly("0x1") });

    const result = await buildProductionRepairDeps().observeTransaction(input(ROBINHOOD_CHAIN_ID));

    expect(mockGetLocalPublicClient).toHaveBeenCalledWith(robinhood);
    expect(mockGetPendlePublicClient).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "mined", status: "success" });
  });

  it("memoizes the resolved client per chain for the lifetime of ONE sweep run", async () => {
    const request = receiptOnly("0x1");
    mockGetPendlePublicClient.mockReturnValue({ request });
    const deps = buildProductionRepairDeps();

    await deps.observeTransaction(input(MONAD_CHAIN_ID));
    await deps.observeTransaction(input(MONAD_CHAIN_ID, "0xdef"));

    // Chain discovery happens once per distinct chain per run, not per row.
    expect(mockGetChains).toHaveBeenCalledTimes(1);
    expect(mockGetPendlePublicClient).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);

    // A NEW run re-resolves, so a chain-list change is picked up next tick.
    await buildProductionRepairDeps().observeTransaction(input(MONAD_CHAIN_ID));
    expect(mockGetChains).toHaveBeenCalledTimes(2);
  });

  it("reports a mined revert through the fallback source too", async () => {
    mockGetPendlePublicClient.mockReturnValue({ request: receiptOnly("0x0") });

    await expect(
      buildProductionRepairDeps().observeTransaction(input(MONAD_CHAIN_ID)),
    ).resolves.toEqual({ kind: "mined", status: "reverted" });
  });

  // A receipt whose status we cannot READ must never be reported as a revert:
  // `definitively_failed` is irreversible, and viem's own receipt formatter
  // yields `null` for a status value it does not recognize. Only the literal
  // "reverted" is proof of a revert; everything else is ambiguity.
  it.each([
    ["an unrecognized status string", "0x2"],
    ["a null status", null],
    ["an absent status", undefined],
  ])("treats %s as an UNREADABLE receipt, never as a revert", async (_label, status) => {
    mockGetPendlePublicClient.mockReturnValue({ request: receiptOnly(status) });

    await expect(
      buildProductionRepairDeps().observeTransaction(input(MONAD_CHAIN_ID)),
    ).resolves.toEqual({ kind: "unreadable_receipt" });
  });

  it("keeps the existing error posture: an RPC failure concludes NOTHING", async () => {
    mockRequest.mockRejectedValue(new Error("transport timeout"));

    const observation = await buildProductionRepairDeps().observeTransaction(input(MONAD_CHAIN_ID));

    expect(observation.kind).toBe("rpc_error");
  });

  it("says so by name when no chain source knows the chain — never a silent 'nothing there'", async () => {
    mockGetPendlePublicClient.mockReturnValue(undefined);

    const observation = await buildProductionRepairDeps().observeTransaction(input(999_999));

    // NOT `unknown_to_node`: we never looked. Reporting non-inclusion here would
    // start the A6 clock on a row nobody ever asked a node about.
    expect(observation.kind).toBe("rpc_error");
  });

  it("still prefers the Khalani client when that registry does carry the chain", async () => {
    mockGetChain.mockReturnValue({ chainId: 8453 });
    mockCreateDynamicPublicClient.mockReturnValue({ request: receiptOnly("0x1") });

    const result = await buildProductionRepairDeps().observeTransaction(input(8453));

    expect(result).toEqual({ kind: "mined", status: "success" });
    expect(mockGetLocalPublicClient).not.toHaveBeenCalled();
    expect(mockGetPendlePublicClient).not.toHaveBeenCalled();
  });
});
