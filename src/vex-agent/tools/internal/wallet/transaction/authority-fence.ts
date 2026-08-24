/**
 * THE AUTHORITY FENCE - the check that the authority a signature would be made
 * under is still the authority that was granted, re-asked at every point where
 * losing it would matter.
 *
 * ## The defect this exists for
 *
 * `gateConfirm` proves the selected wallet is the approved wallet ONCE. The
 * claim, the remote preparation, the signature and the submission then all run
 * against that decision. Between the proof and the signature the user can edit
 * the project's wallet scope, or lock Vex - and neither of those could stop
 * wallet A from signing after the project had already moved to B.
 *
 * ## What it re-reads, and why those two facts
 *
 * Under the SESSION CONTROL LOCK, in one transaction:
 *
 *   1. the AUTHORITATIVE wallet selection on the session row. `updateProjectScope`
 *      mirrors a Studio project's selection onto its backing session inside a
 *      transaction that takes this same lock first, so a scope edit is either
 *      wholly visible to this read or wholly after it;
 *   2. the durable STUDIO DISPATCH GENERATION (migration 086), which both
 *      `lockSecretSession` and its unlock advance. A generation that moved since
 *      the anchor means Vex was locked or unlocked in between.
 *
 * Plus the DISPATCH PREFLIGHT, which is the one gap the durable generation
 * cannot cover: when the lock's advance itself failed (the database was down),
 * the row still holds the old generation and only the main process knows.
 *
 * This does NOT invent a fence. It is the A3 Studio fence and the A3 lock, read
 * from a third caller.
 *
 * ## SEAM A - the ordering contract (verbatim; tests assert exactly this)
 *
 *   - A lock that wins before the pre-sign fence prevents key loading and
 *     signing.
 *   - Once key loading and signing have begun, a lock cannot retroactively
 *     cancel the local signature.
 *   - The post-stage fence immediately before submission prevents broadcast when
 *     lock or scope revocation wins before submission.
 *   - A submission already invoked won the ordering: the outcome is ambiguous or
 *     chain-observed, never guessed.
 *   - `clearKeystorePasswordProvider` is defense in depth for FUTURE loads, not
 *     revocation of a materialized key.
 *
 * ## Where it is asked
 *
 *   (a) INSIDE the T2 claim transaction, before the claim CAS - so a lock or a
 *       scope edit that won before the claim leaves the intent `pending`, with
 *       nothing claimed and nothing decrypted;
 *   (b) IMMEDIATELY BEFORE SIGNING, after every awaited preparation call, so the
 *       window between the last remote round trip and the signature is as short
 *       as the design allows;
 *   (c) AFTER STAGING AND IMMEDIATELY BEFORE SUBMISSION, so a lock that arrives
 *       while the durable evidence is being written still stops the broadcast.
 *
 * The fence NEVER runs while holding key material longer than it must, and it is
 * DB-only: it takes the session control lock and releases it, exactly as every
 * other holder does.
 */

import type { PoolClient } from "pg";

import type { WalletTransactionFamily } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import { readSessionWalletAuthorityWith } from "@vex-agent/db/repos/sessions.js";
import { readStudioDispatchGenerationWith } from "@vex-agent/db/repos/studio-runtime-gate.js";
import { walletAddressesEqual } from "@tools/wallet/inventory.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { studioDispatchPreflightAllows } from "@vex-agent/engine/core/approval-runtime/studio/dispatch-gate.js";
import logger from "@utils/logger.js";

import { refuse, type TransactionOutcome } from "./refusal.js";

/** Where the fence was asked. Structural, and the only thing a log line names. */
export type AuthorityFencePoint = "claim" | "pre_sign" | "pre_submit";

/**
 * The authority as it stood when this dispatch was authorized. Captured ONCE,
 * before any key material is loaded, and compared at every later point.
 */
export interface AuthorityAnchor {
  readonly sessionId: string;
  readonly family: WalletTransactionFamily;
  /** The wallet the intent was prepared for and the session had selected. */
  readonly walletAddress: string;
  /** `null` when the gate row could not be read; a null anchor fails closed. */
  readonly dispatchGeneration: string | null;
  readonly intentId: string;
}

/** What the authority says right now. */
interface CurrentAuthority {
  readonly walletAddress: string | null;
  readonly dispatchGeneration: string | null;
}

async function readAuthorityWith(
  client: PoolClient,
  sessionId: string,
  family: WalletTransactionFamily,
): Promise<CurrentAuthority> {
  const session = await readSessionWalletAuthorityWith(client, sessionId);
  const generation = await readStudioDispatchGenerationWith(client);
  const walletAddress =
    session === null
      ? null
      : family === "solana"
        ? session.selectedSolanaWalletAddress
        : session.selectedEvmWalletAddress;
  return { walletAddress, dispatchGeneration: generation };
}

/**
 * Capture the anchor. Takes the lock itself, commits, and returns - it holds
 * nothing across the work that follows.
 *
 * A missing generation row (migration 086 not applied) yields `null`, and a
 * `null` anchor generation makes every later comparison refuse: a fence that
 * cannot state what it is fencing against has not proven anything.
 */
export async function captureAuthorityAnchor(input: {
  readonly sessionId: string;
  readonly family: WalletTransactionFamily;
  readonly walletAddress: string;
  readonly intentId: string;
}): Promise<AuthorityAnchor> {
  const generation = await withSessionControlLock(input.sessionId, (client) =>
    readStudioDispatchGenerationWith(client));
  return {
    sessionId: input.sessionId,
    family: input.family,
    walletAddress: input.walletAddress,
    dispatchGeneration: generation,
    intentId: input.intentId,
  };
}

/**
 * Compare the anchor against what the authority says NOW, on the CALLER's
 * transaction. The caller must already hold the session control lock.
 *
 * Used at fence point (a), which runs inside the claim transaction: the check
 * and the claim commit or roll back together, so there is no instant in which
 * the fence passed and the claim then committed under different authority.
 */
export async function recheckAuthorityWith(
  client: PoolClient,
  anchor: AuthorityAnchor,
  point: AuthorityFencePoint,
): Promise<TransactionOutcome<void>> {
  const current = await readAuthorityWith(client, anchor.sessionId, anchor.family);
  return compareAuthority(anchor, current, point);
}

/**
 * Fence points (b) and (c): the caller holds no transaction, so this opens one,
 * takes the lock, reads, and releases. DB-only and short by construction.
 *
 * A THROW is a refusal. A fence that could not reach the database has not proven
 * the authority is intact, and the fail-closed direction on a money path is to
 * sign nothing.
 */
export async function recheckAuthority(
  anchor: AuthorityAnchor,
  point: AuthorityFencePoint,
): Promise<TransactionOutcome<void>> {
  try {
    return await withSessionControlLock(anchor.sessionId, (client) =>
      recheckAuthorityWith(client, anchor, point));
  } catch (cause) {
    logger.warn("wallet.transaction.authority_fence_unavailable", {
      intentId: anchor.intentId,
      sessionId: anchor.sessionId,
      point,
      errorName: cause instanceof Error ? cause.name : "unknown",
    });
    return fenceRefusal(
      anchor,
      point,
      "Vex could not confirm that this transaction is still authorized",
    );
  }
}

function compareAuthority(
  anchor: AuthorityAnchor,
  current: CurrentAuthority,
  point: AuthorityFencePoint,
): TransactionOutcome<void> {
  // The preflight is asked FIRST: it is the only signal that survives a lock
  // whose durable advance could not be written, and a refusal from it makes the
  // generation comparison below meaningless rather than reassuring.
  if (!studioDispatchPreflightAllows()) {
    return fenceRefusal(anchor, point, "Vex is locked");
  }

  if (anchor.dispatchGeneration === null || current.dispatchGeneration === null) {
    return fenceRefusal(
      anchor,
      point,
      "Vex could not read the runtime gate that proves this dispatch is still current",
    );
  }
  if (current.dispatchGeneration !== anchor.dispatchGeneration) {
    return fenceRefusal(anchor, point, "Vex was locked or unlocked");
  }

  if (current.walletAddress === null) {
    return fenceRefusal(anchor, point, "this session no longer has a wallet selected");
  }
  const inventoryFamily = anchor.family === "solana" ? "solana" : "evm";
  if (!walletAddressesEqual(inventoryFamily, current.walletAddress, anchor.walletAddress)) {
    return fenceRefusal(anchor, point, "the wallet this session signs with was changed");
  }

  return { ok: true, value: undefined };
}

/** The sentence a refused fence returns. Names the cause and the safe state. */
function fenceRefusal(
  anchor: AuthorityAnchor,
  point: AuthorityFencePoint,
  cause: string,
): TransactionOutcome<void> {
  const stateSentence =
    point === "pre_submit"
      ? "Nothing was broadcast and no funds moved, and the signed transaction was discarded."
      : "Nothing was signed and no funds moved.";
  logger.warn("wallet.transaction.authority_fence_refused", {
    intentId: anchor.intentId,
    sessionId: anchor.sessionId,
    point,
  });
  return refuse<void>(
    "forbidden_field",
    `Refusing to sign: ${cause} after this transaction was authorized, so the authority it was `
    + `approved under is no longer the authority Vex holds. ${stateSentence} Prepare the `
    + "transaction again under the current wallet and permission.",
    { intentId: anchor.intentId, fencePoint: point },
  );
}
