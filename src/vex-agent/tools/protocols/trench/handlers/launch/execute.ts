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
import {
  resolveLaunchAuthorizationVariant,
  type LaunchVariantResult,
} from "../../../shared/launch-authorization-variant.js";
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
import { openLaunchSigningClients } from "../../../shared/launch-signing-clients.js";

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
    return fail(`${TOOL_ID} does not support dryRun - call trench__launch_preview instead.`);
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

/**
 * Decide WHICH C0 variant authorizes this dispatch, from trusted host evidence.
 *
 * THE MATRIX AND ITS RULINGS NOW LIVE IN ONE PLACE,
 * `../../../shared/launch-authorization-variant.ts`, because pools.fun launches
 * make exactly the same decision and a second copy of an authorization matrix is
 * how two launch tools end up disagreeing about who may spend. This wrapper
 * supplies the two tool ids that appear in the refusals and nothing else; the
 * behaviour is unchanged.
 *
 * The restricted refusal routes the user to `trench.launch_request_form`, whose
 * Deploy click is handled by `./execute-user-submit.ts` - the `user_submit`
 * variant is not decided here and never reaches this function.
 */
async function resolveAuthorizationVariant(
  context: ProtocolExecutionContext,
): Promise<LaunchVariantResult> {
  return resolveLaunchAuthorizationVariant(context, {
    toolId: TOOL_ID,
    formToolId: "trench.launch_request_form",
  });
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
