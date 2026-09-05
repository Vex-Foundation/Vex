/**
 * The pools.fun launch's ATTRIBUTION step - claiming the VEX badge.
 *
 * One reason to change: how a confirmed launch proves to pools.fun that Vex
 * created it. Split out of `broadcast.ts` because it is a different concern
 * from settlement and has a different failure contract: NOTHING here may affect
 * the launch result, the fee leg, or the durable records. A badge is cosmetic;
 * a launch is real money.
 *
 * ── Why the signature is produced HERE and nowhere else ────────────────────
 *
 * The attested string names the token, and the token's address only exists once
 * the launch receipt has been decoded - so it cannot be pre-signed, and there
 * is no parallel-at-launch shortcut to take. After this handler returns, its
 * wallet client is gone: the identity-repair and attribution sweeps hold no
 * signer, by construction and by decree. This function therefore runs
 * SYNCHRONOUSLY right after the confirm, with no artificial delay -
 * `personal_sign` is a local operation, not a network round trip.
 *
 * A wallet that refuses to sign costs the token its badge and nothing else: the
 * failure is logged with its real scrubbed cause and `pools_attest_signature`
 * stays NULL, where the sweep counts it as a named gap rather than retrying
 * something it can never complete.
 *
 * ── The gate ───────────────────────────────────────────────────────────────
 *
 * The WHOLE leg - the signature, the durable write and the POST - is gated on
 * `poolsFunAttestationEnabled` being strictly `true`. Disabled means zero
 * signatures, zero HTTP and zero log noise: a lane that is off must be
 * indistinguishable from a lane that does not exist, or "off" becomes a thing
 * operators have to read logs to confirm. The gate is checked in BOTH exported
 * functions rather than once at the call site, because a signing authorization
 * that depends on a caller remembering to ask is not an authorization.
 */

import { loadConfig, poolsAttestationEnabled } from "@config/store.js";
import { buildPoolsAttestMessage } from "@tools/pools-fun/attribution.js";
import { buildAgentscanAttestMessage } from "@vex-agent/agentscan/attest-message.js";
import { POOLS_CHAIN_ID } from "@tools/pools-fun/constants.js";
import { POOLS_ATTEST_LANE_MISCONFIG_CODE } from "@tools/pools-fun/attribution-codes.js";
import * as launchedTokens from "@vex-agent/db/repos/launched-tokens.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

/**
 * The ONE capability this leg needs from the launch's wallet client. A viem
 * `WalletClient` satisfies it structurally (method bivariance), and a test can
 * satisfy it with a plain object instead of casting a partial fake to the full
 * client type. Accepting the whole client here would demand exactly such a
 * cast at every boundary that only ever signs one message.
 */
export interface AttestMessageSigner {
  signMessage(args: { message: string }): Promise<string>;
}

/**
 * Sign the attestation with the SAME wallet that signed the launch, and store
 * it on the launched-token row.
 *
 * Returns the signature so the POST below can proceed even when the durable
 * write did not land (a launch whose `launched_tokens` row is still being
 * reconciled must not lose its one chance at a badge), or `null` when the lane
 * is disabled or the wallet could not sign. Never throws.
 */
export async function signAndStorePoolsAttestation(
  walletClient: AttestMessageSigner,
  tokenAddress: string,
): Promise<string | null> {
  if (!poolsAttestationEnabled()) return null;

  let signature: string;
  try {
    signature = await walletClient.signMessage({
      message: buildPoolsAttestMessage(tokenAddress),
    });
  } catch (err) {
    logger.warn("pools.launch_attribution.sign_failed", {
      // The REAL cause, scrubbed at the canonical boundary: without it a wallet
      // that is locked and a wallet that rejected look identical in the log.
      error: summarizeProtocolError(err).message,
    });
    return null;
  }

  try {
    await launchedTokens.stampPoolsAttestSignature({
      chainId: POOLS_CHAIN_ID,
      tokenAddress,
      attestSignature: signature,
    });
  } catch (err) {
    // The signature is still returned: the POST below is this token's one
    // chance while the signer exists, and losing it to a bookkeeping failure
    // would strand the row in the sweep's unsigned gap forever.
    logger.warn("pools.launch_attribution.store_failed", {
      error: summarizeProtocolError(err).message,
    });
  }
  return signature;
}

/**
 * Sign the AGENTSCAN attestation with the same wallet that signed the launch,
 * and store it beside the launched-token row.
 *
 * A SECOND SIGNATURE OVER DIFFERENT BYTES, and it has to be. The venue badge
 * above signs pools.fun's own venue-prefixed, domain-bound string; the AgentScan
 * registry recovers over its own canonical one and refuses anything else
 * definitively. Neither literal is repeated here: each lives in exactly one
 * builder module, which is what `lint/signing-oracle-guard.test.ts` enforces, so
 * no second module can assemble a byte-identical signable payload. One signature
 * cannot serve both verifiers, so a launch produces both, or the row is simply
 * never a candidate for the sweep it could not sign for.
 *
 * NOT GATED ON THE VENUE LANE, deliberately. `poolsAttestationEnabled()` governs
 * whether Vex claims the pools.fun BADGE; whether an AgentScan attestation is
 * ever delivered is governed by `services.agentscanApiUrl` at sweep time, which
 * is a different operator decision on a different lane. Gating the signature on
 * the badge would mean turning the badge off silently strands every launch's
 * AgentScan proof - and the signature cannot be produced later, because this is
 * the last moment a signer exists.
 *
 * NO POST HAPPENS HERE. Unlike the badge, every AgentScan delivery goes through
 * the periodic sweep (`sync/agentscan-attest.ts`), which reads this column. This
 * function's whole job is to capture the proof while it still can.
 *
 * Never throws: a wallet that refuses to sign, or a row not yet written, costs
 * the token its AgentScan attestation and nothing else.
 */
export async function signAndStoreAgentscanAttestation(
  walletClient: AttestMessageSigner,
  tokenAddress: string,
): Promise<void> {
  let signature: string;
  try {
    signature = await walletClient.signMessage({
      message: buildAgentscanAttestMessage(POOLS_CHAIN_ID, tokenAddress),
    });
  } catch (err) {
    logger.warn("pools.launch_agentscan_attest.sign_failed", {
      error: summarizeProtocolError(err).message,
    });
    return;
  }

  try {
    await launchedTokens.stampAgentscanAttestSignature({
      chainId: POOLS_CHAIN_ID,
      tokenAddress,
      attestSignature: signature,
    });
  } catch (err) {
    // Nothing to fall back to: unlike the badge, there is no inline POST that
    // could still use an unstored signature, and the sweep reads the column.
    // A launch that reaches here has already happened and is unaffected.
    logger.warn("pools.launch_agentscan_attest.store_failed", {
      error: summarizeProtocolError(err).message,
    });
  }
}

/**
 * POST the attestation, best effort. Success marks the row attributed; a
 * terminal refusal is recorded so the sweep never retries it; anything else is
 * left with `attributed_at` NULL for the next cadence.
 *
 * Never throws, and is deliberately AWAITED rather than left floating: an
 * unawaited promise rejecting after the handler returns is an unhandled
 * rejection in the agent process, and the call is one bounded HTTP request that
 * happens after the launch and the fee are already settled.
 */
export async function postPoolsLaunchAttribution(
  tokenAddress: string,
  attestSignature: string | null,
  txHash: string,
): Promise<void> {
  if (!poolsAttestationEnabled()) return;
  if (attestSignature === null) return;

  try {
    const { attributePoolsLaunch, resolvePoolsAttestBaseUrl } = await import(
      "@tools/pools-fun/attribution.js"
    );
    if (resolvePoolsAttestBaseUrl(loadConfig().services.poolsFunAttestApiUrl) === null) {
      // Enabled but no deliverable endpoint yet: the signature is already
      // stored, so the sweep delivers it once the URL is configured. Skipping
      // quietly here keeps a healthy launch free of per-launch delivery noise.
      return;
    }
    const outcome = await attributePoolsLaunch({ tokenAddress, attestSignature, txHash });

    if (outcome.kind === "attributed") {
      await markPoolsAttributedByIdentity(tokenAddress);
      return;
    }

    if (outcome.kind === "rejected") {
      // Definitive, from the CLOSED vocabulary. Recorded durably so the sweep
      // drops the row instead of replaying a refusal that cannot change.
      await recordPoolsRejectionByIdentity(tokenAddress, outcome.code);
      logger.warn("pools.launch_attribution.rejected", {
        status: outcome.status,
        code: outcome.code,
      });
      return;
    }

    if (outcome.kind === "retryable" && outcome.code === POOLS_ATTEST_LANE_MISCONFIG_CODE) {
      // The LANE is wrong, not this row - every launch would get this answer.
      // Loud on purpose: silently retrying a misconfigured lane forever with no
      // operator-visible signal is the failure this code exists to prevent.
      logger.warn("pools.attribution.lane_misconfig", {
        status: outcome.status,
        code: outcome.code,
      });
      return;
    }

    logger.info("pools.launch_attribution.not_attributed", {
      outcome: outcome.kind,
      ...(outcome.kind === "retryable"
        ? { status: outcome.status, code: outcome.code }
        : { detail: outcome.detail }),
    });
  } catch (err) {
    logger.warn("pools.launch_attribution.post_failed", {
      error: summarizeProtocolError(err).message,
    });
  }
}

/** The badge landed; find the row by identity and stamp it. Best effort. */
async function markPoolsAttributedByIdentity(tokenAddress: string): Promise<void> {
  try {
    const row = await launchedTokens.getByIdentity(POOLS_CHAIN_ID, tokenAddress);
    if (row === null) {
      // The identity row is not written yet (the reconciler owns it now). The
      // badge is already granted upstream and the endpoint is idempotent, so
      // the sweep's later retry is a harmless no-op that stamps the row.
      logger.info("pools.launch_attribution.row_not_ready", { tokenAddress });
      return;
    }
    await launchedTokens.markPoolsAttributed({ id: row.id });
  } catch (err) {
    logger.warn("pools.launch_attribution.mark_failed", {
      error: summarizeProtocolError(err).message,
    });
  }
}

/** A terminal refusal; record it so the sweep stops offering the row. Best effort. */
async function recordPoolsRejectionByIdentity(
  tokenAddress: string,
  code: Parameters<typeof launchedTokens.markPoolsAttributionRejected>[0]["code"],
): Promise<void> {
  try {
    const row = await launchedTokens.getByIdentity(POOLS_CHAIN_ID, tokenAddress);
    if (row === null) {
      // Nothing durable to mark yet. The sweep will meet the same refusal on
      // its own pass and record it there, so the row still leaves the lane.
      logger.info("pools.launch_attribution.row_not_ready", { tokenAddress });
      return;
    }
    await launchedTokens.markPoolsAttributionRejected({ id: row.id, code });
  } catch (err) {
    logger.warn("pools.launch_attribution.mark_failed", {
      error: summarizeProtocolError(err).message,
    });
  }
}
