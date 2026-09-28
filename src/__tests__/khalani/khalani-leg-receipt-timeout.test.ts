/**
 * Kairos S-5 — the Khalani leg's receipt wait has an EXPLICIT bound.
 *
 * viem's implicit default is 180 s. The leg now passes the shared per-chain
 * receipt deadline, and a wait that reaches it ends as `ambiguous` at the
 * `confirm` stage: the handler records the leg as pending and reconciliation
 * resolves it. The broadcast is never repeated.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAddress, WaitForTransactionReceiptTimeoutError, type Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

import type { EvmWallet } from "@tools/wallet/multi-auth.js";

const privateKey = generatePrivateKey();
const EVM: EvmWallet = { family: "eip155", address: privateKeyToAddress(privateKey), privateKey };

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
    prepareTransactionRequest: (...p: unknown[]) => mockPrepare(...p),
    signTransaction: (...p: unknown[]) => mockSign(...p),
  }),
  createDynamicPublicClient: () => ({
    estimateGas: (...p: unknown[]) => mockEstimateGas(...p),
    getBlockNumber: (...p: unknown[]) => mockGetBlockNumber(...p),
    sendRawTransaction: (...p: unknown[]) => mockSendRaw(...p),
    waitForTransactionReceipt: (...p: unknown[]) => mockWaitReceipt(...p),
  }),
}));

vi.mock("@tools/khalani/chains.js", () => ({
  getChainRpcUrl: () => "https://rpc.example",
}));

import {
  khalaniLegNativeValueCall,
  signStageKhalaniLeg,
  type KhalaniStagedLeg,
  type NormalizedEvmTx,
} from "@tools/khalani/bridge-executor.js";
import { classifyNativeValue } from "@tools/evm-chains/native-value-authorization/index.js";
import { receiptWaitDeadlineMs } from "@tools/evm-chains/receipt-wait-policy.js";

const BASE_CHAIN = {
  id: 8453,
  name: "Base",
  type: "eip155" as const,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};

const TARGET: Address = getAddress("0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa");

const hooks = {
  onNonceReserved: vi.fn(async (request: { nodePendingNonce: number }) => request.nodePendingNonce),
  onHashStaged: vi.fn(async () => {}),
  onAccepted: vi.fn(async () => {}),
};

function zeroValueLeg(): Extract<KhalaniStagedLeg, { kind: "evm" }> {
  const tx: NormalizedEvmTx = { to: TARGET, data: "0xdeadbeef", value: 0n };
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

beforeEach(() => {
  vi.clearAllMocks();
  mockEstimateGas.mockResolvedValue(120_000n);
  mockGetBlockNumber.mockResolvedValue(34_567_890n);
  mockPrepare.mockResolvedValue({ nonce: 3, to: TARGET });
  mockSign.mockResolvedValue("0xabcdef");
  mockSendRaw.mockResolvedValue(undefined);
  mockWaitReceipt.mockResolvedValue({ status: "success", blockNumber: 34_567_890n, logs: [] });
});

describe("Khalani leg receipt wait (S-5)", () => {
  it("passes the shared per-chain deadline instead of viem's implicit 180 s", async () => {
    const outcome = await signStageKhalaniLeg(zeroValueLeg(), BASE_CHAIN, [BASE_CHAIN], EVM, hooks);

    expect(outcome.kind).toBe("confirmed");
    expect(mockWaitReceipt).toHaveBeenCalledTimes(1);
    const [args] = mockWaitReceipt.mock.calls[0] ?? [];
    expect(args).toMatchObject({ timeout: receiptWaitDeadlineMs(BASE_CHAIN.id) });
    expect(receiptWaitDeadlineMs(BASE_CHAIN.id)).toBeLessThan(180_000);
  });

  it("a wait that hits the deadline is PENDING (ambiguous/confirm) and is never resent", async () => {
    mockWaitReceipt.mockRejectedValue(new WaitForTransactionReceiptTimeoutError({ hash: "0x01" }));

    const outcome = await signStageKhalaniLeg(zeroValueLeg(), BASE_CHAIN, [BASE_CHAIN], EVM, hooks);

    expect(outcome.kind).toBe("ambiguous");
    if (outcome.kind !== "ambiguous") return;
    expect(outcome.stage).toBe("confirm");
    expect(outcome.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    // The hash was staged before the send, the send happened once, and nothing
    // after the timeout touched the network again.
    expect(hooks.onHashStaged).toHaveBeenCalledTimes(1);
    expect(mockSendRaw).toHaveBeenCalledTimes(1);
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockWaitReceipt).toHaveBeenCalledTimes(1);
  });
});
