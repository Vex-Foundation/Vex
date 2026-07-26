/**
 * Which input tokens Vex will take a bridge fee from.
 *
 * WHY THIS EXISTS: for a fee-on-transfer (or otherwise taxing) token,
 * `transfer(treasury, fee)` does NOT deliver `fee` — the treasury receives
 * less. The user is still debited exactly `fee`, so nobody is overcharged, but
 * recording "the treasury received `fee`" would be false. Rather than book a
 * number that did not happen, Vex declines the fee on such a token and says so.
 *
 * TWO LAYERS, because the exact answer is available at different costs:
 *
 *  - EVM: KyberSwap's honeypot/FoT oracle (`getHoneypotFotInfo`) is the ONLY
 *    fee-on-transfer detector in this repo. It is reused verbatim here — it is
 *    a TOKEN fact, not a KyberSwap venue fact, and it is already validated at
 *    the HTTP boundary and used on the swap money path
 *    (`kyberswap/handlers/swap.ts`). It covers only the chains KyberSwap
 *    serves; elsewhere the answer is UNKNOWN and the fee is charged under the
 *    "amount sent" semantics the disclosure states explicitly.
 *
 *  - Solana: exact and free. A Token-2022 `TransferFeeConfig` is the on-chain
 *    equivalent, and it lives on the mint account the fee-transfer builder
 *    already reads — see `solana-fee-transfer.ts`, which refuses to build a
 *    leg for such a mint.
 */

import { chainIdToSlug } from "../kyberswap/chains.js";
import { getKyberTokenApiClient } from "../kyberswap/token-api/client.js";
import logger from "../../utils/logger.js";
import { isNativeEvmFeeToken } from "./evm-fee-transfer.js";

export type BridgeFeeEligibility =
  | { readonly charge: true }
  | { readonly charge: false; readonly reason: string };

const CHARGE: BridgeFeeEligibility = { charge: true };

/**
 * Decide, BEFORE the venue is quoted, whether the origin token can carry the
 * fee — the quote amount depends on the answer, so it cannot be deferred to
 * broadcast time.
 *
 * FAIL-SOFT by design: a transport failure or a chain KyberSwap does not serve
 * yields `charge: true`. That is not a claim the token is clean — it is the
 * "unknown" case, and the disclosure covers it by defining the recorded fee as
 * the amount SENT to the treasury rather than the amount credited.
 */
export async function evaluateEvmBridgeFeeEligibility(
  chainId: number,
  tokenAddress: string,
): Promise<BridgeFeeEligibility> {
  // Native coins have no transfer hook and no tax — a value transfer always
  // delivers exactly what it sends.
  if (isNativeEvmFeeToken(tokenAddress)) return CHARGE;
  if (chainIdToSlug(chainId) === undefined) return CHARGE;

  try {
    const info = await getKyberTokenApiClient().getHoneypotFotInfo(chainId, tokenAddress);
    if (info.isHoneypot) {
      return { charge: false, reason: "the origin token is flagged as a honeypot, so Vex does not transfer it" };
    }
    if (info.isFOT || info.tax > 0) {
      return {
        charge: false,
        reason:
          `the origin token is fee-on-transfer (${info.tax}% tax), so a treasury transfer would not deliver `
          + "the stated amount",
      };
    }
    return CHARGE;
  } catch (err) {
    logger.warn("bridge_fee.fot_check_failed", {
      chainId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return CHARGE;
  }
}
