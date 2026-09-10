/** Native settlement evidence shared by readers and durable writers, without RPC setup. */
export const NATIVE_BALANCE_BOUND_SOURCE = "native_balance_delta_bound";
export const V4_NATIVE_DECODER_VERSION = "2026-09-10.uniswap-v4-native-bound";

export type NativeBalanceEvidence =
  | { readonly kind: "bound"; readonly inputLowerBound: bigint; readonly outputCredit: bigint;
      readonly gasCost: bigint; readonly blockHash: string; readonly blockNumber: bigint }
  | { readonly kind: "unavailable"; readonly reason: string };
export interface NativeBalanceRpc {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
}
