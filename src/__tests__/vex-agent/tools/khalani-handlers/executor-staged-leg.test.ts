/**
 * Phase-2 W3a — `bridge-executor` staged per-leg signing + planning.
 *
 * Pins the leg-level discipline the handler suite mocks away:
 *   - an EVM leg stages its hash (with a numeric nonce) BEFORE any broadcast;
 *   - a send failure is `ambiguous(send)`, a reverted receipt is `reverted`;
 *   - `onHashStaged` throwing aborts BEFORE the broadcast (untracked-tx safety);
 *   - a SOLANA leg stages the base58 signature in `txHash` with `nonce: null`
 *     (the B1 nonce matrix), then confirms;
 *   - a SOLANA confirmation that resolves `reverted` (RPC `value.err`) is mapped to
 *     a `reverted` outcome, NOT confirmed (blocker 2); a confirm RPC error is
 *     `ambiguous(confirm)`;
 *   - `planKhalaniDepositLegs` classifies roles, blocks PERMIT2, and requires
 *     exactly one deposit leg.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeFunctionData, keccak256 } from "viem";

const EVM = { family: "eip155" as const, address: "0x1234567890AbcdEF1234567890aBcdef12345678", privateKey: ("0x" + "ab".repeat(32)) as `0x${string}` };
const SOL = { family: "solana" as const, address: "So1anaAddr1111111111111111111111111111111", secretKey: new Uint8Array(64) };

const mockPrepare = vi.fn();
const mockSign = vi.fn();
const mockSendRaw = vi.fn();
const mockWaitReceipt = vi.fn();

vi.mock("@tools/khalani/evm-client.js", () => ({
  createDynamicWalletClient: () => ({
    account: { address: EVM.address },
    chain: { id: 8453 },
    prepareTransactionRequest: (...a: unknown[]) => mockPrepare(...a),
    signTransaction: (...a: unknown[]) => mockSign(...a),
  }),
  createDynamicPublicClient: () => ({
    sendRawTransaction: (...a: unknown[]) => mockSendRaw(...a),
    waitForTransactionReceipt: (...a: unknown[]) => mockWaitReceipt(...a),
  }),
}));

const mockSignSolana = vi.fn();
const mockBroadcastSolana = vi.fn();
const mockConfirmSolana = vi.fn();
vi.mock("@tools/khalani/solana-signer.js", () => ({
  signSolanaTransactionWithSignature: (...a: unknown[]) => mockSignSolana(...a),
  broadcastSignedSolanaTransaction: (...a: unknown[]) => mockBroadcastSolana(...a),
  confirmSolanaSignature: (...a: unknown[]) => mockConfirmSolana(...a),
}));

vi.mock("@tools/khalani/chains.js", () => ({
  getChainRpcUrl: () => "https://rpc.example",
}));

import { planKhalaniDepositLegs, signStageKhalaniLeg } from "@tools/khalani/bridge-executor.js";
import type { KhalaniStagedLeg } from "@tools/khalani/bridge-executor.js";

const BASE_CHAIN = { id: 8453, name: "Base", type: "eip155" as const, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } };
const SOL_CHAIN = { id: 20011000000, name: "Solana", type: "solana" as const, nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 } };
const SERIALIZED = "0xabcdef";

function evmLeg(): KhalaniStagedLeg {
  return { role: "bridge_deposit", family: "eip155", isDeposit: true, kind: "evm", tx: { to: EVM.address } };
}
function solLeg(): KhalaniStagedLeg {
  return { role: "bridge_deposit", family: "solana", isDeposit: true, kind: "solana", base64Tx: "base64tx" };
}

describe("bridge-executor — EVM staged leg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrepare.mockResolvedValue({ nonce: 3, to: EVM.address });
    mockSign.mockResolvedValue(SERIALIZED);
    mockSendRaw.mockResolvedValue(undefined);
    mockWaitReceipt.mockResolvedValue({ status: "success" });
  });

  it("stages hash + numeric nonce BEFORE broadcast, then confirms", async () => {
    const order: string[] = [];
    const staged: { txHash: string; fromAddress: string; nonce: number | null }[] = [];
    const outcome = await signStageKhalaniLeg(evmLeg(), BASE_CHAIN, [BASE_CHAIN], EVM, {
      onHashStaged: async (h) => { order.push("stage"); staged.push(h); },
      onAccepted: async () => { order.push("accept"); },
    });
    expect(staged).toHaveLength(1);
    expect(staged[0]!.nonce).toBe(3);
    expect(staged[0]!.fromAddress).toBe(EVM.address);
    expect(staged[0]!.txHash).toBe(keccak256(SERIALIZED));
    expect(order[0]).toBe("stage"); // staged before broadcast/accept
    expect(mockSendRaw).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: "confirmed", txHash: keccak256(SERIALIZED) });
  });

  it("onHashStaged throwing aborts BEFORE any broadcast", async () => {
    await expect(signStageKhalaniLeg(evmLeg(), BASE_CHAIN, [BASE_CHAIN], EVM, {
      onHashStaged: async () => { throw new Error("CAS miss"); },
      onAccepted: async () => {},
    })).rejects.toThrow("CAS miss");
    expect(mockSendRaw).not.toHaveBeenCalled();
  });

  it("a send failure is ambiguous(send)", async () => {
    mockSendRaw.mockRejectedValueOnce(new Error("rpc down"));
    const outcome = await signStageKhalaniLeg(evmLeg(), BASE_CHAIN, [BASE_CHAIN], EVM, { onHashStaged: async () => {}, onAccepted: async () => {} });
    expect(outcome).toEqual({ kind: "ambiguous", txHash: keccak256(SERIALIZED), stage: "send" });
  });

  it("a reverted receipt is reverted", async () => {
    mockWaitReceipt.mockResolvedValueOnce({ status: "reverted" });
    const outcome = await signStageKhalaniLeg(evmLeg(), BASE_CHAIN, [BASE_CHAIN], EVM, { onHashStaged: async () => {}, onAccepted: async () => {} });
    expect(outcome).toEqual({ kind: "reverted", txHash: keccak256(SERIALIZED) });
  });

  it("a receipt-wait failure is ambiguous(confirm)", async () => {
    mockWaitReceipt.mockRejectedValueOnce(new Error("timeout"));
    const outcome = await signStageKhalaniLeg(evmLeg(), BASE_CHAIN, [BASE_CHAIN], EVM, { onHashStaged: async () => {}, onAccepted: async () => {} });
    expect(outcome).toEqual({ kind: "ambiguous", txHash: keccak256(SERIALIZED), stage: "confirm" });
  });
});

describe("bridge-executor — Solana staged leg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignSolana.mockReturnValue({ signedBase64: "signed", signature: "BASE58SIGNATURE" });
    mockBroadcastSolana.mockResolvedValue("BASE58SIGNATURE");
    mockConfirmSolana.mockResolvedValue({ status: "confirmed" });
  });

  it("stages the base58 signature in txHash with nonce NULL, then confirms", async () => {
    const staged: { txHash: string; fromAddress: string; nonce: number | null }[] = [];
    const outcome = await signStageKhalaniLeg(solLeg(), SOL_CHAIN, [SOL_CHAIN], SOL, {
      onHashStaged: async (h) => { staged.push(h); },
      onAccepted: async () => {},
    });
    expect(staged).toHaveLength(1);
    expect(staged[0]!.txHash).toBe("BASE58SIGNATURE"); // signature, not a hash
    expect(staged[0]!.nonce).toBeNull(); // B1 nonce matrix — Solana never carries a nonce
    expect(staged[0]!.fromAddress).toBe(SOL.address);
    expect(outcome).toEqual({ kind: "confirmed", txHash: "BASE58SIGNATURE" });
  });

  it("a broadcast failure is ambiguous(send) — signature already staged", async () => {
    mockBroadcastSolana.mockRejectedValueOnce(new Error("blockhash expired"));
    const outcome = await signStageKhalaniLeg(solLeg(), SOL_CHAIN, [SOL_CHAIN], SOL, { onHashStaged: async () => {}, onAccepted: async () => {} });
    expect(outcome).toEqual({ kind: "ambiguous", txHash: "BASE58SIGNATURE", stage: "send" });
  });

  it("a reverted confirmation (RPC value.err) is REVERTED, never confirmed (blocker 2)", async () => {
    mockConfirmSolana.mockResolvedValueOnce({ status: "reverted", error: "InstructionError" });
    const outcome = await signStageKhalaniLeg(solLeg(), SOL_CHAIN, [SOL_CHAIN], SOL, { onHashStaged: async () => {}, onAccepted: async () => {} });
    expect(outcome).toEqual({ kind: "reverted", txHash: "BASE58SIGNATURE" });
  });

  it("a confirm RPC error is ambiguous(confirm) — never a false success", async () => {
    mockConfirmSolana.mockRejectedValueOnce(new Error("confirm timeout"));
    const outcome = await signStageKhalaniLeg(solLeg(), SOL_CHAIN, [SOL_CHAIN], SOL, { onHashStaged: async () => {}, onAccepted: async () => {} });
    expect(outcome).toEqual({ kind: "ambiguous", txHash: "BASE58SIGNATURE", stage: "confirm" });
  });

  it("family mismatch fails closed (Solana leg, EVM signer)", async () => {
    await expect(signStageKhalaniLeg(solLeg(), SOL_CHAIN, [SOL_CHAIN], EVM, { onHashStaged: async () => {}, onAccepted: async () => {} }))
      .rejects.toThrow(/Solana deposit requires a Solana signing wallet/);
  });
});

describe("bridge-executor — planKhalaniDepositLegs", () => {
  it("classifies roles: deposit → bridge_deposit, approve(0) → allowance_reset, other approve → allowance", async () => {
    const resetCalldata = encodeFunctionData({
      abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }],
      functionName: "approve",
      args: [EVM.address, 0n],
    });
    const grantCalldata = encodeFunctionData({
      abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }],
      functionName: "approve",
      args: [EVM.address, 100n],
    });
    const plan = {
      kind: "CONTRACT_CALL" as const,
      approvals: [
        { type: "eip1193_request" as const, request: { method: "eth_sendTransaction", params: [{ to: EVM.address, data: resetCalldata }] } },
        { type: "eip1193_request" as const, request: { method: "eth_sendTransaction", params: [{ to: EVM.address, data: grantCalldata }] } },
        { type: "eip1193_request" as const, request: { method: "eth_sendTransaction", params: [{ to: EVM.address, data: "0xdeadbeef" }] }, deposit: true },
      ],
    };
    const legs = planKhalaniDepositLegs(plan, BASE_CHAIN);
    expect(legs.map((l) => l.role)).toEqual(["allowance_reset", "allowance", "bridge_deposit"]);
    expect(legs.filter((l) => l.isDeposit)).toHaveLength(1);
  });

  it("skips a wallet_switchEthereumChain approval (not a broadcast)", async () => {
    const plan = {
      kind: "CONTRACT_CALL" as const,
      approvals: [
        { type: "eip1193_request" as const, request: { method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] } },
        { type: "eip1193_request" as const, request: { method: "eth_sendTransaction", params: [{ to: EVM.address, data: "0xdead" }] }, deposit: true },
      ],
    };
    const legs = planKhalaniDepositLegs(plan, BASE_CHAIN);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.role).toBe("bridge_deposit");
  });

  it("blocks PERMIT2", async () => {
    expect(() => planKhalaniDepositLegs({ kind: "PERMIT2", permit: {}, transferDetails: {} }, BASE_CHAIN)).toThrow(/PERMIT2/);
  });

  it("requires exactly one deposit leg", async () => {
    const plan = { kind: "CONTRACT_CALL" as const, approvals: [{ type: "eip1193_request" as const, request: { method: "eth_sendTransaction", params: [{ to: EVM.address, data: "0xdead" }] } }] };
    expect(() => planKhalaniDepositLegs(plan, BASE_CHAIN)).toThrow(/deposit=true/);
  });
});
