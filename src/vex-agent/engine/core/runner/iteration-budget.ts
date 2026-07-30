/**
 * The per-turn iteration budget — ONE source of truth.
 *
 * An "iteration" is one model turn INCLUDING its entire parallel tool batch,
 * so a budget of 50 is already potentially hundreds of tool calls. The number
 * is therefore not a spend cap and must not be read as one; it is a backstop
 * against a model that loops on tool calls without ever summarising.
 *
 * Owner decision (2026-07-29): a session running with `permission: 'full'` is
 * autonomous by contract — "nie może mieć przerwanej sesji" — so it gets a
 * deliberately generous budget, for BOTH agent sessions and mission runs. A
 * `restricted` session keeps today's 50, because every mutating step there is
 * gated on a human approval anyway and an unbounded loop is pure waste.
 *
 * There is NO session-level ceiling and NO spend gate anywhere in this design.
 * The wall-clock `timeoutMs` in `DEFAULT_LOOP_CONFIG` is the independent second
 * bound; break-even between the two is ~12 s/iteration, so for real tool work
 * the timeout binds first and the runtime continuation (see
 * `runtime-continuation.ts`) — not a bigger number here — is what keeps an
 * autonomous session going.
 *
 * `DEFAULT_LOOP_CONFIG.maxIterations` is deliberately left alone: it stays the
 * conservative default for any caller that has not made an autonomy decision.
 * Callers that HAVE made one override it with `maxIterationsForPermission`.
 */

import type { Permission } from "../../types.js";

/** Budget for `permission: 'restricted'` — unchanged from before this module. */
export const RESTRICTED_MAX_ITERATIONS = 50;

/** Budget for `permission: 'full'` — agent sessions AND mission runs. */
export const FULL_AUTONOMY_MAX_ITERATIONS = 1000;

/**
 * The per-turn iteration budget for a session's permission. The ONLY place
 * this mapping exists; do not re-derive it at a call site.
 */
export function maxIterationsForPermission(permission: Permission): number {
  return permission === "full"
    ? FULL_AUTONOMY_MAX_ITERATIONS
    : RESTRICTED_MAX_ITERATIONS;
}
