/**
 * Phase-2 W3a — `bridge-executor` staged per-leg signing + planning.
 * W5 (K9, closing K2's flagged cross-card break) extended the Solana leg to
 * the provider-built-tx doctrine: sole-signer check + fresh-blockhash REPLACE
 * via the shared `prepareVersionedTx`, evidence threaded through the hash.
 *
 * Pins the leg-level discipline the handler suite mocks away:
 *   - an EVM leg stages its hash (with a numeric nonce) BEFORE any broadcast;
 *   - a send failure is `ambiguous(send)`, a reverted receipt is `reverted`;
 *   - `onHashStaged` throwing aborts BEFORE the broadcast (untracked-tx safety);
 *   - a SOLANA leg stages the base58 signature + fresh blockhash evidence
 *     (`recentBlockhash`/`lastValidBlockHeight`) in `txHash`/nonce-null shape
 *     (the B1 nonce matrix), then confirms;
 *   - a SOLANA confirmation that resolves `reverted` (RPC `value.err`) is mapped to
 *     a `reverted` outcome, NOT confirmed (blocker 2); a confirm RPC error is
 *     `ambiguous(confirm)`;
 *   - `planKhalaniDepositLegs` classifies roles, blocks PERMIT2, and requires
 *     exactly one deposit leg.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { Keypair } from "@solana/web3.js";

const EVM = { family: "eip155" as const, address: "0x1234567890AbcdEF1234567890aBcdef12345678", privateKey: ("0x" + "ab".repeat(32)) as `0x${string}` };
const SOL_KEYPAIR = Keypair.generate();
const SOL = { family: "solana" as const, address: SOL_KEYPAIR.publicKey.toBase58(), secretKey: SOL_KEYPAIR.secretKey };

const mockPrepare = vi.fn();
const mockSign = vi.fn();
const mockSendRaw = vi.fn();
const mockWaitReceipt = vi.fn();
const mockEstimateGas = vi.fn();
const mockGetBlockNumber = vi.fn();

vi.mock("@tools/khalani/evm-client.js", () => ({
  createDynamicWalletClient: () => ({
    account: { address: EVM.address },
    chain: { id: 8453 },
    prepareTransactionRequest: (...a: unknown[]) => mockPrepare(...a),
    signTransaction: (...a: unknown[]) => mockSign(...a),
  }),
  createDynamicPublicClient: () => ({
    estimateGas: (...a: unknown[]) => mockEstimateGas(...a),
    getBlockNumber: (...a: unknown[]) => mockGetBlockNumber(...a),
    sendRawTransaction: (...a: unknown[]) => mockSendRaw(...a),
    waitForTransactionReceipt: (...a: unknown[]) => mockWaitReceipt(...a),
  }),
}));

const mockPrepareVersionedTx = vi.fn();
vi.mock("@tools/solana-ecosystem/shared/solana-transaction.js", () => ({
  prepareVersionedTx: (...a: unknown[]) => mockPrepareVersionedTx(...a),
}));

const mockBroadcastSolana = vi.fn();
const mockConfirmSolana = vi.fn();
vi.mock("@tools/khalani/solana-signer.js", () => ({
  broadcastSignedSolanaTransaction: (...a: unknown[]) => mockBroadcastSolana(...a),
  confirmSolanaSignature: (...a: unknown[]) => mockConfirmSolana(...a),
}));

vi.mock("@tools/khalani/chains.js", () => ({
  getChainRpcUrl: () => "https://rpc.example",
}));

import { planKhalaniDepositLegs, signStageKhalaniLeg } from "@tools/khalani/bridge-executor.js";
import type { KhalaniStagedLeg } from "@tools/khalani/bridge-executor.js";
import { classifyNativeValue } from "@tools/evm-chains/native-value-authorization/index.js";
import {
  DependentLegGasEstimateError,
  DEPENDENT_LEG_ESTIMATE_ATTEMPTS,
  DEPENDENT_LEG_ESTIMATE_MARKER,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { VexError, ErrorCodes } from "../../../../errors.js";

const BASE_CHAIN = { id: 8453, name: "Base", type: "eip155" as const, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } };
const SOL_CHAIN = { id: 20011000000, name: "Solana", type: "solana" as const, nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 } };
const SERIALIZED = "0xabcdef";

/**
 * Every EVM leg now carries a native-value authorization, re-validated inside
 * `signStageEvmLeg` before anything is signed. These helpers authorize whatever
 * value they are handed so the suites below keep testing what they are about —
 * gas discipline and staging order — instead of tripping the value gate. The
 * gate itself is pinned separately in `khalani/khalani-native-value-gate.test.ts`.
 */
function authorizedNativeValue(tx: { to: string; data?: Hex; value?: bigint }) {
  const valueWei = tx.value ?? 0n;
  return classifyNativeValue({
    call: { chainId: BASE_CHAIN.id, to: tx.to as Address, data: tx.data, valueWei },
    nativePrincipal: valueWei > 0n
      ? {
          amountWei: valueWei,
          recipient: null,
          refund: "spent_not_recoverable" as const,
          evidence: { source: "vex_constructed" as const, detail: "test fixture" },
        }
      : undefined,
  });
}

function evmLeg(): KhalaniStagedLeg {
  const tx = { to: EVM.address };
  return {
    role: "bridge_deposit", family: "eip155", isDeposit: true, kind: "evm", tx,
    nativeValue: authorizedNativeValue(tx),
  };
}
/** An EVM leg in either role — the gas discipline must cover approvals AND the deposit. */
function evmLegOf(
  role: "allowance" | "bridge_deposit",
  txOverrides: { data?: Hex; value?: bigint; gas?: bigint } = {},
): KhalaniStagedLeg {
  const tx = { to: EVM.address, ...txOverrides };
  return {
    role,
    family: "eip155",
    isDeposit: role === "bridge_deposit",
    kind: "evm",
    tx,
    nativeValue: authorizedNativeValue(tx),
  };
}
function solLeg(): KhalaniStagedLeg {
  return { role: "bridge_deposit", family: "solana", isDeposit: true, kind: "solana", base64Tx: "base64tx" };
}

/** Receipt block of a confirmed EVM leg — the next leg's read-after-write anchor. */
const ALLOWANCE_BLOCK = 34_567_890n;

describe("bridge-executor — EVM staged leg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEstimateGas.mockResolvedValue(120_000n);
    mockGetBlockNumber.mockResolvedValue(ALLOWANCE_BLOCK);
    mockPrepare.mockResolvedValue({ nonce: 3, to: EVM.address });
    mockSign.mockResolvedValue(SERIALIZED);
    mockSendRaw.mockResolvedValue(undefined);
    mockWaitReceipt.mockResolvedValue({ status: "success", blockNumber: ALLOWANCE_BLOCK });
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
    // `settledAtBlock` is the receipt block the caller threads into the NEXT
    // leg as its read-after-write anchor.
    expect(outcome).toEqual({ kind: "confirmed", txHash: keccak256(SERIALIZED), settledAtBlock: ALLOWANCE_BLOCK });
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

/**
 * Gas-limit discipline for the Vex-signed EVM legs (2026-07-24 out-of-gas
 * defect class). Khalani hands us a provider-built transaction that MAY carry
 * its own `gas`; signing that verbatim — or letting viem sign the node's bare
 * estimate — is the same defect that mined-reverted four KyberSwap executes on
 * Base at ~97.3% of their limit with zero logs. The signed limit must be
 * `max(providerGas, headroom(ourOwnEstimate))`, and it must survive onto the
 * object actually serialized.
 */
describe("bridge-executor — EVM staged leg gas limit", () => {
  /** The bare estimate that was actually signed for the reverted Base swap. */
  const OWN_ESTIMATE = 1_026_236n;
  /** 200% headroom policy (`gasLimitWithHeadroom`) applied to OWN_ESTIMATE. */
  const HEADROOMED = 2_052_472n;
  /** Replaying that calldata at its own block proves this much was required. */
  const MEASURED_REQUIREMENT = 1_634_838n;
  /** KyberSwap's own quote `data.gas` for that call — a 4.6x lowball. */
  const PROVIDER_LOWBALL = 356_167n;
  /** A provider asking for MORE than our headroomed figure. */
  const PROVIDER_HIGHER = 2_480_913n;

  /** The `gas` on the object handed to `signTransaction` — what the chain enforces. */
  function signedGas(): bigint | undefined {
    const request = mockSign.mock.calls[0]?.[0] as { gas?: bigint } | undefined;
    return request?.gas;
  }
  function preparedGas(): bigint | undefined {
    const request = mockPrepare.mock.calls[0]?.[0] as { gas?: bigint } | undefined;
    return request?.gas;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockEstimateGas.mockResolvedValue(OWN_ESTIMATE);
    mockGetBlockNumber.mockResolvedValue(ALLOWANCE_BLOCK);
    mockPrepare.mockResolvedValue({ nonce: 3, to: EVM.address });
    mockSign.mockResolvedValue(SERIALIZED);
    mockSendRaw.mockResolvedValue(undefined);
    mockWaitReceipt.mockResolvedValue({ status: "success", blockNumber: ALLOWANCE_BLOCK });
  });

  const noopHooks = { onHashStaged: async () => {}, onAccepted: async () => {} };

  // BOTH Vex-signed legs go through this path — an ERC-20 approval that runs
  // out of gas strands the bridge just as effectively as the deposit doing so.
  for (const role of ["allowance", "bridge_deposit"] as const) {
    it(`signs our headroomed estimate for the ${role} leg when Khalani quoted no gas`, async () => {
      await signStageKhalaniLeg(evmLegOf(role), BASE_CHAIN, [BASE_CHAIN], EVM, noopHooks);

      expect(preparedGas()).toBe(HEADROOMED);
      expect(signedGas()).toBe(HEADROOMED);
      expect(signedGas()!).toBeGreaterThanOrEqual(MEASURED_REQUIREMENT);
    });

    it(`ignores a provider gas number BELOW our headroomed estimate on the ${role} leg`, async () => {
      await signStageKhalaniLeg(
        evmLegOf(role, { gas: PROVIDER_LOWBALL }),
        BASE_CHAIN, [BASE_CHAIN], EVM, noopHooks,
      );

      // The provider's figure is a hint, never a floor: KyberSwap quoted
      // 356,167 for a call that measurably needed ~1,634,838.
      expect(signedGas()).toBe(HEADROOMED);
      expect(signedGas()!).toBeGreaterThanOrEqual(MEASURED_REQUIREMENT);
    });
  }

  it("honours a provider gas number ABOVE our headroomed estimate", async () => {
    // The provider may know about state our estimate cannot see, so a larger
    // ask is taken at its word rather than clamped down to ours.
    await signStageKhalaniLeg(
      evmLegOf("bridge_deposit", { gas: PROVIDER_HIGHER }),
      BASE_CHAIN, [BASE_CHAIN], EVM, noopHooks,
    );

    expect(signedGas()).toBe(PROVIDER_HIGHER);
  });

  it("keeps the limit when preparation hands back the node's own unbuffered gas", async () => {
    // viem's `attemptFill` is true whenever nonce or fees still need filling,
    // and the `wallet_fillTransaction` reply spreads the node's `gas` over
    // ours. The re-assertion on the signed object is what closes that hole.
    mockPrepare.mockResolvedValue({ nonce: 3, to: EVM.address, gas: OWN_ESTIMATE });

    await signStageKhalaniLeg(evmLegOf("bridge_deposit"), BASE_CHAIN, [BASE_CHAIN], EVM, noopHooks);

    expect(signedGas()).toBe(HEADROOMED);
  });

  it("estimates the exact call that will be signed, including native value", async () => {
    await signStageKhalaniLeg(
      evmLegOf("bridge_deposit", { data: "0xdeadbeef", value: 11_000_000_000_000_000n }),
      BASE_CHAIN, [BASE_CHAIN], EVM, noopHooks,
    );

    expect(mockEstimateGas).toHaveBeenCalledTimes(1);
    expect(mockEstimateGas.mock.calls[0]![0]).toMatchObject({
      to: EVM.address,
      data: "0xdeadbeef",
      value: 11_000_000_000_000_000n,
    });
  });

  it("throws before anything is signed, staged, or broadcast when the estimate reverts", async () => {
    mockEstimateGas.mockRejectedValueOnce(new Error("execution reverted: TRANSFER_FROM_FAILED"));
    const staged: unknown[] = [];

    await expect(signStageKhalaniLeg(evmLegOf("bridge_deposit"), BASE_CHAIN, [BASE_CHAIN], EVM, {
      onHashStaged: async (h) => { staged.push(h); },
      onAccepted: async () => {},
    })).rejects.toThrow(/execution reverted/);

    expect(staged).toHaveLength(0);
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockSendRaw).not.toHaveBeenCalled();
    // No prior confirmed leg was passed — a first-touch revert stays a single
    // attempt with the node's own error.
    expect(mockEstimateGas).toHaveBeenCalledTimes(1);
  });
});

/**
 * The live 2026-07-24 Khalani regression: allowance
 * `0x2445ce73132d354ee741e4ab2d62fb186a205e8c4dbd1ed9ca7a016fa0d9e072` was
 * CONFIRMED on-chain, yet the deposit leg's estimate was refused with
 * `ERC20: transfer amount exceeds allowance` — an immediate retry of the
 * unchanged transaction landed (`0xcef2a865…`). The estimating node lagged the
 * approval it had just confirmed.
 */
describe("bridge-executor — EVM deposit leg estimated after a confirmed allowance", () => {
  const LIVE_ALLOWANCE_REVERT = "Execution reverted with reason: ERC20: transfer amount exceeds allowance.";
  const noopHooks = { onHashStaged: async () => {}, onAccepted: async () => {} };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetBlockNumber.mockResolvedValue(ALLOWANCE_BLOCK);
    mockPrepare.mockResolvedValue({ nonce: 3, to: EVM.address });
    mockSign.mockResolvedValue(SERIALIZED);
    mockSendRaw.mockResolvedValue(undefined);
    mockWaitReceipt.mockResolvedValue({ status: "success", blockNumber: ALLOWANCE_BLOCK + 1n });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function settle<T>(promise: Promise<T>): Promise<T> {
    const raced = promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await raced;
    if (!result.ok) throw result.error;
    return result.value;
  }

  it("signs the deposit when the estimate succeeds on a retry", async () => {
    mockEstimateGas
      .mockRejectedValueOnce(new Error(LIVE_ALLOWANCE_REVERT))
      .mockResolvedValueOnce(1_026_236n);
    const staged: unknown[] = [];

    const outcome = await settle(signStageKhalaniLeg(
      evmLegOf("bridge_deposit"), BASE_CHAIN, [BASE_CHAIN], EVM,
      { onHashStaged: async (h) => { staged.push(h); }, onAccepted: async () => {} },
      { blockNumber: ALLOWANCE_BLOCK },
    ));

    expect(outcome).toEqual({ kind: "confirmed", txHash: keccak256(SERIALIZED), settledAtBlock: ALLOWANCE_BLOCK + 1n });
    expect(staged).toHaveLength(1);
    expect(mockEstimateGas).toHaveBeenCalledTimes(2);
    // The headroom policy is untouched by the retry.
    expect((mockSign.mock.calls[0]?.[0] as { gas?: bigint } | undefined)?.gas).toBe(2_052_472n);
  });

  it("still refuses the deposit pre-sign after the bounded retries, signing and broadcasting nothing", async () => {
    mockEstimateGas.mockRejectedValue(new Error(LIVE_ALLOWANCE_REVERT));
    const staged: unknown[] = [];

    const err = await settle(signStageKhalaniLeg(
      evmLegOf("bridge_deposit"), BASE_CHAIN, [BASE_CHAIN], EVM,
      { onHashStaged: async (h) => { staged.push(h); }, onAccepted: async () => {} },
      { blockNumber: ALLOWANCE_BLOCK },
    ).catch((e: unknown) => e));

    expect(err).toBeInstanceOf(DependentLegGasEstimateError);
    expect((err as Error).message).toContain(DEPENDENT_LEG_ESTIMATE_MARKER);
    expect(staged).toHaveLength(0);
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockSendRaw).not.toHaveBeenCalled();
    expect(mockEstimateGas).toHaveBeenCalledTimes(DEPENDENT_LEG_ESTIMATE_ATTEMPTS);
  });

  it("does not retry a leg with no confirmed prior leg behind it", async () => {
    mockEstimateGas.mockRejectedValue(new Error(LIVE_ALLOWANCE_REVERT));

    const err = await settle(
      signStageKhalaniLeg(evmLegOf("allowance"), BASE_CHAIN, [BASE_CHAIN], EVM, noopHooks).catch((e: unknown) => e),
    );

    expect(err).not.toBeInstanceOf(DependentLegGasEstimateError);
    expect(mockEstimateGas).toHaveBeenCalledTimes(1);
  });
});

describe("bridge-executor — Solana staged leg", () => {
  const PREPARED = {
    serialized: new Uint8Array([1, 2, 3, 4]),
    signature: "BASE58SIGNATURE",
    recentBlockhash: "FreshBlockhash1111111111111111111111111111",
    lastValidBlockHeight: 123456789,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrepareVersionedTx.mockResolvedValue(PREPARED);
    mockBroadcastSolana.mockResolvedValue("BASE58SIGNATURE");
    mockConfirmSolana.mockResolvedValue({ status: "confirmed" });
  });

  it("prepares via the sole-signer/fresh-blockhash primitive, stages signature + evidence with nonce NULL, then confirms", async () => {
    const staged: Array<{
      txHash: string; fromAddress: string; nonce: number | null;
      recentBlockhash?: string; lastValidBlockHeight?: number;
    }> = [];
    const outcome = await signStageKhalaniLeg(solLeg(), SOL_CHAIN, [SOL_CHAIN], SOL, {
      onHashStaged: async (h) => { staged.push(h); },
      onAccepted: async () => {},
    });
    expect(mockPrepareVersionedTx).toHaveBeenCalledTimes(1);
    const [txArg, keypairArg] = mockPrepareVersionedTx.mock.calls[0]!;
    expect(txArg).toBe("base64tx");
    expect((keypairArg as { publicKey: { toBase58(): string } }).publicKey.toBase58()).toBe(SOL.address);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.txHash).toBe("BASE58SIGNATURE"); // signature, not a hash
    expect(staged[0]!.nonce).toBeNull(); // B1 nonce matrix — Solana never carries a nonce
    expect(staged[0]!.fromAddress).toBe(SOL.address);
    // W5 §2/R2b: the fresh blockhash evidence prepareVersionedTx produced is
    // threaded through the SAME staged-hash callback — no second write.
    expect(staged[0]!.recentBlockhash).toBe(PREPARED.recentBlockhash);
    expect(staged[0]!.lastValidBlockHeight).toBe(PREPARED.lastValidBlockHeight);
    // No EVM block to anchor on — a Solana plan never estimates EVM gas.
    expect(outcome).toEqual({ kind: "confirmed", txHash: "BASE58SIGNATURE", settledAtBlock: null });
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

  it("a prepareVersionedTx refusal (e.g. sole-signer violation) aborts BEFORE any hash is staged or broadcast", async () => {
    mockPrepareVersionedTx.mockRejectedValueOnce(
      new VexError(ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION, "Refusing to sign: not the sole required signer."),
    );
    const staged: unknown[] = [];
    await expect(signStageKhalaniLeg(solLeg(), SOL_CHAIN, [SOL_CHAIN], SOL, {
      onHashStaged: async (h) => { staged.push(h); },
      onAccepted: async () => {},
    })).rejects.toThrow(/sole required signer/);
    expect(staged).toHaveLength(0);
    expect(mockBroadcastSolana).not.toHaveBeenCalled();
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
