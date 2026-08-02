/**
 * Main-side TOKEN LAUNCH owner — the module the IPC handlers call.
 *
 * WHY THIS LAYER EXISTS. Repo law: IPC handlers do not import `@vex-agent`
 * directly. `main/ipc/images.ts` → `main/images/index.ts` → the repo is the
 * established shape, and it earns its keep here: this file owns the DTO mapping
 * and the agent-runtime calls, so the handler file stays a thin, auditable
 * boundary that validates, authorizes, logs and returns `Result`.
 *
 * WHAT THIS MODULE IS RESPONSIBLE FOR, in C0 terms: MAIN — never the renderer —
 * reconstructs the money. The renderer sends the form the user filled and the
 * `previewId` it was shown; everything that becomes a spend (the creation fee,
 * `msg.value`, the calldata) is derived HERE, on this side of the boundary.
 *
 * This file is the public entry point and stays one: the shared plan assembly
 * lives in `./plan-context.ts`, the Deploy click in `./submit.ts`. No caller's
 * import changes.
 */

import * as launchedTokens from "@vex-agent/db/repos/launched-tokens.js";
import type { LaunchedTokenDto, TokenLaunchPreviewResult } from "@shared/schemas/token-launch.js";
import type { TokenLaunchForm } from "@shared/schemas/token-launch.js";
import {
  buildLaunchPlan,
  planLaunchContext,
  refusalFromPlanCode,
  TRENCH_LAUNCH_CHAIN_ID,
  type TokenLaunchRefusal,
} from "./plan-context.js";

export {
  buildLaunchPlan,
  checkPreviewStillValid,
  NO_FEE_LEG,
  planLaunchContext,
  refusalFromPlanCode,
  TRENCH_LAUNCH_CHAIN_ID,
  validateLaunchRequest,
} from "./plan-context.js";
export type { LaunchPlan, TokenLaunchRefusal } from "./plan-context.js";

export { cancelLaunch } from "./cancel.js";
export type { TokenLaunchCancelOutcome } from "./cancel.js";

export { submitLaunch } from "./submit.js";
export type {
  SubmittedLaunchExecutor,
  SubmittedLaunchOutcome,
  TokenLaunchSubmitOutcome,
} from "./submit.js";

/**
 * How long the dialog TELLS the user a preview is good for.
 *
 * Advisory only, and deliberately so: the binding check is `previewId`
 * re-derivation on submit, which catches a moved fee or a moved anchor whatever
 * the clock says. A countdown that could ARM a submit would be a second, weaker
 * staleness mechanism — this one only prompts a re-preview.
 */
const PREVIEW_ADVISORY_TTL_MS = 60_000;

export type TokenLaunchPreviewOutcome =
  | { readonly ok: true; readonly preview: TokenLaunchPreviewResult }
  | { readonly ok: false; readonly refusal: TokenLaunchRefusal };

/**
 * Price a launch for the desktop dialog — READ-ONLY. Nothing here signs,
 * broadcasts, or writes a row.
 *
 * IT IS THE SAME PIPELINE THE EXECUTE LEG USES (`buildLaunchPlan`) over the same
 * resolved context, not a second one. That is the whole point: the figure the
 * user consents to must be derived by the code that will later spend it.
 *
 * NO CEILINGS are passed. §C6 gates the AUTONOMOUS path; a human looking at the
 * dialog is the authority for their own launch, and enforcing a mission ceiling
 * against them would refuse a launch the mission never asked for.
 */
export async function previewLaunch(input: {
  readonly sessionId: string;
  readonly form: TokenLaunchForm;
}): Promise<TokenLaunchPreviewOutcome> {
  const context = await planLaunchContext(input.sessionId, input.form);
  if (!context.ok) return { ok: false, refusal: context.refusal };

  const planned = await buildLaunchPlan({
    request: context.request,
    sessionId: input.sessionId,
    walletAddress: context.walletAddress as `0x${string}`,
    permission: context.permission,
    publicClient: context.publicClient,
    planFeeLeg: context.planFeeLeg,
    nativeAddress: context.nativeAddress,
  });
  if (!planned.ok) {
    return { ok: false, refusal: refusalFromPlanCode(planned.code, planned.reason) };
  }

  const { preview } = planned.plan;
  return {
    ok: true,
    preview: {
      previewId: preview.previewId,
      creationFeeWei: preview.creationFeeWei,
      prebuyWei: preview.prebuyWei,
      msgValueWei: preview.msgValueWei,
      vexFeeWei: preview.vexFeeWei,
      vexFeeCharged: preview.vexFeeCharged,
      estimatedGasLimit: preview.estimatedGasLimit,
      estimatedGasPriceWei: preview.estimatedGasPriceWei,
      estimatedNetworkFeeWei: preview.estimatedNetworkFeeWei,
      anchorBlockNumber: preview.anchorBlockNumber,
      predictedTokenAddress: preview.predictedTokenAddress,
      chainId: preview.chainId,
      imageId: preview.imageId,
      expiresAt: new Date(Date.now() + PREVIEW_ADVISORY_TTL_MS).toISOString(),
      note: preview.note,
    },
  };
}

/**
 * The user's own launches, mapped to the renderer DTO.
 *
 * `initialBuyRaw` and `initialBuyDecimals` travel TOGETHER and are null together
 * — a raw amount without its decimals is unreadable, and pairing a null amount
 * with a decimals value would imply an amount exists.
 */
export async function listMyLaunches(
  walletAddresses: readonly string[],
  chainId: number,
  limit: number,
): Promise<LaunchedTokenDto[]> {
  const rows = await launchedTokens.listForWallets({ walletAddresses, chainId, limit });
  return rows.map((row) => ({
    tokenAddress: row.tokenAddress,
    name: row.name,
    symbol: row.symbol,
    createTxHash: row.createTxHash,
    chainId: row.chainId,
    createdAt: row.createdAt,
    initialBuyRaw: row.initialBuyRaw,
    initialBuyDecimals: row.initialBuyRaw === null ? null : row.initialBuyDecimals,
  }));
}
