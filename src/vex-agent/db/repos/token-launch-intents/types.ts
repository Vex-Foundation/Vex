/**
 * Token-launch intents — row shape, domain types, and the row→domain mapper
 * (migration `062_trench_launch.sql`).
 *
 * Pure shape only: no state-machine policy (that lives in `./writers.js`) and no
 * queries (`./reads.js`). Extracted from the parent `../token-launch-intents.js`
 * facade, which keeps its name and its public entry point so no caller's import
 * changes; see that file for the C1 contract this shape serves.
 */

import type { PoolClient } from "pg";

export type TokenLaunchIntentOrigin = "user" | "agent_requested_form" | "agent";

export type TokenLaunchIntentStatus =
  /**
   * ADVISORY, and NON-LIVE by construction (migration 082). A pools.fun preview
   * writes one of these so Agent Scan can surface previews from intents rather
   * than from hashless activity rows. It carries no authorization and no hash -
   * the database refuses one that does - consumes no launch ceiling, takes no
   * image lock, and CANNOT transition into signing: the signing path
   * CAS-consumes an `authorization_id`, and a previewed row has none, so a real
   * launch must start a fresh intent.
   */
  | "previewed"
  | "awaiting_user_form"
  | "authorized"
  | "consuming"
  | "broadcast_pending"
  | "confirmed"
  /**
   * VIRTUALS ONLY, and deliberately NOT a failure (migration 110).
   *
   * A Virtuals launch takes two transactions and only the first is ours.
   * `BondingV5.preLaunch` confirmed - the agent token exists, its pair exists,
   * the creator's VIRTUAL is inside BondingV5 - and the second, the keeper's
   * `BondingV5.launch(token)`, has not been OBSERVED within the bounded wait
   * the signing handler could hold. Nothing is wrong: the keeper's own
   * transaction is what lists the agent, Vex must never send it (doing so on
   * 2026-09-04 cost token `0xd1eF7097` its listing), and the sweep observes it
   * later without a signer.
   *
   * Migration 110 requires `protocol = 'virtuals'`, a `tx_hash` and a
   * `token_address` on this status: all three were established before it could
   * be reached, and a row asserting the state without them is a defect the
   * schema refuses to store.
   *
   * THE VEX FEE IS WAIVED HERE, PERMANENTLY (owner F3). The fee is collectible
   * only while the handler still owns the approved signer; a reconciliation has
   * none, so a later collection would be a transfer nobody authorized. Reaching
   * this status is the waiver, not a deferral.
   */
  | "awaiting_keeper"
  | "terminal_failure"
  | "cancelled"
  | "expired"
  /**
   * NO LONGER TRACKED, OUTCOME UNPROVEN - terminal, and deliberately NOT a
   * failure. Mirrors `agent_activity.superseded_unproven` (migration 068) and
   * means exactly the same thing here: no node can account for this hash and
   * the pending lane stopped tracking it. The lane reaches that terminal from
   * EITHER a proven nonce supersession OR a transaction unknown to the node,
   * and the intent does not record which - so nothing downstream may claim
   * "another transaction replaced it" (Codex final review 2026-08-05). What
   * actually happened was never established. The token may exist.
   *
   * `terminal_failure` would assert the create did not happen, which nothing
   * established, so this status carries NO `failure_reason`. Migration 072
   * admits it and requires `tx_hash IS NOT NULL` - the hash is the whole
   * evidence.
   */
  | "superseded_unproven";

/**
 * Which C0 authorization variant authorized this launch.
 *
 * `full_autonomy` is deliberately NOT called consent anywhere in this codebase:
 * it is trusted host/engine evidence that a mission was permitted to spend, and
 * no human acted. Naming it consent would misdescribe the audit record.
 *
 * `session_full` is the CHAT counterpart of that evidence (owner decree
 * 2026-08-02): the user put THIS session in full permission and asked for a
 * launch in it. That is the same consent basis every other mutating tool
 * executes on in full mode, but it is neither a resolved approval card nor a
 * mission contract, so it gets its own name rather than borrowing one that
 * would name evidence that does not exist. Migration 064 admits it.
 */
export type LaunchAuthorizationKind =
  | "user_submit"
  | "approval_card"
  | "full_autonomy"
  | "session_full";

/**
 * The statuses that still hold LIVE money state — an intent that may yet sign,
 * or one that has signed and not settled.
 *
 * Consumed by the image-locker delete refusal (C2: an image may not be deleted
 * while a live intent references it) and by anything asking "is this session
 * mid-launch?". Kept here rather than inlined at each call site so the two
 * cannot drift into disagreeing about what "live" means.
 */
export const LIVE_TOKEN_LAUNCH_INTENT_STATUSES: readonly TokenLaunchIntentStatus[] = [
  "awaiting_user_form",
  "authorized",
  "consuming",
  "broadcast_pending",
];

/**
 * `awaiting_keeper` is deliberately ABSENT from the list above, and the reason
 * is the definition of that list rather than an oversight.
 *
 * "Live" here means a row that may yet SIGN, or that has signed and not
 * settled. An `awaiting_keeper` row has signed AND settled: its `preLaunch`
 * confirmed, the token address is decoded, and nothing about it can reach a
 * signature again - the only remaining event is somebody else's transaction.
 * The image-locker delete refusal reads this list, and holding a user's image
 * hostage to a launch that already happened would be a bug, not a safeguard.
 */

/**
 * The live statuses whose ONLY forward transition carries `expires_at > NOW()`
 * in its own predicate: `awaiting_user_form` can only be authorized or
 * cancelled, and `authorized` can only be consumed, and both CAS writers in
 * `./writers.js` require an unexpired window. So once `expires_at` has passed,
 * a row in either status can NEVER reach a signature; it holds no live money
 * state, only a stale label.
 *
 * `consuming` and `broadcast_pending` are deliberately NOT here.
 * `markBroadcastPendingWith` has no expiry predicate, so a `consuming` row may
 * still sign after its window lapses, and a `broadcast_pending` row already
 * signed.
 *
 * Consumed by the image-locker delete refusal, which must not hold a user's
 * image hostage to a launch that can never happen. Only the expiry sweep
 * (`sync/launch-form-expiry.ts`) stamps a lapsed row terminal, and it covers
 * `awaiting_user_form` alone, so a lapsed `authorized` row keeps its status
 * indefinitely.
 */
export const EXPIRY_BOUND_TOKEN_LAUNCH_INTENT_STATUSES: readonly TokenLaunchIntentStatus[] = [
  "awaiting_user_form",
  "authorized",
];

/**
 * Why a form continuation was retired without its turn ever running. Mirrors
 * the CHECK constraint in migration 070 — both halves of one closed vocabulary.
 *
 *   `session_deleted`             the session is gone (removed or soft-deleted),
 *                                 so there is no history to resume against.
 *   `resume_failed_deterministic` the same deterministic provider refusal on two
 *                                 consecutive attempts with an unchanged prompt.
 */
export type UserFormContinuationCloseReason =
  | "session_deleted"
  | "resume_failed_deterministic";

export interface TokenLaunchIntent {
  intentId: string;
  sessionId: string;
  origin: TokenLaunchIntentOrigin;
  status: TokenLaunchIntentStatus;
  chainId: number;
  walletAddress: string;
  name: string;
  symbol: string;
  description: string | null;
  links: Record<string, unknown>;
  imageId: string | null;
  /** Raw wei. Always read WITH `prebuyDecimals` — a bare raw amount is unreadable (rule 90). */
  prebuyRaw: string | null;
  prebuyDecimals: number | null;
  authorizationId: string | null;
  authorizationKind: LaunchAuthorizationKind | null;
  authorizedAt: string | null;
  /**
   * The §C3b continuation's durable anchors — set only on the
   * `agent_requested_form` path, the ONE path where an agent's turn is parked.
   * A `user`-origin launch resumes nothing; an `agent` (Path 2) launch never
   * parked. `toolCallId` is the id of the ORIGINAL parked
   * `trench.launch_request_form` call, without which a resumed tool result
   * answers no pending call.
   */
  toolCallId: string | null;
  missionRunId: string | null;
  /** `messages.id` of the appended tool-result row — stamped in the SAME transaction as that row. */
  resultMessageId: number | null;
  /**
   * When a resumed turn COMPLETED for this form. The only thing that ends the
   * continuation's eligibility — `resultMessageId` says the transcript has the
   * answer, which is true long before the turn that answer exists for has run.
   */
  resumeConsumedAt: string | null;
  /**
   * Why the continuation was closed WITHOUT a resumed turn ever running, or
   * `null` for the ordinary path where one did. Describes the owed model turn
   * only — never the launch's own outcome.
   */
  resumeClosedReason: UserFormContinuationCloseReason | null;
  txHash: string | null;
  tokenAddress: string | null;
  failureReason: string | null;
  /**
   * The persisted C0 consent snapshot. `unknown` on purpose: the reader
   * (`execute-user-submit.ts` `parseStoredBinding`) schema-validates it as
   * untrusted input before anything acts on it. Typing it as a trusted shape
   * here would make every reader believe a stored row it never checked.
   */
  authorizationJson: unknown;
  expiresAt: string;
  /** Migration 082: which launchpad this intent belongs to. */
  protocol: TokenLaunchIntentProtocol;
  /** Migration 082: pools.fun fields, `null` on a Trench intent. */
  pools: PoolsLaunchIntentFields | null;
  /**
   * Migration 110: the Virtuals launch block, `null` on every other launchpad.
   *
   * `unknown` for the same reason `authorizationJson` is: `mapRow` hands back
   * what the database held, and the launch lane's own reader validates it
   * before acting. Typing it as the trusted shape here would make every reader
   * believe a row it never checked.
   */
  virtuals: unknown;
  consumedAt: string | null;
  cancelledAt: string | null;
  broadcastAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
}

/** The launchpad an intent belongs to (migration 082's discriminator). */
export type TokenLaunchIntentProtocol = "trench" | "pools_fun" | "virtuals";

/**
 * pools.fun launch fields.
 *
 * `pairedAsset` is the SYMBOLIC pair; `pairedAssetAddress` is the address the
 * calldata verifier proved it maps to. Both are stored because the verifier's
 * job is to show they agree, and a record keeping only one could not be audited
 * afterwards.
 */
export interface PoolsLaunchIntentFields {
  readonly pairedAsset: "weth" | "usdg";
  readonly pairedAssetAddress?: string | null | undefined;
  /** The RESOLVED recipient address, whatever choice produced it. */
  readonly feeRecipientAddress?: string | null | undefined;
  readonly metadataUri?: string | null | undefined;
  readonly imageUrl?: string | null | undefined;
  readonly predictedTokenAddress?: string | null | undefined;
  readonly gatewayAddress?: string | null | undefined;
  readonly deploymentFeeWei?: string | null | undefined;
}

/**
 * The Virtuals launch block (migration 110), stored as one JSONB column.
 *
 * `unknown` is deliberately NOT used for the shape the way `authorizationJson`
 * is, because unlike that blob this one is written and read by the SAME lane
 * and every field has a named consumer. What IS shared with it is the reading
 * discipline: `mapRow` performs no validation, so the launch lane's own reader
 * schema-checks the block before anything acts on it (rule 04 - a durable row
 * is untrusted input).
 *
 * The fields that already have a column on this table are NOT repeated here:
 * chain, wallet, name, symbol, description, links, image id, the committed
 * amount (`prebuyRaw`/`prebuyDecimals`), the transaction hash and the token
 * address mean exactly what they mean for the other launchpads.
 */
export interface VirtualsLaunchIntentFields {
  /** The canonical chain slug the deployment table names: `base` or `robinhood`. */
  readonly chainKey: string;
  /** `BondingV5` - the contract signed, recorded so an upgrade is auditable. */
  readonly bondingV5: string;
  /** The PUBLIC content-addressed image URL written into `preLaunch`. */
  readonly imageUrl: string;
  /** The content id the launch-assets host addressed those bytes by. */
  readonly imageCid?: string | null | undefined;
  /** `cores_`, the venue's capability ids. */
  readonly cores: readonly number[];
  /** `antiSniperTaxType_`, 0-5 (`BondingConfig.sol:30-35`). */
  readonly antiSniperTaxType: number;
  /** Whether `" by Virtuals"` was appended, and therefore the on-chain name. */
  readonly nameSuffix: "by_virtuals" | "none";
  /** The name the ERC-20 actually carries - what the approval displayed. */
  readonly onChainName: string;
  /** twitter, telegram, youtube, website - the contract's fixed order. */
  readonly urls: readonly [string, string, string, string];
  /** `keccak256(chainId | to | value | data)` of the exact `preLaunch` call. */
  readonly calldataFingerprint: string;
  /** `purchaseAmount_`: what the venue receives. `committed - vexFee`. */
  readonly launchAmountRaw: string;
  /** `calculateLaunchFee(false, false)` at the pinned block. Measured 0. */
  readonly protocolFeeRaw: string;
  /** Vex's 25 bps, or `null` when it floored to zero. */
  readonly vexFeeRaw?: string | null | undefined;
  /** The pair `PreLaunched` named, once the receipt is decoded. */
  readonly pairAddress?: string | null | undefined;
  /** `virtualId` from `PreLaunched`. */
  readonly virtualId?: string | null | undefined;
  /** `initialPurchase` from `PreLaunched` - exactly what a cancel refunds. */
  readonly initialPurchaseRaw?: string | null | undefined;
  /** The block `preLaunch` landed in; the sweep scans for `Launched` from it. */
  readonly preLaunchBlock?: string | null | undefined;
  /** The keeper's `launch()` hash, once observed. */
  readonly keeperLaunchTxHash?: string | null | undefined;
  /** True once the fee leg was skipped for good under owner F3. */
  readonly vexFeeWaived?: boolean | undefined;
}

export interface CreateTokenLaunchIntentInput {
  intentId: string;
  sessionId: string;
  origin: TokenLaunchIntentOrigin;
  /**
   * The path's ENTRY state — `awaiting_user_form` when a human still has to fill
   * the form, `authorized` when the C0 record IS the entry (Path 2 full autonomy
   * and the restricted approval path). Deliberately explicit and deliberately
   * narrowed to those two: defaulting it would make one of the two paths
   * silently wrong, and every other status must be reached by a CAS transition.
   */
  /**
   * The ENTRY state. `previewed` joins the two live entries because a pools.fun
   * preview is created directly in it and never transitions out - see the
   * status union.
   */
  status: Extract<TokenLaunchIntentStatus, "previewed" | "awaiting_user_form" | "authorized">;
  chainId: number;
  walletAddress: string;
  name: string;
  symbol: string;
  description?: string | null;
  links?: Record<string, unknown>;
  imageId?: string | null;
  prebuyRaw?: string | null;
  prebuyDecimals?: number | null;
  authorizationId?: string | null;
  authorizationKind?: LaunchAuthorizationKind | null;
  /**
   * The C0 consent snapshot, persisted AS-IS. `unknown` on purpose, on both
   * sides: the writer stays dumb (it has no business deciding what a valid
   * authorization looks like) and the READER schema-validates it as untrusted
   * input before anything acts on it. Typing it as a trusted shape here would
   * make every reader believe a stored row it never checked.
   */
  authorizationJson?: unknown;
  /**
   * REQUIRED on the `agent_requested_form` path and forbidden nowhere else —
   * the DB CHECK `token_launch_intents_form_path_has_tool_call` enforces it.
   * Optional in the type because the other two origins genuinely have no parked
   * call to name.
   */
  toolCallId?: string | null;
  missionRunId?: string | null;
  /**
   * The whole pre-authorization window AND the §C3b continuation's expiry — one
   * timestamp, deliberately. Two could only ever disagree, and a continuation
   * that expires at a different moment from the form it resumes is how a turn
   * hangs or resumes against a form the user can still submit.
   */
  /**
   * WHICH LAUNCHPAD this intent belongs to (migration 082). Defaults to
   * `"trench"` in the database, so an omitted value keeps every existing caller
   * writing exactly the rows it wrote before.
   */
  protocol?: TokenLaunchIntentProtocol | undefined;
  /**
   * The pools.fun launch fields. All optional and all meaningless on a Trench
   * intent, which has no pair (its curve is ETH by construction). The database
   * requires `pairedAsset` on any `pools_fun` row.
   */
  pools?: PoolsLaunchIntentFields | undefined;
  /**
   * The Virtuals launch block (migration 110). Required by the database on a
   * `virtuals` intent and forbidden on every other launchpad.
   */
  virtuals?: VirtualsLaunchIntentFields | undefined;
  expiresAt: string;
}

// ── ISO normalisation (TIMESTAMPTZ → Date; mirrors the wallet-intents repo) ──

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoOrNull(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}

/**
 * `null` stays `null`; anything else becomes a number.
 *
 * NOT truthiness: `0` decimals is a real, valid answer and must survive. node-pg
 * returns SMALLINT as a number and BIGINT as a string, so both are normalised
 * through one place.
 */
function nullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/** Every column of the table, in declaration order. The ONE list both writers and reads select. */
export const SELECT_COLUMNS =
  "intent_id, session_id, origin, status, chain_id, wallet_address, " +
  "name, symbol, description, links, image_id, prebuy_raw, prebuy_decimals, " +
  "authorization_id, authorization_kind, authorized_at, " +
  "tool_call_id, mission_run_id, result_message_id, resume_consumed_at, " +
  "resume_closed_reason, " +
  "tx_hash, token_address, " +
  "failure_reason, authorization_json, expires_at, consumed_at, cancelled_at, broadcast_at, " +
  "confirmed_at, created_at, " +
  // Migration 082. Selected for every reader so a pools intent can be READ back
  // as a pools intent - a field that can be written but not read is half a
  // feature, and Agent Scan needs `protocol` to surface previews distinctly.
  "protocol, paired_asset, paired_asset_address, fee_recipient_address, " +
  "metadata_uri, image_url, predicted_token_address, gateway_address, deployment_fee_wei, " +
  // Migration 110. Selected for every reader for the same reason the pools
  // columns are: a field that can be written but not read is half a feature,
  // and the keeper sweep reads this block to know which token to look for.
  "virtuals";

export function mapRow(r: Record<string, unknown>): TokenLaunchIntent {
  return {
    intentId: r.intent_id as string,
    sessionId: r.session_id as string,
    origin: r.origin as TokenLaunchIntentOrigin,
    status: r.status as TokenLaunchIntentStatus,
    chainId: Number(r.chain_id),
    walletAddress: r.wallet_address as string,
    name: r.name as string,
    symbol: r.symbol as string,
    description: (r.description as string | null) ?? null,
    links: (r.links as Record<string, unknown>) ?? {},
    imageId: (r.image_id as string | null) ?? null,
    prebuyRaw: (r.prebuy_raw as string | null) ?? null,
    prebuyDecimals: nullableInt(r.prebuy_decimals),
    authorizationId: (r.authorization_id as string | null) ?? null,
    authorizationKind: (r.authorization_kind as LaunchAuthorizationKind | null) ?? null,
    authorizedAt: toIsoOrNull(r.authorized_at as string | Date | null),
    toolCallId: (r.tool_call_id as string | null) ?? null,
    missionRunId: (r.mission_run_id as string | null) ?? null,
    resultMessageId: nullableInt(r.result_message_id),
    resumeConsumedAt: toIsoOrNull(r.resume_consumed_at as string | Date | null),
    resumeClosedReason:
      (r.resume_closed_reason as UserFormContinuationCloseReason | null) ?? null,
    txHash: (r.tx_hash as string | null) ?? null,
    tokenAddress: (r.token_address as string | null) ?? null,
    failureReason: (r.failure_reason as string | null) ?? null,
    authorizationJson: r.authorization_json ?? null,
    expiresAt: toIso(r.expires_at as string | Date),
    protocol: (r.protocol as TokenLaunchIntentProtocol | null) ?? "trench",
    // The whole pools block is null on a Trench intent rather than an object of
    // nulls: "this launchpad has no such fields" and "these fields are empty"
    // are different statements, and only the first is true here.
    pools: r.paired_asset === null || r.paired_asset === undefined
      ? null
      : {
        pairedAsset: r.paired_asset as "weth" | "usdg",
        pairedAssetAddress: (r.paired_asset_address as string | null) ?? null,
        feeRecipientAddress: (r.fee_recipient_address as string | null) ?? null,
        metadataUri: (r.metadata_uri as string | null) ?? null,
        imageUrl: (r.image_url as string | null) ?? null,
        predictedTokenAddress: (r.predicted_token_address as string | null) ?? null,
        gatewayAddress: (r.gateway_address as string | null) ?? null,
        deploymentFeeWei: (r.deployment_fee_wei as string | null) ?? null,
      },
    // Handed back exactly as stored. Validation belongs to the launch lane's
    // own reader, not to a mapper that has no idea what a valid block is.
    virtuals: r.virtuals ?? null,
    consumedAt: toIsoOrNull(r.consumed_at as string | Date | null),
    cancelledAt: toIsoOrNull(r.cancelled_at as string | Date | null),
    broadcastAt: toIsoOrNull(r.broadcast_at as string | Date | null),
    confirmedAt: toIsoOrNull(r.confirmed_at as string | Date | null),
    createdAt: toIso(r.created_at as string | Date),
  };
}

/**
 * Run one CAS `UPDATE … RETURNING` on the caller's transaction and map the row.
 *
 * `null` means the predicate MISSED — a hard "race lost" signal, never a silent
 * success. Callers MUST gate on it; for `consumeIfAuthorizedWith` in particular,
 * ignoring `null` would mean signing a launch twice.
 */
export async function casRow(
  client: PoolClient,
  sql: string,
  params: readonly unknown[],
): Promise<TokenLaunchIntent | null> {
  const res = await client.query<Record<string, unknown>>(sql, [...params]);
  const row = res.rows[0];
  return row === undefined ? null : mapRow(row);
}
