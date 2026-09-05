/**
 * `pools.launch_preview` - what a launch would cost, and a durable record of
 * having asked.
 *
 * ADVISORY, AND HONEST ABOUT WHY. The final token address cannot be known here:
 * the image determines the metadata URI, which determines the salt, which
 * determines the CREATE2 address. Only a real `prepare` settles it, and a
 * `prepare` PINS A PERSISTENT IPFS OBJECT through the provider's account - so a
 * preview deliberately does NOT call it. Quoting a token address here would mean
 * either pinning metadata for a launch nobody committed to, or inventing an
 * address the launch will not use.
 *
 * WHAT IT DOES READ is the one number that actually moves: the gateway's CURRENT
 * deployment fee. That fee is dynamic - measured moving 4x inside 24 hours - so
 * a preview quoting a cached figure would be worse than no preview.
 *
 * THE ROW IT WRITES is a `previewed` intent, which the database itself keeps
 * non-live: it carries no authorization and no hash (the CHECK refuses one that
 * does), so it consumes no launch ceiling and cannot become a launch. A real
 * launch starts a fresh intent. That is what makes this a `local_write` rather
 * than a read, and why Agent Scan can surface previews from intents instead of
 * from hashless activity rows.
 */

import { randomUUID } from "node:crypto";
import { formatEther, getAddress } from "viem";

import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import { POOLS_CHAIN_ID, POOLS_CHAIN_SLUG, poolsLaunchSuite } from "@tools/pools-fun/constants.js";
import { POOLS_FEE_BPS, POOLS_FEE_VENUE } from "@tools/pools-fun/fee/venue.js";
import { splitAmountForFeeBps } from "@tools/vex-fee/bps-split.js";
import { createWith } from "@vex-agent/db/repos/token-launch-intents.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { acquireSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status.js";

import { ok, fail } from "../../../handler-helpers.js";
import { resolveSelectedAddress, walletScopeErrorToResult } from "../../../../internal/wallet/resolve.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { poolsFailureDetail } from "../failure.js";
import { readPoolsLaunchInputs } from "./inputs.js";

const TOOL_ID = "pools.launch_preview";

/**
 * How long a preview row is kept. Previews are advisory and cheap to redo, so
 * the window is short: a stale cost estimate is worse than none, because the
 * deployment fee it quotes moves.
 */
const PREVIEW_WINDOW_MS = 15 * 60 * 1000;

/** One cost leg, raw + decimals, exactly as the runtime contract shapes them. */
function nativeAmount(rawWei: bigint): { rawWei: string; decimals: number; assetSymbol: string; human: string } {
  return { rawWei: rawWei.toString(), decimals: 18, assetSymbol: "ETH", human: formatEther(rawWei) };
}

export async function poolsLaunchPreviewHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const validated = readPoolsLaunchInputs(p);
  if (!validated.ok) return fail(validated.reason);
  const inputs = validated.value;

  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${TOOL_ID} requires an active session.`);

  // Address only - a preview never needs a key, and asking for one would make a
  // read-shaped tool able to unlock a wallet.
  let walletAddress: string;
  try {
    walletAddress = getAddress(
      resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
    );
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  try {
    // The ONE live read: the gateway's current fee. Everything else here is
    // arithmetic over it.
    const config = await getPoolsFunClient().launchConfig({ signal: context.abortSignal });
    const deploymentFeeWei = BigInt(config.deploymentFeeWei);
    const prebuyWei = inputs.prebuyWei ?? 0n;

    // The native launch value: deployment fee + ETH prebuy. This is the Vex fee
    // basis, and a USDG prebuy is deliberately NOT in it (see the fee venue).
    const launchValueWei = deploymentFeeWei + prebuyWei;
    const split = splitAmountForFeeBps(launchValueWei, {
      bps: POOLS_FEE_BPS,
      amountLabel: POOLS_FEE_VENUE.amountLabel,
    });

    const intentId = randomUUID();
    const expiresAt = new Date(Date.now() + PREVIEW_WINDOW_MS).toISOString();

    // Created under the session control lock, like every other intent: creation
    // is the one transition a row lock cannot exclude, because the row has no
    // identity to lock until it exists.
    await withTransaction(async (client) => {
      await acquireSessionControlLock(client, sessionId);
      await createWith(client, {
        intentId,
        sessionId,
        origin: "agent",
        status: "previewed",
        chainId: POOLS_CHAIN_ID,
        walletAddress,
        name: inputs.name,
        symbol: inputs.symbol,
        // NO imageId: a preview takes no image lock, so it can never pin a
        // picture a launch then finds missing.
        ...(inputs.prebuyWei === null
          ? {}
          : { prebuyRaw: inputs.prebuyWei.toString(), prebuyDecimals: 18 }),
        missionRunId: context.missionRunId ?? null,
        expiresAt,
        protocol: "pools_fun",
        pools: {
          pairedAsset: inputs.pairedAsset,
          // The suite a launch would target, recorded on the preview row so a
          // later reader knows which contract this estimate described.
          gatewayAddress: poolsLaunchSuite().gateway,
          deploymentFeeWei: config.deploymentFeeWei,
        },
      });
    });

    return ok({
      chain: POOLS_CHAIN_SLUG,
      chainId: POOLS_CHAIN_ID,
      previewId: intentId,
      advisory: true,
      name: inputs.name,
      symbol: inputs.symbol,
      pairedAsset: inputs.pairedAsset,
      wallet: walletAddress,
      costs: {
        deploymentFee: nativeAmount(deploymentFeeWei),
        ...(inputs.prebuyWei === null ? {} : { prebuy: nativeAmount(inputs.prebuyWei) }),
        // The launch's `msg.value`. Excludes the Vex fee, which is a separate
        // later transaction, and excludes gas.
        transactionValue: nativeAmount(launchValueWei),
        vexFee: {
          ...nativeAmount(split.feeRaw),
          bps: POOLS_FEE_BPS,
          charged: split.charged,
          basis: "launch_msg_value",
          chargedOn: POOLS_FEE_VENUE.basisText.launch_msg_value,
        },
      },
      feeRecipient: {
        address: walletAddress,
        note: "Vex pins the creator fee stream to your own session wallet on an agent launch. To send it "
          + "somewhere else, launch through the app's form, where you choose the recipient and your submission "
          + "authorizes it.",
      },
      note:
        "ADVISORY ESTIMATE. The token's final ADDRESS is not knowable yet: the image sets the metadata link, "
        + "which sets the salt, which sets the address, and only preparing a real launch settles it. The "
        + "deployment fee above was read live and moves over time, so it is re-read and re-verified at launch. "
        + "Nothing was spent, nothing was signed, and this preview cannot become a launch on its own.",
      expiresAt,
    });
  } catch (err) {
    return fail(`${TOOL_ID} could not price this launch (${poolsFailureDetail(TOOL_ID, err)})`);
  }
}
