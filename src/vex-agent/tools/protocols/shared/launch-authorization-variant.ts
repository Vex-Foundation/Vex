/**
 * WHICH C0 variant authorizes a launch dispatch - shared by every launchpad.
 *
 * EXTRACTED, NOT COPIED. This decision was written for `trench.launch_execute`
 * and is reproduced here verbatim in behaviour so pools.fun can reuse it: a
 * second hand-written copy of an authorization matrix is how two launch tools
 * end up disagreeing about who may spend, and the difference would only ever
 * show up as a real launch nobody authorized. The only per-tool inputs are the
 * two tool ids that appear in the refusals.
 *
 * THE MATRIX, and the rulings behind it (owner decrees 2026-08-02):
 *
 *   MISSION RUN -> `full_autonomy`. Mission evidence (a `missionId` or a
 *   `missionRunId` on the dispatch) puts the call on this path, which must prove
 *   COMPLETE provenance and both frozen ceilings or be refused. Partial
 *   provenance never falls through to the chat branch: a mission dispatch
 *   missing a field is a broken dispatch, and letting it borrow the chat basis
 *   would drop the ceilings mission spending exists to be bounded by.
 *
 *   FULL-PERMISSION CHAT -> `session_full`. No mission, session permission
 *   `full`: the user set that permission and asked for the launch, which is the
 *   same consent basis every other mutating tool spends on in chat
 *   (`swap_execute`). No ceilings apply - the mission ceilings bound UNATTENDED
 *   spending against a host-authored contract.
 *
 *   RESTRICTED -> refused BY NAME, pointing at the launch FORM. THE FORM
 *   REPLACES THE APPROVAL CARD; a launch must never produce both, so
 *   `evaluateApprovalGate` exempts the execute tool by name
 *   (`protocols/runtime/gates.ts`) and the refusal is produced here, where the
 *   remedy can be named, instead of a card that shows tool arguments where the
 *   form would show the fee, the image and the total.
 *
 * THERE IS DELIBERATELY NO `approval_card` BRANCH. With the card exempted, no
 * dispatch can arrive carrying an `approvalId` for these tools, and a branch no
 * path reaches is dead code that reads like a live authorization route.
 * `approval_card` REMAINS in the DB kind vocabulary - historical rows carry it,
 * and an audit vocabulary is not dead because no new row will use it.
 *
 * THE `user_submit` VARIANT IS NOT DECIDED HERE and never reaches this function.
 * A launch the human deployed from the form is not an agent dispatch at all - no
 * tool call, no `ProtocolExecutionContext` - so it has its own entry point per
 * launchpad, authorizing against the snapshot the user consented to.
 */

import { readMissionLaunchCeilings } from "@vex-agent/engine/mission/launch-ceiling.js";
import type { AutonomousLaunchCeilings } from "@vex-agent/engine/mission/launch-ceiling.js";
import { requireExecutionProvenance } from "../execution-provenance.js";
import type { ProtocolExecutionContext } from "../types.js";

/** The two tool ids that appear in this decision's refusals. */
export interface LaunchVariantTools {
  /** The execute tool being dispatched, named in every refusal. */
  readonly toolId: string;
  /** The form tool a restricted session is sent to instead. */
  readonly formToolId: string;
}

export interface ResolvedLaunchVariant {
  readonly ok: true;
  readonly kind: "full_autonomy" | "session_full";
  readonly missionRunId: string | null;
  /** Non-null ONLY for the autonomous path, where the mission ceilings apply. */
  readonly ceilings: AutonomousLaunchCeilings | null;
}

export type LaunchVariantResult =
  | ResolvedLaunchVariant
  | { readonly ok: false; readonly reason: string };

export async function resolveLaunchAuthorizationVariant(
  context: ProtocolExecutionContext,
  tools: LaunchVariantTools,
): Promise<LaunchVariantResult> {
  const hasMissionEvidence =
    (context.missionId ?? "").trim().length > 0 || (context.missionRunId ?? "").trim().length > 0;

  if (!hasMissionEvidence) {
    if (context.sessionPermission !== "full") {
      return {
        ok: false,
        reason:
          `${tools.toolId} refused: this session is in restricted permission. The launch form is this `
          + `tool's consent surface — open it for the user by calling ${tools.formToolId}, and `
          + "their Deploy click authorizes the launch. Nothing was signed.",
      };
    }
    return { ok: true, kind: "session_full", missionRunId: null, ceilings: null };
  }

  const provenance = requireExecutionProvenance(context);
  if (!provenance.ok) return { ok: false, reason: provenance.reason };

  if (context.sessionPermission !== "full") {
    return {
      ok: false,
      reason:
        `${tools.toolId} refused: no approval authorized this launch and the session is not in full autonomy. `
        + "Nothing was signed.",
    };
  }

  // THE EXACT RUN, never "whichever run is active". The provenance already names
  // the run the host bound to this dispatch; reading by mission alone let run A's
  // launch be gated by run B's frozen snapshot — a different, possibly larger,
  // ceiling than the one that authorized this call. The engine refuses by name
  // when the run is missing, terminal, or not this mission's, and those reasons
  // are surfaced verbatim rather than flattened into a generic error.
  const read = await readMissionLaunchCeilings(
    provenance.provenance.missionId,
    provenance.provenance.missionRunId,
  );
  if (!read.ok) {
    return { ok: false, reason: `${tools.toolId} ${read.reason}` };
  }

  return {
    ok: true,
    kind: "full_autonomy",
    missionRunId: provenance.provenance.missionRunId,
    ceilings: read.ceilings,
  };
}
