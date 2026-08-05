/**
 * The launch's ATTRIBUTION step — claiming the VEX badge on trench.express.
 *
 * One reason to change: how a confirmed launch proves to the launchpad that Vex
 * created it. Split out of `broadcast.ts` because it is a different concern
 * from settlement and has a different failure contract: NOTHING here may affect
 * the launch result, the fee leg, or the durable records. A badge is cosmetic;
 * a launch is real money.
 *
 * ── Why the signature is produced HERE and nowhere else ────────────────────
 *
 * The attested string names the token, and the token's address only exists once
 * the create receipt has been decoded — so it cannot be pre-signed, and there is
 * no parallel-at-launch shortcut to take. After this handler returns, its
 * wallet client is gone: the identity-repair and attribution sweeps hold no
 * signer, by construction and by decree. This function therefore runs
 * SYNCHRONOUSLY right after the confirm, with no artificial delay —
 * `personal_sign` is a local operation, not a network round trip.
 *
 * A wallet that refuses to sign costs the token its badge and nothing else: the
 * failure is logged with its real cause and `attest_signature` stays NULL, where
 * the sweep counts it as a named gap rather than retrying something it can never
 * complete.
 */

import type { Account, Chain, Transport, WalletClient } from "viem";

import { buildAttestMessage } from "@tools/trench-express/attribution.js";
import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
import * as launchedTokens from "@vex-agent/db/repos/launched-tokens.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

/**
 * Sign the attestation with the SAME wallet that signed `create`, and store it
 * on the launched-token row.
 *
 * Returns the signature so the POST below can proceed even when the durable
 * write did not land (a launch whose `launched_tokens` row is still being
 * reconciled must not lose its one chance at a badge), or `null` when the
 * wallet could not sign. Never throws.
 */
export async function signAndStoreAttestation(
  walletClient: WalletClient<Transport, Chain, Account>,
  tokenAddress: string,
): Promise<string | null> {
  let signature: string;
  try {
    signature = await walletClient.signMessage({ message: buildAttestMessage(tokenAddress) });
  } catch (err) {
    logger.warn("trench.launch_attribution.sign_failed", {
      // The REAL cause, scrubbed at the canonical boundary: without it a wallet
      // that is locked and a wallet that rejected look identical in the log.
      error: summarizeProtocolError(err).message,
    });
    return null;
  }
  try {
    await launchedTokens.stampAttestSignature({
      chainId: TRENCH_CHAIN_ID,
      tokenAddress,
      attestSignature: signature,
    });
  } catch (err) {
    logger.warn("trench.launch_attribution.store_failed", {
      error: summarizeProtocolError(err).message,
    });
  }
  return signature;
}

/**
 * POST the attribution, best effort. Success marks the row attributed; any
 * failure is logged with the provider's own words and left to the
 * `launch_attribution` sweep, which retries from the stored signature.
 *
 * Never throws, and is deliberately AWAITED rather than left floating: an
 * unawaited promise rejecting after the handler returns is an unhandled
 * rejection in the agent process, and the call is one bounded HTTP request that
 * happens after the launch and the fee are already settled.
 */
export async function postLaunchAttribution(
  tokenAddress: string,
  attestSignature: string | null,
): Promise<void> {
  if (attestSignature === null) return;
  try {
    const { attributeLaunchedToken } = await import("@tools/trench-express/attribution.js");
    const outcome = await attributeLaunchedToken({ tokenAddress, attestSignature });
    if (outcome.kind === "attributed") {
      await markAttributedByIdentity(tokenAddress);
      return;
    }
    logger.warn("trench.launch_attribution.not_attributed", {
      outcome: outcome.kind,
      ...(outcome.kind === "rejected" ? { status: outcome.status } : {}),
      detail: outcome.detail,
    });
  } catch (err) {
    logger.warn("trench.launch_attribution.post_failed", {
      error: summarizeProtocolError(err).message,
    });
  }
}

/** The badge landed; find the row by identity and stamp it. Best effort. */
async function markAttributedByIdentity(tokenAddress: string): Promise<void> {
  const row = await launchedTokens.getByIdentity(TRENCH_CHAIN_ID, tokenAddress);
  if (row === null) {
    // The identity row is not written yet (the reconciler owns it now). The
    // badge is already granted upstream and the endpoint is idempotent, so the
    // sweep's later retry is a harmless no-op that stamps the row.
    logger.info("trench.launch_attribution.row_not_ready", { tokenAddress });
    return;
  }
  await launchedTokens.markAttributed(row.id);
}
