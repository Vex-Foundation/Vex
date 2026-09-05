/**
 * What a BondingV5 LAUNCH revert means, by name.
 *
 * A separate table from `../curve/revert-mapping.ts` even though three of the
 * selectors are shared, and the sharing is exactly why. `InvalidInput()` on a
 * curve trade means "the deadline passed or the amount was zero"; on a launch
 * it means "the purchase is below the venue's launch fee, a core list was
 * empty, or - on a cancel - this token was never pre-launched". Same four
 * bytes, different situations, different remedies. One table serving both would
 * have to say something vague enough to be true of all of them, which is how an
 * agent is told nothing at all.
 *
 * The selectors are COMPUTED from the signatures rather than hand-pasted, so a
 * typo cannot silently produce a table that matches nothing. The signatures are
 * transcribed from `BondingV5.sol:171-177`.
 */

import { toFunctionSelector } from "viem";

/** The bounded classes this lane distinguishes. Never provider text. */
export type LaunchRevertClass =
  | "invalid_input"
  | "token_status"
  | "anti_sniper_type"
  | "launch_mode"
  | "unauthorized_launcher"
  | "special_params"
  | "allowance_or_balance"
  | "unknown";

export interface LaunchRevertVerdict {
  readonly kind: LaunchRevertClass;
  /** Agent-facing sentence: what happened, then what to do about it. */
  readonly reason: string;
}

const SELECTORS: Readonly<Record<string, LaunchRevertClass>> = {
  [toFunctionSelector("InvalidInput()")]: "invalid_input",
  [toFunctionSelector("InvalidTokenStatus()")]: "token_status",
  [toFunctionSelector("InvalidAntiSniperType()")]: "anti_sniper_type",
  [toFunctionSelector("LaunchModeNotEnabled()")]: "launch_mode",
  [toFunctionSelector("UnauthorizedLauncher()")]: "unauthorized_launcher",
  [toFunctionSelector("InvalidSpecialLaunchParams()")]: "special_params",
};

const REASONS: Readonly<Record<LaunchRevertClass, string>> = {
  invalid_input:
    "BondingV5 rejected an argument of this call (InvalidInput). On a launch that is a purchase below the venue's "
    + "own launch fee or an empty cores list; on a cancel it is a token that was never pre-launched, or one whose "
    + "creator is not this wallet - the contract reverts with the same four bytes for all of them. Nothing moved.",
  token_status:
    "BondingV5 refused because this agent's launch is already finished (InvalidTokenStatus): the keeper has executed "
    + "launch(), or the launch was already cancelled. A launch cannot be cancelled once it is live - the agent now "
    + "trades on its bonding curve, so sell it with virtuals__agent_trade_execute instead. Nothing moved.",
  anti_sniper_type:
    "BondingV5 refused the anti-sniper type (InvalidAntiSniperType). BondingConfig admits 0-5 only. Nothing moved.",
  launch_mode:
    "BondingV5 refused the launch mode (LaunchModeNotEnabled). Vex only sends the NORMAL mode. Nothing moved.",
  unauthorized_launcher:
    "BondingV5 refused because this wallet is not on its privileged-launcher list (UnauthorizedLauncher). That list "
    + "gates the X_LAUNCH and ACP_SKILL modes, which Vex never sends. Nothing moved.",
  special_params:
    "BondingV5 refused the special-launch parameters (InvalidSpecialLaunchParams). Nothing moved.",
  allowance_or_balance:
    "BondingV5 could not pull the VIRTUAL this launch commits: the allowance to BondingV5 or the balance was short "
    + "at inclusion time. Nothing was launched.",
  unknown:
    "the launch transaction reverted and the contract gave no reason Vex can name. Nothing was launched. Take a "
    + "fresh preview before trying again.",
};

/**
 * Classify a revert from its error payload.
 *
 * Both an estimate-time refusal and a mined revert reach here, and both carry
 * the same selector - the DIFFERENCE between them is whether bytes were
 * broadcast, which the caller knows and this function deliberately does not.
 */
export function classifyLaunchRevert(err: unknown): LaunchRevertVerdict {
  const text = errorText(err);
  for (const [selector, kind] of Object.entries(SELECTORS)) {
    if (text.includes(selector)) return { kind, reason: REASONS[kind] };
  }
  // Name matching is the SECOND pass, not the first: a node that decodes the
  // custom error for us reports the name and no selector, and a node that does
  // not reports the selector and no name.
  if (/InvalidTokenStatus/i.test(text)) return { kind: "token_status", reason: REASONS.token_status };
  if (/InvalidAntiSniperType/i.test(text)) return { kind: "anti_sniper_type", reason: REASONS.anti_sniper_type };
  if (/LaunchModeNotEnabled/i.test(text)) return { kind: "launch_mode", reason: REASONS.launch_mode };
  if (/UnauthorizedLauncher/i.test(text)) {
    return { kind: "unauthorized_launcher", reason: REASONS.unauthorized_launcher };
  }
  if (/InvalidSpecialLaunchParams/i.test(text)) return { kind: "special_params", reason: REASONS.special_params };
  if (/InvalidInput/i.test(text)) return { kind: "invalid_input", reason: REASONS.invalid_input };
  if (/insufficient allowance|transfer amount exceeds|ERC20:/i.test(text)) {
    return { kind: "allowance_or_balance", reason: REASONS.allowance_or_balance };
  }
  return { kind: "unknown", reason: REASONS.unknown };
}

/**
 * The bounded text a classification may read.
 *
 * Only the fields viem itself populates, and never anything that reaches a log
 * or a durable row: the caller stores the CLASS and this module's own sentence,
 * not the provider's payload.
 */
function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err === null || typeof err !== "object") return "";
  const parts: string[] = [];
  const record = err as Record<string, unknown>;
  for (const key of ["shortMessage", "details", "message", "data", "name"]) {
    const value = record[key];
    if (typeof value === "string") parts.push(value);
  }
  const cause = record.cause;
  if (cause !== undefined && cause !== err) parts.push(errorText(cause));
  return parts.join(" ");
}
