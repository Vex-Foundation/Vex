import { expect, it, vi } from "vitest";
import { assertReservedNonceMatchesPending } from "@tools/evm-chains/nonce-signing-guard.js";

it.each([[2, 1, "local_nonce_ledger_ahead"], [1, 2, "local_nonce_ledger_behind"]] as const)("refuses reserved %s against pending %s", async (reserved, pending, reason) => {
  const getTransactionCount = vi.fn(async () => pending);
  await expect(assertReservedNonceMatchesPending({ getTransactionCount }, "0x1111111111111111111111111111111111111111", 8453, reserved))
    .rejects.toMatchObject({ name: "EvmNonceMismatchError", status: "not_attempted", retryable: true, failureCode: "broadcast_error", reason });
  expect(getTransactionCount).toHaveBeenCalledWith({ address: "0x1111111111111111111111111111111111111111", blockTag: "pending" });
});

import { createPublicClient, createWalletClient, custom } from "viem";
import { base } from "viem/chains";
import { signStageBroadcast } from "@tools/evm-chains/staged-broadcast.js";
import { onNonceReservationScopeExit } from "@tools/evm-chains/nonce-reservation-scope.js";

it.each([6, 8])("refuses nonce %s in the real staged signer and releases the reservation", async reserved => {
  const address = "0x1111111111111111111111111111111111111111";
  const signer = vi.fn(async (): Promise<never> => { throw new Error("disabled signer"); });
  const transport = custom({ request: async ({ method }) => {
    if (method === "eth_estimateGas") return "0x5208";
    if (method === "eth_getTransactionCount") return "0x7";
    throw new Error(`Unexpected method ${method}`);
  } }, { retryCount: 0 });
  const publicClient = Object.assign(createPublicClient({ chain: base, transport }), {
    prepareTransactionRequest: async () => ({ to: address, chainId: 8453, nonce: 6, gas: 21000n, type: "eip1559" as const, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }),
  });
  const wallet = createWalletClient({ chain: base, transport, account: { address, type: "local", source: "custom", publicKey: "0x", signTransaction: signer, signMessage: signer, signTypedData: signer } });
  const release = vi.fn(async () => {});
  const stage = vi.fn(async () => {});
  await expect(signStageBroadcast(publicClient, { kind: "deferred", address, chain: base, onBeforeSign: async () => {}, createSigner: async () => wallet },
    { to: address, data: "0x" }, { onNonceReserved: async () => { onNonceReservationScopeExit(release); return reserved; }, onHashStaged: stage, onAccepted: async () => {} }))
    .rejects.toMatchObject({ name: "EvmNonceMismatchError", status: "not_attempted", retryable: true });
  expect(signer).not.toHaveBeenCalled();
  expect(stage).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});
