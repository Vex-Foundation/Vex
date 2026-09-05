/**
 * The Virtuals launch's ATTESTATION step - the AgentScan creator proof.
 *
 * One reason to change: how a confirmed pre-launch proves to AgentScan that
 * this wallet created the agent. Its own module rather than a branch inside
 * `identity.ts`, for the same two reasons the pools lane split its own out:
 *
 *  1. NOTHING here may affect the launch, the fee leg or the durable launch
 *     records. A badge is cosmetic; a launch is real money. The failure
 *     contract is "log it and move on", and a function that also owned the
 *     identity write could not honestly promise that.
 *  2. It is a SIGNING SITE, and the signing-oracle guard
 *     (`__tests__/vex-agent/lint/signing-oracle-guard.test.ts`) requires every
 *     text-message signing site to be one named module, so a new one is a
 *     reviewed addition rather than a line that appeared inside an existing
 *     file. The message builder is the other half:
 *     `@tools/virtuals/launch/attest-message.js`.
 *
 * ## Why the signature is produced HERE and nowhere else
 *
 * The attested string names the TOKEN, and the token's address only exists once
 * the `preLaunch` receipt has been decoded - so it cannot be pre-signed. After
 * the launch handler returns, its wallet client is gone: the AgentScan attest
 * sweep and the keeper-launch sweep hold no signer, by construction and by
 * decree. So a signature not taken here can never be taken, and the row would
 * sit unattestable forever.
 *
 * `personal_sign` is a local operation, not a network round trip, and it moves
 * no funds and authorizes nothing on chain - it is a proof of authorship. That
 * is why taking it inside a launch the user already approved is not a second
 * money decision.
 *
 * A wallet that refuses to sign costs the agent its badge and nothing else.
 */

import { buildVirtualsAttestMessage } from "@tools/virtuals/launch/attest-message.js";
import { stampAgentscanAttestSignature } from "@vex-agent/db/repos/launched-tokens.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

/**
 * The ONE capability this leg needs from the launch's wallet client.
 *
 * A viem `WalletClient` satisfies it structurally, and a test can satisfy it
 * with a plain object instead of casting a partial fake to the full client
 * type. Accepting the whole client here would demand exactly such a cast at a
 * boundary that only ever signs one message.
 */
export interface VirtualsAttestSigner {
  signMessage(args: { message: string }): Promise<string>;
}

export interface VirtualsAttestOutcome {
  readonly signed: boolean;
  /** Plain language, agent-facing. Always states the launch is unaffected. */
  readonly note: string;
}

/**
 * Sign the AgentScan creator proof with the SAME wallet that signed the launch,
 * and store it on the launched-token row.
 *
 * NEVER THROWS. Every failure mode here is bookkeeping about a launch that
 * already happened, so each one is reported in the returned block and the
 * launch stands either way. `stampAgentscanAttestSignature` is write-once, so a
 * re-entry converges rather than replacing a stored proof.
 */
export async function signAndStoreVirtualsAttestation(input: {
  readonly signer: VirtualsAttestSigner;
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly launchpad: string;
}): Promise<VirtualsAttestOutcome> {
  let signature: string;
  try {
    signature = await input.signer.signMessage({
      message: buildVirtualsAttestMessage(input.chainId, input.tokenAddress),
    });
  } catch (err) {
    logger.warn("virtuals.launch.attest_sign_failed", {
      chainId: input.chainId,
      error: summarizeProtocolError(err).message,
    });
    return {
      signed: false,
      note:
        "The AgentScan creator proof could not be signed, so this launch will not carry a Vex badge. Nothing else is "
        + "affected - the agent is on chain and the launch is recorded. The proof cannot be produced later: only the "
        + "launching wallet can sign it, and only while this call holds it.",
    };
  }

  try {
    const stamped = await stampAgentscanAttestSignature({
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      launchpad: input.launchpad,
      attestSignature: signature,
    });
    return {
      signed: stamped,
      note: stamped
        ? "The AgentScan creator proof was signed and stored. Vex submits it in the background; the launch does not "
          + "wait for it."
        : "The AgentScan creator proof was signed but a proof was already stored for this agent, so it was kept. The "
          + "launch is unaffected.",
    };
  } catch (err) {
    logger.warn("virtuals.launch.attest_store_failed", {
      chainId: input.chainId,
      error: summarizeProtocolError(err).message,
    });
    return {
      signed: false,
      note:
        "The AgentScan creator proof was signed but could not be stored, so this launch may not carry a Vex badge. "
        + "The agent is on chain and the launch is recorded.",
    };
  }
}
