/**
 * `virtuals.launch.preview` - price an agent launch and show the whole plan,
 * without signing anything.
 *
 * It is MUTATING in exactly one sense and no other: it writes an advisory
 * `previewed` row so the plan a person is shown can be claimed, once, by the
 * execute that acts on it. It opens no key, sends no transaction, grants no
 * allowance and takes no fee. The database refuses to let that row carry an
 * authorization or a hash (migration 082), which is the structural half of "a
 * preview cannot become a signature".
 *
 * THE PICTURE IS REQUIRED HERE TOO. Unlike the pools preview, this one seals a
 * calldata FINGERPRINT the execute is held to, and the image URL is inside that
 * calldata - so a preview without a picture would return a fingerprint no
 * execute could ever match. See `./launch/image.ts`.
 */

import { getAddress } from "viem";

import { getVirtualsCurvePublicClient } from "@tools/virtuals/curve/index.js";
import {
  resolveSelectedAddress,
  walletScopeErrorToResult,
} from "@vex-agent/tools/internal/wallet/resolve.js";

import type { ToolResult } from "../../../types.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import { summarizeProtocolError } from "../../runtime/errors.js";
import { readLaunchFields } from "./launch/params.js";
import { resolveLaunchImage } from "./launch/image.js";
import { buildLaunchPlan, describeLaunchPlan } from "./launch/plan.js";
import { createLaunchPreviewIntent, LAUNCH_PREVIEW_WINDOW_MS } from "./launch/intent.js";
import { LAUNCH_EXECUTE_PUBLIC_NAME, LAUNCH_PREVIEW_TOOL_ID } from "./launch/tool-ids.js";

export async function virtualsLaunchPreview(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const read = readLaunchFields(p);
  if (!read.ok) {
    // A closed chain and a closed launch shape are ANSWERS, not errors: they
    // carry the measured reason, so an agent stops looking for a workaround.
    if (read.handoff) {
      return ok({
        supported: false,
        chain: read.handoff.chain,
        reason: read.handoff.reason,
        useInstead: read.handoff.useInstead,
      });
    }
    if (read.unsupported) {
      return ok({
        supported: false,
        feature: read.unsupported.feature,
        reason: read.unsupported.reason,
      });
    }
    return fail(read.reason);
  }
  const fields = read.fields;

  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${LAUNCH_PREVIEW_TOOL_ID} requires an active session.`);

  // Address only - a preview NEVER decrypts.
  let wallet: string;
  try {
    wallet = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  const walletAddress = getAddress(wallet);

  // REQUIRED even here: the preview seals the fingerprint of the exact
  // `preLaunch` calldata and the image URL is inside it, so a preview without a
  // picture would hand back a fingerprint no execute could ever match.
  const image = await resolveLaunchImage({ params: p, context });
  if (!image.ok) return fail(image.reason);

  const client = getVirtualsCurvePublicClient(fields.deployment);
  let built;
  try {
    built = await buildLaunchPlan({ client, fields, image: image.image, wallet: walletAddress });
  } catch (err) {
    return fail(`Virtuals launch state unavailable (${summarizeProtocolError(err).message}).`);
  }
  if (!built.ok) return fail(built.reason);
  const plan = built.plan;

  const expiresAt = new Date(Date.now() + LAUNCH_PREVIEW_WINDOW_MS).toISOString();
  let previewId: string;
  try {
    previewId = await createLaunchPreviewIntent({
      sessionId,
      walletAddress,
      chainId: fields.deployment.chainId,
      name: fields.name,
      symbol: fields.ticker,
      description: fields.description,
      committedRaw: plan.fee.committedRaw,
      decimals: plan.state.virtualDecimals,
      missionRunId: context.missionRunId ?? null,
      block: {
        chainKey: fields.deployment.key,
        bondingV5: fields.deployment.bondingV5,
        imageUrl: plan.image.url,
        imageCid: plan.image.cid,
        cores: fields.cores,
        antiSniperTaxType: fields.antiSniperTaxType,
        nameSuffix: fields.nameSuffix,
        onChainName: plan.onChainName,
        urls: fields.urls,
        calldataFingerprint: plan.fingerprint,
        launchAmountRaw: plan.fee.launchAmountRaw.toString(),
        protocolFeeRaw: plan.state.protocolLaunchFeeRaw.toString(),
        vexFeeRaw: plan.fee.feeRaw === null ? null : plan.fee.feeRaw.toString(),
      },
    });
  } catch (err) {
    return fail(`The launch preview could not be recorded (${summarizeProtocolError(err).message}). Nothing was signed.`);
  }

  return ok({
    ...describeLaunchPlan({ plan, fields, wallet: walletAddress }),
    previewId,
    advisory: true,
    expiresAt,
    executeWith: LAUNCH_EXECUTE_PUBLIC_NAME,
    note:
      "Nothing was signed and no allowance was granted. Pass this previewId to "
      + `${LAUNCH_EXECUTE_PUBLIC_NAME} together with the IDENTICAL fields: the execute re-reads the chain, rebuilds `
      + "the exact calldata and refuses if its fingerprint differs from the one above. A previewId is single-use and "
      + `lapses after ${Math.round(LAUNCH_PREVIEW_WINDOW_MS / 60_000)} minutes.`,
  });
}
