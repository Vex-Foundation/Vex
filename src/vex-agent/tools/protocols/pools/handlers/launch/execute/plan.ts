/**
 * The pools.fun launch MONEY-PATH assembly - one ordered pipeline that ends in a
 * VERIFIED plan or a named refusal. Nothing here signs, broadcasts or writes.
 *
 * ORDER IS THE CONTRACT, and every step exists because the next one must not
 * guess:
 *
 *   1. PREPARE through the provider (image uploaded once) - the only source of
 *      the calldata, the salt and the metadata URI.
 *   2. DECODE the calldata, so every later step reads the tuple rather than the
 *      response's claims about it.
 *   3. ANCHOR the chain at ONE block and read every fact the verifier judges
 *      against, including the gateway's own WETH.
 *   4. SIMULATE twice: once with the dev-buy floor removed, to learn the real
 *      fill, and once over the FINAL bytes exactly as they will be signed.
 *   5. FETCH the metadata document the launch pins, bounded.
 *   6. PRICE the network cost as a CEILING and plan the Vex fee leg - both are
 *      inputs to the verifier's balance point, so they come before it.
 *   7. ENFORCE the mission ceilings (autonomous path only).
 *   8. VERIFY all 15 points. This is the gate: only `ok: true` may go on to
 *      create an authorization.
 *   9. BIND the proved tuple to the exact bytes and their fingerprint.
 *
 * WHY THE VERIFIER RUNS BEFORE ANY AUTHORIZATION EXISTS: authorizing first and
 * checking afterwards would mean the user approved something nobody had checked.
 * See `../authorization.ts` for why a trench-style re-derive-and-compare is
 * unavailable here and what stands in its place.
 */

import { getAddress, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";

import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import { readPoolsChainAnchors } from "@tools/pools-fun/launch/anchors.js";
import { bindPoolsLaunchCall, type PoolsAuthorizedLaunchCall } from "@tools/pools-fun/launch/fingerprint.js";
import {
  encodeLaunchWithoutMinOut,
  simulatePoolsLaunch,
} from "@tools/pools-fun/launch/simulate.js";
import {
  decodeLaunchCalldata,
  verifyPoolsLaunchCalldata,
  type PoolsMetadataDocument,
} from "@tools/pools-fun/launch/verify-calldata.js";
import type {
  PoolsChainAnchors,
  PoolsFeeRecipientIntent,
  PoolsLaunchTuple,
  PoolsVerifierViolation,
} from "@tools/pools-fun/launch/verifier-types.js";
import {
  POOLS_CHAIN_ID,
  POOLS_LAUNCH_SUITE_VERSION,
  POOLS_USDG_ADDRESS,
  poolsLaunchSuite,
} from "@tools/pools-fun/constants.js";
import { POOLS_FEE_LEG_GAS_LIMIT, POOLS_FEE_VENUE } from "@tools/pools-fun/fee/venue.js";
import type {
  PoolsPrepareFeeRecipient,
  PoolsResolvedFeeRecipient,
} from "@tools/pools-fun/types.js";
import {
  enforceAutonomousLaunchCeilings,
  launchChargeableWei,
  type AutonomousLaunchCeilings,
} from "@vex-agent/engine/mission/launch-ceiling.js";
import type { Permission } from "@vex-agent/engine/types.js";
import { planNativeFeeLeg, type NativeFeeLegPlan } from "../../../../shared/native-fee-leg/plan.js";
import { composePoolsLaunchValue, type PoolsLaunchAuthorizationBinding } from "../authorization.js";
import type { PoolsFeeRecipientChoice } from "../../../launch/desktop-inputs.js";
import { fetchLaunchMetadata } from "./metadata.js";
import { preparePoolsLaunchCalldata, type PoolsLaunchImageSource } from "./prepare.js";

/** The native sentinel every fee row identifies ETH by. */
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/** Never a fee recipient: the gateway substitutes msg.sender for it, and we send explicitly. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface BuildPoolsLaunchPlanInput {
  readonly name: string;
  readonly symbol: string;
  readonly pairedAsset: "weth" | "usdg" | "stock";
  /**
   * WHICH tokenised stock, on a `stock` pair; `null` on every other pair.
   *
   * The pair the verifier holds the tuple to is THIS address (point 5), and the
   * factory's own `allowedPairedAsset` and `pricingModeFor` at the anchored
   * block decide whether it is launchable and how its opening price is derived.
   * Nothing in this build carries a list of stock addresses: such a list would
   * be a second source of truth that goes stale the day the launchpad lists
   * another one.
   */
  readonly pairedStockAddress: Address | null;
  readonly image: PoolsLaunchImageSource;
  /** The NATIVE prebuy, or `null`. Human ETH travels with it for the provider. */
  readonly prebuyWei: bigint | null;
  readonly prebuyHuman: string | null;
  readonly sessionId: string;
  readonly walletAddress: Address;
  /**
   * Where the creator fee stream goes.
   *
   * On the AGENT path this is either `{kind: "address"}` holding the session
   * wallet - the system pins it, the tools have no recipient parameter, and the
   * verifier holds the signed tuple to EXACT equality with it (zero rejected) -
   * or `{kind: "holders"}`, which names no address at all and is proven against
   * the gateway's own live sentinel by point 15. The manual form may also pass
   * an X handle, which only the launchpad can resolve - see
   * `resolveFeeRecipientExpectation`.
   */
  readonly feeRecipient: PoolsFeeRecipientChoice;
  /**
   * The optional socials the metadata carries. Present only on the desktop form
   * path, where a human typed them; the agent-facing tools have no such
   * parameter. Declared HERE rather than accepted loosely, because an input a
   * caller supplies and the builder drops is a silent lie about what was
   * launched.
   */
  readonly tweetUrl?: string | undefined;
  readonly websiteUrl?: string | undefined;
  readonly permission: Permission;
  readonly publicClient: PublicClient<Transport, Chain>;
  /** Present ONLY on the autonomous path, where both mission ceilings apply. */
  readonly ceilings?: { readonly contract: AutonomousLaunchCeilings; readonly launchesUsed: number } | undefined;
  readonly signal?: AbortSignal | undefined;
  /**
   * SIMULATION ONLY: build and verify the plan, then stop.
   *
   * This builder never signed anything, so `simulateOnly` changes nothing HERE -
   * it is carried on the plan so the caller cannot lose it between the gate and
   * the signer. The flag is set at the tool boundary and read again in
   * `execute.ts`, which is the leg that would otherwise open a wallet, create an
   * authorization and broadcast; carrying it on the verified plan is what makes
   * "this plan may not be signed" a property of the plan rather than a variable
   * the caller has to remember.
   *
   * A prepare STILL HAPPENS: it pins an IPFS object and mines a salt, so a
   * simulation is not free of provider side effects, and the caller is told so.
   * Nothing on-chain moves and no key is touched.
   */
  readonly simulateOnly?: boolean | undefined;
}

export type PoolsLaunchPlanRefusalCode =
  | "prepare_refused"
  | "calldata_undecodable"
  | "anchors_unreadable"
  | "simulation_failed"
  | "gas_unestimable"
  | "ceiling_refused"
  | "verifier_refused";

/** A launch that passed every check, with the exact call it authorizes. */
export interface PoolsLaunchPlan {
  readonly call: PoolsAuthorizedLaunchCall;
  readonly tuple: PoolsLaunchTuple;
  readonly binding: PoolsLaunchAuthorizationBinding;
  readonly feeLeg: NativeFeeLegPlan<"launch_msg_value"> | null;
  readonly anchors: PoolsChainAnchors;
  readonly predictedPoolAddress: Address;
  readonly metadataUri: string;
  /** Whether the image actually landed in the pinned metadata - a provider trap, surfaced. */
  readonly imageLanded: boolean;
  /**
   * The gas the launch would cost, as a CEILING, and the price it was bounded
   * at. Carried on the plan because a simulation's whole product is this number
   * plus the fingerprint - a caller that stops here must not have to re-estimate
   * (a second estimate at a later block would describe a different launch).
   */
  readonly gas: { readonly limit: bigint; readonly priceWei: bigint; readonly boundWei: bigint };
  /** True when this plan was built under `simulateOnly` and must never be signed. */
  readonly simulateOnly: boolean;
}

export type BuildPoolsLaunchPlanResult =
  | { readonly ok: true; readonly plan: PoolsLaunchPlan }
  | {
      readonly ok: false;
      readonly code: PoolsLaunchPlanRefusalCode;
      readonly reason: string;
      /**
       * The verifier's own violations, when it was the verifier that refused.
       *
       * Carried STRUCTURED rather than only inside the message so a caller can
       * classify without reading prose: the desktop lane maps "the wallet
       * cannot pay" and "this pair is not allowlisted" onto different refusal
       * kinds, and sniffing a sentence for those would be a parser nobody
       * declared.
       */
      readonly violations?: readonly PoolsVerifierViolation[] | undefined;
    };

function refuse(
  code: PoolsLaunchPlanRefusalCode,
  reason: string,
  violations?: readonly PoolsVerifierViolation[],
): BuildPoolsLaunchPlanResult {
  return violations === undefined ? { ok: false, code, reason } : { ok: false, code, reason, violations };
}

export async function buildPoolsLaunchPlan(
  input: BuildPoolsLaunchPlanInput,
): Promise<BuildPoolsLaunchPlanResult> {
  // THE SUITE COMES FROM VEX, NOT FROM THE RESPONSE. `launches/prepare` returns
  // a `to` that has already moved twice in three days; taking it as the target
  // would mean the provider chooses which contract Vex signs against. The suite
  // table names the gateway, and the verifier's point 1 requires the response to
  // agree with it - the comparison only means something because the two sides
  // have independent origins.
  const suite = poolsLaunchSuite();
  const gateway = suite.gateway as Address;

  // 1. The provider half.
  const prepared = await preparePoolsLaunchCalldata({
    name: input.name,
    symbol: input.symbol,
    pairedAsset: input.pairedAsset,
    ...(input.pairedStockAddress === null
      ? {}
      : { pairedStockAddress: input.pairedStockAddress }),
    // A holders launch sends `feesToHolders` and NO recipient; every other
    // launch sends the recipient explicitly. The two are mutually exclusive on
    // the wire because they are mutually exclusive in fact.
    ...(input.feeRecipient.kind === "holders"
      ? { holderRewards: { payout: input.feeRecipient.mode } }
      : { feeRecipient: toPrepareFeeRecipient(input.feeRecipient) }),
    launcher: input.walletAddress,
    image: input.image,
    devBuyEth: input.prebuyHuman,
    ...(input.tweetUrl === undefined ? {} : { tweetUrl: input.tweetUrl }),
    ...(input.websiteUrl === undefined ? {} : { websiteUrl: input.websiteUrl }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!prepared.ok) return refuse("prepare_refused", prepared.reason);
  const { response, config, imageUrl } = prepared.value;

  // 2. The tuple. Every later step reads THIS, never the response's claims.
  const tuple = decodeLaunchCalldata(response.data as Hex);
  if (tuple === null) {
    return refuse(
      "calldata_undecodable",
      "Refusing to launch: the launchpad returned calldata that does not decode as a gateway launch, so "
        + "there is no way to know what it would do. Nothing was signed.",
    );
  }

  // 2b. WHO THE FEE STREAM PAYS, settled before anything is verified against it.
  const recipient = resolveFeeRecipientExpectation(input.feeRecipient, response, suite);
  if (!recipient.ok) return refuse("verifier_refused", recipient.reason);
  const feeRecipient = recipient.intent;

  // 3. One block, every fact.
  const anchored = await readPoolsChainAnchors({
    publicClient: input.publicClient,
    // The allowlist and the start tick are read for the address the TUPLE names.
    // Proving that address is the pair the caller asked for is the verifier's
    // point 5, and reading the allowlist for some other address would answer a
    // question nobody asked.
    pairedAssetAddress: tuple.pairedAsset,
    launcher: input.walletAddress,
    userSalt: tuple.userSalt,
    name: tuple.name,
    symbol: tuple.symbol,
    metadataUri: tuple.metadataUri,
    // The attestation the TUPLE carries, so the tick the factory derives is
    // derived from the exact bytes that would be signed.
    priceAttestation: tuple.priceAttestation,
    priceSignature: tuple.priceSignature,
    gatewayAddress: gateway,
    factoryAddress: suite.factory as Address,
  });
  if (!anchored.ok) {
    return refuse("anchors_unreadable", `Refusing to launch: ${anchored.reason} Nothing was signed.`);
  }
  const anchors = anchored.anchors;

  // 4. Both simulations.
  const fillProbe = await simulatePoolsLaunch({
    publicClient: input.publicClient,
    account: input.walletAddress,
    gateway,
    data: encodeLaunchWithoutMinOut(tuple),
    valueWei: BigInt(response.value),
    blockNumber: anchors.blockNumber,
  });
  if (!fillProbe.ok) {
    return refuse(
      "simulation_failed",
      `Refusing to launch: this launch does not simulate on-chain (${fillProbe.reason}), so signing it would `
        + "spend gas to fail. Nothing was signed.",
    );
  }
  const finalSimulation = await simulatePoolsLaunch({
    publicClient: input.publicClient,
    account: input.walletAddress,
    gateway,
    data: response.data as Hex,
    valueWei: BigInt(response.value),
    blockNumber: anchors.blockNumber,
  });

  // 5. The metadata document, bounded.
  const metadata = await fetchLaunchMetadata(tuple.metadataUri, input.signal);

  // 6. The gas CEILING and the Vex fee, both inputs to the balance point.
  const gas = await priceLaunchGas(input.publicClient, {
    account: input.walletAddress,
    gateway,
    data: response.data as Hex,
    valueWei: BigInt(response.value),
  });
  if (!gas.ok) {
    return refuse(
      "gas_unestimable",
      `Refusing to launch: the launch could not be gas-priced (${gas.reason}), so the wallet's balance cannot `
        + "be checked against it. Nothing was signed.",
    );
  }

  const deploymentFeeWei = BigInt(config.deploymentFeeWei);
  const prebuyWei = input.prebuyWei ?? 0n;
  const msgValueWei = composePoolsLaunchValue(deploymentFeeWei, prebuyWei);

  const feeLeg = planNativeFeeLeg(POOLS_FEE_VENUE, {
    basis: "launch_msg_value",
    baseWei: msgValueWei,
    // The fee is a SEPARATE later transfer; it does not reduce the launch value,
    // so the net figure carries no meaning on this basis.
    netApplies: false,
    parentKind: "launch",
    chainId: POOLS_CHAIN_ID,
    nativeAddress: NATIVE_ADDRESS,
    walletAddress: input.walletAddress,
    sessionId: input.sessionId,
  });
  const vexFeeWei = feeLeg?.feeWei ?? 0n;
  // The fee leg is its own transaction, so its gas belongs in the ceiling the
  // balance is judged against. Zero when the fee floors to dust: there is then no
  // second transaction at all, and budgeting one would overstate the cost.
  const gasBoundWei = gas.launchGasWei + (vexFeeWei > 0n ? POOLS_FEE_LEG_GAS_LIMIT * gas.gasPriceWei : 0n);

  // 7. Mission ceilings - autonomous path only. A human-authorized launch is
  //    deliberately ungated here; the ceilings bound UNATTENDED spending.
  if (input.ceilings !== undefined) {
    const verdict = enforceAutonomousLaunchCeilings(
      input.ceilings.contract,
      launchChargeableWei(msgValueWei, vexFeeWei),
      input.ceilings.launchesUsed,
    );
    if (!verdict.ok) return refuse("ceiling_refused", verdict.reason);
  }

  // 8. THE GATE.
  const verdict = verifyPoolsLaunchCalldata({
    response,
    expectation: {
      name: input.name,
      symbol: input.symbol,
      pairedAsset: input.pairedAsset,
      // THREE PAIRS, THREE AUTHORITIES, and none of them the response.
      //
      // WETH has an on-chain definition and is held to it - the gateway's own
      // `weth()`, which is the address its native-prebuy guard compares
      // against. USDG has none, so it is held to the pinned address the chain
      // registry carries. A STOCK is held to the address the CALLER named, which
      // is the only thing that can distinguish one of 194 listed stocks from
      // another; whether the factory will accept it is `allowedPairedAsset` at
      // the anchored block (point 5), and how it is priced is `pricingModeFor`
      // (points 6 and 14). Neither is decided here.
      pairedAssetAddress: expectedPairedAssetAddress(input, anchors.gatewayWeth),
      feeRecipient,
      launcher: input.walletAddress,
      gatewayVersion: BigInt(config.gatewayVersion),
      ...(imageUrl === null ? {} : { imageUrl }),
      ...(input.prebuyWei === null
        ? {}
        : { devBuy: { mode: "native" as const, amountWei: input.prebuyWei } }),
    },
    anchors,
    metadata,
    simulation: {
      simulatedDevBuyOut: fillProbe.value.devBuyOut,
      simulatedTokenAddress: fillProbe.value.tokenAddress,
      finalSimulationSucceeded: finalSimulation.ok,
      ...(finalSimulation.ok ? {} : { finalSimulationError: finalSimulation.reason }),
    },
    gasBoundWei,
    vexFeeWei,
    gatewayAddress: gateway,
    factoryAddress: suite.factory as Address,
    lockerAddress: suite.locker as Address,
  });
  if (!verdict.ok) {
    return refuse("verifier_refused", describeVerifierRefusal(verdict.violations), verdict.violations);
  }

  // 9. Bind what was proved to what will be signed.
  const call = bindPoolsLaunchCall(verdict.tuple, response);

  return {
    ok: true,
    plan: {
      call,
      tuple: verdict.tuple,
      feeLeg,
      anchors,
      gas: { limit: gas.gasLimit, priceWei: gas.gasPriceWei, boundWei: gasBoundWei },
      simulateOnly: input.simulateOnly === true,
      predictedPoolAddress: response.predictedPoolAddress as Address,
      metadataUri: tuple.metadataUri,
      imageLanded: typeof metadata?.image === "string",
      binding: {
        name: tuple.name,
        symbol: tuple.symbol,
        metadataUri: tuple.metadataUri,
        imageUrl,
        imageId: input.image.kind === "locker" ? input.image.imageId : null,
        chainId: POOLS_CHAIN_ID,
        gateway,
        pairedAsset: input.pairedAsset,
        pairedAssetAddress: tuple.pairedAsset,
        predictedTokenAddress: response.predictedTokenAddress as Address,
        userSalt: tuple.userSalt,
        deploymentFeeWei: deploymentFeeWei.toString(),
        prebuyWei: prebuyWei.toString(),
        msgValueWei: msgValueWei.toString(),
        vexFeeWei: vexFeeWei.toString(),
        gasBoundWei: gasBoundWei.toString(),
        anchorBlockNumber: anchors.blockNumber.toString(),
        // THE ADDRESS THAT IS ACTUALLY IN THE SIGNED TUPLE - which under a
        // holders intent is the gateway's SENTINEL, and is NOT what the
        // settlement decoder will find in `GatewayLaunch`.
        //
        // This comment used to say the opposite, and it was wrong in exactly the
        // case this lane enables. The verified V3 gateway RESOLVES the sentinel
        // to the distributor it just deployed before emitting the event, so the
        // receipt names the distributor and the tuple names the sentinel. Both
        // facts are recorded, separately: this field is what was SIGNED, and
        // `holderRewards` below is the INTENT the sentinel expressed, which is
        // what lets the decoder prove the resolved distributor is the one this
        // launch's own `DistributorDeployed` event named.
        feeRecipient: tuple.feeRecipient,
        holderRewards:
          input.feeRecipient.kind === "holders"
            ? { mode: input.feeRecipient.mode, sentinel: tuple.feeRecipient }
            : null,
        walletAddress: input.walletAddress,
        calldata: call.data,
        callFingerprint: call.fingerprint,
        sessionId: input.sessionId,
        permission: input.permission,
      },
    },
  };
}

/**
 * Vex's recipient choice, expressed in the launchpad's `{type, value}` contract.
 *
 * The two vocabularies are deliberately kept apart: ours names the DECISION a
 * caller made (`session_wallet` is already collapsed into `address` before a
 * plan is built), the provider's names the IDENTITY KIND it will resolve. This
 * function is the whole translation and the only place that knows the provider's
 * `type` strings.
 *
 * A handle is NEVER mapped to `wallet`. The two resolve to different addresses,
 * and quietly re-labelling one as the other would point the fee stream somewhere
 * the user did not name - the exact defect the manual path exists to avoid.
 *
 * A HOLDERS CHOICE HAS NO TRANSLATION HERE, and that is structural rather than
 * an omission: it is not an identity the launchpad resolves, it is the absence
 * of one. The prepare sends `feesToHolders` INSTEAD of a recipient (see the
 * caller), so asking this function for a `{type, value}` would mean a holders
 * launch had reached the one code path that names somebody to pay.
 */
export function toPrepareFeeRecipient(
  choice: Exclude<PoolsFeeRecipientChoice, { kind: "holders" }>,
): PoolsPrepareFeeRecipient {
  return choice.kind === "address"
    ? { type: "wallet", value: choice.address }
    : { type: "x", value: choice.username };
}

/**
 * The address the verifier will hold this launch's fee recipient to.
 *
 * TWO MODES, AND THE ASYMMETRY IS THE PRODUCT DECISION (owner decision 3).
 *
 * `address` - the AGENT path always, and the manual path when the user typed an
 * address. The address is known BEFORE the launchpad is asked, so the verifier's
 * point 4 holds the signed tuple to EXACT equality with it and rejects the zero
 * address outright. The agent has no recipient parameter at all, so on that path
 * this is always the session wallet.
 *
 * `x_username` - MANUAL PATH ONLY. Vex cannot independently verify a
 * handle-to-address mapping: only the launchpad knows it, so a verifier check
 * against it would be the provider grading its own answer. On this one field, on
 * this one path, THE VERIFIER IS THE USER - and that control is sound rather
 * than a concession:
 *
 *   - the fingerprint covers `(chainId, to, data, value)`;
 *   - the tuple inside `data` names the resolved recipient;
 *   - stage 1 shows `resolvedFeeRecipient` decoded from those same bytes;
 *   - Deploy consumes that exact fingerprint.
 *
 * So what the user confirms IS what gets deployed, and point 4
 * (`response_mirrors_calldata`) is what makes that binding trustworthy - a
 * resolution the response fails to mirror into the tuple is still refused.
 *
 * The checks below are the cheap ones that cost nothing and catch a broken or
 * hostile resolution: it must parse as an address, it must not be the zero
 * address, and it must not be one of the protocol's own contracts. Anything past
 * that is the user's call, not ours. A handle is NEVER silently coerced into the
 * session wallet - a fee stream that quietly goes somewhere other than where the
 * user aimed it is the defect this whole path exists to avoid.
 */
function resolveFeeRecipientExpectation(
  choice: PoolsFeeRecipientChoice,
  response: { readonly feeRecipient: PoolsResolvedFeeRecipient },
  suite: { readonly gateway: string; readonly factory: string; readonly locker: string },
):
  | { readonly ok: true; readonly intent: PoolsFeeRecipientIntent }
  | { readonly ok: false; readonly reason: string } {
  if (choice.kind === "address") return { ok: true, intent: { kind: "address", address: choice.address } };
  // A HOLDERS INTENT NAMES NO ADDRESS AND RESOLVES TO NONE HERE. It travels as
  // the mode the caller chose, and point 15 is what binds it to the gateway's
  // own live sentinel for exactly that mode. Resolving it to an address in this
  // function would put a fee destination in a module the provider's response can
  // reach, which is the property this whole path exists to deny.
  if (choice.kind === "holders") return { ok: true, intent: { kind: "holders", mode: choice.mode } };

  let resolved: Address;
  try {
    resolved = getAddress(response.feeRecipient.address);
  } catch {
    return {
      ok: false,
      reason:
        `Refusing to launch: the launchpad resolved "@${choice.username}" to `
        + `"${response.feeRecipient.address}", which is not a readable address, so there is no way to show you `
        + "where the creator fees would go. Nothing was signed.",
    };
  }

  const forbidden: readonly { readonly address: string; readonly label: string }[] = [
    { address: ZERO_ADDRESS, label: "the zero address" },
    { address: suite.gateway, label: "the launch gateway itself" },
    { address: suite.factory, label: "the launchpad factory" },
    { address: suite.locker, label: "the fee locker" },
  ];
  const hit = forbidden.find((entry) => sameAddressLoose(entry.address, resolved));
  if (hit !== undefined) {
    return {
      ok: false,
      reason:
        `Refusing to launch: the launchpad resolved "@${choice.username}" to ${hit.label} (${resolved}), `
        + "which would send the creator fee stream somewhere it can never be claimed from. Nothing was signed.",
    };
  }
  return { ok: true, intent: { kind: "address", address: resolved } };
}

/**
 * The address the tuple's pair must equal, per pair kind.
 *
 * A `stock` pair with no address is a defect in the caller, not a provider
 * outcome: the input reader refuses that combination by name before a plan is
 * ever built, so reaching here without one would mean the boundary was bypassed.
 * It throws rather than falling back to WETH, because a fallback would launch
 * against a different asset than the one that was asked for.
 */
function expectedPairedAssetAddress(
  input: Pick<BuildPoolsLaunchPlanInput, "pairedAsset" | "pairedStockAddress">,
  gatewayWeth: Address,
): Address {
  if (input.pairedAsset === "weth") return gatewayWeth;
  if (input.pairedAsset === "usdg") return POOLS_USDG_ADDRESS as Address;
  if (input.pairedStockAddress === null) {
    throw new Error(
      "pools launch plan: a stock-paired launch reached the verifier with no stock address; the input "
        + "boundary must refuse that combination before a plan exists",
    );
  }
  return input.pairedStockAddress;
}

/** Case-insensitive address equality that refuses a malformed input. */
function sameAddressLoose(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/**
 * Every failed point, named.
 *
 * A refusal that names one problem invites a retry that hits the next; naming
 * all of them is what lets the agent, and the human reading it, understand the
 * actual state (owner decree: the real cause, in agent-friendly words).
 */
function describeVerifierRefusal(
  violations: readonly { readonly point: string; readonly detail: string }[],
): string {
  const detail = violations.map((v) => `${v.point}: ${v.detail}`).join("; ");
  return (
    "Refusing to launch: the launchpad's transaction failed Vex's pre-signing checks - "
    + `${detail}. Nothing was signed.`
  );
}

/**
 * The network cost CEILING, never a number to spend.
 *
 * The estimate is headroomed exactly the way the staged broadcaster will sign it,
 * so the bound the balance is judged against is the bound that can actually be
 * charged.
 */
async function priceLaunchGas(
  publicClient: PublicClient<Transport, Chain>,
  call: { readonly account: Address; readonly gateway: Address; readonly data: Hex; readonly valueWei: bigint },
): Promise<
  | { readonly ok: true; readonly launchGasWei: bigint; readonly gasPriceWei: bigint; readonly gasLimit: bigint }
  | { readonly ok: false; readonly reason: string }
> {
  try {
    const estimate = await publicClient.estimateGas({
      account: call.account,
      to: call.gateway,
      data: call.data,
      value: call.valueWei,
    });
    const gasLimit = gasLimitWithHeadroom(estimate);
    const gasPriceWei = await publicClient.getGasPrice();
    return { ok: true, gasLimit, gasPriceWei, launchGasWei: gasLimit * gasPriceWei };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.name : "the node did not say why" };
  }
}
