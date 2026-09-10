import { EvmNonceReservationExpiredError } from "@tools/evm-chains/nonce-reservation-scope.js";
import { beforeEach, expect, it, vi } from "vitest";
import { createPublicClient, createWalletClient, custom, defineChain } from "viem";
import { runUniswapFeeLeg } from "@vex-agent/tools/protocols/uniswap/handlers/swap/fee/run.js";

import { UniswapPreSignDebitRefusal } from "@vex-agent/tools/protocols/uniswap/handlers/swap/quote-spendability.js";
import { ErrorCodes } from "../../../errors.js";
import { failHashlessActivityEvent } from "@vex-agent/db/repos/agent-activity.js";

beforeEach(() => vi.clearAllMocks());
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  reserveActivityEvmNonce: vi.fn(async (_id, r) => r.nodePendingNonce),
  markActivityBroadcast: vi.fn(), markBroadcastAccepted: vi.fn(), confirmActivityEvent: vi.fn(),
  failActivityEvent: vi.fn(async () => ({ applied: true })),
  failHashlessActivityEvent: vi.fn(async () => ({ applied: true })),
}));

it.each([[137, false, false], [4663, false, false], [137, true, false], [4663, true, false], [137, false, true], [137, "expired", false]] as const)("prepares chain %s fee at the approved cap, debit refusal=%s, price drift=%s", async (chainId, refused, priceDrift) => {
  const address = "0x1111111111111111111111111111111111111111";
  const methods: string[] = [];
  const signer = vi.fn(async (): Promise<never> => { throw new Error("disabled signer"); });
  const chain = defineChain({ id: chainId, name: "fee fixture", nativeCurrency: { name: "native", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
  const transport = custom({ request: async ({ method }) => {
    methods.push(method);
    if (method === "eth_estimateGas") return "0x5208";
    if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
    if (method === "eth_getTransactionCount") return "0x1";
    if (method === "eth_getBlockByNumber") return { number: "0x1", baseFeePerGas: "0x64", timestamp: "0x1", transactions: [] };
    if (method === "eth_maxPriorityFeePerGas") return priceDrift ? "0x2" : "0x1";
    if (method === "eth_fillTransaction") return { tx: { from: address, to: address, value: "0x64", data: "0x", nonce: "0x1", gas: "0x5208", chainId: `0x${chainId.toString(16)}`, type: "0x2", maxFeePerGas: "0xf1", maxPriorityFeePerGas: "0x1" } };
    throw new Error(`Unexpected RPC method ${method}`);
  } }, { retryCount: 0 });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account: { address, type: "local", source: "custom", publicKey: "0x", signTransaction: signer, signMessage: signer, signTypedData: signer } });
  const debitGate = vi.fn(async (r: { maxFeePerGas?: bigint }) => { expect(r.maxFeePerGas).toBe(121n);
    if (refused === "expired") throw new EvmNonceReservationExpiredError();
    if (refused) throw new UniswapPreSignDebitRefusal(ErrorCodes.INSUFFICIENT_BALANCE, "Refusing to sign: remaining native balance is insufficient.", "Top up the native balance.", false);
  });
  const result = await runUniswapFeeLeg({ chainId, tokenDecimals: 18, feeRowId: 1, publicClient, walletClient, debitGate,
    feeCap: { mode: "eip1559", maxFeePerGasWei: 121n, maxPriorityFeePerGasWei: 1n },
    plan: { feeRaw: 100n, isNativeValue: true, txParams: { to: address, data: "0x", value: 100n },
      event: { eventRole: "swap_fee", kind: "swap", protocol: "uniswap", chainId, chainSlug: "fixture", walletAddress: address, sessionId: "fixture" } },
  });
  if (priceDrift) {
    expect(debitGate).not.toHaveBeenCalled();
    expect(signer).not.toHaveBeenCalled();
    expect(result.collectionNote).toContain("exceeds this fee leg's approved cap");
    expect(result.collectionNote).not.toContain("uniswap__swap_quote");
  } else {
    expect(debitGate).toHaveBeenCalledOnce();
  }
  if (refused) {
    expect(signer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ collection: "not_attempted", txHash: null, collectionNote: expect.stringContaining(refused === "expired" ? "fee signing lease expired" : "remaining native balance is insufficient") });
    expect(result.collectionNote).toContain("No fee retry happens automatically");
    expect(failHashlessActivityEvent).toHaveBeenCalledWith(1, { failureCode: refused === "expired" ? "broadcast_error" : "allowance_or_balance", failureReason: result.collectionNote });
  } else if (!priceDrift) expect(signer).toHaveBeenCalledOnce();
  expect(methods).not.toContain("eth_fillTransaction");
});
