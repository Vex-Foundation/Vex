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
   * Which launchpad produced the token: `trench_express` or `pools_fun`
   * (migration 082). Defaults to `trench_express` for callers that predate the
   * second venue - named rather than assumed. Both venues share chain 4663, so
   * this is the ONLY thing that tells the two populations apart.
   */
  launchpad?: string;
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
      input.launchpad ?? "trench_express",
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
 * Attach the creator's attest signature to an already-recorded token.
 *
 * A SEPARATE write from `record` on purpose: `record` is `DO NOTHING`, so a row
 * the identity-repair sweep inserted first would silently swallow the signature
 * the handler holds — and the handler is the ONLY thing that can ever produce
 * one (nothing after it holds a signer). `attest_signature IS NULL` in the
 * predicate keeps it write-once: a re-run never replaces a stored signature.
 *
 * Returns whether this call stored it.
 */
export async function stampAttestSignature(input: {
  chainId: number;
  tokenAddress: string;
  attestSignature: string;
}): Promise<boolean> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE launched_tokens
        SET attest_signature = $3
      WHERE chain_id = $1 AND LOWER(token_address) = LOWER($2)
        AND attest_signature IS NULL
      RETURNING id`,
    [input.chainId, input.tokenAddress, input.attestSignature],
  );
  return row !== null;
}

/** What the attribution sweep needs to make one POST, and nothing more. */
export interface AttributionCandidate {
  id: number;
  chainId: number;
  tokenAddress: string;
  attestSignature: string;
}

/**
 * Claim up to `limit` signed-but-unattributed tokens, least-recently-attempted
 * first, stamping `attribution_attempted_at` in the SAME statement.
 *
 * The stamp is what makes the window advance: attribution can be refused
 * permanently (a 403 is not retryable into a success), and without the stamp the
 * same 25 refused rows would be re-served on every pass forever while row 26 is
 * never reached — the starvation `token-launch-intents/sweep-claim.ts` documents.
 * `retryAfterSeconds` keeps a just-attempted row out of the next pass.
 *
 * `FOR UPDATE SKIP LOCKED` gives two concurrent sweeps disjoint batches.
 *
 * CONFINED TO `trench_express`. `chain_id` alone stopped being a venue selector
 * at migration 082: pools.fun launches land on the SAME chain 4663, and their
 * badge is claimed against a different endpoint with a differently-formatted
 * signature (`pools_attest_signature`). Without this predicate the trench sweep
 * would POST a pools.fun token to trench.express and stamp
 * `attribution_attempted_at` on a row it can never attribute. The value is
 * exact, not an allow-list: a third launchpad must opt in deliberately.
 */
export async function claimAttributionCandidates(input: {
  chainId: number;
  limit: number;
  retryAfterSeconds: number;
}): Promise<AttributionCandidate[]> {
  const rows = await query<Record<string, unknown>>(
    `WITH candidates AS (
       SELECT id AS candidate_id
         FROM launched_tokens
        WHERE chain_id = $1
          AND launchpad = 'trench_express'
          AND attributed_at IS NULL
          AND attest_signature IS NOT NULL
          AND (attribution_attempted_at IS NULL
               OR attribution_attempted_at < NOW() - ($3 || ' seconds')::interval)
        ORDER BY attribution_attempted_at ASC NULLS FIRST, id ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE launched_tokens t
        SET attribution_attempted_at = NOW()
       FROM candidates c
      WHERE t.id = c.candidate_id
      RETURNING t.id, t.chain_id, t.token_address, t.attest_signature`,
    [input.chainId, input.limit, String(input.retryAfterSeconds)],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    chainId: Number(r.chain_id),
    tokenAddress: r.token_address as string,
    attestSignature: r.attest_signature as string,
  }));
}

/** The badge landed. Terminal — the row leaves the sweep's candidate set for good. */
export async function markAttributed(id: number): Promise<boolean> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE launched_tokens SET attributed_at = NOW()
      WHERE id = $1 AND attributed_at IS NULL
      RETURNING id`,
    [id],
  );
  return row !== null;
}

/**
 * What the AgentScan attestation sweep needs to make one POST. A SEPARATE
 * candidate set from `AttributionCandidate` — same signature, two independent
 * consumers — plus the creation tx hash the AgentScan wire contract requires
 * as a validated hint (trench.express's own `/vex/attribute` never asked for
 * one).
 */
export interface AgentscanAttestCandidate {
  id: number;
  chainId: number;
  tokenAddress: string;
  attestSignature: string;
  createTxHash: string;
}

/**
 * Claim up to `limit` signed-but-unattested (AgentScan) tokens, least-recently-
 * attempted first, stamping `agentscan_attest_attempted_at` in the SAME
 * statement. Mirrors `claimAttributionCandidates` verbatim in shape, over the
 * 074 pair of columns instead of 071's — a permanently-refused row moves to
 * the back of the queue instead of starving row 26, and `FOR UPDATE SKIP
 * LOCKED` gives two concurrent sweeps disjoint batches.
 *
 * CONFINED TO `trench_express`, like its 071 twin and for a sharper reason:
 * `attest_signature` carries the TRENCH-formatted proof, so a pools.fun row
 * selected here would ship a signature over the wrong message to AgentScan.
 * Whether AgentScan should also receive pools.fun attestations (over
 * `pools_attest_signature`) is a real product question and an EXPLICIT future
 * decision - not something this predicate should answer by accident.
 */
export async function claimAgentscanAttestCandidates(input: {
  chainId: number;
  limit: number;
  retryAfterSeconds: number;
}): Promise<AgentscanAttestCandidate[]> {
  const rows = await query<Record<string, unknown>>(
    `WITH candidates AS (
       SELECT id AS candidate_id
         FROM launched_tokens
        WHERE chain_id = $1
          AND launchpad = 'trench_express'
          AND agentscan_attested_at IS NULL
          AND attest_signature IS NOT NULL
          AND (agentscan_attest_attempted_at IS NULL
               OR agentscan_attest_attempted_at < NOW() - ($3 || ' seconds')::interval)
        ORDER BY agentscan_attest_attempted_at ASC NULLS FIRST, id ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE launched_tokens t
        SET agentscan_attest_attempted_at = NOW()
       FROM candidates c
      WHERE t.id = c.candidate_id
      RETURNING t.id, t.chain_id, t.token_address, t.attest_signature, t.create_tx_hash`,
    [input.chainId, input.limit, String(input.retryAfterSeconds)],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    chainId: Number(r.chain_id),
    tokenAddress: r.token_address as string,
    attestSignature: r.attest_signature as string,
    createTxHash: r.create_tx_hash as string,
  }));
}

/** The AgentScan attestation landed. Terminal — the row leaves the sweep's candidate set for good. */
export async function markAgentscanAttested(id: number): Promise<boolean> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE launched_tokens SET agentscan_attested_at = NOW()
      WHERE id = $1 AND agentscan_attested_at IS NULL
      RETURNING id`,
    [id],
  );
  return row !== null;
}

/**
 * Trench tokens on this chain that can NEVER be attributed by the sweep:
 * unattributed, with no stored signature. Counted rather than claimed, because
 * the sweep holds no signer and re-serving them would be a loop that can only
 * fail.
 *
 * CONFINED TO `trench_express`. This number is LOGGED AS A GAP - an operator
 * reads it as "this many trench launches will never get their badge". Before
 * migration 082 `chain_id` was a faithful proxy for the venue; since then every
 * pools.fun launch has been inflating this count with rows the trench sweep was
 * never responsible for. The pools lane counts its own gap
 * (`countPoolsUnsignedAttributionGap`).
 */
export async function countUnsignedAttributionGap(chainId: number): Promise<number> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT COUNT(*)::int AS gap FROM launched_tokens
      WHERE chain_id = $1
        AND launchpad = 'trench_express'
        AND attributed_at IS NULL
        AND attest_signature IS NULL`,
    [chainId],
  );
  return row === null ? 0 : Number(row.gap);
}

// ── pools.fun attribution lane (migration 087) ──────────────────────────────
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
 * WRITE-ONCE, exactly like `stampAttestSignature`: `pools_attest_signature IS
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
 * Migration 087's `launched_tokens_pools_terminal_requires_signature` is the
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
 * (type-only, so no runtime dependency crosses the layer) and migration 087's
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
 * An unsigned row is non-terminal BY CONSTRUCTION (087's
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
