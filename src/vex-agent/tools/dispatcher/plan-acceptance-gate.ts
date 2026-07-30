/**
 * Plan-mode acceptance gate for the dispatcher (code-level defense-in-depth).
 *
 * While session-scoped plan-mode is ON and the active plan is NOT user-accepted,
 * side-effecting tools are blocked until the user accepts the plan. Read-kind
 * tools, read-only protocol quotes/previews, and the safe-control allowlist are
 * always permitted so the agent can still research and refine the plan.
 */

import type { ToolCallRequest, ToolResult } from "../types.js";
import type { InternalToolContext } from "../internal/types.js";
import { getActionKind } from "../registry.js";
import { isMutatingProtocolAlias } from "../mutating-aliases.js";
import { dispatchTargetIsMutating } from "./mutating-targets.js";

/**
 * Tools always allowed while a plan is pending acceptance — the safe-control
 * set: author/refine the plan (`plan_write`), stop the mission (`mission_stop`),
 * relieve context pressure (`compact_apply`), and edit the mission draft during
 * setup (`mission_draft_update`). These are `local_write` but must NOT be
 * trapped behind the gate (mission_stop is the escape hatch; `compact_apply` is
 * the agent's only pressure relief at barrier/critical — the rationale transfers
 * verbatim from the tool it replaced; `mission_draft_update` is a local
 * DB write with no fund-moving side effect — safe-listing it lets setup
 * co-author the contract and plan together without deadlocking once an
 * unaccepted plan exists, mirroring why `plan_write` is here).
 */
const PLAN_GATE_SAFE_CONTROL: ReadonlySet<string> = new Set([
  "plan_write",
  "mission_stop",
  "compact_apply",
  "mission_draft_update",
]);

/**
 * Plan-mode acceptance gate (code-level defense-in-depth). When session-scoped
 * plan-mode is ON and the active plan is NOT user-accepted, block side-effecting
 * tools until the user accepts the plan. Reads LIVE plan state per call so a
 * `plan_write` that invalidates acceptance mid-batch is reflected immediately
 * (agent mode does not pause). Returns a synthetic error when blocked; null when
 * the gate is inactive or the call is allowed.
 *
 * Allow while pending: `read`-kind tools (incl. `discover_tools` and read-only
 * protocol quotes/previews) + the safe-control allowlist. Block everything else
 * — execution, wallet broadcasts, posts, scheduling, and sensitive local writes
 * like `polymarket_setup`. For `execute_tool` / mutating aliases the EFFECTIVE
 * side-effect of the resolved TARGET is what matters (the wrapper's own
 * actionKind is `read`), so we resolve via `dispatchTargetIsMutating`.
 */
export async function checkPlanAcceptanceDeny(
  call: ToolCallRequest,
  context: InternalToolContext,
): Promise<ToolResult | null> {
  if (!context.sessionId) return null;
  // Fast path: plan-mode off this turn → no gate, and crucially NO DB read.
  // Plan-mode cannot toggle mid-turn, so this turn-start snapshot is accurate.
  if (!context.planMode) return null;
  // Dynamic import mirrors the protocol runtime's DB-access pattern and avoids
  // a static tool → DB cycle (same shape as markAutoRetryUnsafe below).
  const { getActivePlan } = await import("@vex-agent/db/repos/session-plans.js");
  const plan = await getActivePlan(context.sessionId);
  if (!plan || !plan.enabled || plan.accepted) return null; // gate inactive

  if (PLAN_GATE_SAFE_CONTROL.has(call.name)) return null;

  const isProtocolExecution =
    call.name === "execute_tool" || isMutatingProtocolAlias(call.name);
  const allowed = isProtocolExecution
    ? !dispatchTargetIsMutating(call) // non-mutating target (read/quote/preview) ok
    : getActionKind(call.name) === "read"; // read-kind internal tools ok

  if (allowed) return null;

  return {
    success: false,
    output:
      `Plan mode is on and your action plan is not yet accepted, so "${call.name}" is blocked. ` +
      `Research, discovery, read-only quotes, and plan edits (plan_write) are allowed. ` +
      `Finish the plan and ask the user to review and accept it — execution unlocks on acceptance.`,
  };
}
