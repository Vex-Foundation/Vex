/**
 * THE LAST GATE BEFORE THE KEY on a Virtuals agent launch.
 *
 * ## Why a second authority check exists at all
 *
 * `virtuals.launch.execute` builds its plan, holds the rebuilt calldata
 * fingerprint against the one the preview sealed, and claims the preview -
 * all before it opens a key. That is necessary and it is NOT sufficient, for
 * the same two reasons the curve trade's own gate exists
 * (`../trade/final-authority.ts`), measured on this lane by the 2026-09-07
 * final review:
 *
 *  1. IT RUNS ON THE FALLBACK READER. The plan is built through
 *     `getVirtualsCurvePublicClient` - a viem `fallback` over the whole endpoint
 *     list - while the launch is estimated, signed and broadcast through the
 *     PINNED client (`getVirtualsCurveClients`). A BondingV5 implementation, a
 *     BondingConfig address or a launch fee proven on one node is not proven on
 *     the node that will execute the bytes.
 *  2. IT RUNS BEFORE THE ALLOWANCE LEGS. An approval takes block time - tens of
 *     seconds on Base, unbounded when the node is slow. Everything the plan
 *     proved is therefore stale by the time `preLaunch` is signed: BondingV5 can
 *     be upgraded behind its proxy, the venue's own launch fee can move, the
 *     wallet's VIRTUAL can be spent elsewhere, and the allowance the approval
 *     just wrote may not be what the signing node sees.
 *
 * So every "YES" row of the plan's own authority table (`./plan.ts`) is re-read
 * HERE, through the pinned signing reader, after every dependent approval has
 * mined and immediately before the signature. This is MetaMask's `beforeSign`
 * position exactly (`TransactionController.ts:3664-3690`: the hook runs, the
 * controller re-reads the authoritative record, and the bytes it signs are built
 * from THAT record rather than from the caller's original request).
 *
 * ## The calldata is recomputed, never trusted
 *
 * `startTime_` is the constant 0 (`./plan.ts`), so the whole `preLaunch` call is
 * a PURE FUNCTION of the approved fields. This gate rebuilds it from the sealed
 * approval and compares the result to both the plan and the FINAL PREPARED
 * REQUEST that `signStageBroadcast` is about to serialize. A gate whose subject
 * is not the bytes that will be signed proves nothing about them, which is
 * Rabby's rule (`provider/controller.ts:686-745`) and the reason the request is
 * passed in rather than captured.
 *
 * ## What it refuses, and what it deliberately does not
 *
 * Refuses BY NAME: a pinned node that cannot be read, a moved implementation, a
 * contract suite that no longer names Vex's router, a changed BondingConfig or
 * protocol launch fee, a changed VIRTUAL scale, a wallet that can no longer pay
 * or has not got the allowance the approval was supposed to write, sealed fields
 * that no longer match the plan, and calldata that is not the calldata the
 * approval bound.
 *
 * Does NOT refuse: a moved block number, a changed scheduled-launch delay (0 is
 * below `block.timestamp + startTimeDelay` at every block for every delay, so an
 * immediate launch stays immediate), or a balance above the approved commitment.
 *
 * A refusal from here means NOTHING WAS SIGNED: `signStageBroadcast` runs this
 * as `onBeforeSign`, whose throw aborts before the key is used and before any
 * bytes exist.
 */

import { formatUnits, getAddress, type Address, type Chain, type PublicClient, type Transport } from "viem";

import {
  buildPreLaunchTx,
  launchCalldataFingerprint,
  readLaunchState,
  type LaunchState,
} from "@tools/virtuals/launch/index.js";
import type { VirtualsCurveDeployment } from "@tools/virtuals/curve/index.js";
import type { FinalSignedRequest } from "@tools/evm-chains/staged-broadcast.js";
import type { AgentActivityFailureCode } from "@vex-agent/db/repos/agent-activity.js";
import type { VirtualsLaunchIntentFields } from "@vex-agent/db/repos/token-launch-intents.js";

import type { LaunchPlan } from "./plan.js";

/** The bounded classes this gate refuses in. Never provider text. */
export type LaunchFinalAuthorityKind =
  | "state_unreadable"
  | "implementation_moved"
  | "suite_mismatch"
  | "drift"
  | "allowance_or_balance"
  | "calldata_changed";

/**
 * A refusal at the last gate. Thrown so that `signStageBroadcast` aborts before
 * the signature; carries the agent-facing sentence and the durable failure code
 * so the leg is terminalized as what it was rather than as an unknown revert.
 */
export class VirtualsLaunchFinalAuthorityError extends Error {
  readonly kind: LaunchFinalAuthorityKind;
  readonly failureCode: AgentActivityFailureCode;
  /** The whole agent-facing sentence, already ending in "Nothing was signed". */
  readonly refusal: string;

  constructor(input: {
    readonly kind: LaunchFinalAuthorityKind;
    readonly failureCode: AgentActivityFailureCode;
    readonly refusal: string;
  }) {
    super(input.refusal);
    this.name = "VirtualsLaunchFinalAuthorityError";
    this.kind = input.kind;
    this.failureCode = input.failureCode;
    this.refusal = input.refusal;
  }
}

const NOTHING_SIGNED =
  "Nothing was signed and no agent was created; any approval this launch already mined stands, and no Vex fee was taken.";

function refuse(
  kind: LaunchFinalAuthorityKind,
  failureCode: AgentActivityFailureCode,
  what: string,
): never {
  throw new VirtualsLaunchFinalAuthorityError({
    kind,
    failureCode,
    refusal: `Refused at the final signing check: ${what} ${NOTHING_SIGNED}`,
  });
}

export interface LaunchFinalAuthorityInput {
  /** The PINNED signing reader - the same node that will broadcast these bytes. */
  readonly client: PublicClient<Transport, Chain>;
  readonly deployment: VirtualsCurveDeployment;
  readonly wallet: Address;
  /** The plan the preview sealed and this execution authorized. */
  readonly plan: LaunchPlan;
  /** The sealed approval block, read off the claimed intent. */
  readonly sealed: VirtualsLaunchIntentFields;
  /** What `signStageBroadcast` is about to serialize. */
  readonly request: FinalSignedRequest;
}

/**
 * Re-establish every launch authority row through the pinned signing reader and
 * refuse by name on any drift. Resolves only when the bytes may be signed.
 *
 * THE ORDER IS DELIBERATE and mirrors the plan's own walk: what the pinned node
 * says the contracts ARE, then whether the wallet can still pay for the launch
 * it approved, then whether the approval's own sealed figures still describe the
 * plan, and last whether the bytes are the bytes those figures produce.
 */
export async function assertVirtualsLaunchFinalAuthority(
  input: LaunchFinalAuthorityInput,
): Promise<void> {
  const { plan, sealed, deployment } = input;

  // ── THE CONTRACTS, AS THE SIGNING NODE SEES THEM ──
  let state: Awaited<ReturnType<typeof readLaunchState>>;
  try {
    state = await readLaunchState({
      client: input.client,
      deployment,
      wallet: input.wallet,
    });
  } catch {
    // The class only. A provider payload carries urls, request bodies and auth
    // headers, and this sentence reaches an agent and a durable row (rule 07).
    refuse(
      "state_unreadable",
      "simulation_reverted",
      "the node that would broadcast this launch could not be asked for BondingV5's state, so the implementation, the "
      + "venue's launch fee and this wallet's balance behind the signature are UNKNOWN rather than unchanged.",
    );
  }
  if (!state.ok) {
    refuse(
      state.code === "proxy_moved"
        ? "implementation_moved"
        : state.code === "suite_mismatch"
          ? "suite_mismatch"
          : "state_unreadable",
      "simulation_reverted",
      `${state.reason} This was read on the signing node immediately before the signature.`,
    );
  }

  // ── THE AUTHORITY ROWS THE PLAN CALLS "revalidated: YES" ──
  const planned = plan.state;
  assertUnmoved(planned, state, deployment);

  // ── CAN THIS WALLET STILL DO WHAT IT APPROVED ──
  //
  // Both figures are the SIGNING node's, and both are refusals rather than
  // reverts: `preLaunch` pulls `purchaseAmount_` with `safeTransferFrom`, so a
  // spent balance or an allowance the approval leg did not actually leave
  // behind on this node burns the launch's gas for a certain revert.
  const decimals = state.virtualDecimals;
  if (state.virtualBalanceRaw < plan.fee.launchAmountRaw) {
    refuse(
      "allowance_or_balance",
      "allowance_or_balance",
      `this wallet now holds ${formatUnits(state.virtualBalanceRaw, decimals)} VIRTUAL on ${deployment.name} and the `
      + `launch has to send ${formatUnits(plan.fee.launchAmountRaw, decimals)} to the venue.`,
    );
  }
  if (state.allowanceRaw < plan.fee.launchAmountRaw) {
    refuse(
      "allowance_or_balance",
      "allowance_or_balance",
      `the node that would broadcast this launch reports an allowance of `
      + `${formatUnits(state.allowanceRaw, decimals)} VIRTUAL to BondingV5, and the launch needs `
      + `${formatUnits(plan.fee.launchAmountRaw, decimals)}.`,
    );
  }

  // ── THE SEALED APPROVAL, held against the plan one more time ──
  //
  // Cheap, no I/O, and not a duplicate of the pre-claim comparison: that one ran
  // before the key existed and before the approval legs, and this is the last
  // moment at which "what the human approved" and "what is about to be signed"
  // can still be shown to be the same launch.
  assertSealedFieldsHold(sealed, plan);

  // ── THE BYTES THEMSELVES, RECOMPUTED FROM THE APPROVED FIELDS ──
  //
  // `startTime_` is the constant 0, so `preLaunch`'s calldata is a pure function
  // of the approved fields and can be rebuilt rather than trusted. Compared to
  // the plan AND to the REQUEST, because the request is what viem is about to
  // serialize: a target, a calldata blob or an attached value altered on the
  // preparation path would otherwise be signed under a verdict that never looked
  // at it.
  const rebuilt = buildPreLaunchTx({ deployment, args: plan.args });
  const rebuiltFingerprint = launchCalldataFingerprint({ chainId: deployment.chainId, tx: rebuilt });
  if (rebuiltFingerprint !== sealed.calldataFingerprint) {
    refuse(
      "calldata_changed",
      "simulation_reverted",
      `the pre-launch call this build produces from the approved fields fingerprints ${rebuiltFingerprint} and the `
      + `approval sealed ${sealed.calldataFingerprint}.`,
    );
  }

  const request = input.request;
  if (
    request.to === null
    || request.to === undefined
    || getAddress(request.to) !== getAddress(rebuilt.to)
    || request.data !== rebuilt.data
    || request.value !== rebuilt.value
  ) {
    refuse(
      "calldata_changed",
      "simulation_reverted",
      "the transaction about to be signed is not the pre-launch this execution planned and the approval sealed.",
    );
  }
}

/**
 * The pinned reader's answer against the plan's, row by row.
 *
 * The block number is deliberately absent: it MUST move between the plan and the
 * signature, and a launch that refused because a block was mined would refuse
 * every launch.
 */
function assertUnmoved(
  planned: LaunchState,
  current: LaunchState,
  deployment: VirtualsCurveDeployment,
): void {
  if (
    getAddress(current.implementations.bondingV5) !== getAddress(planned.implementations.bondingV5)
    || getAddress(current.implementations.frouterV3) !== getAddress(planned.implementations.frouterV3)
  ) {
    refuse(
      "implementation_moved",
      "simulation_reverted",
      `BondingV5 or FRouterV3 on ${deployment.name} is running a different implementation than the one this launch was `
      + `planned against - the signing node reports ${getAddress(current.implementations.bondingV5)} behind BondingV5 `
      + `and the plan was built against ${getAddress(planned.implementations.bondingV5)}. An upgrade changes what `
      + "preLaunch MEANS at an unchanged address.",
    );
  }
  if (getAddress(current.bondingConfig) !== getAddress(planned.bondingConfig)) {
    refuse(
      "drift",
      "simulation_reverted",
      `BondingV5 now names ${getAddress(current.bondingConfig)} as its BondingConfig and this launch was priced `
      + `against ${getAddress(planned.bondingConfig)}, so the fee table behind the signature is not the one that was `
      + "shown.",
    );
  }
  if (current.protocolLaunchFeeRaw !== planned.protocolLaunchFeeRaw) {
    refuse(
      "drift",
      "simulation_reverted",
      `the venue's own launch fee moved from ${planned.protocolLaunchFeeRaw.toString()} to `
      + `${current.protocolLaunchFeeRaw.toString()} raw VIRTUAL between the plan and the signature, so the initial `
      + "purchase left for the agent is not the one the approval showed.",
    );
  }
  if (current.virtualDecimals !== planned.virtualDecimals) {
    refuse(
      "drift",
      "simulation_reverted",
      `VIRTUAL on ${deployment.name} reports ${current.virtualDecimals} decimals on the signing node and the amount `
      + `was parsed with ${planned.virtualDecimals}, so the committed amount would not mean what it was shown as.`,
    );
  }
}

/** The approval's own figures, held against the plan that is about to be signed. */
function assertSealedFieldsHold(sealed: VirtualsLaunchIntentFields, plan: LaunchPlan): void {
  if (sealed.calldataFingerprint !== plan.fingerprint) {
    refuse(
      "drift",
      "simulation_reverted",
      `the approval sealed the pre-launch ${sealed.calldataFingerprint} and this execution is about to sign `
      + `${plan.fingerprint}.`,
    );
  }
  if (getAddress(sealed.bondingV5) !== getAddress(plan.deployment.bondingV5)) {
    refuse(
      "drift",
      "simulation_reverted",
      `the approval named BondingV5 ${getAddress(sealed.bondingV5)} and this launch targets `
      + `${getAddress(plan.deployment.bondingV5)}.`,
    );
  }
  if (sealed.launchAmountRaw !== plan.fee.launchAmountRaw.toString()) {
    refuse(
      "drift",
      "simulation_reverted",
      `the approval committed ${sealed.launchAmountRaw} raw VIRTUAL to the venue and this launch would send `
      + `${plan.fee.launchAmountRaw.toString()}.`,
    );
  }
  if (sealed.protocolFeeRaw !== plan.state.protocolLaunchFeeRaw.toString()) {
    refuse(
      "drift",
      "simulation_reverted",
      `the approval showed a venue launch fee of ${sealed.protocolFeeRaw} raw VIRTUAL and this plan carries `
      + `${plan.state.protocolLaunchFeeRaw.toString()}.`,
    );
  }
  if (sealed.onChainName !== plan.onChainName) {
    refuse(
      "drift",
      "simulation_reverted",
      `the approval showed the on-chain name "${sealed.onChainName}" and this launch would create `
      + `"${plan.onChainName}".`,
    );
  }
  if (sealed.imageUrl !== plan.image.url) {
    refuse(
      "drift",
      "simulation_reverted",
      "the picture this launch would write into the agent is not the picture the approval showed.",
    );
  }
}
