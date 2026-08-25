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

import {
  approvedPerGasCapWei,
  quoteWalletTxVexFee,
  walletTxVexFeeSkipSentence,
  WALLET_TX_FEE_BPS,
  WALLET_TX_FEE_RECEIVER_EVM,
} from "./vex-fee.js";

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

/**
 * The Vex-fee lines, ALWAYS present on an EVM card - charged or explicitly not.
 *
 * WHY ALWAYS. A card that shows fee lines only when a fee applies teaches a
 * reader that their absence means the section did not render, not that nothing
 * is charged. The skipped arm states the reason with its numbers, so a user can
 * see the decision rather than infer it from silence.
 *
 * Every value is DERIVED from fields the digest already binds - the payload's
 * `valueWei` and the approved fee bounds - plus build constants, so digest v3
 * covers these lines by covering this preview and the fee can never differ
 * between the card, the digest and the transfer.
 *
 * `evmValueWei` of `null` is the Solana family: no fee lane exists there, so
 * nothing is stated. A row whose fee bounds are not EVM bounds is likewise
 * silent - it is a shape prepare never writes and confirm refuses by name.
 */
function appendVexFeeLines(
  criticalArgs: Record<string, string>,
  evmValueWei: string | null,
  feeBounds: WalletTransactionFeeBounds,
): void {
  if (evmValueWei === null) return;
  const perGasCapWei = approvedPerGasCapWei(feeBounds);
  if (perGasCapWei === null) return;

  const quote = quoteWalletTxVexFee(BigInt(evmValueWei), perGasCapWei);
  if (!quote.charged) {
    criticalArgs.vexFee = `none - ${walletTxVexFeeSkipSentence(quote)}`;
    return;
  }
  criticalArgs.vexFeeBps = String(WALLET_TX_FEE_BPS);
  criticalArgs.vexFeeBaseWei = quote.baseWei.toString();
  criticalArgs.vexFeeWei = quote.feeWei.toString();
  criticalArgs.vexFeeReceiver = WALLET_TX_FEE_RECEIVER_EVM;
  criticalArgs.vexFeeMaxNetworkFeeWei = quote.maxNetworkFeeWei.toString();
  criticalArgs.vexFeeNote =
    "Vex platform fee, separate from the network fee. It is a SEPARATE transfer that runs only "
    + "AFTER this transaction confirms, IN ADDITION to the value this transaction sends and to its "
    + "own network fee, and it pays the network fee shown as vexFeeMaxNetworkFeeWei on top. A "
    + "transaction that does not happen is never charged, and a fee transfer that fails leaves this "
    + "transaction untouched.";
}

export function buildTransactionPreview(
  decoded: DecodedWalletTransaction,
  feeBounds: WalletTransactionFeeBounds,
  chainLabel: string,
  evmValueWei: string | null,
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

  appendVexFeeLines(criticalArgs, evmValueWei, feeBounds);

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
  /**
   * The EVM payload's RAW `valueWei`, or `null` on Solana. REQUIRED, not
   * optional: it is the base of the Vex fee lines, and a caller that could omit
   * it would silently render a card with no fee section on a transaction that
   * will be charged one. It is a digest-bound field, so covering it here keeps
   * the card a pure function of what the digest already binds.
   */
  readonly evmValueWei: string | null;
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
  return buildTransactionPreview(input.decoded, input.feeBounds, chainLabel, input.evmValueWei);
}
