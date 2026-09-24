/**
 * Finish a Lighter key registration that is already on chain.
 *
 * `executeApprovedLighterKeyRegistration` submits the change-pub-key
 * transaction and then walks the registration to `active`. It cannot always
 * finish in one pass: the account's next nonce has to reach
 * `registrationNonce + 1` before the credential may be activated, and Lighter
 * publishes that a little after the transaction lands. The executor stops at
 * `key_verified_pending_nonce` when it gets there first.
 *
 * Nothing used to come back for it. No sweep covers key registration, and
 * `lighter.key.register.prepare` refuses every post-submission state by
 * design - re-registering a key that is already registered is exactly what it
 * exists to prevent. So a registration that lost that race stayed unfinished:
 * the local credential never activated, and the setup modal watched a flag
 * that nothing could ever set.
 *
 * This is the evidence-only half of the executor, reachable from the desk. It
 * reads the live slot and nonce and advances durable lifecycle state. It is
 * structurally unable to sign, submit or replace anything.
 */

import type { LighterIntegrationEnvironment } from "@shared/schemas/lighter-integration.js";
import type { LighterKeyRegistrationReconcile } from "@shared/schemas/lighter-trading.js";
import { buildLighterOnboardingReaders } from "@tools/lighter/wallet-funding/onboarding-readers.js";
import { findLiveLighterKeyRegistrationIntentForAccount } from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import { log } from "../logger/index.js";
import { reconcileLighterKeyRegistration } from "./key-registration-execution.js";
import { readSessionWalletFromEngine } from "./onboarding-checklist.js";

/** States a registration can still be carried forward from, without signing. */
const RECONCILABLE_STATES: ReadonlySet<string> = new Set([
  "key_registration_tx_staged",
  "change_pub_key_submitted",
  "key_verified",
  "nonce_synchronized",
  "ambiguous",
]);

/**
 * A STAGED registration was signed and may or may not have been sent. While its
 * signed transaction is still live, the executor that staged it may be about
 * to send it, and reconciling it then would race that send. Once the signed
 * expiry has passed the executor refuses to send it, so only then is it this
 * path's business: it either landed (the slot shows the key) or never will.
 * Before, nothing reconciled it at all, and a staged registration left by a
 * closed session held the wallet's onboarding forever.
 */
function stagedStillSendable(intent: { readonly executionState: string; readonly registrationTxExpiredAt: string | null }, nowMs: number): boolean {
  if (intent.executionState !== "key_registration_tx_staged") return false;
  const expiredAtMs = intent.registrationTxExpiredAt === null ? Number.NaN : Number(intent.registrationTxExpiredAt);
  return !Number.isSafeInteger(expiredAtMs) || nowMs <= expiredAtMs;
}

export async function reconcileSetupKeyRegistration(input: {
  readonly sessionId: string;
  readonly environment: LighterIntegrationEnvironment;
}): Promise<LighterKeyRegistrationReconcile> {
  const wallet = await readSessionWalletFromEngine(input.sessionId);
  const account = await buildLighterOnboardingReaders().readLighterAccount(
    input.environment,
    wallet.walletAddress,
  );
  if (account === null) return { attempted: false, status: null };

  const intent = await findLiveLighterKeyRegistrationIntentForAccount(
    input.environment,
    account.account_index,
  );
  // Nothing on chain to carry forward: a registration that has not been
  // submitted is the prepare path's business, not this one's.
  if (
    intent === null
    || !RECONCILABLE_STATES.has(intent.executionState)
    || stagedStillSendable(intent, Date.now())
  ) {
    return { attempted: false, status: null };
  }

  const result = await reconcileLighterKeyRegistration({
    sessionId: input.sessionId,
    intentId: intent.intentId,
    walletResolution: wallet.walletResolution,
    walletPolicy: wallet.walletPolicy,
  });
  log.info(
    `[lighter:key-registration-reconcile] ${result.status} `
      + `state=${result.executionState} environment=${input.environment}`,
  );
  return { attempted: true, status: result.status };
}
