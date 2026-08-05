/**
 * Display arithmetic + refusal classification for the token-launch dialog.
 *
 * WHY THIS FILE IS PURE AND SEPARATE: the numbers it renders are the ones the
 * user's Deploy click authorizes. Under owner decision D3 that click IS the
 * spend-consent, so a formatting bug here is a consent defect, not a cosmetic
 * one. Keeping the arithmetic out of the components makes it directly testable
 * and keeps the rule-90 invariants below in one readable place.
 *
 * THE INVARIANTS THIS FILE ENFORCES (rule 90, money-path discipline):
 *
 *  1. **Every amount is BigInt arithmetic over raw wei decimal strings.** A wei
 *     value does not survive `number` — 1e18 exceeds `Number.MAX_SAFE_INTEGER`
 *     by two orders of magnitude, so parsing one as a float silently rounds the
 *     low digits of a number the user is about to authorize. There is no
 *     `parseFloat` in this file and there must never be one.
 *
 *  2. **The exact value is rendered, never a rounded one.** `formatWeiEth`
 *     trims trailing zeros and nothing else. Truncating to "nice" precision
 *     would let two different authorized amounts print identically, which is
 *     exactly the class of error the consent line exists to prevent.
 *
 *  3. **The one sum this file offers is named for exactly what it contains.**
 *     `estimatedTotalCostWei` is what launching costs in total, gas estimate
 *     included; it may never be collapsed with `msg.value`, because the two
 *     have different truth statuses and the caller must label them
 *     differently — the total is an ESTIMATE (it contains gas), the authorized
 *     figure is not.
 *
 *     Owner decision (2026-08-02): the modal submit IS the spend consent, so
 *     every cost surface must state the whole cost. An earlier version of this
 *     file refused to compute any gas-inclusive total at all; that left the user
 *     consenting while looking at a number smaller than what the launch would
 *     actually take out of their wallet. The fix is to show the total AND keep
 *     `msg.value` broken out as the only committed figure — not to hide the sum.
 *
 *  4. **There is no mission-ceiling helper here** (Codex round 4, 2026-08-02).
 *     One existed and its result was rendered as "checked against your mission
 *     limit" on a preview that passes NO ceilings — a verdict nobody reached.
 *     Reintroduce a ceiling figure only alongside DTO metadata naming the
 *     ceiling that was actually applied.
 *
 *  5. **An unreadable amount renders an em-dash, never a zero.** `"0"` is a
 *     legitimate wei value (a zero prebuy is the default), so a parse failure
 *     that fell back to zero would be indistinguishable from a real zero and
 *     would understate what is being authorized.
 */

import type { TokenLaunchSubmitResult } from "../../../lib/api/token-launch.js";

/** Native ETH on Robinhood Chain 4663. Never inferred, never a parameter. */
const WEI_DECIMALS = 18n;
const WEI_PER_ETH = 10n ** WEI_DECIMALS;

/** Unknown / unreadable values print this, matching the shell's convention. */
export const UNKNOWN_AMOUNT = "—";

/**
 * Parse a raw wei decimal string. Deliberately strict: only an unsigned run of
 * digits is a wei amount. A sign, a decimal point, hex, whitespace or an empty
 * string is malformed input from a boundary we do not control, and this returns
 * `null` so the caller renders the em-dash rather than a number it invented.
 */
export function parseWei(raw: string | null | undefined): bigint | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/**
 * Exact wei → ETH, trailing zeros trimmed. `1000000000000000n` → `"0.001"`,
 * `0n` → `"0"`, `10n` → `"0.00000000000000001"`.
 *
 * The fraction is built by string padding rather than division so no float ever
 * touches the value: `1n` must print its eighteenth decimal place, and any
 * float path loses it.
 */
export function formatWeiEth(raw: string | null | undefined): string {
  const wei = parseWei(raw);
  if (wei === null) return UNKNOWN_AMOUNT;
  const whole = wei / WEI_PER_ETH;
  const fraction = (wei % WEI_PER_ETH).toString().padStart(Number(WEI_DECIMALS), "0");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed.length === 0 ? whole.toString() : `${whole.toString()}.${trimmed}`;
}

/** Same, with the unit appended — the voice used beside the Deploy button. */
export function formatWeiEthWithUnit(raw: string | null | undefined): string {
  const value = formatWeiEth(raw);
  return value === UNKNOWN_AMOUNT ? UNKNOWN_AMOUNT : `${value} ETH`;
}

/**
 * The estimated total this launch costs: `msg.value + vexFee + networkFee`.
 *
 * It is an ESTIMATE because gas is one, and the caller must label it as such.
 * It exists because the modal submit is the spend consent (owner decision
 * 2026-08-02): a consent surface that shows only `msg.value` under-states what
 * the wallet will actually pay, and the user cannot consent to a number they
 * were never shown. `msg.value` stays broken out beside it as the one figure
 * this click commits.
 *
 * Returns `null` if any term is unreadable — a partial sum presented as a total
 * would be worse than no total at all.
 */
export function estimatedTotalCostWei(
  msgValueWei: string | null | undefined,
  vexFeeWei: string | null | undefined,
  networkFeeWei: string | null | undefined,
): string | null {
  const value = parseWei(msgValueWei);
  const fee = parseWei(vexFeeWei);
  const gas = parseWei(networkFeeWei);
  if (value === null || fee === null || gas === null) return null;
  return (value + fee + gas).toString();
}

/**
 * The prebuy field: the user-typed ETH decimal, normalised to the plain decimal
 * string the IPC contract accepts (`^\d+(\.\d+)?$`), or `null` when it is not
 * an amount at all.
 *
 * NOTHING IS CONVERTED HERE. The decimal → wei conversion happens exactly once,
 * main-side, because a decimals slip in the UI is a thousandfold spend error and
 * two implementations of the same conversion are two chances to make it. This
 * function only decides whether the text on screen is a well-formed amount, so
 * the user is told at the field instead of by a refusal after Deploy.
 *
 * `""` normalises to `"0"` — an unfilled prebuy means no prebuy, the documented
 * default. `".5"` and `"2."` are REFUSED rather than repaired: the schema main
 * validates with does not accept them, and quietly rewriting what the user typed
 * on a money field is not this layer's call. More than 18 fractional digits is
 * refused too — ETH has no nineteenth decimal place to spend.
 */
export function normalizeEthInput(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "0";
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (match === null) return null;
  const fractionText = match[2] ?? "";
  if (fractionText.length > Number(WEI_DECIMALS)) return null;
  return trimmed;
}

/**
 * How the dialog should REACT to a refusal — not what it should say. Main
 * authors the sentence (it has the numbers and the redaction rules); this only
 * decides which affordance the user gets back, mirroring the locker card's
 * precedent of rendering `error.message` verbatim.
 *
 *  - `re_review` — the preview the click was bound to no longer holds. Re-arm:
 *    fetch a fresh preview and make the user look at the new number before
 *    Deploy becomes clickable again. NEVER silently proceed on the old one.
 *  - `ceiling`   — a mission limit refused it. Honest, expected, not a bug.
 *  - `image`     — the launch has no usable image (our product rule).
 *  - `unavailable` — our side is not ready (resolver unmounted, fee unreadable).
 *    Calm try-again, and explicitly NOT the user's fault.
 *  - `blocked`   — everything else: show main's message, no special affordance.
 *
 * The codes are the dotted lowercase `tokenLaunch.*` set, matching every other
 * `VexError.code` on disk (`support.persist_failed`, `images.in_use`,
 * `internal.cancelled`) and the dotted-namespace `VexDomain` enum. An unknown
 * code degrades to `blocked` rather than throwing, so a refusal this table has
 * not met yet still shows the user main's own sentence.
 */
export type LaunchRefusalKind =
  | "re_review"
  | "ceiling"
  | "image"
  | "unavailable"
  | "blocked";

const REFUSAL_KIND_BY_CODE: Readonly<Record<string, LaunchRefusalKind>> = {
  // ── the preview no longer holds → re-review ──────────────────────────────
  "tokenLaunch.preview_stale": "re_review",
  "tokenLaunch.preview_expired": "re_review",
  "tokenLaunch.preview_unknown": "re_review",

  // ── mission ceilings (C6b) — honest refusals, not errors ─────────────────
  "tokenLaunch.value_ceiling_exceeded": "ceiling",
  "tokenLaunch.launch_count_exceeded": "ceiling",
  "tokenLaunch.ceiling_not_set": "ceiling",

  // ── the image product rule ───────────────────────────────────────────────
  "tokenLaunch.image_required": "image",
  "tokenLaunch.image_unknown": "image",
  "tokenLaunch.image_digest_mismatch": "image",

  // ── our side is not ready — never phrased as the user's mistake ──────────
  "tokenLaunch.image_unavailable": "unavailable",
  "tokenLaunch.fee_unreadable": "unavailable",
  "images.store_unavailable": "unavailable",
};

export function classifyLaunchRefusal(code: string): LaunchRefusalKind {
  return REFUSAL_KIND_BY_CODE[code] ?? "blocked";
}

/**
 * The standing sentence beside a `re_review` refusal. The specifics (which fee
 * moved, from what to what) come from main's own message, which is rendered
 * next to this; this line only explains why the button went away.
 */
export const RE_REVIEW_NOTE =
  "The amounts you were shown are no longer current, so nothing was signed. Review the new numbers before deploying.";

/**
 * How a COMPLETED submit is presented, and whether the dialog may close itself.
 *
 * `success` is the confirmed receipt; `caution` is a real spend whose outcome is
 * not yet proven; `failure` is a launch that burned gas and created nothing. The
 * tone exists because every completed submit used to render green, which paints
 * a REVERTED launch as a success.
 *
 * AUTO-DISMISS requires a receipt the user can still find after the dialog is
 * gone AND a transcript that does not contradict it:
 *
 *  - `confirmed` / `confirmed_pending_identity` — mined and successful. An
 *    Activity row carries it and the agent's resumed turn states it truthfully.
 *  - `pending` — DISMISSIBLE, with a caution tone. This flipped when B-PRE
 *    landed: `submit.ts` now picks the wake arm from the STATUS
 *    (`wakeOutcomeFor`), so an unconfirmed broadcast resumes the agent as
 *    `unconfirmed` with honest do-not-retry prose instead of "deployed the
 *    token. This is done". The transcript no longer contradicts the receipt, so
 *    holding the modal open bought nothing. It still never invites a retry.
 *  - `reverted` — HELD. A failed launch that burned gas is not a successful
 *    deploy and the user must see it.
 *  - missing/EMPTY hash — HELD. `execute-seam` can report a broadcast with no
 *    hash, and there is then no receipt to find anywhere else.
 */
export type TerminalTone = "success" | "caution" | "failure";

export interface LaunchOutcomePresentation {
  readonly tone: TerminalTone;
  readonly autoDismiss: boolean;
}

/** The statuses whose receipt outlives the dialog. `reverted` is not one. */
const DISMISSIBLE_STATUSES: ReadonlySet<string> = new Set([
  "confirmed",
  "confirmed_pending_identity",
  "pending",
]);

export function classifyLaunchOutcome(
  result: Pick<TokenLaunchSubmitResult, "status" | "txHash">,
): LaunchOutcomePresentation {
  // `.trim()`, because `z.string().nullable()` admits `""` and `"   "` alike
  // and neither is a transaction the user could ever look up.
  const hasHash = result.txHash !== null && result.txHash.trim().length > 0;
  const tone: TerminalTone =
    result.status === "reverted"
      ? "failure"
      : result.status === "pending" || !hasHash
        ? "caution"
        : "success";
  return { tone, autoDismiss: hasHash && DISMISSIBLE_STATUSES.has(result.status) };
}

/**
 * Links are user-authored and travel into a token's public metadata. Only
 * `https:` is accepted — `javascript:`, `data:` and bare `http:` are refused at
 * the field rather than sanitized later, so the untrusted value never reaches a
 * renderer sink or the calldata in the first place (rule 03 boundary law).
 */
export function isAcceptableLaunchLink(value: string): boolean {
  if (value.length === 0) return true; // an empty row is simply unfilled
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:";
}
