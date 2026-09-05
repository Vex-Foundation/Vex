/**
 * The launch field vocabulary, shared by `pools.launch_preview` and
 * `pools.launch_request_form`.
 *
 * ONE array, two tools, deliberately: the preview must price exactly the launch
 * the form would submit, and two hand-written param lists are how a preview
 * starts describing a different launch than the one that executes.
 *
 * THE HARD RULE, inherited verbatim from the Trench launch params: NO `fee`,
 * `value`, `min`, `minOut`, `deadline`, `recipient` or gas parameter appears
 * here, ever. A model-supplied fee or recipient is an overcharge vector and the
 * approval preview is arguments-only, so the human approving would never see it.
 * `fee-params-never-from-model.test.ts` fails the build if one appears.
 *
 * THE RECIPIENT IN PARTICULAR (owner decision 3): the agent-facing launch tools
 * have NO `feeRecipient` parameter at all. The system pins the fee recipient to
 * the session wallet on every agent launch. ONLY the manual desktop form lets a
 * user choose a different recipient, and that choice is authorized by the form
 * itself rather than by anything the model wrote.
 */

import type { ProtocolParamDef } from "../../types.js";
import type { NumericParamSpecs } from "../../runtime/list-params.js";

/**
 * The launchable pairs.
 *
 * `stock` joined WETH and USDG when the V3 factory was measured: all 194 rows
 * of `GET /pools-fun/launch-assets` answer `allowedPairedAsset(asset) = true`,
 * and `pricingModeFor(asset)` names how each one is priced (159 `SIGNED_STOCK`,
 * 35 `CHAINLINK_STOCK`, measured 2026-09-04). The symbolic value alone cannot
 * identify WHICH stock, so a `stock` pair is always accompanied by
 * `pairedStockAddress`, and both are held to the factory's own answer at the
 * anchored block by verifier points 5 and 6 - never to a list in this build.
 */
export const POOLS_LAUNCH_PAIRED_ASSETS = ["weth", "usdg", "stock"] as const;
export type PoolsLaunchPairedAssetValue = (typeof POOLS_LAUNCH_PAIRED_ASSETS)[number];

/**
 * Where a launch's creator fee stream goes when the caller asks for HOLDER
 * REWARDS, in the launchpad's own vocabulary
 * (`launches/config.holderRewardsPayoutModes`, measured).
 *
 * These are not addresses and can never become one. Each mode names a SENTINEL
 * constant that the verifier reads live from the gateway that will interpret it
 * (`FEES_TO_HOLDERS`, `_PAIRED`, `_BOTH`), and verifier point 15 refuses unless
 * the signed tuple carries exactly that sentinel. A suite that does not expose a
 * mode's sentinel refuses it by name rather than falling back to another one.
 */
export const POOLS_HOLDER_REWARDS_PAYOUTS = ["token", "paired", "both"] as const;
export type PoolsHolderRewardsPayoutValue = (typeof POOLS_HOLDER_REWARDS_PAYOUTS)[number];

/** Bounds for the numeric side of the launch form. */
export const POOLS_LAUNCH_NUMERIC_PARAMS: NumericParamSpecs = {};

export const POOLS_LAUNCH_FIELD_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "name",
    type: "string",
    required: true,
    description:
      "The token's full display name, 1 to 64 characters, exactly as it should appear on the launchpad and in the pinned metadata.",
  },
  {
    key: "symbol",
    type: "string",
    required: true,
    description:
      "The ticker, 1 to 16 characters. Symbols are NOT unique on pools.fun and copycats are routinely live, so this is a label rather than an identity.",
  },
  {
    key: "pairedAsset",
    type: "string",
    enum: [...POOLS_LAUNCH_PAIRED_ASSETS],
    description:
      "Which asset the new pool trades against: weth (default), usdg, or stock for one of the tokenised "
      + "stocks the launch factory allows. A stock pair REQUIRES pairedStockAddress naming which stock, and it "
      + "is the launch factory - not this build - that decides whether that address is launchable and how it is "
      + "priced: list the allowed stocks and their pricing mode with pools__launch_assets_list. A stock-paired "
      + "pool's liquidity after listing is UNKNOWN at launch time; the illiquidity badge on pools.fun is a fact "
      + "about pools that already trade and says nothing about a pair being created now.",
  },
  {
    key: "pairedStockAddress",
    type: "string",
    description:
      "The 0x address of the tokenised stock to pair against, REQUIRED when pairedAsset is stock and refused "
      + "by name on any other pair. Take it from pools__launch_assets_list, which reads the factory's own "
      + "allowedPairedAsset and pricingModeFor for every listed stock. A SIGNED_STOCK pair is priced by a "
      + "backend-signed quote the factory accepts only 30 to 120 seconds after it was observed, so such a launch "
      + "must be prepared, confirmed and broadcast inside that window and is re-prepared automatically if it lapses.",
  },
  {
    key: "holderRewards",
    type: "boolean",
    description:
      "Set true to direct this token's CREATOR FEE STREAM to its own holders instead of to the launching "
      + "wallet. Locked at launch and IRREVERSIBLE: the launchpad deploys a rewards distributor for the token and "
      + "the creator receives nothing from trading fees, ever. Vex proves this before signing by reading the "
      + "gateway's own FEES_TO_HOLDERS sentinel constants live and refusing unless the transaction carries "
      + "exactly the sentinel for the mode you asked for; no address can be supplied here or anywhere on this "
      + "surface. Omit or set false for the ordinary launch, where the fee stream goes to the user's session wallet.",
  },
  {
    key: "holderRewardsMode",
    type: "string",
    enum: [...POOLS_HOLDER_REWARDS_PAYOUTS],
    description:
      "Which asset the holders are paid in when holderRewards is true: token (default - the launched token, "
      + "bought back from the fees), paired (the asset the pool trades against), or both. Refused by name when "
      + "holderRewards is not true, and refused by name when the launch suite does not expose that mode's "
      + "sentinel - the V2 suite has the token mode only.",
  },
  {
    key: "imageId",
    type: "string",
    description:
      "IN-APP ONLY: the identifier of a picture the user already staged in the app's image locker, listed by "
      + "launchpads__images_list (one locker, shared by every launchpad). The agent can never create one, only name "
      + "one the locker already holds. Over the Vex Studio MCP surface this parameter is REFUSED BY NAME and "
      + "imagePath is used instead. Optional here; pools__launch_execute REQUIRES a picture.",
  },
  {
    key: "imagePath",
    type: "string",
    description:
      "VEX STUDIO MCP ONLY: the path of an image file INSIDE the current project (PNG, JPEG, WebP or GIF), "
      + "which Vex reads itself and publishes. A URL is never accepted on any surface, because the launchpad "
      + "writes the picture's location on chain and a URL could serve different bytes tomorrow. In the Vex app "
      + "this parameter is REFUSED BY NAME and imageId is used instead. Optional here; pools__launch_execute "
      + "REQUIRES a picture.",
  },
  {
    key: "prebuy",
    type: "string",
    description:
      "Optional same-transaction first buy, in HUMAN decimal ETH (for example \"0.01\") - not wei. Autonomous launches support an ETH prebuy only, and only on a WETH pair (the gateway refuses a native dev buy against any other pair); a USDG or stock-paired prebuy needs an approval leg and is available through the desktop form instead.",
  },
];

/**
 * The SAME vocabulary, plus the one parameter only the executing tool has.
 *
 * Derived from the array above rather than hand-written, because two hand-kept
 * param lists are how the executing tool starts describing a different launch
 * from the one the preview priced.
 *
 * A PICTURE IS REQUIRED ON THIS TOOL, but the requirement cannot be expressed as
 * `required: true` on a param here, because WHICH param names the picture
 * depends on the consent surface the call arrives on: `imageId` in the app,
 * `imagePath` over Vex Studio MCP (`protocols/shared/launch-image-input.ts`).
 * A manifest is static and a surface is not, so the requirement is enforced in
 * the handler, which refuses by name and states the surface's own remedy. The
 * PPV incident (2026-08-19) is why it is a refusal at all: the agent omitted the
 * image, the launchpad pinned metadata with no image key, and the token renders
 * blank on pools.fun forever. An optional param plus a warning did not stop it.
 *
 * `simulateOnly` is DECLARED rather than accepted quietly: a caller that passed
 * it and was ignored would believe nothing was going to be signed. It is the one
 * parameter on this tool that makes it not spend.
 */
export const POOLS_LAUNCH_EXECUTE_PARAMS: readonly ProtocolParamDef[] = [
  ...POOLS_LAUNCH_FIELD_PARAMS,
  {
    key: "simulateOnly",
    type: "boolean",
    description:
      "Set true to run the WHOLE launch path and stop at the edge of signing: the launchpad prepares real "
      + "calldata, the chain is read at one anchored block, the launch is simulated from the user's wallet, all "
      + "15 pre-signing checks run, and the gas is estimated over those exact bytes - then it returns the "
      + "would-be launch (predicted token address, calldata fingerprint, value, fees, gas bound) with "
      + "launched: false. NO wallet key is opened, no authorization is created and nothing is broadcast, so no "
      + "token exists afterwards. One side effect DOES happen: preparing a launch pins a metadata object with "
      + "the launchpad and mines a new salt, so a real launch prepared later has a different salt and a "
      + "different token address. Use it to show a user exactly what a launch would do before they commit.",
  },
];
