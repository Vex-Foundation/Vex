/**
 * Direction-conditional token params for the two-way Pendle quote tools
 * (`pendle.lp.quote`, `pendle.py.quote`).
 *
 * Both tools declare `tokenIn` AND `tokenOut` because each `direction` needs a
 * different one. Only ONE applies per direction, and until W9d the other was
 * SILENTLY IGNORED: `pendle.lp.quote {direction:"remove", tokenIn:"0x…"}`
 * quoted an exit to the market's underlying and never said the token the agent
 * asked to receive had been discarded. `market.get`'s XOR is enforced
 * (`market-read-params.ts`), so the same surface enforced the rule in one place
 * and dropped it in another.
 *
 * The mirror defect is the ABSENT one: a `direction:"add"` with no `tokenIn`
 * reached `resolveInputToken("")` and surfaced as `Pendle input token "" is not
 * a valid address` - our own missing-parameter refusal dressed up as a bad
 * address. Both are named here, by param, with the direction that would have
 * accepted them.
 */

/** Which token param a direction actually consumes, and which is inapplicable. */
export interface PendleDirectionTokens {
  /** The direction value being validated, e.g. `"add"`. */
  readonly direction: string;
  /** The param this direction consumes. */
  readonly applicable: "tokenIn" | "tokenOut";
  /** Human phrasing of the direction's flow, e.g. `"token → LP"`. */
  readonly flow: string;
  /** What the inapplicable side IS, e.g. `"the market's LP token"`. */
  readonly fixedSide: string;
  /** The direction that WOULD have accepted the inapplicable param. */
  readonly otherDirection: string;
}

/**
 * The refusal text for a param that does not apply to this direction, or `null`
 * when nothing inapplicable was supplied.
 */
export function inapplicableTokenParamRefusal(
  p: Record<string, unknown>,
  spec: PendleDirectionTokens,
): string | null {
  const inapplicable = spec.applicable === "tokenIn" ? "tokenOut" : "tokenIn";
  const supplied = p[inapplicable];
  if (typeof supplied !== "string" || supplied.trim().length === 0) return null;
  const side = spec.applicable === "tokenIn" ? "output" : "input";
  return (
    `\`${inapplicable}\` does not apply to direction '${spec.direction}' (${spec.flow}): the ${side} IS ${spec.fixedSide}. `
    + `Remove \`${inapplicable}\`, or use direction '${spec.otherDirection}' if that is the trade you meant. `
    + "Vex will not quote a trade while ignoring a token you named."
  );
}

/**
 * The refusal text for the direction's REQUIRED token param when it is absent,
 * or `null` when it was supplied.
 */
export function missingDirectionTokenRefusal(
  p: Record<string, unknown>,
  spec: PendleDirectionTokens,
  role: string,
): string | null {
  const supplied = p[spec.applicable];
  if (typeof supplied === "string" && supplied.trim().length > 0) return null;
  return (
    `Missing \`${spec.applicable}\`: direction '${spec.direction}' (${spec.flow}) needs the ${role} CONTRACT ADDRESS. `
    + "Pass an ERC-20 address (use the chain's wrapped native, e.g. WETH, for ETH)."
  );
}
