/** Isolated-block native input lower bounds. Never an exact spend claim. */
import { z } from "zod";
import { encodeFunctionData, parseAbi, getAddress, type Hex } from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import { rpcReadFailureOf } from "../evm-chains/rpc-read-failure.js";

import type { NativeBalanceEvidence, NativeBalanceRpc } from "./v4-native-types.js";
export { NATIVE_BALANCE_BOUND_SOURCE, V4_NATIVE_DECODER_VERSION } from "./v4-native-types.js";
export type { NativeBalanceEvidence, NativeBalanceRpc } from "./v4-native-types.js";
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const quantity = z.string().max(66).regex(/^0x[0-9a-fA-F]+$/).transform(BigInt);
const receiptSchema = z.object({ transactionHash: hash, blockHash: hash, blockNumber: quantity,
  from: address, to: address, status: z.literal("0x1"), gasUsed: quantity, effectiveGasPrice: quantity,
  l1Fee: quantity.nullish(), operatorFeeScalar: quantity.nullish(), operatorFeeConstant: quantity.nullish() });
const transactionSchema = z.object({ hash, from: address, to: address.nullable(), value: quantity,
  type: quantity, authorizationList: z.array(z.unknown()).optional() });
const blockSchema = z.object({ hash, parentHash: hash, number: quantity, transactions: z.array(transactionSchema) });
// viem 2.54.3 op-stack/abis.ts and contracts.ts. A missing fee field is not zero.
const operatorFeeAbi = parseAbi(["function operatorFeeScalar() view returns (uint32)", "function operatorFeeConstant() view returns (uint64)"]);
const authorizationSchema = z.object({ address, chainId: quantity, nonce: quantity, yParity: quantity, r: hash, s: hash });

/** Structural RPC boundary, following the repair owner's asJsonRpcClient. */
export function nativeBalanceRpc(client: unknown): NativeBalanceRpc {
  if (!client || typeof client !== "object" || !("request" in client) || typeof client.request !== "function") {
    throw new Error("Native balance evidence requires a read-only RPC client");
  }
  return client as NativeBalanceRpc;
}

export async function readV4NativeBalanceEvidence(client: NativeBalanceRpc, input: {
  readonly chainId: number; readonly wallet: string; readonly txHash: string; readonly router: string;
}): Promise<NativeBalanceEvidence> {
  const unavailable = (reason: string): NativeBalanceEvidence => ({ kind: "unavailable", reason });
  try {
    const r = receiptSchema.parse(await client.request({ method: "eth_getTransactionReceipt", params: [input.txHash] }));
    if (r.transactionHash.toLowerCase() !== input.txHash.toLowerCase()
      || r.from.toLowerCase() !== input.wallet.toLowerCase() || r.to.toLowerCase() !== input.router.toLowerCase()
      || r.blockNumber === 0n) return unavailable("native_balance_receipt_mismatch");
    const b = blockSchema.parse(await client.request({ method: "eth_getBlockByHash", params: [r.blockHash, true] }));
    if (b.hash.toLowerCase() !== r.blockHash.toLowerCase() || b.number !== r.blockNumber) return unavailable("native_balance_block_mismatch");
    const own = b.transactions.filter(tx => tx.hash.toLowerCase() === input.txHash.toLowerCase());
    if (own.length !== 1 || own[0]?.from.toLowerCase() !== input.wallet.toLowerCase()
      || own[0]?.to?.toLowerCase() !== input.router.toLowerCase()) return unavailable("native_balance_transaction_missing");
    if (!own[0] || ![0n, 1n, 2n].includes(own[0].type)) return unavailable("native_balance_fee_shape_unsupported");
    if (b.transactions.some(tx => tx.hash.toLowerCase() !== input.txHash.toLowerCase()
      && (tx.from.toLowerCase() === input.wallet.toLowerCase() || tx.to?.toLowerCase() === input.wallet.toLowerCase()))) {
      return unavailable("native_balance_block_not_isolated");
    }
    // EIP-7702 can install wallet code from another sender. Recover public
    // authorities transiently; never retain authorization signatures in evidence.
    for (const tx of b.transactions) {
      if (tx.type === 4n && tx.authorizationList === undefined) return unavailable("native_balance_eoa_not_proven");
      for (const item of tx.authorizationList ?? []) {
        const a = authorizationSchema.parse(item);
        if (a.chainId > BigInt(Number.MAX_SAFE_INTEGER) || a.nonce > BigInt(Number.MAX_SAFE_INTEGER)
          || a.yParity > 1n) return unavailable("native_balance_eoa_not_proven");
        const authority = await recoverAuthorizationAddress({ authorization: { address: getAddress(a.address),
          chainId: Number(a.chainId), nonce: Number(a.nonce), yParity: Number(a.yParity), r: a.r as Hex, s: a.s as Hex } });
        if (authority.toLowerCase() === input.wallet.toLowerCase()) return unavailable("native_balance_eoa_not_proven");
      }
    }
    const parent = { blockHash: b.parentHash, requireCanonical: true };
    const mined = { blockHash: b.hash, requireCanonical: true };
    const code = await client.request({ method: "eth_getCode", params: [input.wallet, parent] });
    if (code !== "0x") return unavailable("native_balance_eoa_not_proven");
    const before = quantity.parse(await client.request({ method: "eth_getBalance", params: [input.wallet, parent] }));
    const after = quantity.parse(await client.request({ method: "eth_getBalance", params: [input.wallet, mined] }));
    if ((input.chainId === 10 || input.chainId === 8453) && r.l1Fee == null) return unavailable("native_balance_l1_fee_missing");
    if (input.chainId === 10 || input.chainId === 8453) {
      for (const [functionName, provided] of [["operatorFeeScalar", r.operatorFeeScalar], ["operatorFeeConstant", r.operatorFeeConstant]] as const) {
        const fee = provided ?? quantity.parse(await client.request({ method: "eth_call", params: [{
          to: "0x4200000000000000000000000000000000000015", data: encodeFunctionData({ abi: operatorFeeAbi, functionName }),
        }, mined] }));
        if (fee !== 0n) return unavailable("native_balance_fee_shape_unsupported");
      }
    }
    const gasCost = r.gasUsed * r.effectiveGasPrice + (r.l1Fee ?? 0n);
    const delta = before - after - gasCost;
    const inputLowerBound = delta > 0n ? delta : 0n;
    if (!own[0] || inputLowerBound > own[0].value) return unavailable("native_balance_debit_exceeds_value");
    return { kind: "bound", inputLowerBound, outputCredit: -delta, gasCost,
      blockHash: b.hash, blockNumber: b.number };
  } catch (error) {
    return unavailable(rpcReadFailureOf(error)?.failureClass === "archive_gated"
      ? "native_balance_archive_gated" : "native_balance_evidence_unavailable");
  }
}
