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
 *   3. Establish the C0 authorization VARIANT from HOST evidence, never params.
 *      A RESTRICTED session never reaches here with a spend: the protocol
 *      runtime's approval gate turns the call into a `pendingApproval` card
 *      first, and the resumed dispatch arrives carrying `approvalId`. So an
 *      absent approval id means this must be Path 2, which then has to PROVE
 *      mission provenance and full autonomy or be refused.
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
import {
  requireExecutionProvenance,
  readApprovalProvenance,
} from "../../../execution-provenance.js";
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
    isAutonomous: variant.isAutonomous,
    ceilings: variant.ceilings,
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
  readonly isAutonomous: boolean;
  readonly missionRunId: string | null;
  /** Non-null ONLY for the autonomous path, where §C6/§C6b apply. */
  readonly ceilings: AutonomousLaunchCeilings | null;
}

/**
 * Decide WHICH C0 variant authorizes this dispatch, from trusted host evidence.
 *
 * An `approvalId` means a human resolved an approval card — the `approval_card`
 * variant, and §C6 does not gate it (a person decided). Its absence means
 * nothing human authorized this call, so it can only be Path 2, which must prove
 * mission provenance AND full autonomy AND both ceilings. There is deliberately
 * no third branch: a dispatch that is neither is refused.
 *
 * THE `user_submit` VARIANT IS NOT DECIDED HERE AND NEVER REACHES THIS
 * FUNCTION. A launch the human deployed from the dialog is not an agent
 * dispatch at all — no tool call, no `ProtocolExecutionContext` — so it has its
 * own public entry, `./execute-user-submit.ts`, which authorizes against the
 * snapshot the user consented to. Only `approval_card` and `full_autonomy` are
 * agent-path variants.
 */
async function resolveAuthorizationVariant(
  context: ProtocolExecutionContext,
): Promise<ResolvedVariant | { ok: false; reason: string }> {
  const approvalId = readApprovalProvenance(context);
  if (approvalId !== null) {
    return { ok: true, isAutonomous: false, missionRunId: context.missionRunId ?? null, ceilings: null };
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
    isAutonomous: true,
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
