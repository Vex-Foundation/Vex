/**
 * Behavior tests for `ensureKyberAllowance` (Etap 4 — always-exact allowance).
 *
 * The exact-amount doctrine (mirroring Uniswap's `ensureUniswapAllowanceExact`)
 * means a short allowance is topped up to EXACTLY `requiredAmount`, never to an
 * unlimited `maxUint256`. These tests assert the on-chain `approve` call amount
 * and the sufficient-allowance short-circuit.
 */

import { describe, it, expect, vi } from "vitest";
import { maxUint256, type Address, type Hex } from "viem";
import { ensureKyberAllowance } from "@tools/kyberswap/evm-utils.js";
import { META_AGGREGATION_ROUTER_V2 } from "@tools/kyberswap/constants.js";

const OWNER = "0x18b467Cb28FC07Ca6E17A964b3319051B3072B79" as Address;
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address; // USDC
const SPENDER = META_AGGREGATION_ROUTER_V2;
const FAKE_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000001" as Hex;

interface ApproveCall {
  readonly functionName: string;
  readonly args: readonly unknown[];
}

/** Build mocked viem clients; `writeContract` records each call's args. */
function makeClients(currentAllowance: bigint) {
  const approveCalls: ApproveCall[] = [];
  const publicClient = {
    readContract: vi.fn(async () => currentAllowance),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", logs: [] })),
  };
  const walletClient = {
    account: { address: OWNER },
    chain: { id: 1 },
    writeContract: vi.fn(async (call: ApproveCall) => {
      approveCalls.push({ functionName: call.functionName, args: call.args });
      return FAKE_HASH;
    }),
  };
  // The util only consumes the narrow surface exercised here; the viem generic
  // client types are structurally wider, so cast at this test boundary only.
  return { publicClient, walletClient, approveCalls } as unknown as {
    publicClient: Parameters<typeof ensureKyberAllowance>[0];
    walletClient: Parameters<typeof ensureKyberAllowance>[1];
    approveCalls: ApproveCall[];
  };
}

describe("ensureKyberAllowance — always-exact approval", () => {
  it("approves EXACTLY requiredAmount (never maxUint256) when allowance is zero", async () => {
    const required = 1_000_000n; // 1 USDC (6 decimals)
    const { publicClient, walletClient, approveCalls } = makeClients(0n);

    const result = await ensureKyberAllowance(publicClient, walletClient, TOKEN, SPENDER, required);

    expect(result).not.toBeNull();
    // Exactly one approve, for the exact required amount.
    const approves = approveCalls.filter(c => c.functionName === "approve");
    expect(approves).toHaveLength(1);
    expect(approves[0]!.args[1]).toBe(required);
    // Doctrine guard: it must NOT approve an unlimited allowance.
    expect(approves[0]!.args[1]).not.toBe(maxUint256);
  });

  it("short-circuits (no approve) when the current allowance already covers requiredAmount", async () => {
    const required = 1_000_000n;
    const { publicClient, walletClient, approveCalls } = makeClients(5_000_000n);

    const result = await ensureKyberAllowance(publicClient, walletClient, TOKEN, SPENDER, required);

    expect(result).toBeNull();
    expect(approveCalls).toHaveLength(0);
  });

  it("USDT-style: resets to 0 then approves EXACTLY requiredAmount when a partial allowance exists", async () => {
    const required = 1_000_000n;
    const { publicClient, walletClient, approveCalls } = makeClients(500_000n); // partial < required

    const result = await ensureKyberAllowance(publicClient, walletClient, TOKEN, SPENDER, required);

    expect(result).not.toBeNull();
    const approves = approveCalls.filter(c => c.functionName === "approve");
    expect(approves).toHaveLength(2);
    // First: reset to 0.
    expect(approves[0]!.args[1]).toBe(0n);
    // Second: exact required amount, not maxUint256.
    expect(approves[1]!.args[1]).toBe(required);
    expect(approves[1]!.args[1]).not.toBe(maxUint256);
  });

  it("honors an explicit maxUint256 requiredAmount (zap-out/migrate LP-exit case)", async () => {
    // Callers that genuinely need an unlimited standing allowance pass maxUint256
    // AS requiredAmount; the function then approves exactly that (unlimited).
    const { publicClient, walletClient, approveCalls } = makeClients(0n);

    await ensureKyberAllowance(publicClient, walletClient, TOKEN, SPENDER, maxUint256);

    const approves = approveCalls.filter(c => c.functionName === "approve");
    expect(approves).toHaveLength(1);
    expect(approves[0]!.args[1]).toBe(maxUint256);
  });
});
