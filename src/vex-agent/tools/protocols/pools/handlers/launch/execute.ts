/**
 * `pools.launch_execute` - the only leg that can authorize a pools.fun token
 * launch.
 *
 * THIS FILE IS THE PUBLIC ENTRY POINT AND OWNS THE ORDER; each step's mechanics
 * live in the same-named sibling folder (`./execute/`), one responsibility per
 * file.
 *
 * THE ORDER, AND WHY EACH STEP IS WHERE IT IS:
 *
 *   1. Boundary-validate. Every parameter the launch surface deliberately does
 *      not have - a fee, a value, a recipient, a deadline, gas, a salt, a minimum
 *      output - is refused BY NAME rather than ignored (`./inputs.ts`).
 *   2. Resolve the wallet ADDRESS only. No key is touched: this leg can refuse
 *      for a dozen honest reasons, and none of them should have unlocked a
 *      wallet.
 *   3. Establish the C0 authorization VARIANT from HOST evidence, never from
 *      params - shared with Trench so two launchpads cannot disagree about who
 *      may spend (`shared/launch-authorization-variant.ts`). A restricted
 *      session is refused by name and sent to `pools.launch_request_form`, which
 *      is this tool's consent surface instead of an approval card.
 *   4. Build the VERIFIED plan: image uploaded once, prepare, anchored chain
 *      reads, both simulations, the gas ceiling, the Vex fee, the mission
 *      ceilings, and then all 13 verifier points (`./execute/plan.ts`). The
 *      verifier is the gate, and it runs while NO authorization exists.
 *   5. Only on a verified plan: create the intent already `authorized` and
 *      CAS-consume it - the exactly-once gate (`./execute/authorize.ts`). What
 *      is authorized is the fingerprint of the exact bytes step 4 proved.
 *   6. Hand that fingerprint, and nothing else, to the staged broadcast.
 *
 * THE KEY IS DECRYPTED AT STEP 3b, between the authorization variant and the
 * plan: late enough that the boundary, the wallet scope and the authority
 * decision have all refused first, and early enough that a wallet which cannot
 * sign never burns an authorization.
 *
 * The broadcaster stays INJECTED (defaulted to the real one) so the ordering
 * above can be pinned by tests without standing up a signer.
 */

import { getAddress, type Address } from "viem";

import { getLocalChain } from "@tools/evm-chains/registry.js";
import { openLaunchSigningClients } from "../../../shared/launch-signing-clients.js";
import { POOLS_CHAIN_ID } from "@tools/pools-fun/constants.js";
import { fail } from "../../../handler-helpers.js";
import { resolveSelectedAddress, walletScopeErrorToResult } from "../../../../internal/wallet/resolve.js";
import { resolveLaunchAuthorizationVariant } from "../../../shared/launch-authorization-variant.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import type { ToolResult } from "../../../../types.js";
import { readPoolsLaunchInputs } from "./inputs.js";
import type { PoolsLaunchAuthorization } from "./authorization.js";
import { buildPoolsLaunchPlan, type PoolsLaunchPlan } from "./execute/plan.js";
import {
  authorizeAndConsumePoolsLaunch,
  newPoolsLaunchIds,
  settlePoolsLaunchFailure,
} from "./execute/authorize.js";
import { broadcastPoolsLaunch } from "./execute/broadcast.js";

const TOOL_ID = "pools.launch_execute";
const FORM_TOOL_ID = "pools.launch_request_form";

/**
 * What happens once a launch is authorized.
 *
 * INJECTED so the ORDER above can be pinned without a signer, and defaulted to
 * the real staged broadcast: a default that silently did nothing would leave a
 * consumed authorization looking like a launch in flight. A `null` broadcaster
 * is an explicit test-only choice, and it RELEASES the authorization rather than
 * abandoning it.
 */
export interface PoolsLaunchExecuteDeps {
  readonly broadcast: PoolsLaunchBroadcaster | null;
}

export type PoolsLaunchBroadcaster = (input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly walletAddress: Address;
  readonly plan: PoolsLaunchPlan;
  readonly params: Record<string, unknown>;
  readonly publicClient: Parameters<typeof broadcastPoolsLaunch>[0]["publicClient"];
  readonly walletClient: Parameters<typeof broadcastPoolsLaunch>[0]["walletClient"];
}) => Promise<ToolResult>;

const DEFAULT_DEPS: PoolsLaunchExecuteDeps = { broadcast: broadcastPoolsLaunch };

export async function poolsLaunchExecuteHandler(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  deps: PoolsLaunchExecuteDeps = DEFAULT_DEPS,
): Promise<ToolResult> {
  if (params.dryRun === true) {
    return fail(`${TOOL_ID} does not support dryRun - call pools__launch_preview instead.`);
  }

  // 1. Boundary.
  // `requireImage` is set HERE and nowhere else: this is the only leg that
  // signs, and an imageless launch is irreversible (the PPV incident).
  const validated = readPoolsLaunchInputs(params, { requireImage: true });
  if (!validated.ok) return fail(validated.reason);
  const inputs = validated.value;

  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${TOOL_ID} requires an active session.`);

  // 2. Address only - no decryption anywhere on this leg.
  let walletAddress: Address;
  try {
    walletAddress = getAddress(
      resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
    );
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  const chainConfig = getLocalChain(POOLS_CHAIN_ID);
  if (!chainConfig) {
    return fail(`Robinhood Chain (${POOLS_CHAIN_ID}) is not in the local chain registry.`);
  }

  // 3. The C0 variant, from host evidence only.
  const variant = await resolveLaunchAuthorizationVariant(context, {
    toolId: TOOL_ID,
    formToolId: FORM_TOOL_ID,
  });
  if (!variant.ok) return fail(variant.reason);

  // 3b. ONLY NOW may the key be decrypted - after the boundary, the wallet
  //     scope and the authorization variant have all been settled, and BEFORE
  //     any authorization exists. Opening it later would mean a wallet that
  //     cannot sign still burned an authorization; opening it earlier would
  //     unlock a wallet for a call that a dozen honest refusals never reach.
  const signing = openLaunchSigningClients(context, chainConfig);
  if (!signing.ok) return signing.result;

  // 4. THE VERIFIED PLAN. Nothing is authorized until this returns ok.
  const planned = await buildPoolsLaunchPlan({
    name: inputs.name,
    symbol: inputs.symbol,
    pairedAsset: inputs.pairedAsset,
    image: inputs.imageId === null ? { kind: "none" } : { kind: "locker", imageId: inputs.imageId },
    prebuyWei: inputs.prebuyWei,
    prebuyHuman: inputs.prebuyHuman,
    sessionId,
    walletAddress,
    // The system pins the creator fee stream to the session wallet on every
    // agent launch, and the tools have no recipient parameter at all - so this
    // is always an ADDRESS choice, held to exact equality by the verifier. Only
    // the desktop form may name anyone else (owner decision 3).
    feeRecipient: { kind: "address", address: walletAddress },
    permission: context.sessionPermission,
    publicClient: signing.clients.publicClient,
    ...(variant.ceilings === null
      ? {}
      : { ceilings: { contract: variant.ceilings, launchesUsed: 0 } }),
    ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
  });
  if (!planned.ok) return fail(planned.reason);

  // 5. Authorize + CAS-consume, over the fingerprint of the verified bytes.
  const ids = newPoolsLaunchIds();
  const consumed = await authorizeAndConsumePoolsLaunch({
    intentId: ids.intentId,
    authorizationId: ids.authorizationId,
    sessionId,
    missionRunId: variant.missionRunId,
    plan: planned.plan,
    authorizationKind: variant.kind,
    ceilings: variant.ceilings,
    authorization: buildAuthorizationRecord(variant, planned.plan, context),
  });
  if (!consumed.ok) return fail(consumed.reason);

  // 6. The staged broadcast of that exact fingerprint.
  if (deps.broadcast === null) {
    await settlePoolsLaunchFailure(ids.intentId, sessionId, "BroadcastUnavailable:not_wired");
    return fail(
      `${TOOL_ID} verified and authorized this launch but its broadcast leg is not wired in this build, so `
        + "NOTHING WAS SIGNED and the authorization was released. No funds moved.",
    );
  }

  return deps.broadcast({
    intentId: ids.intentId,
    sessionId,
    walletAddress,
    plan: planned.plan,
    params,
    publicClient: signing.clients.publicClient,
    walletClient: signing.clients.walletClient,
  });
}

/**
 * The C0 record persisted for audit.
 *
 * Written on BOTH agent variants, unlike Trench, which writes one only for
 * `session_full`. The reason is the pools.fun order: there is no
 * re-derive-and-compare before signing (a second prepare would describe a
 * different token), so the binding this record carries is the only durable
 * statement of what the fingerprint MEANT - which token at which address, which
 * pair, which fee at which block, which recipient. It is audit, never a gate:
 * nothing reads it back to decide.
 */
function buildAuthorizationRecord(
  variant: { readonly kind: "full_autonomy" | "session_full"; readonly missionRunId: string | null; readonly ceilings: { readonly maxLaunchValueRaw: string | null; readonly maxLaunchCount: number | null } | null },
  plan: PoolsLaunchPlan,
  context: ProtocolExecutionContext,
): PoolsLaunchAuthorization {
  const authorizedAt = new Date().toISOString();
  if (variant.kind === "session_full") {
    return { kind: "session_full", binding: plan.binding, authorizedAt };
  }
  return {
    kind: "full_autonomy",
    binding: plan.binding,
    provenance: {
      missionId: context.missionId ?? "",
      missionRunId: variant.missionRunId ?? "",
      maxLaunchValueRaw: variant.ceilings?.maxLaunchValueRaw ?? null,
      maxLaunchCount: variant.ceilings?.maxLaunchCount ?? null,
    },
    authorizedAt,
  };
}
