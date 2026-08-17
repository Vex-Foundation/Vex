/**
 * Projection of a Morpho vault PREVIEW into agent-facing rows.
 *
 * The mutation layer already returns a shaped, honest quote; this file adds only
 * what the agent layer owns, and deliberately adds nothing else. Two jobs:
 *
 *  1. GOVERNANCE, which the preview cannot see. `readMorphoVaultState` reads the
 *     vault contract, so it knows the share price and the decimals but nothing
 *     about who can change the vault or whether a gate can refuse an exit. Those
 *     facts live in Morpho's own API read, and a deposit preview that omits them
 *     is a number without the one hazard that can strand it.
 *
 *  2. A SUMMARY that never reads better than the evidence. The three cases the
 *     wording keeps apart are the ones a reader acts on differently: a gate that
 *     is PROVEN present, a gate that is PROVEN absent, and a governance read that
 *     did not answer. The third is not the second. Reporting an unread gate as
 *     "not gated" is exactly the "unknown reported as zero reads as safety"
 *     failure the wallet lane already records, and it is worse here because the
 *     next step is a deposit.
 */

import type { MorphoVaultQuote } from "@tools/morpho/mutations.js";
import type { MorphoVaultDetail } from "@tools/morpho/types.js";

/**
 * What the governance read produced. A discriminated union rather than a
 * nullable object, so "we read it and there are no gates" cannot be spelled the
 * same way as "we could not read it".
 */
export type MorphoQuoteGovernance =
  | { readonly status: "read"; readonly detail: MorphoVaultDetail }
  | { readonly status: "unavailable"; readonly reason: string };

export interface ProjectedQuoteGovernance {
  readonly status: "read" | "unavailable";
  readonly withdrawalGated: boolean | null;
  readonly depositGated: boolean | null;
  readonly timelockSeconds: number | null;
  readonly perFunctionTimelocks: readonly { readonly functionName: string; readonly durationSeconds: number | null }[];
  readonly pendingConfigCount: number | null;
  readonly redWarnings: readonly string[];
  readonly note: string;
}

/** The sentence a withdrawal-gated vault must carry, wherever it is reported. */
export const MORPHO_QUOTE_GATING_WARNING =
  "WITHDRAWALS ARE GATED on this vault: a gate contract decides whether a depositor may exit, so the assets this "
  + "preview prices going in may not be freely retrievable. Say so before recommending the deposit.";

/**
 * The deposit-side counterpart, and it is NOT the lesser of the two.
 *
 * Both are reported whichever direction was priced. A withdrawal gate strands
 * money that is already in; a deposit gate means the operation this preview
 * just priced may be refused on chain by a contract rather than by anything in
 * the numbers, which is a preview that looks entirely healthy and cannot run.
 */
export const MORPHO_QUOTE_DEPOSIT_GATING_WARNING =
  "DEPOSITS ARE GATED on this vault: a gate contract decides whether assets may go in at all, so this operation can "
  + "be refused on chain no matter how the priced figures look. Say so before recommending it.";

/** The sentence an unread governance block must carry. Never softened. */
export const MORPHO_QUOTE_GOVERNANCE_UNKNOWN_NOTE =
  "The vault's governance could not be read on this call, so whether a gate can block a withdrawal, how long a "
  + "curator change waits, and how many changes are already queued are ALL UNKNOWN here. Unknown is not the same as "
  + "absent: do not present this vault as ungated or unchanged on the strength of a read that did not answer. Call "
  + "morpho.vault.get on the same address and chain before acting.";

export const MORPHO_QUOTE_PREVIEW_NOTE =
  "This is a PREVIEW and it commits nothing. No approval was granted, no permit was signed, no transaction was sent, "
  + "and Vex cannot send one on Morpho today. Every figure is point-in-time: the share price, the requirements and "
  + "the simulation all reflect chain state at this read and can change before any real transaction.";

export const MORPHO_QUOTE_GAS_NOTE =
  "`nodeEstimate` is the node's own eth_estimateGas for this exact transaction and `vexGasLimit` is that estimate "
  + "plus Vex's headroom, which is the limit Vex would actually sign. They are two different numbers and neither is "
  + "a fee. A provider's gas figure is never treated as a floor here: the bound is computed from a fresh estimate "
  + "rather than accepted from anyone. When both are null the node refused to estimate and `unavailableReason` says "
  + "so rather than a number being invented.";

export function projectQuoteGovernance(governance: MorphoQuoteGovernance): ProjectedQuoteGovernance {
  if (governance.status === "unavailable") {
    return {
      status: "unavailable",
      withdrawalGated: null,
      depositGated: null,
      timelockSeconds: null,
      perFunctionTimelocks: [],
      pendingConfigCount: null,
      redWarnings: [],
      note: `${MORPHO_QUOTE_GOVERNANCE_UNKNOWN_NOTE} The read failed with: ${governance.reason}`,
    };
  }

  const detail = governance.detail;
  const gating = detail.gating;
  return {
    status: "read",
    // A V1 vault has no gating MECHANISM, so false here is a proven absence
    // rather than a default: `gating: null` means the concept does not exist on
    // this generation, which is a stronger statement than "no gate installed".
    withdrawalGated: gating === null ? false : gating.withdrawalGated,
    depositGated: gating === null ? false : gating.depositGated,
    timelockSeconds: detail.timelockSeconds,
    perFunctionTimelocks: detail.timelocks.map((entry) => ({
      functionName: entry.functionName,
      durationSeconds: entry.durationSeconds,
    })),
    pendingConfigCount: detail.pendingConfigCount,
    redWarnings: detail.warnings.filter((w) => w.level === "RED").map((w) => w.type),
    note: gating === null
      ? "This is a V1 vault, which has no gating mechanism at all: no contract can block a deposit or a withdrawal "
        + "here. Its single `timelockSeconds` governs how long a curator change waits."
      : "This is a V2 vault, whose gates and per-function timelocks are listed. `withdrawalGated` true means a "
        + "contract decides whether a depositor may exit.",
  };
}

/**
 * The one-line reading a caller sees first.
 *
 * It states the direction, the two amounts with their own scales, and then the
 * hazards, in that order. The hazards are appended rather than folded into the
 * numbers because a reader who stops after the first clause must still not have
 * been told something untrue.
 */
export function summariseQuote(quote: MorphoVaultQuote, governance: ProjectedQuoteGovernance): string {
  const asset = quote.vault.assetSymbol ?? "the vault asset";
  const name = quote.vault.name ?? "unnamed vault";
  const head = quote.direction === "deposit"
    ? `Depositing ${quote.input.human} ${asset} into ${name} would mint about ${quote.expectedShares.human} shares`
    : `Withdrawing ${quote.input.human} ${asset} from ${name} would burn about ${quote.expectedShares.human} shares`;

  const requirements = quote.requirements.length === 0
    ? " No approval or signature is required for this shape."
    : ` ${quote.requirements.length} requirement(s) would have to be satisfied first: `
      + `${quote.requirements.map((r) => r.kind).join(", ")}.`;

  // Both gates are reported whichever direction was priced, and neither is
  // folded into the other: they answer different questions and a reader acts on
  // them differently.
  const gate = governance.status === "unavailable"
    ? " The vault's governance could not be read, so gating and timelocks are UNKNOWN rather than absent."
    : `${governance.depositGated === true ? ` ${MORPHO_QUOTE_DEPOSIT_GATING_WARNING}` : ""}`
      + `${governance.withdrawalGated === true ? ` ${MORPHO_QUOTE_GATING_WARNING}` : ""}`;

  const pending = governance.pendingConfigCount !== null && governance.pendingConfigCount > 0
    ? ` ${governance.pendingConfigCount} governance change(s) are already queued on this vault.`
    : "";

  const red = governance.redWarnings.length > 0
    ? ` ${governance.redWarnings.length} RED warning(s): ${governance.redWarnings.join(", ")}.`
    : "";

  const simulation = quote.preflight.verdict === "ok"
    ? " The simulation returned cleanly."
    : quote.preflight.verdict === "reverted"
      ? " The simulation REVERTED; read `preflight.explanation` before treating this as a fault in the vault."
      : " The node did not answer the simulation, so whether it would revert is UNKNOWN.";

  // The tolerance is stated on BOTH directions even though only a deposit
  // carries an on-chain guard, because the caller sent it on both and a value
  // that was accepted and had nothing to bind on must not read as one that bound.
  const tolerance = quote.direction === "deposit"
    ? `a ${quote.sharePrice.slippageBps} bps share-price tolerance, enforced on chain by the built transaction`
    : `a ${quote.sharePrice.slippageBps} bps tolerance that binds on nothing here, because a withdrawal is a direct `
      + "vault call with no share-price leg to guard";

  return `${head} at ${tolerance}.${requirements}${gate}${pending}${red}${simulation}`
    + " Nothing was signed and nothing was sent.";
}
