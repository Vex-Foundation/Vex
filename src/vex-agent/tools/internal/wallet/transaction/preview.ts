/**
 * The approval-card preview for a decoded proposal.
 *
 * ONE builder for both families, because the card is one renderer. The label is
 * the sentence a user reads before authorizing an irreversible action, so it
 * leads with the EFFECT and never with the mechanism: "Approve UNLIMITED USDC
 * spending for 0x...", not "eth_sendRawTransaction".
 *
 * `criticalArgs` is the bound panel. It carries the decoded arguments verbatim
 * plus the authorized fee ceiling, and every value is a string: an amount that
 * reached the card as a JSON number would already have lost precision before
 * anyone read it.
 */

import type {
  DecodedWalletTransaction,
  WalletTransactionFamily,
  WalletTransactionFeeBounds,
  WalletTransactionPreview,
} from "@vex-agent/db/contracts/wallet-transaction-intent.js";

/**
 * Address ellipsis for the LABEL only. NEVER applied to a `criticalArgs` value:
 * the full address always sits in the bound panel of the same object, so
 * nothing is hidden, only summarised in the one-line headline. This matches
 * `buildWalletIntentPreview` on the transfer path, because the approval card is
 * one renderer and two ellipsis rules would read as two products.
 *
 * KNOWN LIMITATION, recorded rather than papered over: a prefix-and-suffix
 * ellipsis is the exact shape an address-poisoning attack targets, since a
 * lookalike address can be generated to match both ends. The mitigation here is
 * that the full value is one line below in `criticalArgs` and is what the
 * proposal digest binds. Whether the headline itself should carry the whole
 * address is a card-design decision for BOTH paths, not something to change on
 * one of them.
 */
function shortAddress(value: string): string {
  return value.length > 20 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}

function evmLabel(decoded: Extract<DecodedWalletTransaction, { family: "eip155" }>): string {
  const args = decoded.criticalArgs;
  if (decoded.functionName === "nativeTransfer") {
    return `Send ${args.valueWei ?? "0"} wei to ${shortAddress(args.recipient ?? "")}`;
  }
  // The decoder proves an ERC-20 target's identity from calldata layout ALONE,
  // so it flags the result unverified. The headline leads with that: the user
  // must not read "let X spend USDC" as a fact when the target was never proven
  // to be USDC. The full target sits in `criticalArgs` below the headline.
  const unverifiedPrefix = args.tokenIdentityVerified === "false" ? "UNVERIFIED TOKEN - " : "";
  if (decoded.role === "approve") {
    const amount = decoded.unlimitedApproval ? "UNLIMITED" : (args.amountRaw ?? args.addedAmountRaw ?? "");
    return `${unverifiedPrefix}${decoded.standard === "permit2" ? "Permit2 " : ""}${decoded.functionName}: `
      + `let ${shortAddress(args.spender ?? "")} spend ${amount} (raw) of `
      + `${shortAddress(args.token ?? "")}`;
  }
  return `${unverifiedPrefix}Call ${decoded.functionName} on `
    + `${shortAddress(args.token ?? decoded.contract ?? "")}`;
}

function solanaLabel(decoded: Extract<DecodedWalletTransaction, { family: "solana" }>): string {
  const effectful = decoded.instructions.filter(
    (one) => one.program !== "compute_budget" && one.program !== "memo",
  );
  const named = effectful.map((one) => `${one.program}.${one.variant}`).join(", ");
  if (named === "") return "Solana transaction with no fund-moving instruction";
  return `Solana transaction: ${named}`;
}

export function buildTransactionPreview(
  decoded: DecodedWalletTransaction,
  feeBounds: WalletTransactionFeeBounds,
  chainLabel: string,
): WalletTransactionPreview {
  const criticalArgs: Record<string, string> = { chain: chainLabel };

  if (decoded.family === "eip155") {
    for (const [key, value] of Object.entries(decoded.criticalArgs)) criticalArgs[key] = value;
    criticalArgs.contract = decoded.contract ?? "none (plain native transfer)";
    criticalArgs.unlimitedApproval = String(decoded.unlimitedApproval);
  } else {
    // Instructions are numbered so a two-instruction proposal cannot present as
    // one line with the second silently overwriting the first.
    decoded.instructions.forEach((one, index) => {
      criticalArgs[`instruction${index + 1}`] = `${one.program}.${one.variant}`;
      for (const [key, value] of Object.entries(one.criticalArgs)) {
        criticalArgs[`instruction${index + 1}.${key}`] = value;
      }
    });
  }

  if (feeBounds.mode === "eip1559") {
    criticalArgs.maxTotalNetworkFeeWei = feeBounds.maxTotalFeeWei;
    criticalArgs.gasLimit = feeBounds.gasLimit;
    criticalArgs.maxFeePerGasWei = feeBounds.maxFeePerGasWei;
    criticalArgs.maxPriorityFeePerGasWei = feeBounds.maxPriorityFeePerGasWei;
  } else if (feeBounds.mode === "legacy") {
    criticalArgs.maxTotalNetworkFeeWei = feeBounds.maxTotalFeeWei;
    criticalArgs.gasLimit = feeBounds.gasLimit;
    criticalArgs.gasPriceWei = feeBounds.gasPriceWei;
  } else {
    criticalArgs.maxTotalNetworkFeeLamports = feeBounds.maxTotalFeeLamports;
    criticalArgs.baseFeeLamports = feeBounds.baseFeeLamports;
    criticalArgs.maxPriorityFeeLamports = feeBounds.maxPriorityFeeLamports;
    criticalArgs.computeUnitLimit = feeBounds.computeUnitLimit;
    criticalArgs.computeUnitPriceMicroLamports = feeBounds.computeUnitPriceMicroLamports;
  }

  // Numbered, and carried WHOLE. A warning is the sentence that tells a user an
  // approval is unlimited or routes through a shared spender; it is never the
  // thing to shorten.
  decoded.warnings.forEach((warning, index) => {
    criticalArgs[`warning${index + 1}`] = warning;
  });

  return {
    label: decoded.family === "eip155" ? evmLabel(decoded) : solanaLabel(decoded),
    criticalArgs,
  };
}

/**
 * The fields the canonical preview is allowed to read. Nothing else.
 *
 * Every one of them is ALREADY BOUND by the proposal digest, which is the whole
 * point: the sentence a human authorizes has to be a pure function of the facts
 * the digest covers, or the card and the digest are two sources of truth and
 * only one of them is checked at commit time.
 *
 * `tokenIdentityVerified` is READ from `decoded.criticalArgs`, never re-derived
 * here. The decoder is the one owner of that judgement (V6); a second derivation
 * at card time could disagree with the flag the digest bound, and the
 * disagreement would show up as an "UNVERIFIED TOKEN" prefix appearing or
 * disappearing without the digest changing.
 */
export interface CanonicalPreviewInput {
  readonly family: WalletTransactionFamily;
  readonly chainAlias: string | null;
  readonly decoded: DecodedWalletTransaction;
  readonly feeBounds: WalletTransactionFeeBounds;
}

/**
 * THE canonical preview: the human-visible card rendered from bound fields
 * alone, deterministically, by the same renderer the prepare path uses.
 *
 * One producer, three consumers - the durable `preview_json`, the digest
 * preimage, and the approval binding - so a stored card that disagrees with
 * this function is provably an edit rather than a rendering difference.
 *
 * The chain LABEL is derived rather than passed: on `eip155` it is the intent's
 * own `chainAlias`, and on Solana it is the constant the family renders under.
 * Accepting it as a parameter would put a free-form string on the card that the
 * digest could not tie to anything.
 */
export function canonicalTransactionPreview(
  input: CanonicalPreviewInput,
): WalletTransactionPreview {
  const chainLabel = input.family === "solana" ? "solana" : (input.chainAlias ?? "");
  return buildTransactionPreview(input.decoded, input.feeBounds, chainLabel);
}
