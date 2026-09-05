/**
 * pools.fun handlers.
 *
 * The five read tools are READ-ONLY: four call the launchpad REST client, and `pools.token`
 * additionally reads the PartyLocker and the token contract at one pinned block.
 * The two launch tools write LOCAL state only: `launch_preview` records an
 * advisory preview, and `launch_request_form` opens the app's form and parks the
 * turn. `launch_execute` is the ONE leg that signs and spends: it verifies the
 * launchpad's own calldata against the chain, takes a C0 authorization over the
 * exact bytes, and broadcasts them. Trading pools.fun tokens is still the
 * existing `kyberswap` venue's job.
 */

import type { ProtocolHandler } from "../types.js";
import { poolsTokensHandler } from "./handlers/list.js";
import { poolsSearchHandler } from "./handlers/search.js";
import { poolsCandlesHandler } from "./handlers/candles.js";
import { poolsTokenHandler } from "./handlers/token.js";
import { poolsMyLaunchesHandler } from "./handlers/my-launches.js";
import { poolsLaunchPreviewHandler } from "./handlers/launch/preview.js";
import { poolsLaunchRequestFormHandler } from "./handlers/launch/request-form.js";
import { poolsLaunchExecuteHandler } from "./handlers/launch/execute.js";
import { poolsClaimFeesHandler } from "./handlers/claim.js";
import { poolsLaunchAssetsHandler } from "./handlers/launch-assets.js";
import { poolsHolderRewardsGetHandler } from "./handlers/holder-rewards-get.js";
import { poolsHolderRewardsClaimHandler } from "./handlers/holder-rewards-claim.js";
import { poolsHolderRewardsDistributeHandler } from "./handlers/holder-rewards-distribute.js";

export const POOLS_HANDLERS: Record<string, ProtocolHandler> = {
  "pools.tokens": (p, context) => poolsTokensHandler(p, context),
  "pools.search": (p, context) => poolsSearchHandler(p, context),
  "pools.candles": (p, context) => poolsCandlesHandler(p, context),
  "pools.token": (p, context) => poolsTokenHandler(p, context),
  "pools.my_launches": (p, context) => poolsMyLaunchesHandler(p, context),
  // The launchable stock universe, joined with the launch factory's pricing mode.
  "pools.launch_assets": (p, context) => poolsLaunchAssetsHandler(p, context),
  // Fees-to-holders state for one token, on-chain first. Reads only; the claim
  // and the permissionless distribute are their own tools.
  "pools.holder_rewards": (p, context) => poolsHolderRewardsGetHandler(p, context),
  "pools.launch_preview": (p, context) => poolsLaunchPreviewHandler(p, context),
  "pools.launch_request_form": (p, context) => poolsLaunchRequestFormHandler(p, context),
  // The ONE leg that signs. Its fee leg needs no adapter: the shared native-fee
  // lane takes the pools venue directly, so there is no per-venue seam to keep
  // in step here.
  "pools.launch_execute": (p, context) => poolsLaunchExecuteHandler(p, context),
  // `dryRun: true` simulates and signs nothing; without it this claims for real
  // behind the ordinary approval gate.
  "pools.claim_fees": (p, context) => poolsClaimFeesHandler(p, context),
  // The HOLDER's side of the same launchpad: `claim()` on the token's own
  // reward distributor, and the permissionless `distribute()` that starts the
  // stream for everybody. Both carry NO Vex fee - the server's claim arm binds
  // no fee role, and the owner fee policy charges swaps, bridges and launches.
  "pools.holder_rewards_claim": (p, context) => poolsHolderRewardsClaimHandler(p, context),
  "pools.holder_rewards_distribute": (p, context) => poolsHolderRewardsDistributeHandler(p, context),
};
