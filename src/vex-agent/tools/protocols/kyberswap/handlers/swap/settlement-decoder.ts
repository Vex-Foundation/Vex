/**
 * The KyberSwap settlement decoder for the repair sweep, registered once at
 * module load (imported for that side effect by `handlers/swap.ts`).
 *
 * Separate from `chain-native.ts` on purpose: this module HAS a load-time side
 * effect, so a caller that only wants the pure lookups must not be forced to
 * trigger a registration.
 */

import { NATIVE_TOKEN_ADDRESS, META_AGGREGATION_ROUTER_V2 } from "@tools/kyberswap/constants.js";
import { decodeKyberSwapSettlement } from "@tools/kyberswap/evm-utils.js";
import { isRecord } from "@utils/validation-helpers.js";
import { registerSettlementDecoder } from "@vex-agent/sync/settlement-decoders.js";
import { chainIdToSlugSafe, tryGetWrappedNativeAddress } from "./chain-native.js";
import { PROTOCOL } from "./protocol-id.js";

interface KyberSettlementReceipt {
  readonly logs: ReadonlyArray<{ address: string; topics: readonly string[]; data: string }>;
}

function isKyberSettlementReceipt(value: unknown): value is KyberSettlementReceipt {
  return isRecord(value) && Array.isArray(value.logs);
}

registerSettlementDecoder(PROTOCOL, (input) => {
  if (!isKyberSettlementReceipt(input.receipt)) return null;
  if (input.tokenInAddress === null || input.tokenOutAddress === null) return null;

  const isNativeAddr = (addr: string) => addr.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();
  const decoded = decodeKyberSwapSettlement({
    logs: input.receipt.logs,
    walletAddress: input.walletAddress,
    tokenIn: { isNative: isNativeAddr(input.tokenInAddress), address: input.tokenInAddress },
    tokenOut: { isNative: isNativeAddr(input.tokenOutAddress), address: input.tokenOutAddress },
    // A native tokenIn leg's executed amount is a certainty of the signed
    // transaction's own value, never a log — Kyber is exact-input, so a mined
    // SUCCESS receipt proves the full signed value left the wallet. The row
    // ALREADY persists exactly that value in `amount_in_raw` (the handler
    // records `buildResp.data.transactionValue` for a native leg, C21 in
    // `execute-plan.ts`), so the sweep can hand it back here and this decoder
    // needs no transaction fetch and no new column. Passed ONLY for a native
    // leg: for an ERC-20 leg the same field is the REQUESTED amount, which
    // must never masquerade as a settlement (see the field's contract in
    // `settlement-decoders.ts`).
    nativeAmountInRaw: isNativeAddr(input.tokenInAddress)
      ? (input.amountInRaw ?? undefined)
      : undefined,
    wrappedNativeAddress: (() => {
      const slug = chainIdToSlugSafe(input.chainId);
      return slug ? tryGetWrappedNativeAddress(slug) : undefined;
    })(),
    // C21 (Codex final-review finding 6): bind the WETH Withdrawal event to
    // the router that actually unwraps it. The aggregator router is the SAME
    // fixed address on every Kyber-supported chain, so — unlike the signed
    // tx's own native-in value — this one IS available without any per-row
    // context.
    wrappedNativeWithdrawalSource: META_AGGREGATION_ROUTER_V2,
  });
  return decoded
    ? {
        executedAmountInRaw: decoded.amountInRaw,
        executedAmountOutRaw: decoded.amountOutRaw,
      }
    : null;
});
