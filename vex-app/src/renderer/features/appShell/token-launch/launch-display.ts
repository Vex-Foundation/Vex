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
 *  3. **Nothing here ever SUMS the network-fee estimate into anything.** There
 *     is deliberately no helper that could produce a gas-inclusive "total": the
 *     authorized figure is `msg.value` and gas is the network's estimate. The
 *     only sum this file offers is the ceiling sum in (4), and its name says
 *     what it is.
 *
 *  4. **The ceiling sum is `msg.value + vexFee`, gas excluded** (coordinator
 *     ruling 2026-08-02). A ceiling that ignored a charge Vex itself imposes
 *     would be a misleading ceiling; gas is excluded because it belongs to the
 *     network and is an estimate, and a ceiling must be checked against
 *     amounts we can stand behind.
 *
 *  5. **An unreadable amount renders an em-dash, never a zero.** `"0"` is a
 *     legitimate wei value (a zero prebuy is the default), so a parse failure
 *     that fell back to zero would be indistinguishable from a real zero and
 *     would understate what is being authorized.
 */

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
 * The amount a mission ceiling is checked against: `msg.value + vexFee`.
 * Network gas is NOT a term and cannot be passed in — see invariant (4).
 * Returns `null` if either input is unreadable, so a partial sum can never be
 * presented as an authoritative one.
 */
export function ceilingCheckedWei(
  msgValueWei: string | null | undefined,
  vexFeeWei: string | null | undefined,
): string | null {
  const value = parseWei(msgValueWei);
  if (value === null) return null;
  // No Vex fee in the DTO at all → the ceiling sum IS msg.value.
  if (vexFeeWei === null || vexFeeWei === undefined) return value.toString();
  const fee = parseWei(vexFeeWei);
  if (fee === null) return null;
  return (value + fee).toString();
}

/**
 * The prebuy field: a user-typed ETH decimal → an exact raw wei string.
 *
 * This is a money-path parser, so it is string arithmetic end to end. `18.7`
 * cannot be multiplied by 1e18 as a float without the low digits drifting, and
 * a drifting prebuy is a drifting `msg.value`. Instead the fraction is padded
 * to exactly 18 places and concatenated, so the result is the digits the user
 * typed and nothing else.
 *
 * Returns `null` for anything that is not an unsigned decimal, and for MORE
 * than 18 fractional digits: silently truncating the nineteenth would spend a
 * different amount than the one on screen. The empty string is `"0"` — an
 * unfilled prebuy field means no prebuy, which is the documented default.
 */
export function parseEthInputToWei(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "0";
  const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (match === null) return null;
  const wholeText = match[1] ?? "";
  const fractionText = match[2] ?? "";
  // "." alone, or a value with no digits at all, is not an amount.
  if (wholeText.length === 0 && fractionText.length === 0) return null;
  if (fractionText.length > Number(WEI_DECIMALS)) return null;
  const padded = fractionText.padEnd(Number(WEI_DECIMALS), "0");
  const whole = wholeText.length === 0 ? 0n : BigInt(wholeText);
  return (whole * WEI_PER_ETH + BigInt(padded)).toString();
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
