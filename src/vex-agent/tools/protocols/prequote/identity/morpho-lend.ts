/**
 * Morpho vault lend identity builders (E3b-2).
 *
 * ONE BUILDER PAIR, TWO CALLERS, which is the whole point: the
 * `morpho.vault.quote` recorder and the `morpho.vault.deposit` /
 * `morpho.vault.withdraw` EXECUTE gates build IDENTICAL identities from the same
 * fields, so their match-hashes collide and quote-before-transaction can
 * actually be enforced. If the two sides derived a field differently the gate
 * would block every honest execute and nothing would fail to say why.
 *
 * WHAT IS BOUND: chain, vault, the RAW asset amount, the approved slippage, and
 * the selected wallet (as both signer and receiver). What is NOT bound is the
 * quote's optional `walletAddress` PARAM. That param only tells the preview
 * whose allowance to report; the wallet that actually signs is always the
 * session's selected wallet, on both sides. Binding the param would mean a quote
 * taken without it could never authorize anything.
 *
 * DIRECTION IS NOT A FIELD, IT IS THE KIND. The quote carries `direction` and
 * picks the builder from it; the execute tools are one per direction and pick
 * theirs from the toolId. A deposit quote therefore cannot authorize a
 * withdrawal execute even for the same vault and amount.
 *
 * Any throw (missing field, unsupported chain, wallet scope) propagates: the
 * recorder treats it as a bounded skip, the gate as a fail-closed BLOCK.
 */

import { getAddress } from "viem";

import { resolveMorphoChainId } from "@tools/morpho/chains.js";
import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "../../slippage-policy.js";
import { canonSlippageBpsWithDefault } from "../slippage.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { LendDepositMatchInput, LendWithdrawMatchInput } from "./hash.js";

/** The direction-specific amount key. Deliberately NOT interchangeable. */
const AMOUNT_KEY = {
  deposit: "depositAmountRaw",
  withdraw: "withdrawAmountRaw",
} as const;

export type MorphoLendDirection = keyof typeof AMOUNT_KEY;

function pStr(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The leg both directions share: chain id, the checksummed vault, the raw asset
 * amount under the direction's own key, and the selected wallet.
 */
function resolveLendLeg(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  direction: MorphoLendDirection,
) {
  const vaultRaw = pStr(params, "vaultAddress");
  const amount = pStr(params, AMOUNT_KEY[direction]);
  if (!vaultRaw || !amount) {
    throw new VexError(
      ErrorCodes.AGENT_VALIDATION_ERROR,
      `Morpho lend identity missing vaultAddress/${AMOUNT_KEY[direction]}.`,
    );
  }
  const chainId = resolveMorphoChainId(pStr(params, "chain"));
  if (chainId === undefined) {
    throw new VexError(ErrorCodes.MORPHO_UNSUPPORTED_CHAIN, "Morpho lend identity on an unsupported chain.");
  }
  let vault: string;
  try {
    vault = getAddress(vaultRaw);
  } catch {
    throw new VexError(ErrorCodes.MORPHO_INVALID_RESPONSE, "Morpho vault is not a valid address.");
  }
  const wallet = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  return { chainId, vault, wallet, amount };
}

/** Build the canonical Morpho vault DEPOSIT identity (asset in, shares minted). */
export function buildMorphoLendDepositIdentity(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): LendDepositMatchInput {
  const leg = resolveLendLeg(params, context, "deposit");
  return {
    kind: "lend_deposit",
    sessionId,
    provider: "morpho",
    chainId: leg.chainId,
    walletAddress: leg.wallet,
    receiver: leg.wallet,
    vault: leg.vault,
    amount: leg.amount,
    slippageBps: canonSlippageBpsWithDefault(params, VEX_DEFAULT_SLIPPAGE_BPS),
  };
}

/** Build the canonical Morpho vault WITHDRAW identity (shares burned, asset out). */
export function buildMorphoLendWithdrawIdentity(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): LendWithdrawMatchInput {
  const leg = resolveLendLeg(params, context, "withdraw");
  return {
    kind: "lend_withdraw",
    sessionId,
    provider: "morpho",
    chainId: leg.chainId,
    walletAddress: leg.wallet,
    receiver: leg.wallet,
    vault: leg.vault,
    amount: leg.amount,
    slippageBps: canonSlippageBpsWithDefault(params, VEX_DEFAULT_SLIPPAGE_BPS),
  };
}
