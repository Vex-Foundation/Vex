/**
 * `trench.launch_execute` — the ONLY leg that signs a Trench token creation.
 *
 * `mutating: true`, `actionKind: "user_wallet_broadcast"`, risk high. This file
 * is the PUBLIC ENTRY POINT and owns the ORDER; each step's mechanics live in
 * the same-named sibling folder (`./execute/`), one responsibility per file.
 *
 * THE ORDER, AND WHY EACH STEP IS WHERE IT IS:
 *
 *   1. Boundary-validate; forbidden params refused BY NAME (`./validate.ts`).
 *   2. Resolve the ADDRESS only, so a failure before signing still records the
 *      real wallet. The key is decrypted (`./execute/clients.ts`) only once the
 *      call may genuinely broadcast.
 *   3. Establish the C0 authorization VARIANT from HOST evidence, never params:
 *      a mission run proves provenance and ceilings (`full_autonomy`), a
 *      full-permission chat session executes directly (`session_full`), and a
 *      restricted session is refused by name and sent to the launch FORM, which
 *      is this tool's consent surface instead of an approval card. The matrix
 *      and the rulings behind it live on `resolveAuthorizationVariant` below.
 *   4. Build the plan — anchored fee, image bytes + digest, `msg.value`, the Vex
 *      fee, BOTH mission ceilings, the native-value gate (`./plan.ts`).
 *   5. Create the intent already `authorized` and CAS-CONSUME it — the
 *      exactly-once gate (`./execute/authorize.ts`).
 *   6. RE-DERIVE the plan and compare it field-by-field against what was
 *      authorized. THIS IS THE LAST GATE: a fee that moved, an image swapped, a
 *      permission downgraded, or substituted calldata all refuse here. Nothing
 *      reads the persisted authorization back to decide — the gate is
 *      re-derivation (see `./authorization.ts`).
 *   7-11. Durable activity row, staged broadcast, decode, record, then the Vex
 *      fee LAST and only on a confirmed receipt (`./execute/broadcast.ts`).
 */

import { randomUUID } from "node:crypto";

import { getAddress, type Address } from "viem";

import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { readMissionLaunchCeilings } from "@vex-agent/engine/mission/launch-ceiling.js";
import type { AutonomousLaunchCeilings } from "@vex-agent/engine/mission/launch-ceiling.js";
import { requireExecutionProvenance } from "../../../execution-provenance.js";
import { resolveSelectedAddress, walletScopeErrorToResult } from "../../../../internal/wallet/resolve.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import type { ToolResult } from "../../../../types.js";
import { fail } from "../../../handler-helpers.js";
import { checkLaunchAuthorizationUnchanged } from "./authorization.js";
import { buildLaunchPlan } from "./plan.js";
import type { LaunchExecuteDeps } from "./fee-seam.js";
import { validateLaunchRequest } from "./validate.js";
import { authorizeAndConsumeLaunch, settleLaunchFailure } from "./execute/authorize.js";
import { broadcastLaunch } from "./execute/broadcast.js";
import { openLaunchSigningClients } from "./execute/clients.js";

const TOOL_ID = "trench.launch_execute";
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/**
 * The §C7 fee seam, INJECTED.
 *
 * The default plans NO fee rather than inventing one: a launch must not be
 * blocked on a fee module that has not landed, and a fabricated fee would be
 * exactly the "number we cannot prove" rule 90 forbids on a signing path.
 */
const DEFAULT_DEPS: LaunchExecuteDeps = { planFeeLeg: () => null, runFeeLeg: null };

export async function trenchLaunchExecuteHandler(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  deps: LaunchExecuteDeps = DEFAULT_DEPS,
): Promise<ToolResult> {
  if (params.dryRun === true) {
    return fail(`${TOOL_ID} does not support dryRun — call trench.launch_preview instead.`);
  }

  // 1. Boundary.
  const validated = validateLaunchRequest(params);
  if (!validated.ok) return fail(validated.reason);

  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${TOOL_ID} requires an active session.`);

  // 2. Address only — no decryption yet.
  let walletAddress: Address;
  try {
    walletAddress = getAddress(
      resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
    );
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  const chainConfig = getLocalChain(TRENCH_CHAIN_ID);
  if (!chainConfig) {
    return fail(`Robinhood Chain (${TRENCH_CHAIN_ID}) is not in the local chain registry.`);
  }

  // 3. The C0 variant, from host evidence only.
  const variant = await resolveAuthorizationVariant(context);
  if (!variant.ok) return fail(variant.reason);

  // 2b. Only now may the key be decrypted.
  const clients = openLaunchSigningClients(context, chainConfig);
  if (!clients.ok) return clients.result;

  const planInput = {
    request: validated.value,
    sessionId,
    walletAddress,
    permission: context.sessionPermission,
    publicClient: clients.clients.publicClient,
    planFeeLeg: deps.planFeeLeg,
    nativeAddress: NATIVE_ADDRESS,
  };

  // 4. Plan — ceilings enforced ONLY on the autonomous path (§C6 leaves a human
  //    click ungated by design).
  const planned = await buildLaunchPlan(
    variant.ceilings === null
      ? planInput
      : { ...planInput, ceilings: { contract: variant.ceilings, launchesUsed: 0 } },
  );
  if (!planned.ok) return fail(planned.reason);

  // 5. Authorize + CAS-consume.
  const intentId = randomUUID();
  const consumed = await authorizeAndConsumeLaunch({
    intentId,
    authorizationId: randomUUID(),
    sessionId,
    walletAddress,
    missionRunId: variant.missionRunId,
    request: validated.value,
    authorizationKind: variant.kind,
    ceilings: variant.ceilings,
    // The C0 record, snapshotted at AUTHORIZE time, for the `session_full` path
    // only. On that path nothing else records what authorized the spend: there
    // is no approval row and no mission contract to reconstruct it from, so
    // without this blob an audit of a chat launch has an id and a kind and no
    // answer to "authorized to spend WHAT?". It is AUDIT ONLY, exactly like the
    // other agent paths — the gate stays the re-derive-and-compare below plus
    // the CAS (see ./authorization.ts). The other two agent variants are left
    // as they are deliberately: their honest records need evidence this call
    // does not hold (when the human resolved the card; the launch count in
    // force inside the authorize transaction).
    authorization:
      variant.kind === "session_full"
        ? { kind: "session_full", binding: planned.plan.binding, authorizedAt: new Date().toISOString() }
        : null,
  });
  if (!consumed.ok) return fail(consumed.reason);

  // 6. Re-derive and compare — the last gate before signing.
  const rederived = await buildLaunchPlan(planInput);
  if (!rederived.ok) {
    await settleLaunchFailure(intentId, sessionId, `PlanRefused:${rederived.code}`);
    return fail(rederived.reason);
  }
  const unchanged = checkLaunchAuthorizationUnchanged(
    planned.plan.binding,
    rederived.plan.binding,
  );
  if (!unchanged.ok) {
    await settleLaunchFailure(intentId, sessionId, "AuthorizationDrift:rederive");
    return fail(unchanged.reason);
  }

  // 7-11.
  return broadcastLaunch({
    intentId,
    sessionId,
    walletAddress,
    plan: rederived.plan,
    request: validated.value,
    params,
    publicClient: clients.clients.publicClient,
    walletClient: clients.clients.walletClient,
    deps,
  });
}

interface ResolvedVariant {
  readonly ok: true;
  readonly kind: "full_autonomy" | "session_full";
  readonly missionRunId: string | null;
  /** Non-null ONLY for the autonomous path, where §C6/§C6b apply. */
  readonly ceilings: AutonomousLaunchCeilings | null;
}

/**
 * Decide WHICH C0 variant authorizes this dispatch, from trusted host evidence.
 *
 * TWO agent-path branches, and the whole matrix (owner decrees 2026-08-02):
 *
 *   MISSION RUN → `full_autonomy`. Mission evidence (a `missionId` or a
 *   `missionRunId` on the dispatch) puts the call on this path, which must
 *   prove COMPLETE provenance and both frozen ceilings or be refused. Partial
 *   provenance never falls through to the chat branch: a mission dispatch
 *   missing a field is a broken dispatch, and letting it borrow the chat basis
 *   would drop the ceilings mission spending exists to be bounded by.
 *
 *   FULL-PERMISSION CHAT → `session_full`. No mission, session permission
 *   `full`: the user set that permission and asked for the launch, which is the
 *   same consent basis every other mutating tool spends on in chat
 *   (`swap_execute`). This branch corrects a real refusal — a full-mode user
 *   got "requires trusted mission provenance" because the handler read an
 *   absent approval id as proof the call HAD to be a mission dispatch. The
 *   launch form is an OPTIONAL path here, not a gate. No ceilings apply:
 *   §C6/§C6b bound UNATTENDED spending against a host-authored contract.
 *
 *   RESTRICTED → refused BY NAME, pointing at `trench.launch_request_form`.
 *   THE FORM REPLACES THE APPROVAL CARD; a launch must never produce both, so
 *   `evaluateApprovalGate` exempts this tool by name
 *   (`protocols/runtime/gates.ts`) and the refusal is produced HERE, where the
 *   remedy can be named, instead of a card that shows tool arguments where the
 *   form would show the fee, the image and the total.
 *
 * THERE IS DELIBERATELY NO `approval_card` BRANCH. It was removed with that
 * ruling: with the card exempted, no dispatch can arrive here carrying an
 * `approvalId` for this tool, and a branch no path reaches is dead code that
 * reads like a live authorization route. `approval_card` REMAINS in the DB kind
 * vocabulary — historical rows carry it, and an audit vocabulary is not dead
 * because no new row will use it.
 *
 * THE `user_submit` VARIANT IS NOT DECIDED HERE AND NEVER REACHES THIS
 * FUNCTION. A launch the human deployed from the form is not an agent dispatch
 * at all — no tool call, no `ProtocolExecutionContext` — so it has its own
 * public entry, `./execute-user-submit.ts`, which authorizes against the
 * snapshot the user consented to. That is what the restricted refusal routes
 * the user to.
 */
async function resolveAuthorizationVariant(
  context: ProtocolExecutionContext,
): Promise<ResolvedVariant | { ok: false; reason: string }> {
  const hasMissionEvidence =
    (context.missionId ?? "").trim().length > 0 || (context.missionRunId ?? "").trim().length > 0;

  if (!hasMissionEvidence) {
    if (context.sessionPermission !== "full") {
      return {
        ok: false,
        reason:
          `${TOOL_ID} refused: this session is in restricted permission. The launch form is this `
          + "tool's consent surface — open it for the user by calling trench.launch_request_form, and "
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
        `${TOOL_ID} refused: no approval authorized this launch and the session is not in full autonomy. `
        + "Nothing was signed.",
    };
  }

  // THE EXACT RUN, never "whichever run is active". The provenance already
  // names the run the host bound to this dispatch; reading by mission alone let
  // run A's launch be gated by run B's frozen snapshot — a different, possibly
  // larger, ceiling than the one that authorized this call. The engine refuses
  // by name when the run is missing, terminal, or not this mission's, and those
  // reasons are surfaced verbatim rather than flattened into a generic error.
  const read = await readMissionLaunchCeilings(
    provenance.provenance.missionId,
    provenance.provenance.missionRunId,
  );
  if (!read.ok) {
    return { ok: false, reason: `${TOOL_ID} ${read.reason}` };
  }

  return {
    ok: true,
    kind: "full_autonomy",
    missionRunId: provenance.provenance.missionRunId,
    ceilings: read.ceilings,
  };
}

/**
 * Test seam for the authorization-variant decision.
 *
 * Exported so the provenance BINDING (which run's ceilings gate this launch)
 * can be pinned without standing up a signer, a chain and a database — the
 * decision is pure policy over trusted host evidence, and it is the one part of
 * this file a mistake in would be silent.
 */
export const resolveAuthorizationVariantForTest = resolveAuthorizationVariant;
