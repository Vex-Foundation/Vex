/**
 * Recording WHICH agent this launch created, and asking the attestation module
 * to prove authorship while the signer still exists.
 *
 * ## Two concerns, and the ORDER between them is the only thing this file owns
 *
 * The identity row must exist before a proof can be attached to it, so this
 * module writes `launched_tokens` and then delegates the proof to
 * `./attribute.js`. The SIGNING itself deliberately lives there and not here:
 * the signing-oracle guard requires each text-message signing site to be one
 * named, reviewed module, and a signature that appeared inside a general
 * bookkeeping file is exactly the silent addition that guard exists to catch.
 *
 * ## Best-effort by contract
 *
 * Every step here is bookkeeping about a launch that ALREADY HAPPENED. A failed
 * identity write, a refused signature or an unavailable database must never
 * turn a confirmed launch into a failure, so nothing in this module throws to
 * its caller: each outcome is reported in the returned block and the launch
 * stands either way.
 *
 * `launched_tokens.record` is an upsert keyed on (chain, lowercased token), so
 * a re-entry converges rather than duplicating.
 */

import type { Account, Chain, Transport, WalletClient } from "viem";

import type { VirtualsCurveDeployment } from "@tools/virtuals/curve/index.js";
import { record as recordLaunchedToken } from "@vex-agent/db/repos/launched-tokens.js";
import logger from "@utils/logger.js";

import { signAndStoreVirtualsAttestation } from "./attribute.js";
import { VIRTUALS_LAUNCH_PROTOCOL } from "./tool-ids.js";

export interface LaunchIdentityOutcome {
  /** True when the `launched_tokens` row exists after this call. */
  readonly recorded: boolean;
  readonly attestation: {
    readonly signed: boolean;
    readonly note: string;
  };
}

export async function recordLaunchIdentity(input: {
  readonly deployment: VirtualsCurveDeployment;
  readonly wallet: string;
  readonly token: string;
  readonly name: string;
  readonly symbol: string;
  readonly imageRef: string;
  readonly createTxHash: string;
  readonly sessionId: string;
  readonly protocolExecutionId: number;
  readonly initialPurchaseRaw: bigint;
  readonly decimals: number;
  readonly walletClient: WalletClient<Transport, Chain, Account>;
}): Promise<LaunchIdentityOutcome> {
  let recorded = false;
  try {
    await recordLaunchedToken({
      walletAddress: input.wallet,
      chainId: input.deployment.chainId,
      tokenAddress: input.token,
      name: input.name,
      symbol: input.symbol,
      launchpad: VIRTUALS_LAUNCH_PROTOCOL,
      imageRef: input.imageRef,
      createTxHash: input.createTxHash,
      // The initial purchase is the VIRTUAL the venue holds for this launch, and
      // it is denominated in VIRTUAL rather than in the agent token: at
      // `preLaunch` no agent tokens have been bought yet - the keeper's
      // `launch()` is what spends it. Recording the agent token here would name
      // an amount that does not exist.
      initialBuyRaw: input.initialPurchaseRaw.toString(),
      initialBuyDecimals: input.decimals,
      initialBuyTokenAddress: input.deployment.virtual,
      sessionId: input.sessionId,
      protocolExecutionId: input.protocolExecutionId,
    });
    recorded = true;
  } catch (err) {
    logger.warn("virtuals.launch.identity_record_failed", {
      chainId: input.deployment.chainId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return {
      recorded: false,
      attestation: {
        signed: false,
        note:
          "Vex could not record this agent in its own launch table, so the AgentScan attestation was not signed "
          + "either - there is no row to attach it to. The launch itself is unaffected and is on chain.",
      },
    };
  }

  return {
    recorded,
    attestation: await signAndStoreVirtualsAttestation({
      signer: input.walletClient,
      chainId: input.deployment.chainId,
      tokenAddress: input.token,
      launchpad: VIRTUALS_LAUNCH_PROTOCOL,
    }),
  };
}
