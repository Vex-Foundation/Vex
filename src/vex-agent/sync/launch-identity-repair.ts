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
 * NEVER RE-BROADCASTS AND NEVER SIGNS. The dependency surface is exactly ONE
 * read-only receipt lookup. This module holds no signer and imports no
 * send/broadcast/sign capability, by construction.
 *
 * A PROVEN REVERT IS THE ONE TERMINAL ANSWER it may write (`terminal_failure`).
 * That is not a weakening of the rule above: the receipt says the create did not
 * happen, so there is no token to lose. Everything short of that literal status
 * is ambiguity and stays pending.
 *
 * WHERE THE PIECES LIVE. This file owns the SWEEP: which intents are claimed,
 * what each answer is allowed to transition, and the order of the writes. How
 * the chain is asked - and WHICH launchpad decoder answers, since the two
 * launchpads attribute a launch through different events - lives in the
 * same-named sibling folder (`./launch-identity-repair/`). The public entry
 * point and every exported name are unchanged.
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
  findLaunchActivityTerminalByTxHash,
  stampLaunchOutputIdentityByTxHash,
} from "@vex-agent/db/repos/agent-activity.js";
import {
  claimBroadcastPendingForSweep,
  confirmWith,
  failWith,
  markSupersededUnprovenWith,
  type TokenLaunchIntent,
} from "@vex-agent/db/repos/token-launch-intents.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";
import { isReceiptNotFound } from "./launch-identity-repair/receipt-errors.js";
import { readAuthorizedPoolsPlan } from "./launch-identity-repair/production-deps.js";
import type {
  LaunchIdentityRepairDeps,
  LaunchReceiptOutcome,
} from "./launch-identity-repair/types.js";

// The public surface is UNCHANGED by the split: every existing importer of this
// module keeps importing exactly what it did before. The implementation moved
// into the same-named sibling folder, one responsibility per file.
export { buildProductionLaunchRepairDeps } from "./launch-identity-repair/production-deps.js";
export type {
  AuthorizedPoolsLaunchPlan,
  LaunchIdentityRepairDeps,
  LaunchReceiptIdentity,
  LaunchReceiptLookupInput,
  LaunchReceiptOutcome,
} from "./launch-identity-repair/types.js";

/**
 * Bounded batch per sweep run, mirroring `REPAIR_BATCH_LIMIT`: the sweep does
 * serial RPC reads inside the shared sync worker, and an unbounded backlog would
 * starve the balance and activity sync sharing the same drain. The remainder is
 * picked up next tick — `claimBroadcastPendingForSweep` serves the
 * least-recently-checked first and stamps every row it hands out, so an
 * ambiguous row moves to the back of the queue and the window always advances
 * rather than re-serving the same 25 rows forever.
 */
export const LAUNCH_REPAIR_BATCH_LIMIT = 25;

/** Native ETH, the unit the prebuy was SPENT in. */
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface LaunchIdentityRepairResult {
  readonly checked: number;
  /** Intents moved `broadcast_pending → confirmed` by THIS run. */
  readonly repaired: number;
  /** Rows inserted into `launched_tokens` by THIS run (0 when the handler already wrote them). */
  readonly indexed: number;
  /** Intents moved `broadcast_pending → terminal_failure` by a PROVEN on-chain revert. */
  readonly failed: number;
  /**
   * Intents moved `broadcast_pending → superseded_unproven` by MIRRORING the
   * pending lane's own terminal verdict on the sibling `agent_activity` row.
   * Not a failure and not a confirmation: the launch stops being re-checked and
   * starts saying what is actually known about it.
   */
  readonly supersededMirrored: number;
  readonly stillPending: number;
}

export async function repairLaunchIdentities(
  deps: LaunchIdentityRepairDeps,
): Promise<LaunchIdentityRepairResult> {
  const candidates = await claimBroadcastPendingForSweep(LAUNCH_REPAIR_BATCH_LIMIT);
  let repaired = 0;
  let indexed = 0;
  let failed = 0;
  let supersededMirrored = 0;
  let stillPending = 0;

  for (const intent of candidates) {
    // THE DURABLE SIBLING IS ASKED FIRST, before any provider call. The pending
    // lane may already have terminalized this broadcast as `superseded_unproven`
    // — it owns that transition — and its verdict is a durable record, not a
    // classification this sweep would have to re-derive. Consulting it first is
    // what makes the recovery work with the RPC completely unavailable, which is
    // the exact condition a superseded launch tends to be discovered in.
    const mirrored = await mirrorSupersededSibling(intent);
    if (mirrored === "mirrored") {
      supersededMirrored++;
      continue;
    }
    if (mirrored === "cas_miss") {
      stillPending++;
      continue;
    }

    const outcome = await lookupOutcome(deps, intent);
    if (outcome === null) {
      stillPending++;
      continue;
    }

    if (outcome.kind === "superseded") {
      // Said ONCE per pass at `info`, never `warn`: this is a diagnosis, not an
      // incident, and warning about it every thirty seconds forever is the
      // runaway loop this workstream exists to end. The prose claims only what
      // the observation established.
      logger.info("launch_identity_repair.superseded", {
        intentId: intent.intentId,
        chainId: intent.chainId,
        hint: "another transaction from this wallet used this one's nonce and this hash has no receipt; "
          + "what the replacement did has NOT been checked. The pending lane owns the terminal transition.",
      });
      stillPending++;
      continue;
    }

    if (outcome.kind === "reverted") {
      // PROVEN not to have happened. No identity row and no confirm: a reverted
      // create minted nothing, so writing either would put a token that does
      // not exist into the user's launch history.
      const terminalized = await withSessionControlLock(intent.sessionId, (client) =>
        failWith(client, intent.intentId, intent.sessionId, "MinedRevert:create"));
      if (terminalized) failed++;
      else logger.info("launch_identity_repair.revert_cas_miss", { intentId: intent.intentId });
      continue;
    }

    const identity = outcome.identity;

    // ORDER MATTERS. The durable identity index is written FIRST, because it is
    // idempotent and because it is the record the user's launch history is
    // built from. Confirming the intent first and then crashing would leave a
    // `confirmed` launch with no row in `launched_tokens` and NOTHING to bring
    // it back: the candidate query only sees `broadcast_pending`. Writing the
    // index first and then crashing merely leaves this intent for the next tick,
    // where the upsert makes the retry free.
    const indexWrite = await launchedTokens.record({
      walletAddress: intent.walletAddress,
      chainId: intent.chainId,
      tokenAddress: identity.tokenAddress,
      name: intent.name,
      symbol: intent.symbol,
      // The intent's OWN discriminator, mapped to this table's vocabulary. The
      // sweep is protocol-agnostic and still reconciles historical Trench rows
      // (migration 108 preserves every `broadcast_pending` one), so it must file
      // each launch under the venue it actually came from rather than under a
      // default.
      launchpad: intent.protocol === "trench" ? "trench_express" : "pools_fun",
      imageRef: intent.imageId,
      createTxHash: requireTxHash(intent),
      // The AUTHORIZED NATIVE prebuy — wei, 18 decimals, denominated in what
      // was SPENT. It is known from the intent itself and needs no receipt
      // decode, which is exactly why the sweep can complete a launch identity
      // without ever reading an amount off the chain.
      ...nativePrebuyColumns(intent),
      sessionId: intent.sessionId,
    });
    if (indexWrite.inserted) indexed++;

    // The launch's `agent_activity` row learns the token it created. Without
    // this the row keeps `token_out_address` NULL and the app's token history —
    // which matches on exactly that column — never shows the launch in the
    // history of its own token. Identity only: this sweep proves no amount, so
    // it never touches status or the executed legs.
    await stampLaunchOutputIdentityByTxHash(requireTxHash(intent), identity.tokenAddress);

    const confirmed = await withSessionControlLock(intent.sessionId, (client) =>
      confirmWith(client, intent.intentId, intent.sessionId, identity.tokenAddress));
    if (confirmed) {
      repaired++;
    } else {
      // A CAS miss is not a failure: the handler's own late finalize, or a
      // concurrent sweep run, already confirmed this intent. The index write
      // above was idempotent, so nothing was double-counted.
      logger.info("launch_identity_repair.duplicate_cas_miss", {
        intentId: intent.intentId,
      });
    }
  }

  return { checked: candidates.length, repaired, indexed, failed, supersededMirrored, stillPending };
}

/** What consulting the durable sibling settled for one claimed intent. */
type SiblingMirrorOutcome = "mirrored" | "cas_miss" | "no_answer";

/**
 * Copy the pending lane's `superseded_unproven` verdict from the launch's
 * sibling `agent_activity` row onto the intent.
 *
 * `no_answer` covers every case that is not that one verdict: no sibling row, a
 * sibling still `pending`, a sibling `confirmed`, or a lookup that threw. All of
 * them fall through to the ordinary RPC classification, which is unchanged and
 * still defers on a fresh `superseded`.
 *
 * A THROW IS CONTAINED. This runs inside the shared sync worker, and a transient
 * DB error while reading a sibling must never abort the sweep for every other
 * claimed row, nor terminalize anything.
 */
async function mirrorSupersededSibling(
  intent: TokenLaunchIntent,
): Promise<SiblingMirrorOutcome> {
  const txHash = intent.txHash;
  if (!txHash) return "no_answer";

  let sibling: { readonly status: string } | null;
  try {
    sibling = await findLaunchActivityTerminalByTxHash(txHash);
  } catch (err) {
    logger.warn("launch_identity_repair.sibling_lookup_failed", {
      intentId: intent.intentId,
      error: summarizeProtocolError(err).message,
    });
    return "no_answer";
  }
  if (sibling === null || sibling.status !== "superseded_unproven") return "no_answer";

  const applied = await withSessionControlLock(intent.sessionId, (client) =>
    markSupersededUnprovenWith(client, intent.intentId, intent.sessionId, txHash));
  if (!applied) {
    logger.info("launch_identity_repair.superseded_cas_miss", {
      intentId: intent.intentId,
    });
    return "cas_miss";
  }

  // Said at `info`, once per row, because the row leaves the candidate set here:
  // this is the END of the runaway re-check loop, not another lap of it.
  logger.info("launch_identity_repair.superseded_mirrored", {
    intentId: intent.intentId,
    chainId: intent.chainId,
    hint: "the pending lane stopped tracking this hash with its outcome unproven; the intent "
      + "now says so instead of waiting for a receipt that will not arrive. The token may "
      + "exist - this is NOT a failure and NOT a licence to launch again.",
  });
  return "mirrored";
}

/**
 * The `initial_buy_*` triple, in ONE convention shared with the launch handler:
 * no prebuy → all three NULL.
 *
 * A ZERO prebuy is "no prebuy", so writing `"0"` with decimals and a token
 * address (as this sweep used to) made the same launch look different depending
 * on WHICH writer got there first — the handler's row said "none", the sweep's
 * said "zero ETH of native". `my-launches` renders whatever it finds, so that
 * divergence was user-visible.
 */
function nativePrebuyColumns(intent: TokenLaunchIntent): {
  initialBuyRaw: string | null;
  initialBuyDecimals: number | null;
  initialBuyTokenAddress: string | null;
} {
  const raw = intent.prebuyRaw;
  const hasPrebuy = raw !== null && raw !== "" && BigInt(raw) > 0n;
  if (!hasPrebuy) {
    return { initialBuyRaw: null, initialBuyDecimals: null, initialBuyTokenAddress: null };
  }
  return {
    initialBuyRaw: raw,
    initialBuyDecimals: intent.prebuyDecimals,
    initialBuyTokenAddress: NATIVE_ADDRESS,
  };
}

/**
 * `null` on every ambiguity, and a thrown lookup is one of them — the sweep must
 * never let a transient RPC failure terminalize a launch or crash the shared
 * sync worker.
 */
async function lookupOutcome(
  deps: LaunchIdentityRepairDeps,
  intent: TokenLaunchIntent,
): Promise<LaunchReceiptOutcome | null> {
  const txHash = intent.txHash;
  if (!txHash) {
    // The DB CHECK makes this unreachable for `broadcast_pending`, and the
    // candidate query filters it too. Belt and braces: never look up "null".
    return null;
  }
  try {
    const outcome = await deps.resolveLaunchOutcome({
      chainId: intent.chainId,
      txHash,
      walletAddress: intent.walletAddress,
      protocol: intent.protocol,
      poolsPlan: readAuthorizedPoolsPlan(intent),
    });
    if (outcome === null) return null;
    if (outcome.kind === "reverted" || outcome.kind === "superseded") return outcome;
    return outcome.identity.tokenAddress.length > 0 ? outcome : null;
  } catch (err) {
    if (isReceiptNotFound(err)) {
      // NOT YET MINED — the sweep's most common and most ordinary answer, and
      // not a failure of anything. It stays a quiet `null`, as this module's
      // dependency contract has always said it should.
      return null;
    }
    logger.warn("launch_identity_repair.lookup_failed", {
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
      `launch_identity_repair: intent ${intent.intentId} is broadcast_pending with no tx hash`,
    );
  }
  return intent.txHash;
}

