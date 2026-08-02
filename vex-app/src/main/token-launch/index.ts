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
 */

import {
  buildLaunchPlan,
  type LaunchPlan,
} from "@vex-agent/tools/protocols/trench/handlers/launch/plan.js";
import { validateLaunchRequest } from "@vex-agent/tools/protocols/trench/handlers/launch/validate.js";
import { checkLaunchAuthorizationUnchanged } from "@vex-agent/tools/protocols/trench/handlers/launch/authorization.js";
import type { PlanTrenchFeeLeg } from "@vex-agent/tools/protocols/trench/handlers/launch/fee-seam.js";
import * as launchedTokens from "@vex-agent/db/repos/launched-tokens.js";
import type { LaunchedTokenDto } from "@shared/schemas/token-launch.js";

/**
 * Reasons the main side refuses. Mapped 1:1 onto `tokenLaunch.*` error codes by
 * the handler — the handler owns the wire shape, this module owns the reason.
 */
export type TokenLaunchRefusal =
  | { readonly kind: "preview_stale"; readonly detail: string }
  | { readonly kind: "value_ceiling_exceeded"; readonly detail: string }
  | { readonly kind: "launch_count_exceeded"; readonly detail: string }
  | { readonly kind: "ceiling_not_set"; readonly detail: string }
  | { readonly kind: "invalid"; readonly detail: string };

/**
 * The fee planner, injected the same way the agent handler takes it.
 *
 * Defaults to "no fee leg" rather than inventing one: a fabricated fee on a
 * signing path is precisely the unprovable number rule 90 forbids.
 */
export const NO_FEE_LEG: PlanTrenchFeeLeg = () => null;

/**
 * Re-derive a plan and confirm it still matches what the preview showed.
 *
 * THE STALENESS CHECK IS THE SAME MECHANISM AS THE AUTHORIZATION GATE, not a
 * second one. A stale preview is just a re-derivation whose bound fields no
 * longer match — so there is one code path, one comparison, and one refusal
 * carrying both sets of numbers. A separate "fee drift" check would be a second
 * place to get it wrong, and would miss any anchored value that is not the fee.
 */
export function checkPreviewStillValid(
  previewedPlan: LaunchPlan,
  currentPlan: LaunchPlan,
  previewId: string,
): TokenLaunchRefusal | null {
  if (currentPlan.preview.previewId !== previewId) {
    return {
      kind: "preview_stale",
      detail:
        `The launch cost changed since you were shown it: the creation fee now reads `
        + `${currentPlan.preview.creationFeeWei} wei at block ${currentPlan.preview.anchorBlockNumber} `
        + `(you were shown ${previewedPlan.preview.creationFeeWei} wei at block `
        + `${previewedPlan.preview.anchorBlockNumber}). Nothing was signed — review the new figures.`,
    };
  }

  const unchanged = checkLaunchAuthorizationUnchanged(
    previewedPlan.binding,
    currentPlan.binding,
  );
  if (!unchanged.ok) return { kind: "preview_stale", detail: unchanged.reason };

  return null;
}

/** Map a plan refusal code onto the main-side refusal vocabulary. */
export function refusalFromPlanCode(
  code: string,
  detail: string,
): TokenLaunchRefusal {
  switch (code) {
    case "ceiling_not_set":
      return { kind: "ceiling_not_set", detail };
    case "value_ceiling_exceeded":
      return { kind: "value_ceiling_exceeded", detail };
    case "launch_count_exceeded":
      return { kind: "launch_count_exceeded", detail };
    default:
      return { kind: "invalid", detail };
  }
}

export { buildLaunchPlan, validateLaunchRequest };

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
