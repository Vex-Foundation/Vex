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
 *      params - shared across launchpads so two of them cannot disagree about who
 *      may spend (`shared/launch-authorization-variant.ts`). A restricted
 *      session is refused by name and sent to `pools.launch_request_form`, which
 *      is this tool's consent surface instead of an approval card.
 *   4. Build the VERIFIED plan: image uploaded once, prepare, anchored chain
 *      reads, both simulations, the gas ceiling, the Vex fee, the mission
 *      ceilings, and then all 15 verifier points (`./execute/plan.ts`). The
 *      verifier is the gate, and it runs while NO authorization exists.
 *   4b. `simulateOnly` STOPS HERE and returns the would-be launch. No signer was
 *      opened at step 3b, no authorization exists, nothing is broadcast.
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
import { getLocalPublicClient } from "@tools/evm-chains/evm-client.js";
import { openLaunchSigningClients } from "../../../shared/launch-signing-clients.js";
import { POOLS_CHAIN_ID } from "@tools/pools-fun/constants.js";
import { fail } from "../../../handler-helpers.js";
import { resolveSelectedAddress, walletScopeErrorToResult } from "../../../../internal/wallet/resolve.js";
import { resolveLaunchAuthorizationVariant } from "../../../shared/launch-authorization-variant.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import type { ToolResult } from "../../../../types.js";
import { readPoolsLaunchInputs } from "./inputs.js";
import {
  resolveProjectFileLaunchImage,
  type LaunchImageSelection,
} from "../../../shared/launch-image-input.js";
import type { PoolsLaunchImageSource } from "./execute/prepare.js";
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

  // ── SIMULATE-ONLY, read before anything else ──────────────────────
  //
  // A launch is irreversible, so there has to be a way to exercise this exact
  // leg - the real prepare, the real anchored reads, the real verifier, a real
  // gas estimate over the real calldata - and stop at the edge of signing. That
  // is what this flag is, and it is read HERE, beside `dryRun`, because the
  // order below is the security contract: the signer opens at step 3b, and a
  // flag read after that point could not prevent a key from being decrypted.
  //
  // THE SHAPE IS BORROWED FROM MetaMask's `beforePublish` HOOK
  // (`agents-colab/metamask-core/packages/transaction-controller/src/TransactionController.ts:3148`),
  // which returns a distinct non-error outcome (`SkippedViaBeforePublishHook`)
  // rather than throwing, and does NOT mark the transaction submitted. Adopted:
  // a stop between "fully checked" and "committed" is a first-class outcome, not
  // a failure. REJECTED: their hook runs AFTER `#signTransaction`, so a skipped
  // publish has still touched the key. On a self-custodial agent path that is
  // the wrong side of the line - the point of a simulation is that no wallet was
  // opened at all - so ours gates the signer, the authorization and the
  // broadcast together.
  //
  // It is deliberately NOT a `dryRun`: `pools__launch_preview` is the advisory,
  // side-effect-free estimate. This runs the whole money path and DOES have a
  // provider side effect (a prepare pins an IPFS object and mines a salt), which
  // the result states.
  const simulateOnly = params.simulateOnly === true;
  if (params.simulateOnly !== undefined && typeof params.simulateOnly !== "boolean") {
    return fail(`"simulateOnly" must be true or false, received ${typeof params.simulateOnly}.`);
  }

  // 1. Boundary.
  // `requireImage` is set HERE and nowhere else: this is the only leg that
  // signs, and an imageless launch is irreversible (the PPV incident).
  const validated = readPoolsLaunchInputs(params, context, {
    requireImage: true,
    toolName: "pools__launch_execute",
  });
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

  // 2b. THE PICTURE'S BYTES, resolved on the surface that owns the containment.
  //
  //     A locker id travels as an id and is resolved by the byte seam inside the
  //     prepare step. A PROJECT PATH cannot: it is a path the MODEL supplied, and
  //     the only boundary that can contain it is the one holding this call's
  //     project root. So it is read HERE, through the no-follow reader, before
  //     any wallet, authorization or provider call exists - a refusal costs
  //     nothing at this point, and reading it later would mean resolving a
  //     model-supplied path in a module that has no root to contain it to.
  const image = await resolveLaunchImageSource(inputs.image, context);
  if (!image.ok) return fail(image.reason);

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
  //
  //     UNDER `simulateOnly` NO KEY IS TOUCHED AT ALL. The plan builder needs a
  //     public client and nothing else; it reads, simulates and verifies. Taking
  //     the read-only client here is what makes "no signer was opened" a
  //     structural property of the leg rather than a promise in a comment.
  let publicClient;
  let signing: ReturnType<typeof openLaunchSigningClients> | null = null;
  if (simulateOnly) {
    publicClient = getLocalPublicClient(chainConfig);
  } else {
    signing = openLaunchSigningClients(context, chainConfig);
    if (!signing.ok) return signing.result;
    publicClient = signing.clients.publicClient;
  }

  // 4. THE VERIFIED PLAN. Nothing is authorized until this returns ok.
  const planned = await buildPoolsLaunchPlan({
    name: inputs.name,
    symbol: inputs.symbol,
    pairedAsset: inputs.pairedAsset,
    pairedStockAddress: inputs.pairedStockAddress,
    image: image.value,
    prebuyWei: inputs.prebuyWei,
    prebuyHuman: inputs.prebuyHuman,
    sessionId,
    walletAddress,
    // TWO SHAPES ON THE AGENT PATH, NEITHER OF THEM AN ADDRESS THE MODEL CHOSE.
    //
    // Without `holderRewards`, the system pins the creator fee stream to the
    // session wallet: the tools have no recipient parameter at all, and the
    // verifier holds the signed tuple to exact equality with it. With it, the
    // stream goes to the gateway's own `FEES_TO_HOLDERS*` sentinel for the
    // chosen mode - a constant read LIVE from the gateway by verifier point 15,
    // not from any input and not from any constant in this build. Only the
    // desktop form may name a third party (owner decision 3).
    feeRecipient:
      inputs.feeStream.kind === "holders"
        ? { kind: "holders", mode: inputs.feeStream.mode }
        : { kind: "address", address: walletAddress },
    permission: context.sessionPermission,
    publicClient,
    ...(simulateOnly ? { simulateOnly: true } : {}),
    ...(variant.ceilings === null
      ? {}
      : { ceilings: { contract: variant.ceilings, launchesUsed: 0 } }),
    ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
  });
  if (!planned.ok) return fail(planned.reason);

  // 4b. THE SIMULATION STOPS HERE, with everything a launch would have been.
  //
  //     No authorization is created, so nothing is consumed and no intent can be
  //     mistaken for a launch in flight; no signer was ever opened. The result
  //     carries the fingerprint of the exact bytes that WOULD be signed, which
  //     is what makes a later real launch comparable to this one.
  if (simulateOnly) return describeSimulatedLaunch(planned.plan, walletAddress);
  //     The plan carries the flag too, and step 5 refuses a flagged plan even
  //     though the line above already returned: "a simulated plan is never
  //     authorized" is enforced where the authorization is created, not only
  //     where the flag was read.
  if (planned.plan.simulateOnly) {
    return fail(`${TOOL_ID}: a plan built under simulateOnly reached the authorization step; nothing was signed.`);
  }

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
    publicClient: signing!.clients.publicClient,
    walletClient: signing!.clients.walletClient,
  });
}

/**
 * The picture, in the form the prepare step can use.
 *
 * A locker selection stays an ID: the byte seam that resolves it also owns the
 * digest check the metadata is verified against, and resolving it here would
 * give that check a second, weaker home. A PROJECT FILE is read here and travels
 * as bytes, because the reader that contains it needs the project root this
 * context carries and the prepare step has none.
 */
async function resolveLaunchImageSource(
  selection: LaunchImageSelection | null,
  context: ProtocolExecutionContext,
): Promise<{ ok: true; value: PoolsLaunchImageSource } | { ok: false; reason: string }> {
  if (selection === null) return { ok: true, value: { kind: "none" } };
  if (selection.kind === "locker") {
    return { ok: true, value: { kind: "locker", imageId: selection.imageId } };
  }
  const resolved = await resolveProjectFileLaunchImage(selection, context);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  return {
    ok: true,
    value: { kind: "bytes", bytes: resolved.image.bytes, label: resolved.image.displayLabel },
  };
}

/**
 * What a `simulateOnly` run returns: the launch that WOULD have been signed.
 *
 * Every number here was produced by the same code a real launch runs, at one
 * anchored block, and the fingerprint is the identity of the exact bytes. It is
 * reported as a would-be launch rather than as a success, in the tool's own
 * words, so neither the model nor a human can read it as "a token was launched".
 */
function describeSimulatedLaunch(plan: PoolsLaunchPlan, walletAddress: Address): ToolResult {
  const data = {
    simulateOnly: true as const,
    launched: false as const,
    chainId: plan.call.chainId,
    wallet: walletAddress,
    gateway: plan.call.to,
    gatewayVersion: plan.anchors.gatewayVersion.toString(),
    anchorBlockNumber: plan.anchors.blockNumber.toString(),
    verifier: "passed" as const,
    predictedTokenAddress: plan.binding.predictedTokenAddress,
    predictedPoolAddress: plan.predictedPoolAddress,
    metadataUri: plan.metadataUri,
    imageLanded: plan.imageLanded,
    calldataFingerprint: plan.call.fingerprint,
    valueWei: plan.call.valueWei.toString(),
    deploymentFeeWei: plan.binding.deploymentFeeWei,
    prebuyWei: plan.binding.prebuyWei,
    vexFeeWei: plan.binding.vexFeeWei,
    gas: {
      limit: plan.gas.limit.toString(),
      priceWei: plan.gas.priceWei.toString(),
      boundWei: plan.gas.boundWei.toString(),
    },
    feeRecipient: plan.binding.feeRecipient,
    deadline: plan.tuple.deadline.toString(),
    note:
      "SIMULATION. Every check a real launch runs was run - the launchpad prepared real calldata, the chain "
      + "was read at the block above, the launch was eth_call-simulated from this wallet, all 15 verifier "
      + "points passed, and the gas above was estimated over these exact bytes. NOTHING WAS SIGNED: no "
      + "wallet key was opened, no authorization was created and no transaction was broadcast, so no token "
      + "exists at the predicted address. One side effect DID happen: preparing a launch pins a metadata "
      + "object with the launchpad and mines a new salt, so a real launch prepared later will have a "
      + "different salt and a different token address.",
  };
  return { success: true, output: JSON.stringify(data), data };
}

/**
 * The C0 record persisted for audit.
 *
 * Written on BOTH agent variants, rather than only for
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
