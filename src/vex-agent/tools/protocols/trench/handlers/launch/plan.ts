/**
 * The launch MONEY-PATH assembly — one ordered pipeline, used by both the
 * preview and the execute leg so the two can never disagree.
 *
 * ORDER IS THE CONTRACT. Each step exists because the one before it produced
 * something the next must not guess:
 *
 *   1. ANCHOR the block. Everything else is read `at` it, so the fee proven into
 *      the authorization and the fee sent with the signature are the same word.
 *   2. READ the creation fee from Diamond storage at that block (§C4b). Never
 *      the preview's 0.001 constant — that constant is a disclosure, not a floor.
 *   3. RESOLVE the image bytes through the C2b seam and hash them. Unregistered
 *      resolver and unknown image are DIFFERENT failures and are reported
 *      differently.
 *   4. COMPOSE `msg.value` = fee + prebuy, exactly.
 *   5. PLAN the Vex fee leg (§C7) — BEFORE the ceiling, because the ceiling
 *      compares `msg.value + vexFee`. The leg is BROADCAST last; planning it
 *      early is what makes the gate check the number actually spent.
 *   6. ENFORCE both mission ceilings (§C6/§C6b) — autonomous path only.
 *   7. BUILD the calldata and run the NATIVE-VALUE GATE: every wei of
 *      `msg.value` attributed to a proven component, exact bigint sum, no
 *      tolerance.
 *
 * Nothing here signs, broadcasts or writes. It produces a plan and a preview
 * DTO; the execute leg decides whether to act on them.
 */

import { formatEther, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";

import { TRENCH_CHAIN_ID, TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";
import { readTrenchCreationFeeWei } from "@tools/trench-express/evm/creation-fee.js";
import {
  buildCreateCalldata,
  buildLaunchNativeValueAuthorization,
} from "@tools/trench-express/evm/create-launch.js";
import { checkNativeValueAuthorizedForCall } from "@tools/evm-chains/native-value-authorization/index.js";
import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import {
  LaunchImageResolverUnavailableError,
  resolveLaunchImageBytes,
} from "../../launch-image-byte-resolver.js";
import type { Permission } from "@vex-agent/engine/types.js";
import {
  enforceAutonomousLaunchCeilings,
  launchChargeableWei,
  type AutonomousLaunchCeilings,
} from "@vex-agent/engine/mission/launch-ceiling.js";
import { composeLaunchMsgValue, type LaunchAuthorizationBinding } from "./authorization.js";
import type { PlanTrenchFeeLeg, TrenchFeeLegPlan } from "./fee-seam.js";
import type { ValidatedLaunchRequest } from "./validate.js";

const DIAMOND = TRENCH_DIAMOND_ADDRESS as Address;

export interface BuildLaunchPlanInput {
  readonly request: ValidatedLaunchRequest;
  readonly sessionId: string;
  readonly walletAddress: Address;
  readonly permission: Permission;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly planFeeLeg: PlanTrenchFeeLeg;
  readonly nativeAddress: Address;
  /**
   * Present ONLY for an autonomous (`full_autonomy`) launch. When set, BOTH
   * mission ceilings are enforced and an absent ceiling refuses. Absent means a
   * human authorized this launch, and §C6 explicitly does not gate that path.
   */
  readonly ceilings?: { readonly contract: AutonomousLaunchCeilings; readonly launchesUsed: number };
}

/** Why a launch could not be planned. Each maps to a distinct user-facing refusal. */
export type LaunchPlanRefusalCode =
  | "image_store_unavailable"
  | "image_not_found"
  | "fee_unreadable"
  | "ceiling_not_set"
  | "value_ceiling_exceeded"
  | "launch_count_exceeded"
  | "native_value_unauthorized"
  | "gas_unestimable"
  | "balance_unreadable"
  | "insufficient_native_balance";

/**
 * A plain native transfer with EMPTY calldata (`fee/plan.ts`).
 *
 * NOT an assumed intrinsic floor: this exact call was estimated live on
 * Robinhood Chain (4663) at block 26020712 and returned 21000, captured in
 * `src/__tests__/trench-express/fixtures/live-captures/fee-leg-gas-estimate.json`
 * and pinned against this constant.
 */
const FEE_LEG_ESTIMATED_GAS = 21_000n;

/**
 * Gas budgeted for the Vex fee leg — WHAT THE BROADCASTER WILL SIGN, not the
 * intrinsic floor.
 *
 * `signStageBroadcast` always signs `gasLimitWithHeadroom(estimate)`, and the
 * live capture cited above proves that estimate is 21000, so the fee leg's
 * signed limit is the headroomed figure and a 21000 budget underbudgets the
 * balance the wallet must actually hold to broadcast it. Derived through the
 * same helper rather than hand-typed, so a retune of the headroom factor moves
 * this with it instead of silently desynchronising.
 *
 * It is budgeted rather than estimated because the leg is not built yet at plan
 * time, and an estimate for a transaction that will be sent AFTER another one
 * has confirmed would be a guess dressed as a measurement.
 */
export const LAUNCH_FEE_LEG_GAS_LIMIT = gasLimitWithHeadroom(FEE_LEG_ESTIMATED_GAS);

export interface LaunchPlan {
  readonly calldata: Hex;
  readonly txParams: { readonly to: Address; readonly data: Hex; readonly value: bigint };
  readonly binding: LaunchAuthorizationBinding;
  readonly feeLeg: TrenchFeeLegPlan | null;
  readonly preview: LaunchPreviewDto;
}

/**
 * The preview DTO the renderer renders off.
 *
 * SEPARATE RAW WEI STRINGS, and deliberately NO pre-formatted total. The
 * consented amount is exactly `msgValueWei`; gas is an ESTIMATE, and summing an
 * estimate into a commitment would present a guess as a promise. The renderer
 * shows "You authorize X" and "Network fee ~Y (estimated)" as two separate
 * facts, which is the only honest way to say it.
 */
export interface LaunchPreviewDto {
  readonly previewId: string;
  readonly creationFeeWei: string;
  readonly prebuyWei: string;
  readonly msgValueWei: string;
  readonly vexFeeWei: string;
  readonly vexFeeCharged: boolean;
  readonly estimatedGasLimit: string;
  readonly estimatedGasPriceWei: string;
  readonly estimatedNetworkFeeWei: string;
  readonly anchorBlockNumber: string;
  readonly predictedTokenAddress: string | null;
  readonly chainId: number;
  readonly imageId: string;
  readonly note: string;
}

export type BuildLaunchPlanResult =
  | { readonly ok: true; readonly plan: LaunchPlan }
  | { readonly ok: false; readonly code: LaunchPlanRefusalCode; readonly reason: string };

function refuse(code: LaunchPlanRefusalCode, reason: string): BuildLaunchPlanResult {
  return { ok: false, code, reason };
}

/**
 * The `previewId` binds the anchored block AND the fee read there.
 *
 * That is what makes staleness detectable WITHOUT a second mechanism: submitting
 * against a preview whose fee no longer re-derives is the same failure as any
 * other authorization drift, and produces the same `tokenLaunch.preview_stale`
 * refusal with both numbers.
 */
export function launchPreviewId(anchorBlockNumber: bigint, creationFeeWei: bigint): string {
  return `lp_${anchorBlockNumber.toString()}_${creationFeeWei.toString()}`;
}

export async function buildLaunchPlan(
  input: BuildLaunchPlanInput,
): Promise<BuildLaunchPlanResult> {
  const { request, publicClient } = input;

  // 1 + 2. Anchor, then read the fee AT that block.
  let anchorBlockNumber: bigint;
  let creationFeeWei: bigint;
  try {
    anchorBlockNumber = await publicClient.getBlockNumber();
    creationFeeWei = await readTrenchCreationFeeWei(publicClient, anchorBlockNumber);
  } catch (err) {
    return refuse(
      "fee_unreadable",
      "Refusing to launch: the launchpad's creation fee could not be proven on-chain right now, "
        + `so the amount to send is unknown (${err instanceof Error ? err.name : "read failed"}). Nothing was signed.`,
    );
  }

  // 3. Image bytes — the two failures are genuinely different.
  let imageBytes: Uint8Array;
  let imageDigest: string;
  try {
    const resolved = await resolveLaunchImageBytes(request.imageId);
    if (resolved === null) {
      return refuse(
        "image_not_found",
        `Refusing to launch: no image with id "${request.imageId}" is in the Trench Photos locker. `
          + "Upload one on the right, or name an image that is already there.",
      );
    }
    imageBytes = resolved.bytes;
    imageDigest = resolved.digest;
  } catch (err) {
    if (err instanceof LaunchImageResolverUnavailableError) {
      return refuse("image_store_unavailable", err.message);
    }
    throw err;
  }

  // 4. Compose the value. Throws rather than returns on a nonsensical fee or
  //    prebuy — both are already validated, so reaching it is a bug, not input.
  const msgValueWei = composeLaunchMsgValue(creationFeeWei, request.prebuyWei);

  // 5. Plan the Vex fee BEFORE the ceiling. It is broadcast LAST, but the
  //    ceiling must compare the number actually spent.
  const feeLeg = input.planFeeLeg({
    basis: "launch_msg_value",
    baseWei: msgValueWei,
    chainId: TRENCH_CHAIN_ID,
    walletAddress: input.walletAddress,
    sessionId: input.sessionId,
    kind: "launch",
    nativeAddress: input.nativeAddress,
  });
  const vexFeeWei = feeLeg?.feeWei ?? 0n;

  // 6. Both mission ceilings — autonomous path only.
  if (input.ceilings) {
    const verdict = enforceAutonomousLaunchCeilings(
      input.ceilings.contract,
      launchChargeableWei(msgValueWei, vexFeeWei),
      input.ceilings.launchesUsed,
    );
    if (!verdict.ok) {
      return refuse(ceilingRefusalCode(input.ceilings.contract), verdict.reason);
    }
  }

  // 7. Calldata + the native-value gate, the LAST thing before a caller may sign.
  const calldata = buildCreateCalldata({
    name: request.name,
    symbol: request.symbol,
    description: request.description,
    links: request.links,
    imageBytes,
    prebuyWei: request.prebuyWei,
  });

  const call = { chainId: TRENCH_CHAIN_ID, to: DIAMOND, data: calldata, valueWei: msgValueWei };
  const authorization = buildLaunchNativeValueAuthorization({
    chainId: TRENCH_CHAIN_ID,
    data: calldata,
    valueWei: msgValueWei,
    creationFeeWei,
    prebuyWei: request.prebuyWei,
    anchorBlockNumber,
  });
  const verdict = checkNativeValueAuthorizedForCall(authorization, call);
  if (!verdict.ok) {
    return refuse(
      "native_value_unauthorized",
      `Refusing to launch: the ETH this launch would send could not be fully attributed to the creation fee `
        + `and your prebuy (${verdict.reason}). Nothing was signed.`,
    );
  }

  // 8. GAS, then the PRE-SIGN BALANCE GATE. Gas never enters the authorized
  //    figure, but a node that will not estimate cannot price this call, and
  //    continuing with a zero would let the balance gate below compare against
  //    a number nobody proved.
  const gas = await estimateLaunchGas(publicClient, input.walletAddress, calldata, msgValueWei);
  if (gas === null) {
    return refuse(
      "gas_unestimable",
      "Refusing to launch: this chain would not estimate gas for the create call, so the transaction "
        + "cannot be priced and the wallet's balance cannot be checked against it. Nothing was signed.",
    );
  }

  // Zero when the fee floors to dust — there is no second transaction to pay
  // gas for, and budgeting one would overstate the cost.
  const feeLegGasWei = vexFeeWei > 0n ? LAUNCH_FEE_LEG_GAS_LIMIT * gas.gasPriceWei : 0n;

  const balanceVerdict = await checkNativeBalanceCovers({
    publicClient,
    walletAddress: input.walletAddress,
    msgValueWei,
    launchGasWei: gas.gasLimit * gas.gasPriceWei,
    vexFeeWei,
    feeLegGasWei,
  });
  if (!balanceVerdict.ok) return balanceVerdict.refusal;

  const binding: LaunchAuthorizationBinding = {
    name: request.name,
    symbol: request.symbol,
    description: request.description,
    links: request.links,
    imageId: request.imageId,
    imageDigest,
    chainId: TRENCH_CHAIN_ID,
    contract: DIAMOND,
    creationFeeWei: creationFeeWei.toString(),
    prebuyWei: request.prebuyWei.toString(),
    msgValueWei: msgValueWei.toString(),
    vexFeeWei: vexFeeWei.toString(),
    anchorBlockNumber: anchorBlockNumber.toString(),
    calldata,
    callFingerprint: authorization.fingerprint,
    sessionId: input.sessionId,
    walletAddress: input.walletAddress,
    permission: input.permission,
  };

  return {
    ok: true,
    plan: {
      calldata,
      txParams: { to: DIAMOND, data: calldata, value: msgValueWei },
      binding,
      feeLeg,
      preview: {
        previewId: launchPreviewId(anchorBlockNumber, creationFeeWei),
        creationFeeWei: creationFeeWei.toString(),
        prebuyWei: request.prebuyWei.toString(),
        msgValueWei: msgValueWei.toString(),
        vexFeeWei: vexFeeWei.toString(),
        vexFeeCharged: vexFeeWei > 0n,
        estimatedGasLimit: gas.gasLimit.toString(),
        estimatedGasPriceWei: gas.gasPriceWei.toString(),
        // EVERY transaction this launch causes, as the shared schema promises:
        // the create's gas AND the fee leg's. Quoting only the create's understated
        // the network cost of a two-transaction action in the consent modal.
        estimatedNetworkFeeWei: (gas.networkFeeWei + feeLegGasWei).toString(),
        anchorBlockNumber: anchorBlockNumber.toString(),
        predictedTokenAddress: null,
        chainId: TRENCH_CHAIN_ID,
        imageId: request.imageId,
        note:
          `You authorize ${formatEther(msgValueWei)} ETH (creation fee + prebuy)`
          + (vexFeeWei > 0n ? `, plus a Vex fee of ${formatEther(vexFeeWei)} ETH charged after the launch confirms` : "")
          + ". Network gas is an ESTIMATE and is charged separately by the network — it is not part of what you authorize.",
      },
    },
  };
}

/** Which named refusal a ceiling verdict maps to, so the app can render the right state. */
function ceilingRefusalCode(contract: AutonomousLaunchCeilings): LaunchPlanRefusalCode {
  if (contract.maxLaunchValueRaw === null || contract.maxLaunchCount === null) {
    return "ceiling_not_set";
  }
  return "value_ceiling_exceeded";
}

/**
 * Gas, as an ESTIMATE and only ever that — `null` when it cannot be produced.
 *
 * It is never part of the AUTHORIZED figure, and the preview still says so. But
 * it IS consumed by the balance gate below, and it used to be reported as `0n`
 * on failure: a provider's silence rendered as a number, which is exactly the
 * shape of error rule 90 forbids. A launch that cannot be priced is refused
 * before anything is signed instead.
 */
async function estimateLaunchGas(
  publicClient: PublicClient<Transport, Chain>,
  account: Address,
  data: Hex,
  value: bigint,
): Promise<{ gasLimit: bigint; gasPriceWei: bigint; networkFeeWei: bigint } | null> {
  try {
    const estimate = await publicClient.estimateGas({ account, to: DIAMOND, data, value });
    const gasLimit = gasLimitWithHeadroom(estimate);
    const gasPriceWei = await publicClient.getGasPrice();
    return { gasLimit, gasPriceWei, networkFeeWei: gasLimit * gasPriceWei };
  } catch {
    return null;
  }
}

/**
 * The PRE-SIGN GATE: can this wallet actually pay for everything this launch
 * sets in motion?
 *
 * The requirement is the WHOLE sequence, not just the call being signed —
 * `msg.value`, the create's own gas, the Vex fee leg that follows it, and that
 * leg's gas. A wallet that covers only the create would still confirm the
 * launch and then fail the fee transfer, which is the one ordering §C7 accepts;
 * refusing here instead means the user is told BY NAME, before a signature,
 * rather than discovering it from a bare node rejection afterwards.
 *
 * There is no tolerance and no percentage: the comparison is exact wei.
 */
async function checkNativeBalanceCovers(input: {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletAddress: Address;
  readonly msgValueWei: bigint;
  readonly launchGasWei: bigint;
  readonly vexFeeWei: bigint;
  readonly feeLegGasWei: bigint;
}): Promise<{ ok: true } | { ok: false; refusal: BuildLaunchPlanResult }> {
  let balanceWei: bigint;
  try {
    balanceWei = await input.publicClient.getBalance({ address: input.walletAddress });
  } catch (err) {
    return {
      ok: false,
      refusal: refuse(
        "balance_unreadable",
        "Refusing to launch: your wallet's ETH balance on Robinhood Chain could not be read right now "
          + `(${err instanceof Error ? err.name : "read failed"}), so there is no proof the launch can be `
          + "paid for. Nothing was signed.",
      ),
    };
  }

  const requiredWei = input.msgValueWei + input.launchGasWei + input.vexFeeWei + input.feeLegGasWei;
  if (balanceWei >= requiredWei) return { ok: true };

  return {
    ok: false,
    refusal: refuse(
      "insufficient_native_balance",
      `Refusing to launch: this launch needs about ${formatEther(requiredWei)} ETH in total `
        + `(${formatEther(input.msgValueWei)} creation fee + prebuy, ~${formatEther(input.launchGasWei)} network gas`
        + (input.vexFeeWei > 0n ? `, ${formatEther(input.vexFeeWei)} Vex fee and its gas` : "")
        + `), and the wallet holds ${formatEther(balanceWei)} ETH. Nothing was signed.`,
    ),
  };
}
