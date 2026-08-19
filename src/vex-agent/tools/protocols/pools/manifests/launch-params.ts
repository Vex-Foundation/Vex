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

/** The launchable pairs. `stock` is deliberately absent - see the enum's prose. */
export const POOLS_LAUNCH_PAIRED_ASSETS = ["weth", "usdg"] as const;
export type PoolsLaunchPairedAssetValue = (typeof POOLS_LAUNCH_PAIRED_ASSETS)[number];

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
      "Which asset the new pool trades against: weth (default) or usdg. These are the only two the factory allows today - tokenised stocks exist in the provider's vocabulary but the on-chain allowlist refuses them, so asking for one would deploy nothing.",
  },
  {
    key: "imageId",
    type: "string",
    description:
      "Identifier of a picture the user already staged in the app's image locker, listed by trench.images (the locker is shared by both launchpads). The agent can never create one, only name one the locker already holds. Optional here; pools.launch_execute REQUIRES it.",
  },
  {
    key: "prebuy",
    type: "string",
    description:
      "Optional same-transaction first buy, in HUMAN decimal ETH (for example \"0.01\") - not wei. Autonomous launches support an ETH prebuy only; a USDG prebuy needs an approval leg and is available through the desktop form instead.",
  },
];

/**
 * The SAME vocabulary, with `imageId` promoted to required - the execute tool's
 * params and nothing else's.
 *
 * Derived from the array above rather than hand-written, because two hand-kept
 * param lists are how the executing tool starts describing a different launch
 * from the one the preview priced. Only the image entry differs, and the reason
 * it does is the PPV incident (2026-08-19): the agent launched a token with no
 * image, the launchpad pinned metadata with no image key, and the token renders
 * blank on pools.fun forever. An optional param plus a warning did not stop it.
 *
 * The preview keeps it optional (advisory, takes no image lock) and the form
 * keeps it optional (the USER picks the image there, and the form is the consent
 * surface). The desktop manual form is unchanged and still allows no image at
 * all, matching the pools.fun site, where a human may launch without one.
 */
export const POOLS_LAUNCH_EXECUTE_PARAMS: readonly ProtocolParamDef[] =
  POOLS_LAUNCH_FIELD_PARAMS.map((param) =>
    param.key === "imageId"
      ? {
          ...param,
          required: true,
          description:
            "REQUIRED on this tool: the identifier of a picture the user already staged in the app's image locker, listed by trench.images (the locker is shared by both launchpads). The agent can never create one, only name one the locker already holds; without it this tool refuses and nothing is launched. A token launched with no image renders blank on pools.fun forever and that cannot be undone.",
        }
      : param,
  );
