/**
 * Shared amount-resolution logic for `agent_activity`-sourced swap legs,
 * used by BOTH `moves-db.ts` and `token-history-db.ts` (Agent Scan plan
 * §4.1/§11.1; Codex final-review round 1 finding 5 / coordinator contract
 * C20). Kept here — not duplicated — because the business rule (which
 * amount a given lifecycle status may honestly show) is identical in both
 * readers; only the caller's output SHAPE differs (a plain string for
 * `MoveItem`, an `AmountField`-wrapped value for `TokenHistoryEntry`).
 *
 * THE RULE: a `confirmed` row shows the raw-computed EXECUTED amount ONLY
 * (receipt Transfer-delta truth) — NEVER the quote-time REQUESTED echo,
 * closing the "quote masquerading as settlement" bug the repair-sweep
 * decoders exposed (they intentionally return raw amounts without a human
 * value, so a naive `COALESCE(executed_human, requested_human)` would
 * silently fall through to the wrong value for any row confirmed via
 * repair). A `pending` row shows the REQUESTED echo instead — nothing has
 * settled yet, so the quote is the only honest value available. Anything
 * else (`failed`, or an unrecognized status) shows NOTHING — a failed
 * attempt's legs are moot; showing a near-miss amount would misrepresent it.
 *
 * Human formatting from raw is BigInt-safe (`viem`'s `formatUnits` — already
 * a `vex-app` dependency, the same audited base-unit-shift primitive wallet
 * code elsewhere in the repo trusts) — `Number`/`parseFloat` is NEVER used
 * on a wei-scale integer string.
 */

import { formatUnits } from "viem";

export type AgentActivitySwapStatus = "pending" | "confirmed" | "failed";

/**
 * `raw` is a base-10 integer string (e.g. "1500000000000000000"); `decimals`
 * is the token's decimal places (SMALLINT). Returns `null` — never throws,
 * never guesses — when either input is absent or `raw` is not a valid
 * integer string (a malformed value must never surface as a fabricated
 * amount). A whole-number result (e.g. "50") is a valid, honest output —
 * callers must not re-impose a decimal-point requirement on it (Codex final
 * review finding 10 / contract C27).
 */
export function formatExecutedAmountHuman(
  raw: string | null,
  decimals: number | null,
): string | null {
  if (raw === null || decimals === null) return null;
  if (!/^-?[0-9]+$/.test(raw)) return null;
  try {
    return formatUnits(BigInt(raw), decimals);
  } catch {
    return null;
  }
}

/**
 * Resolve the single amount string an `agent_activity`-sourced leg may
 * honestly display for its current status — see module header for the rule.
 */
export function resolveAgentActivityAmount(
  status: AgentActivitySwapStatus | null,
  requestedHuman: string | null,
  executedRaw: string | null,
  decimals: number | null,
): string | null {
  if (status === "confirmed") {
    return formatExecutedAmountHuman(executedRaw, decimals);
  }
  if (status === "pending") {
    return requestedHuman;
  }
  return null;
}
