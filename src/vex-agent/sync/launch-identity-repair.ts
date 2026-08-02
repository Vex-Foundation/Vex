/**
 * Trench launch IDENTITY repair — the crash-recovery reconciler for launches
 * whose `create` settled but whose token identity was never written.
 *
 * ── Why the generic sweep cannot do this ───────────────────────────────────
 *
 * `agent-activity-repair.ts` is STATUS-ONLY by owner decree (2026-07-30): it
 * asks the chain one question per pending row — did this tx hash succeed or
 * revert — and writes the status alone. It decodes nothing. That is the right
 * design for a protocol-agnostic sweep, and it is exactly why it cannot finish a
 * launch: a launch's whole point is the ADDRESS of the token that now exists,
 * and that address is only knowable by decoding `TokenCreated` from the receipt.
 * The generic sweep can therefore confirm the `agent_activity` row and still
 * leave `token_launch_intents.token_address` NULL and `launched_tokens` empty.
 *
 * THIS IS NOT THE PRIMARY PATH. The launch handler decodes its own receipt and
 * writes both records inline; that is where a healthy launch is completed. This
 * sweep exists for the window the handler cannot cover — a crash, a kill, or a
 * power loss between the create being mined and the identity being persisted.
 * Without it, "launched tokens are saved" would be a best-effort claim.
 *
 * ── Its guarantees ─────────────────────────────────────────────────────────
 *
 * SAFE TO RE-RUN. `launchedTokens.record` upserts on the case-insensitive
 * identity index (`ON CONFLICT (chain_id, LOWER(token_address)) DO NOTHING`), so
 * running this twice, or racing the handler, converges on exactly one row.
 *
 * NEVER INVENTS AN ADDRESS. If the receipt is missing, unreadable, carries no
 * decodable `TokenCreated`, or the lookup throws, the intent stays
 * `broadcast_pending` and is retried on the next tick. Ambiguity NEVER
 * terminalizes — the same rule the staged-broadcast and activity-repair paths
 * follow, and for the same reason: a launch marked failed is a launch the user
 * may try again, and the first `create` may already have minted their token.
 *
 * NEVER RE-BROADCASTS AND NEVER SIGNS. The dependency surface is exactly two
 * read-only functions. This module holds no signer and imports no
 * send/broadcast/sign capability, by construction.
 *
 * LOOKUP-ONLY AND SESSION-SAFE. The candidate query is global (its rows span
 * arbitrary sessions), but every WRITE goes back through the session-scoped CAS
 * writers in `db/repos/token-launch-intents.ts`, under
 * `withSessionControlLock` keyed by the session id carried on the row it just
 * read — so a launch intent transition made here serializes with the compaction
 * safe-moment gate exactly like one made by the handler.
 */

import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import * as launchedTokens from "@vex-agent/db/repos/launched-tokens.js";
import {
  confirmWith,
  listBroadcastPending,
  type TokenLaunchIntent,
} from "@vex-agent/db/repos/token-launch-intents.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

/**
 * Bounded batch per sweep run, mirroring `REPAIR_BATCH_LIMIT`: the sweep does
 * serial RPC reads inside the shared sync worker, and an unbounded backlog would
 * starve the balance and activity sync sharing the same drain. The remainder is
 * picked up next tick — `listBroadcastPending` orders oldest-first, so the
 * window advances rather than re-serving the same rows.
 */
export const LAUNCH_REPAIR_BATCH_LIMIT = 25;

export interface LaunchReceiptLookupInput {
  readonly chainId: number;
  readonly txHash: string;
}

/**
 * What a confirmed launch receipt proves.
 *
 * `tokenAddress` is the address decoded from `TokenCreated`. A lookup that CAN
 * read the receipt but CANNOT decode the event must return `null` for the whole
 * result rather than a result with an empty address — "the transaction settled"
 * without "and here is the token" is not enough to complete a launch identity,
 * and a half-answer here would be written to the durable index.
 */
export interface LaunchReceiptIdentity {
  readonly tokenAddress: string;
  /** Raw units of the native prebuy actually spent, when the receipt proves it. */
  readonly initialBuyRaw?: string | null;
  readonly initialBuyDecimals?: number | null;
  readonly initialBuyTokenAddress?: string | null;
}

export interface LaunchIdentityRepairDeps {
  /**
   * The ONLY dependency this sweep may have. Read-only: a receipt lookup that
   * decodes `TokenCreated`. Never a send/broadcast/sign capability.
   *
   * `null` means "no answer yet" — not yet mined, a transient RPC error, an
   * unreadable receipt, or a receipt with no decodable `TokenCreated`. All four
   * leave the intent `broadcast_pending`.
   */
  readonly resolveLaunchIdentity: (
    input: LaunchReceiptLookupInput,
  ) => Promise<LaunchReceiptIdentity | null>;
}

export interface LaunchIdentityRepairResult {
  readonly checked: number;
  /** Intents moved `broadcast_pending → confirmed` by THIS run. */
  readonly repaired: number;
  /** Rows inserted into `launched_tokens` by THIS run (0 when the handler already wrote them). */
  readonly indexed: number;
  readonly stillPending: number;
}

export async function repairLaunchIdentities(
  deps: LaunchIdentityRepairDeps,
): Promise<LaunchIdentityRepairResult> {
  const candidates = await listBroadcastPending(LAUNCH_REPAIR_BATCH_LIMIT);
  let repaired = 0;
  let indexed = 0;
  let stillPending = 0;

  for (const intent of candidates) {
    const identity = await lookupIdentity(deps, intent);
    if (identity === null) {
      stillPending++;
      continue;
    }

    // ORDER MATTERS. The durable identity index is written FIRST, because it is
    // idempotent and because it is the record the user's launch history is
    // built from. Confirming the intent first and then crashing would leave a
    // `confirmed` launch with no row in `launched_tokens` and NOTHING to bring
    // it back: the candidate query only sees `broadcast_pending`. Writing the
    // index first and then crashing merely leaves this intent for the next tick,
    // where the upsert makes the retry free.
    const outcome = await launchedTokens.record({
      walletAddress: intent.walletAddress,
      chainId: intent.chainId,
      tokenAddress: identity.tokenAddress,
      name: intent.name,
      symbol: intent.symbol,
      imageRef: intent.imageId,
      createTxHash: requireTxHash(intent),
      initialBuyRaw: identity.initialBuyRaw ?? intent.prebuyRaw,
      initialBuyDecimals: identity.initialBuyDecimals ?? intent.prebuyDecimals,
      initialBuyTokenAddress: identity.initialBuyTokenAddress ?? null,
      sessionId: intent.sessionId,
    });
    if (outcome.inserted) indexed++;

    const confirmed = await withSessionControlLock(intent.sessionId, (client) =>
      confirmWith(client, intent.intentId, intent.sessionId, identity.tokenAddress));
    if (confirmed) {
      repaired++;
    } else {
      // A CAS miss is not a failure: the handler's own late finalize, or a
      // concurrent sweep run, already confirmed this intent. The index write
      // above was idempotent, so nothing was double-counted.
      logger.info("trench.launch_identity_repair.duplicate_cas_miss", {
        intentId: intent.intentId,
      });
    }
  }

  return { checked: candidates.length, repaired, indexed, stillPending };
}

/**
 * `null` on every ambiguity, and a thrown lookup is one of them — the sweep must
 * never let a transient RPC failure terminalize a launch or crash the shared
 * sync worker.
 */
async function lookupIdentity(
  deps: LaunchIdentityRepairDeps,
  intent: TokenLaunchIntent,
): Promise<LaunchReceiptIdentity | null> {
  const txHash = intent.txHash;
  if (!txHash) {
    // The DB CHECK makes this unreachable for `broadcast_pending`, and the
    // candidate query filters it too. Belt and braces: never look up "null".
    return null;
  }
  try {
    const identity = await deps.resolveLaunchIdentity({ chainId: intent.chainId, txHash });
    if (identity && identity.tokenAddress.length > 0) return identity;
    return null;
  } catch (err) {
    logger.warn("trench.launch_identity_repair.lookup_failed", {
      intentId: intent.intentId,
      chainId: intent.chainId,
      // `summarizeProtocolError` is the canonical scrub boundary — a bare
      // `redact()` detects secret SHAPES only, and an RPC error can carry URLs,
      // request/response bodies and auth headers.
      error: summarizeProtocolError(err).message,
    });
    return null;
  }
}

function requireTxHash(intent: TokenLaunchIntent): string {
  if (!intent.txHash) {
    throw new Error(
      `trench.launch_identity_repair: intent ${intent.intentId} is broadcast_pending with no tx hash`,
    );
  }
  return intent.txHash;
}
