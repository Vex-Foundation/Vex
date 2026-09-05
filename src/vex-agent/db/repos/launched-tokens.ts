/**
 * Launched-tokens repo - the durable identity index behind the launch history
 * reads (migration `062_trench_launch.sql`).
 *
 * MULTI-LAUNCHPAD since migration `082_pools_fun_launch.sql`. `launchpad`
 * discriminates the venue (`trench_express`, `pools_fun`), and it is NOT
 * redundant with `chain_id`: both launchpads live on chain 4663, so every
 * venue-scoped selector in this file names the launchpad explicitly. A
 * chain-only predicate here serves one venue's rows to the other venue's sweep.
 *
 * Answers a different question from `agent_activity`. The activity feed answers
 * "what did the agent DO, and did it settle?"; this table answers "which tokens
 * exist because of me?" — keyed by TOKEN IDENTITY rather than by execution. Both
 * ledgers are written for a launch, deliberately.
 *
 * ── Idempotent by construction ─────────────────────────────────────────────
 *
 * "Launched tokens are saved" must survive a crash between the receipt
 * confirming and this row being written, so the write is NOT a bare fail-soft
 * insert. `record` is an upsert on the case-insensitive identity index
 * (`chain_id, LOWER(token_address)`), so the launch handler's own post-confirm
 * write and the crash-recovery identity repair
 * (`sync/launch-identity-repair.ts`) can both run, in either order, any number
 * of times, and converge on exactly one row.
 *
 * `DO NOTHING` rather than `DO UPDATE` is deliberate: the first writer to prove
 * a token exists wins, and a later reconciler must not overwrite the identity
 * record of an on-chain fact it is merely re-deriving.
 *
 * Addresses are stored as the caller supplies them (checksummed by callers);
 * identity is case-insensitive via the unique `LOWER()` index, exactly as
 * `tracked-tokens.ts` does.
 *
 * `initialBuyRaw` travels with BOTH `initialBuyDecimals` and
 * `initialBuyTokenAddress` (rule 90). The token address is not redundant with
 * `tokenAddress`: the prebuy is denominated in what was SPENT (native ETH), not
 * in what was received.
 */

import { query, queryOne } from "../client.js";
// Type-only: the vocabulary's single owner. No runtime dependency crosses from
// the repo layer into a tool module, and the terminal set cannot drift from
// the module the client and the sweep already import.
import type { PoolsAttestTerminalCode } from "@tools/pools-fun/attribution-codes.js";

export interface LaunchedToken {
  id: number;
  walletAddress: string;
  chainId: number;
  launchpad: string;
  tokenAddress: string;
  name: string;
  symbol: string;
  imageRef: string | null;
  createTxHash: string;
  /** Raw units of `initialBuyTokenAddress`. Unreadable without its decimals — never read one without the other. */
  initialBuyRaw: string | null;
  initialBuyDecimals: number | null;
  initialBuyTokenAddress: string | null;
  sessionId: string | null;
  protocolExecutionId: number | null;
  createdAt: string;
}

export interface RecordLaunchedTokenInput {
  walletAddress: string;
  chainId: number;
  tokenAddress: string;
  name: string;
  symbol: string;
  /**
   * Which launchpad produced the token: `trench_express` (retired by migration
   * 108, its historical rows still readable), `pools_fun` (migration 082) or
   * `virtuals` (migration 110). REQUIRED, and stated rather than defaulted:
   * trench.express and pools.fun share chain 4663 and Virtuals spans 4663 and
   * Base 8453, so this is the ONLY thing that tells the populations apart. It
   * used to default to `trench_express` for callers that predated the second
   * venue; after 108 retired that venue the default became a trapdoor - a
   * writer that forgot the discriminator would file a new launch under a
   * protocol that no longer accepts them.
   */
  launchpad: string;
  imageRef?: string | null;
  createTxHash: string;
  initialBuyRaw?: string | null;
  initialBuyDecimals?: number | null;
  initialBuyTokenAddress?: string | null;
  sessionId?: string | null;
  protocolExecutionId?: number | null;
}

const SELECT_COLUMNS =
  "id, wallet_address, chain_id, launchpad, token_address, name, symbol, " +
  "image_ref, create_tx_hash, initial_buy_raw, initial_buy_decimals, " +
  "initial_buy_token_address, session_id, protocol_execution_id, created_at";

/** `null` stays `null`; `0` survives. node-pg returns BIGINT/SMALLINT as strings. */
function nullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function mapRow(r: Record<string, unknown>): LaunchedToken {
  return {
    id: Number(r.id),
    walletAddress: r.wallet_address as string,
    chainId: Number(r.chain_id),
    launchpad: r.launchpad as string,
    tokenAddress: r.token_address as string,
    name: r.name as string,
    symbol: r.symbol as string,
    imageRef: (r.image_ref as string | null) ?? null,
    createTxHash: r.create_tx_hash as string,
    initialBuyRaw: (r.initial_buy_raw as string | null) ?? null,
    initialBuyDecimals: nullableInt(r.initial_buy_decimals),
    initialBuyTokenAddress: (r.initial_buy_token_address as string | null) ?? null,
    sessionId: (r.session_id as string | null) ?? null,
    protocolExecutionId: nullableInt(r.protocol_execution_id),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

/**
 * Record a launched token. IDEMPOTENT — safe to re-run any number of times.
 *
 * `inserted: false` means the identity was already recorded (by the handler's
 * own post-confirm write, or by an earlier repair pass). That is a normal,
 * expected outcome and NOT an error: it is precisely what makes the repair
 * re-runnable. The CURRENT row is returned either way, so a caller never has to
 * follow up with a second query to learn what is stored.
 */
export async function record(
  input: RecordLaunchedTokenInput,
): Promise<{ inserted: boolean; row: LaunchedToken }> {
  const inserted = await queryOne<Record<string, unknown>>(
    `INSERT INTO launched_tokens (
       wallet_address, chain_id, launchpad, token_address, name, symbol,
       image_ref, create_tx_hash, initial_buy_raw, initial_buy_decimals,
       initial_buy_token_address, session_id, protocol_execution_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (chain_id, LOWER(token_address)) DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.walletAddress,
      input.chainId,
      input.launchpad,
      input.tokenAddress,
      input.name,
      input.symbol,
      input.imageRef ?? null,
      input.createTxHash,
      input.initialBuyRaw ?? null,
      input.initialBuyDecimals ?? null,
      input.initialBuyTokenAddress ?? null,
      input.sessionId ?? null,
      input.protocolExecutionId ?? null,
    ],
  );
  if (inserted) return { inserted: true, row: mapRow(inserted) };

  const existing = await getByIdentity(input.chainId, input.tokenAddress);
  if (!existing) {
    // The INSERT conflicted, so a row for this identity exists; a follow-up read
    // that cannot find it means the identity index and this lookup disagree
    // about what identity means. Throw rather than report a launch as unsaved.
    throw new Error(
      `launched_tokens: ON CONFLICT fired for chain ${input.chainId} token ` +
        `${input.tokenAddress} but no existing row could be read back`,
    );
  }
  return { inserted: false, row: existing };
}

/**
 * WHICH LAUNCHPADS CAN BE ATTESTED TO AGENTSCAN, AND WITH WHICH SIGNATURE.
 *
 * The AgentScan attestation registry verifies ONE canonical message, the one
 * `canonicalAttestMessage` builds (`packages/contract/src/attest.ts`). Exactly one
 * module here may produce it: `src/vex-agent/agentscan/attest-message.ts`, the
 * launchpad-neutral builder the pools.fun and Virtuals launch handlers call.
 * The retired trench badge signed the same bytes, but migration 108 deleted its
 * signer along with the venue, so its column is read-only history that this
 * sweep still delivers. A signature over any other
 * message recovers to a different address and is refused, so a launchpad may
 * only appear here once a column holding an AGENTSCAN-FORMATTED signature exists
 * for it.
 *
 * Three do today. `attest_signature` (migration 071) is the trench.express
 * badge proof and signs that same canonical message. It has NO writer any more
 * - migration 108 retired the venue and its launch handler was the only thing
 * that ever stamped it - so it is a read-only column over historical rows,
 * which stay claimable and attestable exactly as before. `pools_attest_signature`
 * (migration 094) does NOT: pools.fun's own badge signs the venue-prefixed
 * message `src/tools/pools-fun/attribution.ts:142` builds, a deliberately
 * different one, so shipping it to AgentScan would send a proof over the wrong
 * bytes and burn the row on a definitive refusal. The pools.fun and Virtuals
 * launches therefore sign a THIRD signature at launch time, over AgentScan's
 * canonical message (`src/vex-agent/agentscan/attest-message.ts`), by the
 * handler that still holds the signer. `agentscan_attest_signature` is that
 * column - added by migration 109 for pools.fun and re-declared IF NOT EXISTS by
 * migration 110 for Virtuals, named for the registry it serves rather than for a
 * venue precisely so the second launchpad that needs it does not mint a third
 * copy. A launch that could not sign leaves it NULL and is simply never a
 * candidate - the same named gap the trench lane has.
 *
 * THE CHAIN IS NOT A PARAMETER any more, and that is the point. The sweep used
 * to be pinned to `TRENCH_CHAIN_ID`, which was a faithful proxy for the venue
 * while one venue existed on one chain. The AgentScan attestation registry
 * covers chain 4663 AND Base 8453, and Virtuals launches on both, so a chain
 * parameter here would silently strand every launch on the other one. The
 * launchpad is the selector; each row reports its OWN `chain_id`.
 *
 * The column names below are frozen literals in this module, never input, so
 * interpolating them into the predicate cannot carry a caller's string into SQL.
 */
const AGENTSCAN_ATTEST_SOURCES = [
  {
    /** `launched_tokens.launchpad`, this repository's own venue vocabulary. */
    launchpad: "trench_express",
    /** The AgentScan wire value the POST must name (`packages/contract/src/launchpad.ts`). */
    wireLaunchpad: "trench",
    /** The column holding a signature over AgentScan's canonical message. */
    signatureColumn: "attest_signature",
  },
  {
    launchpad: "pools_fun",
    wireLaunchpad: "pools_fun",
    /**
     * NOT `pools_attest_signature`. That column signs pools.fun's own
     * venue-prefixed badge message and AgentScan's recovery would read it as a
     * different message entirely; `agentscan_attest_signature` (migration 109)
     * is the third signature, produced at launch time over
     * `agentscan/attest-message.ts`'s canonical string by the handler that still
     * holds the signer. A launch that could not sign leaves it NULL and is
     * simply never a candidate - the same named gap the trench lane has.
     */
    signatureColumn: "agentscan_attest_signature",
  },
  {
    /**
     * Virtuals agent launches (migration 110). ONE venue value across BOTH
     * chains: Virtuals runs the same BondingV5 suite on Base 8453 and Robinhood
     * 4663, and each row reports its own `chain_id`, so narrowing this by chain
     * would strand every launch on the other one.
     */
    launchpad: "virtuals",
    /** The AgentScan wire value; the server dispatches the `preLaunch` creation proof on it. */
    wireLaunchpad: "virtuals",
    /** The same registry-named column pools.fun writes; one message, one owner. */
    signatureColumn: "agentscan_attest_signature",
  },
] as const;

export type AgentscanAttestWireLaunchpad =
  (typeof AGENTSCAN_ATTEST_SOURCES)[number]["wireLaunchpad"];

/**
 * This repository's own venue vocabulary for the launchpads that sign
 * AgentScan's canonical message. The stamp writer takes it rather than a bare
 * string so a caller cannot store a venue name the sweep's predicate above would
 * never select.
 */
export type AgentscanAttestLaunchpad = (typeof AGENTSCAN_ATTEST_SOURCES)[number]["launchpad"];

/** `(launchpad = 'x' AND x_signature IS NOT NULL) OR ...` over the table above. */
const AGENTSCAN_ATTESTABLE_SQL = AGENTSCAN_ATTEST_SOURCES.map(
  (source) => `(launchpad = '${source.launchpad}' AND ${source.signatureColumn} IS NOT NULL)`,
).join(" OR ");

/** `CASE WHEN launchpad = 'x' THEN x_signature END` over the same table. */
const AGENTSCAN_SIGNATURE_SQL = `CASE ${AGENTSCAN_ATTEST_SOURCES.map(
  (source) => `WHEN t.launchpad = '${source.launchpad}' THEN t.${source.signatureColumn}`,
).join(" ")} END`;

/** Local venue value -> the AgentScan wire launchpad, or `null` for a venue that has none. */
export function agentscanWireLaunchpad(launchpad: string): AgentscanAttestWireLaunchpad | null {
  return AGENTSCAN_ATTEST_SOURCES.find((source) => source.launchpad === launchpad)?.wireLaunchpad ?? null;
}

/**
 * What the AgentScan attestation sweep needs to make one POST, plus the
 * creation tx hash the AgentScan wire contract requires
 * as a validated hint (trench.express's own `/vex/attribute` never asked for
 * one) and the launchpad whose creation proof the server must apply.
 */
export interface AgentscanAttestCandidate {
  id: number;
  chainId: number;
  /** The AgentScan wire launchpad this row claims (`trench`, `pools_fun`, `virtuals`). */
  launchpad: AgentscanAttestWireLaunchpad;
  tokenAddress: string;
  attestSignature: string;
  createTxHash: string;
}

/**
 * Claim up to `limit` signed-but-unsubmitted (AgentScan) tokens, least-recently-
 * attempted first, stamping `agentscan_attest_attempted_at` in the SAME
 * statement. Over the 074 pair of columns rather than 071's - a
 * permanently-refused row moves to
 * the back of the queue instead of starving row 26, and `FOR UPDATE SKIP
 * LOCKED` gives two concurrent sweeps disjoint batches.
 *
 * Scoped by LAUNCHPAD and never by chain: see `AGENTSCAN_ATTEST_SOURCES` for
 * which launchpads qualify and why a chain predicate here would strand launches.
 */
export async function claimAgentscanAttestCandidates(input: {
  limit: number;
  retryAfterSeconds: number;
}): Promise<AgentscanAttestCandidate[]> {
  const rows = await query<Record<string, unknown>>(
    `WITH candidates AS (
       SELECT id AS candidate_id
         FROM launched_tokens
        WHERE (${AGENTSCAN_ATTESTABLE_SQL})
          AND agentscan_attested_at IS NULL
          AND (agentscan_attest_attempted_at IS NULL
               OR agentscan_attest_attempted_at < NOW() - ($2 || ' seconds')::interval)
        ORDER BY agentscan_attest_attempted_at ASC NULLS FIRST, id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE launched_tokens t
        SET agentscan_attest_attempted_at = NOW()
       FROM candidates c
      WHERE t.id = c.candidate_id
      RETURNING t.id, t.chain_id, t.launchpad, t.token_address,
                ${AGENTSCAN_SIGNATURE_SQL} AS attest_signature,
                t.create_tx_hash`,
    [input.limit, String(input.retryAfterSeconds)],
  );
  return rows.flatMap((r) => {
    const wire = agentscanWireLaunchpad(r.launchpad as string);
    // Unreachable while the predicate and the table agree; dropped rather than
    // guessed if they ever stop agreeing, because a POST naming the wrong
    // launchpad is a definitive refusal that burns the row.
    if (wire === null) return [];
    return [{
      id: Number(r.id),
      chainId: Number(r.chain_id),
      launchpad: wire,
      tokenAddress: r.token_address as string,
      attestSignature: r.attest_signature as string,
      createTxHash: r.create_tx_hash as string,
    }];
  });
}

/**
 * The attestation was SUBMITTED: the server took the claim into its verify
 * queue and answered 2xx. Terminal for the SUBMISSION sweep; the row moves to
 * the read-back sweep below, because acceptance is not verification.
 *
 * THE POST PATH IS SUBMISSION ONLY. It records that the claim was sent and
 * writes NO verify status, and that is a correctness requirement rather than a
 * simplification. The server's `token-attestations-repo.ts` answers a DUPLICATE
 * POST with the row's EXISTING `verifyStatus`, which can already be `verified`;
 * the previous version of this function copied that word onto the row while
 * leaving `agentscan_verified_at` NULL, and migration 107's
 * `launched_tokens_agentscan_verified_stamp` CHECK forbids exactly that pair.
 * The canonical way in is ordinary: this install crashes after the server
 * commits the attestation and before this mark lands, the row is claimed again,
 * the duplicate POST returns `verified`, and the UPDATE aborts on the CHECK -
 * every sweep, forever, because the row never leaves the candidate set.
 *
 * The status and its stamp are therefore written in exactly one place,
 * `recordAgentscanVerifyStatus`, from the GET verdict that is the only authority
 * on whether the creation proof held. A duplicate POST's status is a log line
 * there and nothing more.
 */
export async function markAgentscanAttested(id: number): Promise<boolean> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE launched_tokens
        SET agentscan_attested_at = NOW()
      WHERE id = $1 AND agentscan_attested_at IS NULL
      RETURNING id`,
    [id],
  );
  return row !== null;
}

/** What the read-back sweep needs to ask the server for one row's verdict. */
export interface AgentscanVerifyCandidate {
  readonly id: number;
  readonly chainId: number;
  readonly tokenAddress: string;
}

/**
 * Claim up to `limit` SUBMITTED rows whose verdict is still open, least-recently-
 * checked first, stamping `agentscan_verify_checked_at` in the same statement.
 *
 * "Still open" is `NULL` (never read back) or `unverified` (the server's own
 * word for "queued, not judged"). The four terminal verdicts leave the set for
 * good: a `verified` row is done, and `mismatch`, `unverifiable` and `revoked`
 * are answers that cannot change by asking again, and re-serving them would be the
 * starvation loop the pools.fun claim documents, dressed up as politeness.
 */
export async function claimAgentscanVerifyCandidates(input: {
  limit: number;
  retryAfterSeconds: number;
}): Promise<AgentscanVerifyCandidate[]> {
  const rows = await query<Record<string, unknown>>(
    `WITH candidates AS (
       SELECT id AS candidate_id
         FROM launched_tokens
        WHERE agentscan_attested_at IS NOT NULL
          AND (agentscan_verify_status IS NULL OR agentscan_verify_status = 'unverified')
          AND (agentscan_verify_checked_at IS NULL
               OR agentscan_verify_checked_at < NOW() - ($2 || ' seconds')::interval)
        ORDER BY agentscan_verify_checked_at ASC NULLS FIRST, id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE launched_tokens t
        SET agentscan_verify_checked_at = NOW()
       FROM candidates c
      WHERE t.id = c.candidate_id
      RETURNING t.id, t.chain_id, t.token_address`,
    [input.limit, String(input.retryAfterSeconds)],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    chainId: Number(r.chain_id),
    tokenAddress: r.token_address as string,
  }));
}

/**
 * Record the server's verdict for one submitted attestation. THE ONLY WRITER of
 * `agentscan_verify_status` and `agentscan_verified_at`.
 *
 * `agentscan_verified_at` is stamped ONLY for `verified`, which is what migration
 * 102's `launched_tokens_agentscan_verified_stamp` requires: the status and the
 * stamp can never tell different stories about the same row. Writing them in one
 * statement, in one place, is what makes that CHECK unfalsifiable rather than a
 * trap for a second writer.
 *
 * A COMPARE-AND-SET, not a blind write. The row is updated only while its status
 * is still open - `NULL` (never read back) or `unverified` (the server's own
 * word for "queued, not judged"). Two sweeps can overlap on one row (the claim
 * uses `FOR UPDATE SKIP LOCKED` per batch, not per row across runs), and an HTTP
 * response can arrive out of order with a newer one, so without the guard a
 * stale `unverified` read could land after a terminal `verified` or `mismatch`
 * and walk a settled row backwards into the polling set. The four terminal
 * verdicts are answers that cannot change by asking again; this predicate is
 * what makes that true of the stored row as well as of the sweep's candidate
 * query. `false` therefore means "already settled", not "not found".
 */
export async function recordAgentscanVerifyStatus(input: {
  id: number;
  status: string;
}): Promise<boolean> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE launched_tokens
        SET agentscan_verify_status = $2,
            agentscan_verify_checked_at = NOW(),
            agentscan_verified_at = CASE WHEN $2 = 'verified' THEN NOW() ELSE NULL END
      WHERE id = $1
        AND agentscan_attested_at IS NOT NULL
        AND (agentscan_verify_status IS NULL OR agentscan_verify_status = 'unverified')
      RETURNING id`,
    [input.id, input.status],
  );
  return row !== null;
}

// ── pools.fun attribution lane (migration 094) ──────────────────────────────
//
// A PARALLEL lane to the trench one above, not a widening of it. The two are
// separate because the proof is separate: pools.fun asks the creator to sign a
// DIFFERENT message than trench.express does, so `pools_attest_signature` is
// its own column and is never interchangeable with `attest_signature`. Every
// selector below bakes in `launchpad = 'pools_fun'`; chain 4663 carries both
// venues, so the launchpad is the only thing that separates the populations.
//
// The lane has TWO terminal states rather than one. trench attribution only
// ever records success, and a refusal is absorbed by the retry window. pools.fun
// can refuse DEFINITIVELY - a token it does not recognise as its own launch will
// never become one - so a definitive refusal is recorded with its reason and the
// row leaves the candidate set instead of being retried until the heat death of
// the sweep. A TRANSPORT failure is deliberately not a rejection: it leaves both
// terminal columns NULL and the row is retried on the next pass.

/**
 * Attach the creator's pools.fun attest signature to an already-recorded token.
 *
 * WRITE-ONCE: `pools_attest_signature IS
 * NULL` in the predicate means a re-run never replaces a stored signature, so
 * the launch handler's own write and any later re-entry converge. The
 * `launchpad = 'pools_fun'` predicate makes the venue a precondition rather
 * than an assumption - a trench row REFUSES this stamp (returns `false`) instead
 * of quietly acquiring a proof over a message its creator never signed.
 *
 * Returns whether this call stored it. `false` means either "already signed" or
 * "not a pools.fun row"; both are non-events for the caller, which has no
 * remediation for either beyond not overwriting.
 */
export async function stampPoolsAttestSignature(input: {
  chainId: number;
  tokenAddress: string;
  attestSignature: string;
}): Promise<boolean> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE launched_tokens
        SET pools_attest_signature = $3
      WHERE chain_id = $1 AND LOWER(token_address) = LOWER($2)
        AND launchpad = 'pools_fun'
        AND pools_attest_signature IS NULL
      RETURNING id`,
    [input.chainId, input.tokenAddress, input.attestSignature],
  );
  return row !== null;
}

/**
 * Store the AGENTSCAN attestation signature a launch produced, on the row that
 * launch just wrote.
 *
 * A SEPARATE COLUMN, NOT A SECOND USE OF THE VENUE ONE. `pools_attest_signature`
 * signs the venue's own message and `agentscan_attest_signature` signs
 * AgentScan's canonical one (`agentscan/attest-message.ts`); they are different
 * bytes and recover to the same wallet only over their own message, so a single
 * column would send one of the two proofs to the wrong verifier and burn the row
 * on a definitive refusal.
 *
 * WRITE-ONCE, exactly like `stampPoolsAttestSignature`: `IS NULL` in the
 * predicate, so a re-run
 * converges. A later write could only be a different signature for the same
 * token - either a defect or a second launch, and neither should silently
 * replace the proof already stored.
 *
 * `launchpad` is a PARAMETER here rather than a baked literal, and that is the
 * one difference from its two siblings. This column is SHARED: it holds the
 * signature over AgentScan's canonical message for every launchpad that owes
 * one, today pools.fun and Virtuals, and its vocabulary is the one
 * `AGENTSCAN_ATTEST_SOURCES` above declares, so a caller cannot invent a third
 * venue name that the sweep's predicate would never select. Baking one venue in
 * would instead force the next lane to copy the function. The value is still a
 * precondition, not an assumption - a row of another venue REFUSES the stamp and
 * returns `false`.
 *
 * Returns whether this call stored it. `false` means "already signed" or "not
 * that launchpad's row"; neither has a remediation beyond not overwriting.
 */
export async function stampAgentscanAttestSignature(input: {
  chainId: number;
  tokenAddress: string;
  launchpad: AgentscanAttestLaunchpad;
  attestSignature: string;
}): Promise<boolean> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE launched_tokens
        SET agentscan_attest_signature = $4
      WHERE chain_id = $1 AND LOWER(token_address) = LOWER($2)
        AND launchpad = $3
        AND agentscan_attest_signature IS NULL
      RETURNING id`,
    [input.chainId, input.tokenAddress, input.launchpad, input.attestSignature],
  );
  return row !== null;
}

/** What the pools.fun attribution sweep needs to make one POST, and nothing more. */
export interface PoolsAttributionCandidate {
  readonly id: number;
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly attestSignature: string;
  /** The pools.fun wire contract requires the creation tx hash as a validated hint. */
  readonly createTxHash: string;
}

/**
 * Claim up to `limit` signed, non-terminal pools.fun tokens, least-recently-
 * attempted first, stamping `pools_attribution_attempted_at` in the SAME
 * statement.
 *
 * `chainId` is deliberately NOT a parameter. The trench claims take one because
 * they predate the second venue and their callers pin `TRENCH_CHAIN_ID`; here
 * the launchpad IS the selector, and adding a chain parameter would invite a
 * caller to narrow the sweep to one chain and silently strand pools.fun launches
 * on any other.
 *
 * Both terminal columns are in the predicate: a DEFINITIVELY REFUSED row must
 * leave the candidate set for good, exactly as an attributed one does.
 * Otherwise the retry window would keep re-serving a row whose answer can never
 * change, which is the starvation `token-launch-intents/sweep-claim.ts`
 * documents, dressed up as politeness.
 *
 * `FOR UPDATE SKIP LOCKED` gives two concurrent sweeps disjoint batches.
 */
export async function claimPoolsAttributionCandidates(input: {
  limit: number;
  retryWindowSeconds: number;
}): Promise<PoolsAttributionCandidate[]> {
  const rows = await query<Record<string, unknown>>(
    `WITH candidates AS (
       SELECT id AS candidate_id
         FROM launched_tokens
        WHERE launchpad = 'pools_fun'
          AND pools_attributed_at IS NULL
          AND pools_attribution_rejected_at IS NULL
          AND pools_attest_signature IS NOT NULL
          AND (pools_attribution_attempted_at IS NULL
               OR pools_attribution_attempted_at < NOW() - ($2 || ' seconds')::interval)
        ORDER BY pools_attribution_attempted_at ASC NULLS FIRST, id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE launched_tokens t
        SET pools_attribution_attempted_at = NOW()
       FROM candidates c
      WHERE t.id = c.candidate_id
      RETURNING t.id, t.chain_id, t.token_address, t.pools_attest_signature, t.create_tx_hash`,
    [input.limit, String(input.retryWindowSeconds)],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    chainId: Number(r.chain_id),
    tokenAddress: r.token_address as string,
    attestSignature: r.pools_attest_signature as string,
    createTxHash: r.create_tx_hash as string,
  }));
}

/**
 * The badge landed. Terminal - the row leaves the sweep's candidate set for good.
 *
 * CAS on BOTH terminal columns, not just its own: a row already refused must not
 * be flipped to attributed by a late success arriving after the refusal was
 * recorded. `false` means the row was already terminal and this call changed
 * nothing.
 *
 * Migration 094's `launched_tokens_pools_terminal_requires_signature` is the
 * backstop under this: a row with no `pools_attest_signature` (every trench row)
 * cannot reach a terminal state at all, so a mis-routed id fails loudly at the
 * database rather than silently marking the wrong venue's token.
 */
export async function markPoolsAttributed(input: { id: number }): Promise<boolean> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE launched_tokens SET pools_attributed_at = NOW()
      WHERE id = $1
        AND pools_attributed_at IS NULL
        AND pools_attribution_rejected_at IS NULL
      RETURNING id`,
    [input.id],
  );
  return row !== null;
}

/**
 * pools.fun DEFINITIVELY refused the badge. Terminal, with the reason recorded.
 *
 * Reserved for answers that cannot change on a retry. A timeout, a 5xx, or a
 * dropped connection is NOT one of these: the caller leaves those non-terminal
 * so the retry window picks the row up again. Collapsing the two would burn a
 * launch's badge on a transient network failure.
 *
 * The code vocabulary is FROZEN and owned by
 * `src/tools/pools-fun/attribution-codes.ts`; this signature imports the type
 * (type-only, so no runtime dependency crosses the layer) and migration 094's
 * `launched_tokens_pools_rejection_code_valid` CHECK restates the same three
 * literals. A lockstep test guards the module-to-SQL half of that pairing.
 *
 * Same both-columns CAS as `markPoolsAttributed`, for the mirror-image reason:
 * a refusal arriving after the badge already landed must not overwrite it.
 */
export async function markPoolsAttributionRejected(input: {
  id: number;
  code: PoolsAttestTerminalCode;
}): Promise<boolean> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE launched_tokens
        SET pools_attribution_rejected_at = NOW(),
            pools_attribution_rejection_code = $2
      WHERE id = $1
        AND pools_attributed_at IS NULL
        AND pools_attribution_rejected_at IS NULL
      RETURNING id`,
    [input.id, input.code],
  );
  return row !== null;
}

/**
 * pools.fun tokens that can NEVER be attributed by the sweep: unattributed, with
 * no stored pools signature. Counted rather than claimed, for the identical
 * reason the trench lane counts its own - the sweep holds no signer, so
 * re-serving these would be a loop that can only fail.
 *
 * No `chainId` parameter, matching the claim: the launchpad is the selector.
 * An unsigned row is non-terminal BY CONSTRUCTION (094's
 * `launched_tokens_pools_terminal_requires_signature`), so this count can never
 * quietly include rows that already reached an end state.
 */
export async function countPoolsUnsignedAttributionGap(): Promise<number> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT COUNT(*)::int AS gap FROM launched_tokens
      WHERE launchpad = 'pools_fun'
        AND pools_attributed_at IS NULL
        AND pools_attest_signature IS NULL`,
  );
  return row === null ? 0 : Number(row.gap);
}

/** Case-insensitive identity lookup — the same notion of identity as the unique index. */
export async function getByIdentity(
  chainId: number,
  tokenAddress: string,
): Promise<LaunchedToken | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM launched_tokens
      WHERE chain_id = $1 AND LOWER(token_address) = LOWER($2)`,
    [chainId, tokenAddress],
  );
  return row ? mapRow(row) : null;
}

/**
 * One wallet's launch history, most recent first — the `trench.my_launches`
 * read path.
 *
 * `walletAddresses` is the SERVER-RESOLVED selected-wallet set, never a
 * model-supplied address: a read tool that let the model name the wallet would
 * let it read another wallet's history. `chainId` narrows to one chain when
 * given; omitted means every chain this wallet has launched on.
 */
export async function listForWallets(input: {
  walletAddresses: readonly string[];
  chainId?: number;
  limit: number;
}): Promise<LaunchedToken[]> {
  const lowered = input.walletAddresses.map((a) => a.toLowerCase());
  const params: unknown[] = [lowered];
  let chainPredicate = "";
  if (input.chainId !== undefined) {
    params.push(input.chainId);
    chainPredicate = ` AND chain_id = $${params.length}`;
  }
  params.push(input.limit);
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM launched_tokens
      WHERE LOWER(wallet_address) = ANY($1::text[])${chainPredicate}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapRow);
}
