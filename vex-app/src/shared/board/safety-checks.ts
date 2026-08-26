/**
 * THE SAFETY CHECK PROJECTOR - one provider bundle into the flat evidence the
 * classifier decides on.
 *
 * WHY THE SPLIT. The classifier (`./safety-classifier.ts`) is a pure table over
 * verdicts, and it must stay one: its whole value is that the chip on a card,
 * the chip in the spotlight and the counters on the chat card are the same
 * function. Provider ARITHMETIC is a different job - a tax is reported on two
 * different scales by two different auditors, a share can arrive in a unit
 * nothing could establish, and a concentration is a threshold comparison. That
 * arithmetic belongs here, once, beside the units it operates on, and what
 * crosses into the classifier is the verdict it produced.
 *
 * THE THRESHOLDS ARE NAMED CONSTANTS AND THEY MOVE ONLY ON PROBE EVIDENCE.
 * They are the one place in the board where a number decides whether a token
 * is described as safe, so each carries the reason it is the number it is.
 *
 * WHAT IS NEVER COMPARED. A percent whose `unit` is `unverified` is not turned
 * into a number and compared: a lock share that might be 89 or 0.89 is not
 * evidence of anything, and treating it as either would be inventing a fact.
 * It becomes an `unverified` check instead, which is its own chip state.
 *
 * MEASURED (probe P1, four chains): `security.*` was ABSENT on solana for a
 * live trending pool and `liquidityLocks` was null on two of four chains, so an
 * unanswered check is the ORDINARY case here and is kept apart from a failed
 * one. Silence is not a verdict.
 */

import type {
  BoardDetailsBundle,
  BoardPercent,
} from "../schemas/board-details.js";

/**
 * A tax at or above this percent is a failing check.
 *
 * Ten percent is the level at which a round trip costs a fifth of the position
 * before any price movement, which is not a fee, it is a mechanism.
 */
export const TAX_HARD_PCT = 10;

/**
 * A tax strictly above this percent fails; at or below it, it passes.
 *
 * A11 separates the two tax thresholds into different table rows, and both of
 * those rows resolve to the same chip state. They are kept as two constants
 * because they are two different product statements, and a later surface that
 * wants to say "high tax" versus "extreme tax" needs both.
 */
export const TAX_RISK_PCT = 5;

/**
 * An owner or creator holding at or above this percent of supply fails.
 *
 * One wallet at a fifth of supply can end the market for everybody else in one
 * transaction.
 */
export const CONCENTRATION_PCT = 20;

/**
 * Below this pair age the card shows the amber "New pair" chip instead of the
 * safety chip. 24 hours.
 *
 * VISUAL PRECEDENCE ONLY (the owner's mockup shows the two as mutually
 * exclusive). The safety state is still classified and still counted, so a new
 * pair that is a honeypot is still counted as high risk.
 */
export const NEW_PAIR_SECONDS = 86_400;

/**
 * Check ids on which the two auditors CONTRADICTING each other is its own
 * answer rather than a flag.
 *
 * "One of our two auditors says this is a honeypot and the other says it is
 * not" is neither a clean result nor a flagged one, and resolving it would
 * mean picking a winner silently. Both have been measured wrong.
 */
export const HARD_CHECK_IDS: ReadonlySet<string> = new Set(["isHoneypot"]);

/**
 * The check ids a verdict REQUIRES. An unanswered one of these is what makes a
 * document partial rather than complete, and partial is never green.
 */
export const REQUIRED_CHECK_IDS: readonly string[] = ["isHoneypot", "contractVerified"];

/** One check, provider-spelled. */
export interface SafetyCheckRow {
  readonly id: string;
  readonly verdict: "pass" | "fail" | "unverified";
  readonly source: string;
}

/**
 * The flat evidence one details read produced.
 *
 * The two identity fields are compared as OPAQUE STRINGS, and
 * {@link tokenIdentity} is the one place that builds them. A provider that
 * stated an address is compared on the address; one that stated only a symbol
 * is compared on `symbol:<...>`, on both sides, so a symbol-only disagreement
 * is still a mismatch and never a fabricated address.
 */
export interface SafetyCheckSet {
  readonly auditedTokenAddress: string | null;
  readonly subjectTokenAddress: string | null;
  readonly checks: readonly SafetyCheckRow[];
  readonly unansweredCheckIds: readonly string[];
}

/** A percent's established value, or null when its scale is unknown. */
function measured(value: BoardPercent | null): number | null {
  if (value === null || value.unit === "unverified") return null;
  return value.normalizedPct;
}

/**
 * One boolean flag as a check. `null` (the provider did not say) produces no
 * check at all, because a silence must not be recorded as a pass.
 */
function flagCheck(
  id: string,
  source: string,
  value: boolean | null,
): SafetyCheckRow | null {
  if (value === null) return null;
  return { id, source, verdict: value ? "fail" : "pass" };
}

/**
 * A flag whose absence is UNVERIFIED rather than dangerous.
 *
 * `contractVerified: false` and `isOpenSource: false` do not say the token does
 * anything hostile; they say nobody can check. A11 puts both on the
 * `unverified` row for that reason, and treating them as failures would paint
 * every unpublished contract as high risk.
 */
function verifiabilityCheck(
  id: string,
  source: string,
  value: boolean | null,
): SafetyCheckRow | null {
  if (value === null) return null;
  return { id, source, verdict: value ? "pass" : "unverified" };
}

/** The sources whose answer is an AUDIT of the contract. */
export const AUDIT_SOURCES: ReadonlySet<string> = new Set(["goplus", "quickintel"]);

/** One percent as a check against a threshold, honouring the unit. */
function percentCheck(
  id: string,
  source: string,
  value: BoardPercent | null,
  failAtOrAbove: number,
): SafetyCheckRow | null {
  if (value === null) return null;
  if (value.unit === "unverified") return { id, source, verdict: "unverified" };
  const pct = measured(value);
  if (pct === null) return null;
  return { id, source, verdict: pct >= failAtOrAbove ? "fail" : "pass" };
}

/**
 * Project one details bundle into the classifier's evidence.
 *
 * Pure, deterministic, and total: every bundle produces a check set, and a
 * bundle whose providers all stayed silent produces an EMPTY check list with
 * every required id unanswered, which the classifier reads as `incomplete`
 * rather than as a clean result.
 */
export function safetyChecksFromBundle(bundle: BoardDetailsBundle): SafetyCheckSet {
  const goPlus = bundle.safety.goplus;
  const quickIntel = bundle.safety.quickintel;
  const authority = bundle.safety.tokenAuthority;
  const rows: (SafetyCheckRow | null)[] = [];

  if (goPlus !== null) {
    rows.push(
      flagCheck("isHoneypot", "goplus", goPlus.isHoneypot),
      flagCheck("cannotSellAll", "goplus", goPlus.cannotSellAll),
      flagCheck("canMint", "goplus", goPlus.isMintable),
      flagCheck("canBlacklist", "goplus", goPlus.isBlacklisted),
      flagCheck("canPauseTrading", "goplus", goPlus.transferPausable),
      flagCheck("hiddenOwner", "goplus", goPlus.hiddenOwner),
      flagCheck("canTakeBackOwnership", "goplus", goPlus.canTakeBackOwnership),
      flagCheck("slippageModifiable", "goplus", goPlus.slippageModifiable),
      flagCheck("isProxy", "goplus", goPlus.isProxy),
      verifiabilityCheck("isOpenSource", "goplus", goPlus.isOpenSource),
      percentCheck("buyTax", "goplus", goPlus.buyTaxPct, TAX_HARD_PCT),
      percentCheck("sellTax", "goplus", goPlus.sellTaxPct, TAX_HARD_PCT),
      percentCheck("ownerShare", "goplus", goPlus.ownerShare, CONCENTRATION_PCT),
      percentCheck("creatorShare", "goplus", goPlus.creatorShare, CONCENTRATION_PCT),
    );
    // The RISK tax band, kept as its own check so a 6 percent tax is a
    // failing check rather than an invisible one under the hard threshold.
    rows.push(
      percentCheck("buyTaxElevated", "goplus", goPlus.buyTaxPct, TAX_RISK_PCT + 0.0000001),
      percentCheck("sellTaxElevated", "goplus", goPlus.sellTaxPct, TAX_RISK_PCT + 0.0000001),
    );
  }

  if (quickIntel !== null) {
    rows.push(
      flagCheck("isHoneypot", "quickintel", quickIntel.isHoneypot),
      flagCheck("isScam", "quickintel", quickIntel.isScam),
      flagCheck("hasObfuscatedAddressRisk", "quickintel", quickIntel.hasObfuscatedAddressRisk),
      flagCheck("canMint", "quickintel", quickIntel.canMint),
      flagCheck("canBlacklist", "quickintel", quickIntel.canBlacklist),
      flagCheck("canPauseTrading", "quickintel", quickIntel.canPauseTrading),
      flagCheck("hiddenOwner", "quickintel", quickIntel.hiddenOwner),
      flagCheck("isProxy", "quickintel", quickIntel.isProxy),
      flagCheck("hasExternalContractRisk", "quickintel", quickIntel.hasExternalContractRisk),
      flagCheck("hasGeneralVulnerabilities", "quickintel", quickIntel.hasGeneralVulnerabilities),
      flagCheck("hasFeeWarning", "quickintel", quickIntel.hasFeeWarning),
      verifiabilityCheck("contractVerified", "quickintel", quickIntel.contractVerified),
      percentCheck("buyTax", "quickintel", quickIntel.buyTaxPct, TAX_HARD_PCT),
      percentCheck("sellTax", "quickintel", quickIntel.sellTaxPct, TAX_HARD_PCT),
      percentCheck("transferTax", "quickintel", quickIntel.transferTaxPct, TAX_HARD_PCT),
      percentCheck("buyTaxElevated", "quickintel", quickIntel.buyTaxPct, TAX_RISK_PCT + 0.0000001),
      percentCheck("sellTaxElevated", "quickintel", quickIntel.sellTaxPct, TAX_RISK_PCT + 0.0000001),
      // CARRIED, NEVER SUBSTITUTED. `lpBurnedPct` never stands in for a lock
      // share; it is here because it is the one field measured arriving with
      // `unit: "unverified"`, and an unverified decision figure is a state.
      quickIntel.lpBurnedPct?.unit === "unverified"
        ? { id: "lpBurnedPct", source: "quickintel", verdict: "unverified" as const }
        : null,
    );
  }

  if (authority !== null) {
    rows.push(
      flagCheck("solanaBridgeMintOnly", "tokenAuthority", authority.solanaBridgeMintOnly),
      flagCheck("solanaMintable", "tokenAuthority", authority.solanaMintable),
      flagCheck("solanaFreezable", "tokenAuthority", authority.solanaFreezable),
    );
  }

  // The lock share is a DECISION figure: an unverified one is a state, and a
  // verified one is not a pass or a fail (a pool with no lock is not unsafe by
  // itself), so only the unverified case produces a check.
  const lockedPct = bundle.liquidityLocks?.lockedPct ?? null;
  if (lockedPct !== null && lockedPct.unit === "unverified") {
    rows.push({ id: "lockedPct", source: "dexscreener", verdict: "unverified" });
  }

  const checks = rows.filter((row): row is SafetyCheckRow => row !== null);
  const answered = new Set(checks.map((row) => row.id));
  const audit = bundle.auditedTokenCheck;
  return {
    auditedTokenAddress: tokenIdentity(audit.auditedTokenAddress, audit.auditedTokenSymbol),
    subjectTokenAddress: tokenIdentity(bundle.baseTokenAddress, bundle.baseTokenSymbol),
    checks,
    unansweredCheckIds: REQUIRED_CHECK_IDS.filter((id) => !answered.has(id)),
  };
}

/**
 * One side's identity as a comparable string.
 *
 * An address when there is one, otherwise the symbol under an explicit
 * `symbol:` prefix so the two kinds can never be compared against each other,
 * otherwise null. Case is folded because only the COMPARISON ignores case; the
 * provider's own spelling is preserved on the bundle for display.
 *
 * A null on either side is an UNVERIFIED subject rather than a verified one,
 * which is the classifier's `unverified` row and never its `clear` one.
 */
export function tokenIdentity(
  address: string | null,
  symbol: string | null,
): string | null {
  if (address !== null && address !== "") return address.toLowerCase();
  if (symbol !== null && symbol !== "") return `symbol:${symbol.toLowerCase()}`;
  return null;
}

/**
 * Whether the card shows the amber "New pair" chip instead of the safety chip.
 * Visual precedence only; see {@link NEW_PAIR_SECONDS}.
 */
export function showsNewPairChip(pairAgeSeconds: number | null): boolean {
  return pairAgeSeconds !== null && pairAgeSeconds < NEW_PAIR_SECONDS;
}
