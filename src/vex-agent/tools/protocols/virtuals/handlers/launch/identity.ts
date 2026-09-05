/**
 * Recording WHICH agent this launch created, and signing the AgentScan
 * attestation while the signer still exists.
 *
 * ## Why the signature has to happen here and nowhere else
 *
 * AgentScan verifies ONE message - `VEX-attest:<chainId>:<lowercased token>`
 * (`canonicalAttestMessage`, the client's own builder) - recovered to the
 * CREATOR's address. Only the wallet that signed the launch can produce it, and
 * this handler is the last place in the entire system that holds that wallet's
 * key: the attest sweep runs later, in a background job, with no signer and no
 * approval. So a signature not taken here is a signature that can never be
 * taken, and the row would sit unattestable forever.
 *
 * The signature is an off-chain `personal_sign`. It spends no gas, moves no
 * funds and authorizes nothing on chain - it is a proof of authorship, which is
 * why taking it inside a launch the user already approved is not a second
 * money decision.
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
 * a re-entry converges rather than duplicating. `stampAgentscanAttestSignature`
 * is write-once for the same reason.
 */

import type { Account, Chain, Transport, WalletClient } from "viem";

import type { VirtualsCurveDeployment } from "@tools/virtuals/curve/index.js";
import { canonicalAttestMessage } from "@vex-agent/agentscan/attest-client.js";
import {
  record as recordLaunchedToken,
  stampAgentscanAttestSignature,
} from "@vex-agent/db/repos/launched-tokens.js";
import logger from "@utils/logger.js";

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

  let signature: string;
  try {
    signature = await input.walletClient.signMessage({
      account: input.walletClient.account,
      message: canonicalAttestMessage(input.deployment.chainId, input.token),
    });
  } catch (err) {
    logger.warn("virtuals.launch.attest_sign_failed", {
      chainId: input.deployment.chainId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return {
      recorded,
      attestation: {
        signed: false,
        note:
          "The AgentScan creator proof could not be signed, so this launch will not carry a Vex badge. Nothing else "
          + "is affected - the agent is on chain and the launch is recorded. The proof cannot be produced later: "
          + "only the launching wallet can sign it, and only while this call holds it.",
      },
    };
  }

  try {
    const stamped = await stampAgentscanAttestSignature({
      chainId: input.deployment.chainId,
      tokenAddress: input.token,
      launchpad: VIRTUALS_LAUNCH_PROTOCOL,
      attestSignature: signature,
    });
    return {
      recorded,
      attestation: {
        signed: stamped,
        note: stamped
          ? "The AgentScan creator proof was signed and stored. Vex submits it in the background; the launch does not "
            + "wait for it."
          : "The AgentScan creator proof was signed but a proof was already stored for this agent, so it was kept. "
            + "The launch is unaffected.",
      },
    };
  } catch (err) {
    logger.warn("virtuals.launch.attest_store_failed", {
      chainId: input.deployment.chainId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return {
      recorded,
      attestation: {
        signed: false,
        note:
          "The AgentScan creator proof was signed but could not be stored, so this launch may not carry a Vex badge. "
          + "The agent is on chain and the launch is recorded.",
      },
    };
  }
}
