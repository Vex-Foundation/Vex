/**
 * Pendle exact-allowance discipline (Codex fund-safety fix): the Router's
 * allowance is SET to the exact required amount — a stale LARGER allowance is
 * reset to exact (never skipped), a smaller non-zero one is zeroed then set,
 * and only an already-exact allowance is a no-op.
 */

import { describe, it, expect, vi } from "vitest";
import { decodeFunctionData, getAddress, type Hex } from "viem";

import {
  ensurePendleAllowanceExact as ensurePendleAllowanceExactBase,
  type CreatePendleAllowanceStaging,
} from "@tools/pendle/erc20.js";
import { PENDLE_ERC20_ABI, PENDLE_ROUTER } from "@tools/pendle/constants.js";
import { ErrorCodes } from "../../../../../errors.js";

const TOKEN = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
const OWNER = getAddress("0x742d35cc6634c0532925a3b844bc454e4438f44e");

function makeClients(currentAllowance: bigint, gasEstimate = 46_312n) {
  let nodePendingNonce = 7;
  const signedRequests: Array<Record<string, unknown>> = [];
  const signTransaction = vi.fn(async (request: Record<string, unknown>) => {
    signedRequests.push(request);
    return "0xdeadbeef" as Hex;
  });
  const estimateGas = vi.fn().mockResolvedValue(gasEstimate);
  const publicClient = {
    readContract: vi.fn().mockResolvedValue(currentAllowance),
    estimateGas,
    sendRawTransaction: vi.fn(async () => {
      nodePendingNonce += 1;
      return `0x${"ab".repeat(32)}` as Hex;
    }),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
  };
  const walletClient = {
    account: { address: OWNER },
    chain: { id: 1 },
    prepareTransactionRequest: vi.fn(async (request: Record<string, unknown>) => ({
      ...request,
      nonce: nodePendingNonce,
    })),
    signTransaction,
  };
  return {
    publicClient,
    walletClient,
    writeContract: signTransaction,
    estimateContractGas: estimateGas,
    signedRequests,
  };
}

/** Extract [spender, amount] pairs of the approve calls, in order. */
function approveArgs(writeContract: ReturnType<typeof vi.fn>): Array<[string, bigint]> {
  return writeContract.mock.calls.map((c) => {
    const request = c[0];
    if (typeof request !== "object" || request === null || !("data" in request)) {
      throw new Error("signed approval request carried no calldata");
    }
    const decoded = decodeFunctionData({ abi: PENDLE_ERC20_ABI, data: String(request.data) as Hex });
    if (decoded.functionName !== "approve") throw new Error("signed request was not approve");
    return [decoded.args[0], decoded.args[1]];
  });
}

const createTestStaging: CreatePendleAllowanceStaging = () => ({
  hooks: {
    onNonceReserved: async (request) => request.nodePendingNonce,
    onHashStaged: async () => undefined,
    onAccepted: async () => undefined,
  },
  terminalize: async () => undefined,
});

function ensurePendleAllowanceExact(
  ...args: Parameters<typeof ensurePendleAllowanceExactBase>
): ReturnType<typeof ensurePendleAllowanceExactBase> {
  const [publicClient, walletClient, token, spender, requiredAmount] = args;
  return ensurePendleAllowanceExactBase(
    publicClient,
    walletClient,
    token,
    spender,
    requiredAmount,
    createTestStaging,
  );
}

describe("ensurePendleAllowanceExact — set-to-exact discipline", () => {
  it("no-op when the allowance already EQUALS the required amount", async () => {
    const { publicClient, walletClient, writeContract } = makeClients(100n);
    const result = await ensurePendleAllowanceExact(
      publicClient as never, walletClient as never, TOKEN, PENDLE_ROUTER, 100n,
    );
    expect(result).toBeNull();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("STALE LARGER allowance is reset to zero then set to exact (never skipped)", async () => {
    const { publicClient, walletClient, writeContract } = makeClients(999999999n);
    const result = await ensurePendleAllowanceExact(
      publicClient as never, walletClient as never, TOKEN, PENDLE_ROUTER, 100n,
    );
    expect(result).not.toBeNull();
    expect(approveArgs(writeContract)).toEqual([
      [PENDLE_ROUTER, 0n],
      [PENDLE_ROUTER, 100n],
    ]);
  });

  it("smaller non-zero allowance is zeroed then set to exact", async () => {
    const { publicClient, walletClient, writeContract } = makeClients(1n);
    await ensurePendleAllowanceExact(
      publicClient as never, walletClient as never, TOKEN, PENDLE_ROUTER, 100n,
    );
    expect(approveArgs(writeContract)).toEqual([
      [PENDLE_ROUTER, 0n],
      [PENDLE_ROUTER, 100n],
    ]);
  });

  it("zero allowance gets a single exact approval", async () => {
    const { publicClient, walletClient, writeContract } = makeClients(0n);
    await ensurePendleAllowanceExact(
      publicClient as never, walletClient as never, TOKEN, PENDLE_ROUTER, 100n,
    );
    expect(approveArgs(writeContract)).toEqual([[PENDLE_ROUTER, 100n]]);
  });

  it("refuses any spender other than the pinned Router", async () => {
    const { publicClient, walletClient } = makeClients(0n);
    try {
      await ensurePendleAllowanceExact(
        publicClient as never, walletClient as never, TOKEN,
        getAddress("0xdEAD000000000000000000000000000000000000"), 100n,
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe(ErrorCodes.INVALID_SPENDER);
    }
  });

  it("does not send the exact approval after a reverted reset", async () => {
    const { publicClient, walletClient, writeContract } = makeClients(1n);
    publicClient.waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });

    await expect(
      ensurePendleAllowanceExact(publicClient as never, walletClient as never, TOKEN, PENDLE_ROUTER, 100n),
    ).rejects.toMatchObject({ code: ErrorCodes.APPROVAL_FAILED });
    expect(writeContract).toHaveBeenCalledTimes(1);
  });
});

/**
 * Gas-limit discipline (2026-07-24 out-of-gas defect class). `writeContract`
 * with no explicit `gas` makes viem sign the node's BARE `eth_estimateGas` with
 * zero headroom — the same signing shape that mined-reverted four KyberSwap
 * executes on Base at ~97.3% of their limit. Approvals are cheap and stable
 * relative to router calldata, but this was the last place still doing it.
 *
 * Unlike Khalani, Pendle's approvals carry NO provider-supplied gas figure
 * (the Convert API's `requiredApprovals` have no gas field), so there is no
 * `max(provider, ours)` reconciliation to pin here — only the headroom floor.
 */
describe("ensurePendleAllowanceExact — gas-limit headroom", () => {
  const ESTIMATE = 46_312n;
  /** 200% headroom policy (`gasLimitWithHeadroom`). */
  const HEADROOMED = 92_624n;

  /** The `gas` passed to each `approve` write, in order. */
  function writtenGas(writeContract: ReturnType<typeof vi.fn>): Array<bigint | undefined> {
    return writeContract.mock.calls.map((c) => {
      const request = c[0];
      if (typeof request !== "object" || request === null || !("gas" in request)) return undefined;
      return typeof request.gas === "bigint" ? request.gas : undefined;
    });
  }

  it("signs the headroomed estimate, not the bare estimate, on a single exact approval", async () => {
    const { publicClient, walletClient, writeContract } = makeClients(0n, ESTIMATE);

    await ensurePendleAllowanceExact(
      publicClient as never, walletClient as never, TOKEN, PENDLE_ROUTER, 100n,
    );

    expect(writtenGas(writeContract)).toEqual([HEADROOMED]);
  });

  it("applies the headroom to BOTH the reset and the exact approval", async () => {
    const { publicClient, walletClient, writeContract, estimateContractGas } = makeClients(1n, ESTIMATE);

    await ensurePendleAllowanceExact(
      publicClient as never, walletClient as never, TOKEN, PENDLE_ROUTER, 100n,
    );

    expect(estimateContractGas).toHaveBeenCalledTimes(2);
    expect(writtenGas(writeContract)).toEqual([HEADROOMED, HEADROOMED]);
  });

  it("estimates each leg against the exact approve call it then writes", async () => {
    const { publicClient, walletClient, estimateContractGas } = makeClients(1n, ESTIMATE);

    await ensurePendleAllowanceExact(
      publicClient as never, walletClient as never, TOKEN, PENDLE_ROUTER, 100n,
    );

    const estimated = estimateContractGas.mock.calls.map((c) => {
      const request = c[0];
      if (typeof request !== "object" || request === null || !("data" in request)) {
        throw new Error("estimated approval request carried no calldata");
      }
      const decoded = decodeFunctionData({ abi: PENDLE_ERC20_ABI, data: String(request.data) as Hex });
      if (decoded.functionName !== "approve") throw new Error("estimated request was not approve");
      return [decoded.args[0], decoded.args[1]];
    });
    expect(estimated).toEqual([
      [PENDLE_ROUTER, 0n],
      [PENDLE_ROUTER, 100n],
    ]);
  });

  it("throws APPROVAL_FAILED before any approve is written when the estimate reverts", async () => {
    const { publicClient, walletClient, writeContract } = makeClients(0n, ESTIMATE);
    publicClient.estimateGas.mockRejectedValueOnce(new Error("execution reverted"));

    await expect(
      ensurePendleAllowanceExact(publicClient as never, walletClient as never, TOKEN, PENDLE_ROUTER, 100n),
    ).rejects.toMatchObject({ code: ErrorCodes.APPROVAL_FAILED });
    // A would-revert approve never reaches signing — same classification the
    // internal estimate produced before the gas limit became explicit.
    expect(writeContract).not.toHaveBeenCalled();
  });
});
