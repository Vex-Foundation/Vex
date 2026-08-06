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

import { formatEther } from "viem";
import * as launchedTokens from "@vex-agent/db/repos/launched-tokens.js";
import {
  getAwaitingForSession,
  listUnsettledForWallets,
} from "@vex-agent/db/repos/token-launch-intents.js";
import type {
  AwaitingLaunchFormDto,
  LaunchedTokenDto,
  TokenLaunchPreviewResult,
} from "@shared/schemas/token-launch.js";
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
 * The user's own launches — PROVEN and UNSETTLED, merged (OD-3).
 *
 * WHY THE MERGE EXISTS. `launched_tokens` is written only once a token identity
 * is proven, so a launch that was broadcast and then stalled appeared NOWHERE:
 * the owner watched a launch he had paid for vanish from his own list, with
 * nothing to tell him why. The unsettled half comes from the intent table, which
 * has the name and symbol he typed and the hash he can look up.
 *
 * UNSETTLED IS TWO THINGS, and the merge keeps them apart. `broadcast_pending`
 * is still being checked; `superseded_unproven` is terminal but proves nothing
 * (migration 072). Both spent real gas with no token to show, so both stay
 * listed — terminalizing the second one without listing it would have made a
 * paid-for launch disappear all over again, which is the whole defect above.
 *
 * IT IS A READ-SIDE MERGE, AND ONLY THAT. No `launched_tokens` row is ever
 * written for an unproven launch — that table is the durable identity index, and
 * a token that may not exist must never enter it.
 *
 * UNSETTLED ROWS COME FIRST: they are the ones the user is waiting on, and the
 * proven ones are already history.
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
  const [proven, unsettled] = await Promise.all([
    launchedTokens.listForWallets({ walletAddresses, chainId, limit }),
    listUnsettledForWallets({ walletAddresses, chainId, limit }),
  ]);

  const unsettledRows: LaunchedTokenDto[] = unsettled
    // A launch with no hash was never broadcast: there is nothing to show and
    // nothing to look up, and listing it would invent a launch that never left.
    .filter((intent) => intent.txHash !== null)
    .map((intent) => ({
      // The row's OWN status decides, never a default. A superseded launch
      // rendered as "in flight" would tell the user Vex is still checking a
      // hash it has already stopped checking.
      lifecycle: intent.status === "superseded_unproven" ? "superseded_unproven" : "in_flight",
      // NULL, never "": the row must be structurally unable to render as a token.
      tokenAddress: null,
      name: intent.name,
      symbol: intent.symbol,
      createTxHash: intent.txHash as string,
      chainId: intent.chainId,
      createdAt: intent.broadcastAt ?? intent.createdAt,
      // The AUTHORIZED native prebuy, straight off the intent. Nothing here was
      // decoded from a receipt, so no other amount may be shown.
      initialBuyRaw: intent.prebuyRaw,
      initialBuyDecimals: intent.prebuyRaw === null ? null : intent.prebuyDecimals,
    }));

  const provenRows: LaunchedTokenDto[] = proven.map((row) => ({
    lifecycle: "launched",
    tokenAddress: row.tokenAddress,
    name: row.name,
    symbol: row.symbol,
    createTxHash: row.createTxHash,
    chainId: row.chainId,
    createdAt: row.createdAt,
    initialBuyRaw: row.initialBuyRaw,
    initialBuyDecimals: row.initialBuyRaw === null ? null : row.initialBuyDecimals,
  }));

  return [...unsettledRows, ...provenRows].slice(0, limit);
}

/**
 * The launch form an AGENT drafted and is now parked waiting on (§C3b).
 *
 * `null` — never a throw — when nothing is waiting. "No form is open" is the
 * ordinary state of a session; the renderer asks this on every push signal and
 * on every session switch, and an exception for the common case would turn an
 * idle session into a visible error.
 *
 * THE NEWEST ROW WINS. The repo read orders by `created_at DESC` and the dialog
 * is a single modal, so the form the user was most recently asked about is the
 * one shown. Older rows stay live in `awaiting_user_form` and surface in turn as
 * each newer one is answered — nothing is silently dropped.
 *
 * WHAT THIS DELIBERATELY DOES NOT RETURN: the wallet address, the consent
 * record, any fee, `msg.value` or gas. This is the TOKEN the agent proposed and
 * nothing more. The money is still derived by `previewLaunch` and re-derived by
 * `submitLaunch`, so no field here can shorten the path to a signature.
 */
export async function getAwaitingLaunchForm(
  sessionId: string,
): Promise<AwaitingLaunchFormDto | null> {
  const rows = await getAwaitingForSession(sessionId);
  for (const row of rows) {
    // Two defensive skips, both of which would produce an unusable dialog:
    // a non-agent origin has no parked turn to answer, and a launch without an
    // image cannot be deployed at all (product rule, enforced at the writer).
    if (row.origin !== "agent_requested_form") continue;
    if (row.imageId === null) continue;
    return {
      intentId: row.intentId,
      origin: "agent_requested_form",
      name: row.name,
      symbol: row.symbol,
      description: row.description ?? "",
      links: readLinkUrls(row.links),
      imageId: row.imageId,
      // Raw wei + its decimals → the plain decimal ETH string the form field
      // takes. Converted HERE, once, by the same library that parsed it: the
      // renderer never does a decimals conversion (rule 90), and it never sees
      // the raw amount it might be tempted to convert itself.
      prebuy: formatEther(BigInt(row.prebuyRaw ?? "0")),
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }
  return null;
}

/**
 * Read the link list out of the row's JSONB blob.
 *
 * The column is `Record<string, unknown>` by type and `{ urls: [...] }` by
 * convention, so every element is checked rather than asserted — a malformed
 * blob yields no links instead of putting a non-string into an `href`.
 */
function readLinkUrls(links: Record<string, unknown>): string[] {
  const urls = links.urls;
  if (!Array.isArray(urls)) return [];
  return urls.filter((url): url is string => typeof url === "string");
}
