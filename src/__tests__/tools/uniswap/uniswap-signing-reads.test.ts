import { expect, it, vi } from "vitest";
import { createPublicClient, createWalletClient, custom, defineChain } from "viem";
import { signUniswapTransaction } from "@tools/uniswap/execute.js";

it("estimates from the same address without auto-preparing a second nonce and fee set", async () => {
  const address = "0x1111111111111111111111111111111111111111";
  const methods: string[] = [];
  const signer = vi.fn(async (): Promise<never> => { throw new Error("disabled signer"); });
  const chain = defineChain({ id: 8453, name: "read-count fixture", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
  const transport = custom({ request: async ({ method, params }) => {
    methods.push(method);
    if (method === "eth_estimateGas") {
      const request = (params as readonly [{ from: string; value: string }])[0];
      expect(request.from.toLowerCase()).toBe(address);
      expect(request.value).toBe("0x64");
      return "0x5208";
    }
    if (method === "eth_getTransactionCount") return "0x1";
    if (method === "eth_maxPriorityFeePerGas") return "0x1";
    if (method === "eth_getBlockByNumber") return { number: "0x1", baseFeePerGas: "0x1", timestamp: "0x1", transactions: [] };
    throw new Error(`Unexpected preparation method ${method}`);
  } }, { retryCount: 0 });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account: { address, type: "local", source: "custom", publicKey: "0x",
    signTransaction: signer, signMessage: signer, signTypedData: signer } });
  await expect(signUniswapTransaction(publicClient, walletClient, { to: address, data: "0x", value: 100n }, undefined,
    async request => request.nodePendingNonce, undefined,
    { cap: { mode: "eip1559", maxFeePerGasWei: 10n, maxPriorityFeePerGasWei: 1n } })).rejects.toThrow("disabled signer");
  expect(signer).toHaveBeenCalledOnce();
  expect(methods).toEqual(["eth_estimateGas", "eth_getTransactionCount", "eth_getBlockByNumber", "eth_maxPriorityFeePerGas", "eth_getTransactionCount"]);
});
