/**
 * The FIRST user-originated Lighter signing path in the desktop app: confirm,
 * sign and submit one TxType 20 leverage change, then prove what happened.
 *
 * Every mechanism here is the fee-authorization template
 * (`fee-authorization-execution.ts`), because that is the only other
 * config-changing signed flow in this repository and its invariants were paid
 * for once already:
 *
 *  - the nonce reservation and the WIRE expiry commit in ONE transaction, so a
 *    crash between them is impossible and an interrupted attempt is strictly
 *    reconciliation-only;
 *  - the signed hash is persisted BEFORE any send can be attempted, including
 *    when consent expires during signing;
 *  - the send-admission latch is the last statement before `sendTx`, and there
 *    is exactly ONE `sendTx`;
 *  - anything other than `code === 200` with the matching hash is AMBIGUOUS,
 *    never "failed": bytes may have reached Lighter, so the nonce stays
 *    reserved until reconciliation proves the outcome;
 *  - the reservation is released only after PROVEN non-submission, or after the
 *    wire expiry plus a safety margin with the live next nonce still equal to
 *    the reserved one.
 *
 * WHAT THE PROOF IS. `getTx` on the signed hash, with the transaction identity
 * and every bound info field equal to what was signed. The account read is
 * taken afterwards and reported as the OBSERVED configuration; it is never the
 * proof, because the row can already match before signing, can be set by
 * another key after an ambiguous submission, and can be superseded later.
 *
 * The whole signing and submission window runs inside
 * `trackCriticalOp(CRITICAL_OP.lighterLeverageChange)`: a Settings action has no
 * agent activity and no approval row for the updater's safe-restart gate to
 * detect, so it registers itself.
 *
 * Nothing here logs a secret, signer stderr or a signed payload.
 */

import { getAddress } from "viem";
import {
  assertIntentAuthority,
  LighterIntentRefusal,
} from "@vex-agent/tools/protocols/lighter/intent-expiry.js";
import { lighterSignerRunExited } from "@tools/lighter/signer-binary-adapter.js";
import { getLighterClient, type LighterClient } from "@tools/lighter/client.js";
import {
  initialMarginFractionToLeverageDisplay,
  LIGHTER_MARGIN_MODE_WIRE,
} from "@tools/lighter/margin-fraction.js";
import type { LighterTxFromL1Response } from "@tools/lighter/types.js";
import * as intents from "@vex-agent/db/repos/lighter-leverage-intents.js";
import * as nonceState from "@vex-agent/db/repos/lighter-nonce-state.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { ErrorCodes, VexError } from "../../../../src/errors.js";
import type {
  ApplyLighterLeverageResult,
  ConfirmLighterLeverageInput,
  LighterLeverageOverview,
} from "@shared/schemas/lighter-trading-limits.js";
import { CRITICAL_OP, trackCriticalOp } from "../updates/critical-ops.js";
import {
  currentTerms,
  defaultLighterLeveragePreparationDeps,
  exactOwnedAccount,
  leverageRefusal,
  marketMinimum,
  positionSide,
  readLighterLeverageAccountSetup,
  readPerpMarketDetail,
  type LighterLeveragePreparationDeps,
} from "./leverage-preparation.js";
import { signConfirmedLighterLeverage } from "./leverage-signing.js";

type Intent = intents.LighterLeverageIntentRow;

/** How long the signed transaction may live on the wire. */
const SIGNED_TX_TTL_MS = 4 * 60_000;
/** Slack past the wire expiry before non-consumption is treated as proven. */
const EXPIRY_SAFETY_MS = 60_000;
/**
 * Provider statuses that PROVE a type-20 transaction executed.
 *
 * MEASURED LIVE on Robinhood Chain, 2026-09-10 (evidence
 * `agents_dm/lighter-live-evidence/leverage-BTC-2026-09-10T20-32-06-390Z/06-tx-proof.json`):
 * the BTC leverage change, hash `2ed160fc...19ee9d6`, came back from `getTx`
 * with `status: 2`, `block_height: 20413971`, `executed_at: 0`, `committed_at: 0`,
 * `verified_at: 0`, and the public account read ALREADY carried the new terms
 * (`initial_margin_fraction: "2.00"`, a fresh BTC row). So 2 is "executed in an
 * L2 block, not yet committed to L1", which is the operative truth for an
 * account setting; 3 is the later committed/verified status the Core withdrawal
 * proof waits for because money leaves the L2 there. Both prove execution here.
 */
const EXECUTED_TX_STATUSES: readonly number[] = [2, 3];

/**
 * Provider statuses that PROVE a terminal failure for TxType 20.
 *
 * DELIBERATELY EMPTY. The executed status is pinned by an existing proof
 * (`withdrawal/l2-proof.ts`), but the failure statuses for a type-20
 * transaction have not been measured against the live provider, and inventing a
 * wire value from convention is exactly what rule 10 forbids. Until the first
 * live run pins them, an unproven outcome stays pending and reconcilable rather
 * than being reported as a rejection Vex cannot substantiate. The raw status
 * travels out in the result so that run can correct this constant.
 */
export const LIGHTER_LEVERAGE_FAILED_TX_STATUSES: readonly number[] = [];

export interface LighterLeverageExecutionDeps {
  readonly client: Pick<LighterClient, "getNextNonce" | "sendTx" | "getTx" | "getAccount">;
  readonly preparation: LighterLeveragePreparationDeps;
  readonly readIntent: typeof intents.find;
  readonly readSetup: typeof readLighterLeverageAccountSetup;
  readonly readMarket: typeof readPerpMarketDetail;
  readonly markExpired: typeof intents.markExpired;
  readonly markRefused: typeof intents.markRefusedUnsubmitted;
  readonly markSigned: typeof intents.markSigned;
  readonly markSubmissionStaged: typeof intents.markSubmissionStaged;
  readonly admitSend: typeof intents.markSendAttemptStarted;
  readonly markSubmitted: typeof intents.markSubmitted;
  readonly markCompleted: typeof intents.markCompleted;
  readonly markAmbiguous: typeof intents.markAmbiguous;
  readonly markRejected: typeof intents.markRejected;
  readonly markExpiredUnsubmitted: typeof intents.markExpiredUnsubmitted;
  readonly reserveSigning: typeof reserveSigning;
  readonly recordNonce: typeof nonceState.recordExecutionObserved;
  readonly releaseNonce: typeof nonceState.releaseReservation;
  readonly releaseUnsubmittedNonce: typeof nonceState.releaseUnsubmittedReservation;
  readonly sign: typeof signConfirmedLighterLeverage;
  readonly track: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly failedTxStatuses: readonly number[];
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly attempts: number;
}

export function defaultLighterLeverageExecutionDeps(): LighterLeverageExecutionDeps {
  return {
    client: getLighterClient(),
    preparation: defaultLighterLeveragePreparationDeps(),
    readIntent: intents.find,
    readSetup: readLighterLeverageAccountSetup,
    readMarket: readPerpMarketDetail,
    markExpired: intents.markExpired,
    markRefused: intents.markRefusedUnsubmitted,
    markSigned: intents.markSigned,
    markSubmissionStaged: intents.markSubmissionStaged,
    admitSend: intents.markSendAttemptStarted,
    markSubmitted: intents.markSubmitted,
    markCompleted: intents.markCompleted,
    markAmbiguous: intents.markAmbiguous,
    markRejected: intents.markRejected,
    markExpiredUnsubmitted: intents.markExpiredUnsubmitted,
    reserveSigning,
    recordNonce: nonceState.recordExecutionObserved,
    releaseNonce: nonceState.releaseReservation,
    releaseUnsubmittedNonce: nonceState.releaseUnsubmittedReservation,
    sign: signConfirmedLighterLeverage,
    track: (fn) => trackCriticalOp(CRITICAL_OP.lighterLeverageChange, fn)(),
    failedTxStatuses: LIGHTER_LEVERAGE_FAILED_TX_STATUSES,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    attempts: 5,
  };
}

export function lighterLeverageReservationId(intentId: string): string {
  return `lighter-leverage:${intentId}`;
}

/**
 * Record the CONSENT and its revalidation, reserve the shared nonce and enter
 * `signing`, in ONE transaction, with the wire expiry persisted alongside.
 *
 * All four commit together because the table refuses a consented `proposed`
 * row: consent is what Confirm produced, and the reservation is the single step
 * that moves the intent into the signing lifecycle. Fails closed while another
 * Lighter transaction owns this account's next nonce: an agent order settling
 * is named as such, so the person reads a situation instead of an error.
 */
export async function reserveSigning(
  intent: Intent,
  txExpiryMs: number,
  revalidation: Record<string, unknown>,
): Promise<Intent> {
  return withTransaction(async (client) => {
    const reservationId = lighterLeverageReservationId(intent.intentId);
    const nonce = await nonceState.reserveObservedWith(client, {
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
      reservationId,
    });
    if (
      !nonce
      || nonce.status !== "reserved"
      || nonce.reservedNonce === null
      || nonce.reservationId !== reservationId
    ) {
      throw leverageRefusal(
        "Another Lighter transaction owns this account's next nonce; an order is settling.",
        "Try the leverage change again once that order has settled.",
      );
    }
    const updated = await intents.reserveSigningWith(client, {
      intentId: intent.intentId,
      nonceValue: nonce.reservedNonce,
      txExpiryMs,
      revalidation,
    });
    if (!updated) {
      throw leverageRefusal(
        "The confirmation window for this leverage change closed before it could be reserved.",
        "Start the change again to review the current terms.",
      );
    }
    return updated;
  });
}

/**
 * Confirm one main-issued proposal. Repeated Confirm on a proposal that already
 * entered the signing lifecycle RECONCILES the same intent; it never signs a
 * second time.
 */
export async function confirmLighterLeverage(
  input: ConfirmLighterLeverageInput,
  signal?: AbortSignal,
  deps: LighterLeverageExecutionDeps = defaultLighterLeverageExecutionDeps(),
): Promise<ApplyLighterLeverageResult> {
  if (!admissionOpen) {
    throw leverageRefusal(
      "Vex is shutting down, so no new Lighter transaction is being started.",
    );
  }
  const intent = await requireIntent(input.proposalId, deps);
  if (intent.executionState !== "proposed") {
    return reconcileLighterLeverage(input, deps);
  }
  if (deps.now() >= intent.expiresAt.getTime()) {
    const expired = await deps.markExpired(intent.intentId);
    return expiredResult(expired ?? intent);
  }

  // REVALIDATION. Every consent invariant of the proposal is re-read against
  // live state before anything is reserved or signed. The consent itself is
  // recorded with the reservation, in one transaction: see `reserveSigning`.
  let revalidation: Record<string, unknown>;
  try {
    revalidation = await revalidateConsent(intent, deps);
  } catch (error) {
    const reason = refusalMessage(error);
    const refused = await deps.markRefused({
      intentId: intent.intentId,
      failureReason: "consent_invariant_drift",
    });
    return { status: "refused", intentId: (refused ?? intent).intentId, reason };
  }

  return deps.track(() => runSigningWindow(intent, revalidation, input, signal, deps));
}

async function runSigningWindow(
  start: Intent,
  revalidation: Record<string, unknown>,
  input: ConfirmLighterLeverageInput,
  signal: AbortSignal | undefined,
  deps: LighterLeverageExecutionDeps,
): Promise<ApplyLighterLeverageResult> {
  let intent = start;
  const assertAuthority = (phase: Parameters<typeof assertIntentAuthority>[2]): void =>
    assertIntentAuthority(intent.expiresAt, deps.now(), phase, signal);
  let signingStarted = false;
  let signerExited = false;
  let sendAdmissionStarted = false;
  let signedHash: string | null = null;
  try {
    assertAuthority("before_reservation");
    const next = await deps.client.getNextNonce(intent.environment, {
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
    });
    if (
      next.code !== 200
      || !Number.isSafeInteger(next.nonce)
      || next.nonce < 0
      || next.nonce >= 2 ** 48
    ) {
      throw leverageRefusal("The Lighter transaction nonce could not be verified.");
    }
    const observedNonce = await deps.recordNonce({
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
      nonce: next.nonce,
      publicKey: intent.observedBefore.publicKey,
    });
    if (!observedNonce) {
      throw leverageRefusal(
        "A previous Lighter transaction on this account is unresolved; an order may be settling.",
        "Reconcile it, or try again once it has settled.",
      );
    }
    assertAuthority("before_reservation");
    intent = await deps.reserveSigning(intent, deps.now() + SIGNED_TX_TTL_MS, revalidation);
    assertAuthority("after_reservation");

    assertAuthority("before_signing");
    signingStarted = true;
    const signed = await deps.sign({ intent });
    signerExited = lighterSignerRunExited({ kind: "resolved" });
    signedHash = normalizeHash(signed.txHash);
    // The hash is recorded independently of send admission, so a consent
    // expiry during signing still leaves provable evidence of what exists. A
    // refused transition here means the row is not where this code believes it
    // is, and nothing may be sent on that belief.
    intent = applied(
      await deps.markSigned({ intentId: intent.intentId, signerTxHash: signedHash }),
      "signed",
    );
    assertAuthority("after_signing");
    intent = applied(await deps.markSubmissionStaged(intent.intentId), "submission_staged");

    assertAuthority("before_submission");
    if (intent.txExpiryMs === null || deps.now() >= intent.txExpiryMs) {
      throw leverageRefusal("The signed leverage transaction expired before it was sent.");
    }
    sendAdmissionStarted = true;
    if (!(await deps.admitSend({ intentId: intent.intentId, signerTxHash: signedHash }))) {
      // The latch carries the consent-expiry predicate, so a refusal here also
      // covers "the confirmation expired while admission was in flight".
      sendAdmissionStarted = false;
      throw new LighterIntentRefusal("submission_admission_refused");
    }
    // THE LAST AUTHORITY GATE. Admission is a round trip, and consent can
    // expire or the person can cancel while it is in flight; the check above
    // read a clock from before it. There is no await between here and `sendTx`,
    // so this is the final moment at which submission can still be prevented.
    assertAuthority("before_submission");
    try {
      const response = await deps.client.sendTx(intent.environment, {
        txType: signed.txType,
        txInfo: signed.txInfo,
      });
      if (response.code === 200 && normalizeHash(response.tx_hash ?? "") === signedHash) {
        const submitted = await deps.markSubmitted({
          intentId: intent.intentId,
          providerOutcome: { code: response.code, txHash: signedHash },
        });
        if (submitted === null) return unresolvedResult(intent, "submitted");
        intent = submitted;
      } else {
        const unconfirmed = await deps.markAmbiguous({
          intentId: intent.intentId,
          failureReason: "submission_response_unconfirmed",
          providerOutcome: { code: response.code },
        });
        if (unconfirmed === null) return unresolvedResult(intent, "ambiguous");
        intent = unconfirmed;
      }
    } catch {
      // A transport failure is not a refusal: the bytes may have landed.
      const unknown = await deps.markAmbiguous({
        intentId: intent.intentId,
        failureReason: "submission_outcome_unknown",
      });
      if (unknown === null) return unresolvedResult(intent, "ambiguous");
      intent = unknown;
    }
    return reconcileLighterLeverage(input, deps);
  } catch (error) {
    signerExited ||= lighterSignerRunExited({ kind: "rejected", error });
    const reason =
      error instanceof LighterIntentRefusal ? error.reason : "leverage_execution_interrupted";
    const message = refusalMessage(error);

    if (intent.nonceValue === null) {
      // Nothing was reserved and nothing was signed. Consent is still recorded:
      // the person pressed Confirm and the refusal came after.
      const refused = await deps.markRefused({
        intentId: intent.intentId,
        failureReason: reason,
      });
      if (refused === null) return unresolvedResult(intent, "refused_unsubmitted");
      return { status: "refused", intentId: refused.intentId, reason: message };
    }
    const provenUnsent =
      !sendAdmissionStarted
      && (!signingStarted
        || (signerExited && (error instanceof LighterIntentRefusal || signedHash === null)));
    if (provenUnsent) {
      // A signature that exists but was never sent keeps its identity in
      // `expired_unsubmitted`. An attempt that never produced one has no
      // identity to keep and is `refused_unsubmitted`; the two states say
      // different true things, and `ambiguous` would say a false one, since it
      // claims a transaction with a known hash may exist.
      const closed = signedHash === null
        ? await deps.markRefused({ intentId: intent.intentId, failureReason: reason })
        : await deps.markExpiredUnsubmitted({ intentId: intent.intentId, failureReason: reason });
      if (closed === null) return unresolvedResult(intent, "unsubmitted");
      await deps.releaseUnsubmittedNonce({
        environment: intent.environment,
        accountIndex: intent.accountIndex,
        apiKeyIndex: intent.apiKeyIndex,
        reservationId: lighterLeverageReservationId(intent.intentId),
        nonceValue: intent.nonceValue,
      });
      return {
        status: "refused",
        intentId: closed.intentId,
        reason: `${message} Nothing was submitted to Lighter.`,
      };
    }
    const ambiguous = await deps.markAmbiguous({
      intentId: intent.intentId,
      failureReason: reason,
    });
    if (ambiguous === null) return unresolvedResult(intent, "ambiguous");
    return ambiguousResult(ambiguous);
  }
}

/**
 * A guarded transition that DID NOT APPLY. The row did not move, so the state
 * this code path believes it is in is not the state on disk. Reporting the
 * outcome it hoped for would be reporting a write that never happened, which is
 * how a `submission_staged` row once came back as `completed`.
 */
class LighterLeverageTransitionRefused extends Error {
  constructor(readonly transitionName: string) {
    super(`The leverage intent could not move to ${transitionName}.`);
  }
}

function applied(row: Intent | null, transitionName: string): Intent {
  if (row === null) throw new LighterLeverageTransitionRefused(transitionName);
  return row;
}

/**
 * The outcome is NOT resolved and Vex says so, naming the transition that did
 * not apply. Never `completed`: nothing here proves what Lighter did.
 */
function unresolvedResult(intent: Intent, transitionName: string): ApplyLighterLeverageResult {
  return {
    status: "ambiguous",
    intentId: intent.intentId,
    reason:
      `Vex could not record this leverage change as ${transitionName}; its stored status moved`
      + " under this attempt. Nothing was sent again. Use Reconcile to check what Lighter did.",
  };
}

/**
 * Recover from EVERY state after the reservation without ever signing again.
 *
 * The reservation is released only after PROVEN non-submission, or after the
 * wire expiry plus the safety margin with the live next nonce still equal to
 * the reserved one.
 */
export async function reconcileLighterLeverage(
  input: ConfirmLighterLeverageInput,
  deps: LighterLeverageExecutionDeps = defaultLighterLeverageExecutionDeps(),
): Promise<ApplyLighterLeverageResult> {
  let intent = await requireIntent(input.proposalId, deps);
  if (intent.executionState === "proposed") {
    if (deps.now() >= intent.expiresAt.getTime()) {
      return expiredResult((await deps.markExpired(intent.intentId)) ?? intent);
    }
    return {
      status: "refused",
      intentId: intent.intentId,
      reason: "This leverage change has not been confirmed yet; nothing was submitted.",
    };
  }
  if (intent.executionState === "expired") return expiredResult(intent);
  if (intent.executionState === "refused_unsubmitted" || intent.executionState === "expired_unsubmitted") {
    return {
      status: "refused",
      intentId: intent.intentId,
      reason: "This leverage change was not submitted to Lighter; nothing was applied.",
    };
  }
  if (intent.executionState === "rejected") {
    return rejectedResult(intent, providerStatusOf(intent));
  }
  if (intent.executionState === "completed") {
    return completedResult(intent, await observe(intent, deps));
  }

  for (let attempt = 0; attempt < deps.attempts; attempt += 1) {
    const evidence = intent.signerTxHash === null ? null : await proveOrNull(intent, deps);
    if (evidence !== null) {
      if (evidence.executed) {
        const completed = await deps.markCompleted({
          intentId: intent.intentId,
          providerOutcome: { status: evidence.status, hash: evidence.hash },
        });
        if (completed === null) return unresolvedResult(intent, "completed");
        intent = completed;
        await freeNonceAfterExecution(intent, deps);
        return completedResult(intent, await observe(intent, deps));
      }
      if (deps.failedTxStatuses.includes(evidence.status)) {
        const rejected = await deps.markRejected({
          intentId: intent.intentId,
          failureReason: "provider_reported_failed_status",
          providerOutcome: { status: evidence.status, hash: evidence.hash },
        });
        if (rejected === null) return unresolvedResult(intent, "rejected");
        intent = rejected;
        await freeNonceAfterExecution(intent, deps);
        return rejectedResult(intent, evidence.status);
      }
      // A status Vex cannot substantiate as either outcome: still pending.
    }

    const settled = await settleAfterExpiry(intent, deps);
    if (settled !== null) return settled;
    if (attempt + 1 < deps.attempts) await deps.sleep(750);
  }
  return ambiguousResult(intent);
}

/**
 * The expiry recovery. Only two things prove an outcome once the wire expiry
 * plus the safety margin has passed: the live next nonce still equal to the
 * reserved one (nothing consumed it), or a nonce that moved past it with no
 * executed proof (something else consumed it, and this change did not land).
 */
async function settleAfterExpiry(
  intent: Intent,
  deps: LighterLeverageExecutionDeps,
): Promise<ApplyLighterLeverageResult | null> {
  if (
    intent.nonceValue === null
    || intent.txExpiryMs === null
    || deps.now() <= intent.txExpiryMs + EXPIRY_SAFETY_MS
  ) {
    return null;
  }
  const next = await deps.client.getNextNonce(intent.environment, {
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
  });
  if (next.code !== 200 || !Number.isSafeInteger(next.nonce)) return null;

  if (String(next.nonce) === intent.nonceValue) {
    // PROVEN non-consumption: the reserved nonce is still the provider's next.
    if (intent.sendAttemptStartedAt === null) {
      // A signature that exists keeps its identity; an attempt that never
      // produced one has none to keep. Both are terminal-unsubmitted, and both
      // release the reservation, because no send was ever attempted.
      const closed = intent.signerTxHash === null
        ? await deps.markRefused({
            intentId: intent.intentId,
            failureReason: "expired_without_signature",
          })
        : await deps.markExpiredUnsubmitted({
            intentId: intent.intentId,
            failureReason: "expired_without_nonce_consumption",
          });
      if (closed === null) return unresolvedResult(intent, "unsubmitted");
      await deps.releaseUnsubmittedNonce({
        environment: intent.environment,
        accountIndex: intent.accountIndex,
        apiKeyIndex: intent.apiKeyIndex,
        reservationId: lighterLeverageReservationId(intent.intentId),
        nonceValue: intent.nonceValue,
      });
      return {
        status: "refused",
        intentId: closed.intentId,
        reason: "The signed leverage change expired before it was sent. Nothing was applied.",
      };
    }
    // A send attempt was started, but the wire expiry plus the safety margin
    // passed and the reserved nonce is STILL the provider's next: no
    // transaction carrying that nonce can execute any more. That is proof of
    // non-execution, not an assumption, which is why this is the one rejection
    // that carries no provider status.
    await deps.releaseNonce({
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
      reservationId: lighterLeverageReservationId(intent.intentId),
      providerNonce: next.nonce,
    });
    const rejected = await deps.markRejected({
      intentId: intent.intentId,
      failureReason: "expired_without_nonce_consumption",
      providerOutcome: { nextNonce: next.nonce },
    });
    if (rejected === null) return unresolvedResult(intent, "rejected");
    return rejectedResult(rejected, null);
  }

  if (BigInt(next.nonce) > BigInt(intent.nonceValue)) {
    const evidence = intent.signerTxHash === null ? null : await proveOrNull(intent, deps);
    if (evidence?.executed === true) {
      const completed = await deps.markCompleted({
        intentId: intent.intentId,
        providerOutcome: { status: evidence.status, hash: evidence.hash },
      });
      if (completed === null) return unresolvedResult(intent, "completed");
      await freeNonceAfterExecution(completed, deps);
      return completedResult(completed, await observe(completed, deps));
    }
    // THE NONCE MOVED AND THERE IS NO EXACT PROOF. Something consumed the
    // reserved nonce, which frees this account's nonce OWNERSHIP so other
    // Lighter work is not blocked behind it. It proves nothing at all about
    // this transaction: it may have executed, it may have been replaced by
    // another transaction with the same nonce, and Lighter's record may simply
    // not be visible yet. Calling that "rejected" would tell the person their
    // leverage is unchanged and invite a second change, which could be false.
    // The intent stays unresolved and reconcilable, the way the provider's own
    // margin example reports a timeout rather than inventing an outcome.
    await freeNonceAfterExecution(intent, deps);
    const unresolved = await deps.markAmbiguous({
      intentId: intent.intentId,
      failureReason: "not_confirmed_after_expiry",
      providerOutcome: { nextNonce: next.nonce, ...(evidence ? { status: evidence.status } : {}) },
    });
    if (unresolved === null) return unresolvedResult(intent, "ambiguous");
    return {
      status: "ambiguous",
      intentId: unresolved.intentId,
      reason:
        "Another Lighter transaction used this account's reserved slot and Vex has no record"
        + " proving what happened to this leverage change. It was not sent again. Check the"
        + " market's leverage on Lighter, and use Reconcile if a record appears.",
    };
  }
  return null;
}

async function freeNonceAfterExecution(
  intent: Intent,
  deps: LighterLeverageExecutionDeps,
): Promise<void> {
  const next = await deps.client.getNextNonce(intent.environment, {
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
  });
  if (next.code !== 200 || !Number.isSafeInteger(next.nonce)) return;
  await deps.recordNonce({
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    nonce: next.nonce,
    publicKey: intent.observedBefore.publicKey,
  });
}

async function proveOrNull(
  intent: Intent,
  deps: LighterLeverageExecutionDeps,
): Promise<LighterUpdateLeverageEvidence | null> {
  try {
    const tx = await deps.client.getTx(intent.environment, {
      by: "hash",
      value: intent.signerTxHash!,
    });
    return proveLighterUpdateLeverageTransaction({ tx, intent });
  } catch {
    // "Not visible yet" and "does not match" are both "no proof today".
    return null;
  }
}

/**
 * The account read taken AFTER the proof, reported as the observed
 * configuration. A later supersession by the user or another key shows up here
 * as what Lighter now says, and is never written back over the proven outcome.
 */
type ObservedLeverage = LighterLeverageOverview["markets"][number]["current"];

/**
 * NULL WHEN THE READ FAILED, never a thrown error. The proof already
 * established what Lighter did with the transaction; an account read that
 * cannot be taken afterwards is a missing observation, not a reason to
 * withdraw a proven outcome or to tell the person nothing was changed.
 */
async function observe(
  intent: Intent,
  deps: LighterLeverageExecutionDeps,
): Promise<ObservedLeverage | null> {
  try {
    const response = await deps.client.getAccount(
      intent.environment,
      { by: "index", value: intent.accountIndex, activeOnly: false },
      { fresh: true },
    );
    const account = exactOwnedAccount(response, intent.accountIndex, intent.walletAddress);
    const detail = await deps.readMarket(intent.environment, intent.marketIndex, deps.preparation);
    const position =
      (Array.isArray(account.positions) ? account.positions : []).find(
        (row) => row.market_id === intent.marketIndex,
      ) ?? null;
    return currentTerms(position, detail);
  } catch {
    return null;
  }
}

export interface LighterUpdateLeverageEvidence {
  readonly hash: string;
  readonly status: number;
  readonly executed: boolean;
  readonly marketIndex: number;
  readonly initialMarginFraction: number;
  readonly marginMode: 0 | 1;
  readonly nonce: string;
  readonly expiredAt: string;
}

/**
 * Exact transaction evidence for one signed leverage change, mirroring
 * `proveLighterCoreWithdrawalL2Transaction`: identity first, then equality of
 * every bound info field, then the executed status.
 *
 * Throws on any mismatch. A caller must never read a throw as "not executed":
 * it means "this is not proof", which is a different thing.
 */
export function proveLighterUpdateLeverageTransaction(input: {
  readonly tx: LighterTxFromL1Response;
  readonly intent: Intent;
}): LighterUpdateLeverageEvidence {
  const { tx, intent } = input;
  if (intent.signerTxHash === null || intent.nonceValue === null || intent.txExpiryMs === null) {
    throw invalidEvidence("This leverage change has no signed identity to prove.");
  }
  if (
    tx.code !== 200
    || normalizeHash(tx.hash) !== intent.signerTxHash
    || tx.type !== 20
    || tx.account_index !== intent.accountIndex
    || tx.api_key_index !== intent.apiKeyIndex
    || String(tx.nonce) !== intent.nonceValue
  ) {
    throw invalidEvidence(
      "Lighter's transaction record does not match the submitted leverage change.",
    );
  }
  const info = exactIntegerFields(tx.info, [
    "AccountIndex",
    "ApiKeyIndex",
    "MarketIndex",
    "InitialMarginFraction",
    "MarginMode",
    "Nonce",
    "ExpiredAt",
  ]);
  if (
    info.AccountIndex !== String(intent.accountIndex)
    || info.ApiKeyIndex !== String(intent.apiKeyIndex)
    || info.MarketIndex !== String(intent.marketIndex)
    || info.InitialMarginFraction !== String(intent.requestedInitialMarginFraction)
    || info.MarginMode !== String(intent.requestedMarginMode)
    || info.Nonce !== intent.nonceValue
    || info.ExpiredAt !== String(tx.expire_at)
    || tx.expire_at !== intent.txExpiryMs
  ) {
    throw invalidEvidence(
      "Lighter's transaction record does not preserve the confirmed leverage fields.",
    );
  }
  if (!Number.isInteger(tx.status) || tx.status < 0) {
    throw invalidEvidence("Lighter returned an invalid leverage transaction status.");
  }
  return {
    hash: intent.signerTxHash,
    status: tx.status,
    executed: EXECUTED_TX_STATUSES.includes(tx.status),
    marketIndex: intent.marketIndex,
    initialMarginFraction: intent.requestedInitialMarginFraction,
    marginMode: intent.requestedMarginMode,
    nonce: intent.nonceValue,
    expiredAt: String(tx.expire_at),
  };
}

/**
 * Re-read every consent invariant against live state. Ownership and key
 * identity come from the same two-part check preparation used; the terms the
 * human saw must be unchanged, and the target must still clear the market's
 * live minimum.
 */
async function revalidateConsent(
  intent: Intent,
  deps: LighterLeverageExecutionDeps,
): Promise<Record<string, unknown>> {
  const setup = await deps.readSetup(
    { environment: intent.environment, walletAddress: intent.walletAddress },
    deps.preparation,
  );
  if (
    setup.accountIndex !== intent.accountIndex
    || setup.apiKeyIndex !== intent.apiKeyIndex
    || setup.publicKey !== intent.observedBefore.publicKey
    || getAddress(setup.walletAddress) !== getAddress(intent.walletAddress)
  ) {
    throw leverageRefusal(
      "The Lighter account or trading key for this wallet changed after you confirmed.",
      "Start the leverage change again so you can review the current terms.",
    );
  }
  const detail = await deps.readMarket(intent.environment, intent.marketIndex, deps.preparation);
  const minFraction = marketMinimum(detail);
  if (intent.requestedInitialMarginFraction < minFraction) {
    throw leverageRefusal(
      `${detail.symbol} now allows at most ${initialMarginFractionToLeverageDisplay(minFraction)}x leverage on Lighter.`,
      "Start the change again and choose a leverage at or below that maximum.",
    );
  }
  const position =
    (Array.isArray(setup.account.positions) ? setup.account.positions : []).find(
      (row) => row.market_id === intent.marketIndex,
    ) ?? null;
  const current = currentTerms(position, detail);
  const before = intent.observedBefore;
  if (
    current.initialMarginFraction !== before.currentInitialMarginFraction
    || LIGHTER_MARGIN_MODE_WIRE[current.marginMode] !== before.currentMarginMode
    || current.source !== before.currentSource
  ) {
    throw leverageRefusal(
      `The leverage on ${detail.symbol} changed after you confirmed, so the terms you saw no longer apply.`,
      "Start the change again to review the current terms.",
    );
  }
  if (
    (position?.position ?? "0") !== before.openPositionSize
    || positionSide(position) !== before.openPositionSide
  ) {
    throw leverageRefusal(
      `Your ${detail.symbol} position changed after you confirmed, so the exposure you saw no longer applies.`,
      "Start the change again to review the current position.",
    );
  }
  return {
    symbol: detail.symbol,
    marketMinInitialMarginFraction: minFraction,
    currentInitialMarginFraction: current.initialMarginFraction,
    currentMarginMode: LIGHTER_MARGIN_MODE_WIRE[current.marginMode],
    openPositionSize: position?.position ?? "0",
    openPositionSide: positionSide(position),
    revalidatedAtMs: deps.now(),
  };
}

async function requireIntent(
  proposalId: string,
  deps: LighterLeverageExecutionDeps,
): Promise<Intent> {
  const intent = await deps.readIntent(proposalId);
  if (!intent) {
    throw leverageRefusal(
      "That leverage change is not on record. Start it again from Settings.",
    );
  }
  return intent;
}

function expiredResult(intent: Intent): ApplyLighterLeverageResult {
  return {
    status: "expired",
    intentId: intent.intentId,
    reason:
      "The confirmation window closed before this change was confirmed. Nothing was signed or submitted.",
  };
}

/**
 * PROVEN EXECUTED. The observation is what Lighter's account read said
 * afterwards; when that read could not be taken the outcome still stands and
 * the note says what is missing, because the transaction proof is the authority
 * here and the account read never was.
 */
function completedResult(
  intent: Intent,
  observed: ObservedLeverage | null,
): ApplyLighterLeverageResult {
  return {
    status: "completed",
    intentId: intent.intentId,
    observed,
    ...(observed === null
      ? {
          note:
            "Lighter executed this change. Vex could not read the account afterwards to show"
            + " the new leverage; reopen this card to read it again.",
        }
      : {}),
  };
}

function ambiguousResult(intent: Intent): ApplyLighterLeverageResult {
  return {
    status: "ambiguous",
    intentId: intent.intentId,
    reason:
      "Vex could not confirm what Lighter did with this change. It was not sent again. Use Reconcile to check its outcome.",
  };
}

function rejectedResult(intent: Intent, providerStatus: number | null): ApplyLighterLeverageResult {
  return {
    status: "rejected",
    intentId: intent.intentId,
    providerStatus,
    reason:
      "Lighter did not execute this leverage change. Your leverage is unchanged; start a new change to try again.",
  };
}

function providerStatusOf(intent: Intent): number | null {
  const status = intent.providerOutcome?.status;
  return typeof status === "number" ? status : null;
}

function refusalMessage(error: unknown): string {
  // Only Vex's own refusal text reaches the user: a provider or signer message
  // could carry payload fragments this surface must never render.
  if (error instanceof LighterIntentRefusal) {
    return "The confirmation expired or was cancelled before Vex could continue. Nothing further was attempted.";
  }
  if (error instanceof VexError && error.code === ErrorCodes.LIGHTER_LEVERAGE_REFUSED) {
    return error.message;
  }
  return "Vex could not complete this leverage change. Nothing further was attempted.";
}

function normalizeHash(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, "");
}

/**
 * Exactly one integer occurrence per field in the raw JSON, mirroring the
 * withdrawal proof: a duplicated or shadowed key in provider text can never be
 * read as agreement.
 */
function exactIntegerFields(
  rawJson: string,
  keys: readonly string[],
): Record<string, string> {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
  } catch {
    throw invalidEvidence("Lighter transaction info is not valid JSON.");
  }
  const result: Record<string, string> = {};
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = [...rawJson.matchAll(new RegExp(`"${escaped}"\\s*:\\s*(\\d+)`, "g"))];
    if (matches.length !== 1 || matches[0]?.[1] === undefined) {
      throw invalidEvidence(
        `Lighter transaction info does not contain exactly one integer ${key} field.`,
      );
    }
    result[key] = BigInt(matches[0][1]).toString(10);
  }
  return result;
}

function invalidEvidence(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Keep the leverage change unresolved and reconcile exact provider evidence before any retry.",
  );
}

/**
 * Admission for new leverage confirmations. Quit CLOSES admission so a confirm
 * that races teardown is refused before it can reserve a nonce; work already
 * inside the signing window keeps running and is what the updater's
 * safe-restart gate sees through `trackCriticalOp`.
 */
let admissionOpen = false;

export function installLighterLeverageService(): () => void {
  admissionOpen = true;
  return () => {
    admissionOpen = false;
  };
}

/** Test-only: read the admission latch. */
export function __lighterLeverageAdmissionOpenForTests(): boolean {
  return admissionOpen;
}
