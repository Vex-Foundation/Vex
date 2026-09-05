/**
 * The pre-sign native-value gate inside `signStageEvmLeg` — the last thing
 * standing between an unexplained native charge and the signing key.
 *
 * Why this suite exists
 * ---------------------
 * `bridge-executor.ts` took Khalani's provider-supplied `value` straight into
 * the normalized transaction and signed it. Live on Base (2026-07-25) that was
 * a deBridge deposit carrying 1e15 wei (0.001 ETH, ~$1.86) present in NEITHER
 * `amountIn` NOR `amountOut` NOR `estimatedGas`: on a $2 bridge the all-in cost
 * was 128% of principal, and the charge was never disclosed or authorized.
 *
 * The gate is deliberately inside the signer rather than only in the handler,
 * so "never sign a value you could not classify" is a property of the signing
 * path and not a convention every future caller must remember. What this suite
 * pins is the part that matters most on a real-funds path: when it refuses,
 * NOTHING is signed — no client is even constructed, no gas is estimated, no
 * hash is staged, nothing is broadcast.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

import type { EvmWallet } from "@tools/wallet/multi-auth.js";

function createEvmWallet(): EvmWallet {
  const privateKey = generatePrivateKey();
  return { family: "eip155", address: privateKeyToAddress(privateKey), privateKey };
}

const EVM = createEvmWallet();

const mockPrepare = vi.fn();
const mockSign = vi.fn();
const mockSendRaw = vi.fn();
const mockWaitReceipt = vi.fn();
const mockEstimateGas = vi.fn();
const mockGetBlockNumber = vi.fn();
const mockWalletClientFactory = vi.fn();
const mockPublicClientFactory = vi.fn();

vi.mock("@tools/khalani/evm-client.js", () => ({
  createDynamicWalletClient: (...a: unknown[]) => {
    mockWalletClientFactory(...a);
    return {
      account: { address: EVM.address },
      chain: { id: 8453 },
      prepareTransactionRequest: (...p: unknown[]) => mockPrepare(...p),
      signTransaction: (...p: unknown[]) => mockSign(...p),
    };
  },
  createDynamicPublicClient: (...a: unknown[]) => {
    mockPublicClientFactory(...a);
    return {
      estimateGas: (...p: unknown[]) => mockEstimateGas(...p),
      getBlockNumber: (...p: unknown[]) => mockGetBlockNumber(...p),
      sendRawTransaction: (...p: unknown[]) => mockSendRaw(...p),
      waitForTransactionReceipt: (...p: unknown[]) => mockWaitReceipt(...p),
    };
  },
}));

vi.mock("@tools/khalani/chains.js", () => ({
  getChainRpcUrl: () => "https://rpc.example",
}));

import {
  khalaniLegNativeValueCall,
  planKhalaniDepositLegs,
  signStageKhalaniLeg,
  type KhalaniStagedLeg,
  type NormalizedEvmTx,
} from "@tools/khalani/bridge-executor.js";
import {
  classifyNativeValue,
  evaluateNativeValueAuthorization,
} from "@tools/evm-chains/native-value-authorization/index.js";
import { VexError, ErrorCodes } from "../../errors.js";

const BASE_CHAIN = {
  id: 8453,
  name: "Base",
  type: "eip155" as const,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};

const DEPOSIT_TARGET: Address = getAddress("0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa");
const UNDISCLOSED_NATIVE_CHARGE = 1_000_000_000_000_000n; // the live 1e15 wei

/**
 * The origin binding the planner needs for the approve rules. Every plan in
 * this suite is native-origin and carries no approval leg, so the binding is
 * never the subject here - it names the native asset, which is exactly what an
 * approval-free plan bridges.
 */
const ORIGIN = {
  fromToken: "0x0000000000000000000000000000000000000000",
  wallet: getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA"),
  bridgedAmountRaw: "3000000000000000",
};

const noopHooks = {
  onNonceReserved: vi.fn(async (request: { nodePendingNonce: number }) => request.nodePendingNonce),
  onHashStaged: vi.fn(async () => {}),
  onAccepted: vi.fn(async () => {}),
};

type EvmStagedLeg = Extract<KhalaniStagedLeg, { kind: "evm" }>;

function evmLeg(tx: NormalizedEvmTx): EvmStagedLeg {
  return {
    role: "bridge_deposit",
    purpose: "bridge",
    family: "eip155",
    isDeposit: true,
    kind: "evm",
    tx,
    nativeValue: classifyNativeValue({ call: khalaniLegNativeValueCall(BASE_CHAIN.id, tx) }),
  };
}

/** Nothing reached the key, the node, or the ledger. */
function expectNothingSigned(): void {
  expect(mockWalletClientFactory).not.toHaveBeenCalled();
  expect(mockPublicClientFactory).not.toHaveBeenCalled();
  expect(mockEstimateGas).not.toHaveBeenCalled();
  expect(mockPrepare).not.toHaveBeenCalled();
  expect(mockSign).not.toHaveBeenCalled();
  expect(mockSendRaw).not.toHaveBeenCalled();
  expect(noopHooks.onHashStaged).not.toHaveBeenCalled();
  expect(noopHooks.onAccepted).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEstimateGas.mockResolvedValue(120_000n);
  mockGetBlockNumber.mockResolvedValue(34_567_890n);
  mockPrepare.mockResolvedValue({ nonce: 3, to: DEPOSIT_TARGET });
  mockSign.mockResolvedValue("0xabcdef");
  mockSendRaw.mockResolvedValue(undefined);
  mockWaitReceipt.mockResolvedValue({ status: "success", blockNumber: 34_567_890n });
});

describe("an unclassified native charge refuses with NOTHING signed", () => {
  it("refuses a provider-supplied value no prover explained", async () => {
    const leg = evmLeg({ to: DEPOSIT_TARGET, data: "0xdeadbeef", value: UNDISCLOSED_NATIVE_CHARGE });
    // Precondition: the planner really did leave it unauthorized.
    expect(evaluateNativeValueAuthorization(leg.nativeValue).ok).toBe(false);

    const err = await signStageKhalaniLeg(leg, BASE_CHAIN, [BASE_CHAIN], EVM, noopHooks)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VexError);
    expect((err as VexError).code).toBe(ErrorCodes.NATIVE_VALUE_UNAUTHORIZED);
    expect((err as VexError).message).toMatch(/could not be attributed to a proven cost component/);
    expectNothingSigned();
  });

  it("says nothing was signed, so an agent knows it may re-quote", async () => {
    const leg = evmLeg({ to: DEPOSIT_TARGET, data: "0xdeadbeef", value: UNDISCLOSED_NATIVE_CHARGE });

    const err = await signStageKhalaniLeg(leg, BASE_CHAIN, [BASE_CHAIN], EVM, noopHooks)
      .catch((e: unknown) => e);

    expect((err as VexError).message).toMatch(/Refused before signing/);
    expect((err as VexError).hint).toMatch(/Nothing was signed/);
  });

  it("refuses when the value GREW after classification (fingerprint mismatch)", async () => {
    // The authorization is honest and complete for 1 wei; the transaction
    // handed to the signer sends far more. Re-validation at the signing
    // boundary is the only thing that catches this.
    const authorizedTx = { to: DEPOSIT_TARGET, value: 1n };
    const authorized = evmLeg(authorizedTx);
    const swapped: EvmStagedLeg = {
      ...authorized,
      kind: "evm",
      tx: { to: DEPOSIT_TARGET, value: UNDISCLOSED_NATIVE_CHARGE },
    };

    const err = await signStageKhalaniLeg(swapped, BASE_CHAIN, [BASE_CHAIN], EVM, noopHooks)
      .catch((e: unknown) => e);

    expect((err as VexError).code).toBe(ErrorCodes.NATIVE_VALUE_UNAUTHORIZED);
    expect((err as VexError).message).toMatch(/not the one whose native value was authorized/);
    expectNothingSigned();
  });

  it("refuses when the TARGET changed after classification", async () => {
    const authorized = evmLeg({ to: DEPOSIT_TARGET, value: 0n });
    const redirected: EvmStagedLeg = {
      ...authorized,
      kind: "evm",
      tx: { to: getAddress(EVM.address), value: 0n },
    };

    const err = await signStageKhalaniLeg(redirected, BASE_CHAIN, [BASE_CHAIN], EVM, noopHooks)
      .catch((e: unknown) => e);

    expect((err as VexError).code).toBe(ErrorCodes.NATIVE_VALUE_UNAUTHORIZED);
    expectNothingSigned();
  });
});

describe("legitimate legs still sign", () => {
  it("an ERC-20 leg sends no value and passes the gate", async () => {
    const leg = evmLeg({ to: DEPOSIT_TARGET, data: "0xa9059cbb" });

    const outcome = await signStageKhalaniLeg(leg, BASE_CHAIN, [BASE_CHAIN], EVM, noopHooks);

    expect(outcome.kind).toBe("confirmed");
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(noopHooks.onHashStaged).toHaveBeenCalledTimes(1);
  });

  it("a NATIVE TRANSFER deposit is proven by the planner and is NOT refused", async () => {
    // The live native path (`isNativeTransferToken` → `value: BigInt(plan.amount)`).
    // A `tx.value == fixedFee` rule would have bricked exactly this leg; the
    // correct equality is `tx.value − nativePrincipal == fixedFee`, so a plan
    // whose whole value IS the principal authorizes cleanly with no fee at all.
    const legs = planKhalaniDepositLegs(
      {
        kind: "TRANSFER",
        depositAddress: DEPOSIT_TARGET,
        amount: "3000000000000000",
        token: "0x0000000000000000000000000000000000000000",
        chainId: 8453,
      },
      BASE_CHAIN,
      null,
      ORIGIN,
    );

    expect(legs).toHaveLength(1);
    const leg = legs[0]!;
    if (leg.kind !== "evm") throw new Error("expected an EVM leg");
    expect(leg.tx.value).toBe(3_000_000_000_000_000n);
    expect(evaluateNativeValueAuthorization(leg.nativeValue)).toEqual({ ok: true });
    expect(leg.nativeValue.components.map((c) => c.kind)).toEqual(["native_principal"]);

    const outcome = await signStageKhalaniLeg(leg, BASE_CHAIN, [BASE_CHAIN], EVM, noopHooks);

    expect(outcome.kind).toBe("confirmed");
    expect(mockSign).toHaveBeenCalledTimes(1);
  });

  it("the planner leaves a provider CONTRACT_CALL value unclassified (the live defect)", () => {
    const legs = planKhalaniDepositLegs(
      {
        kind: "CONTRACT_CALL",
        approvals: [
          {
            type: "eip1193_request",
            request: {
              method: "eth_sendTransaction",
              params: [{
                to: DEPOSIT_TARGET,
                data: "0xdeadbeef",
                value: `0x${UNDISCLOSED_NATIVE_CHARGE.toString(16)}`,
              }],
            },
            deposit: true,
          },
        ],
      },
      BASE_CHAIN,
      null,
      ORIGIN,
    );

    const leg = legs[0]!;
    if (leg.kind !== "evm") throw new Error("expected an EVM leg");
    expect(leg.tx.value).toBe(UNDISCLOSED_NATIVE_CHARGE);
    // Network-free planning cannot prove a protocol fee, so it must NOT claim
    // one. The unclassified remainder is what forces the handler to run the
    // prover before anything is recorded or signed.
    expect(evaluateNativeValueAuthorization(leg.nativeValue).ok).toBe(false);
    expect(leg.nativeValue.components.map((c) => c.kind)).toEqual(["unclassified"]);
  });

  it("a provider CONTRACT_CALL with NO value authorizes offline (the ERC-20 norm)", () => {
    const legs = planKhalaniDepositLegs(
      {
        kind: "CONTRACT_CALL",
        approvals: [
          {
            type: "eip1193_request",
            request: { method: "eth_sendTransaction", params: [{ to: DEPOSIT_TARGET, data: "0xdeadbeef" }] },
            deposit: true,
          },
        ],
      },
      BASE_CHAIN,
      null,
      ORIGIN,
    );

    const leg = legs[0]!;
    if (leg.kind !== "evm") throw new Error("expected an EVM leg");
    expect(evaluateNativeValueAuthorization(leg.nativeValue)).toEqual({ ok: true });
    expect(leg.nativeValue.components).toEqual([]);
  });
});
