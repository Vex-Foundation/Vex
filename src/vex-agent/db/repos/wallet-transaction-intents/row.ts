/**
 * The `wallet_transaction_intents` DTO, its column list, and the STRICT row
 * parser that turns a PostgreSQL row into it.
 *
 * MOVE-ONLY extraction from the sibling `../wallet-transaction-intents.ts`,
 * which keeps its name, its SQL and its public exports - every symbol here is
 * re-exported from there, so no import site moved. Different reason to change:
 * this file changes when the ROW SHAPE or its validation does; the parent
 * changes when a CAS predicate or a lifecycle transition does. The split also
 * keeps the parent under the repository's file-size alert.
 */

import {
  DecodedWalletTransactionSchema,
  EvmTransactionPayloadSchema,
  SolanaTransactionPayloadSchema,
  WalletTransactionFeeBoundsSchema,
  WalletTransactionPreviewSchema,
  WALLET_TRANSACTION_FAILURE_STAGES,
  WALLET_TRANSACTION_FAMILIES,
  WALLET_TRANSACTION_INTENT_STATUSES,
  type DecodedWalletTransaction,
  type WalletTransactionFailureStage,
  type WalletTransactionFamily,
  type WalletTransactionFeeBounds,
  type WalletTransactionIntentStatus,
  type WalletTransactionPreview,
  type EvmTransactionPayload,
  type SolanaTransactionPayload,
} from "../../contracts/wallet-transaction-intent.js";
import { toIso, toIsoOrNull } from "../wallet-intent-lifecycle.js";

// ── DTO ────────────────────────────────────────────────────────────────

export type WalletTransactionPayload =
  | { readonly family: "eip155"; readonly evm: EvmTransactionPayload }
  | { readonly family: "solana"; readonly solana: SolanaTransactionPayload };

export interface WalletTransactionIntent {
  readonly intentId: string;
  readonly sessionId: string;
  readonly walletAddress: string;
  readonly family: WalletTransactionFamily;
  readonly chainAlias: string | null;
  /** Numeric EVM chain id; null for Solana. */
  readonly chainId: number | null;
  readonly payload: WalletTransactionPayload;
  readonly decoded: DecodedWalletTransaction;
  readonly preview: WalletTransactionPreview;
  readonly feeBounds: WalletTransactionFeeBounds;
  readonly proposalDigest: string;
  readonly proposalDigestVersion: string;
  /** Solana only: the blockhash the canonical message carries. */
  readonly recentBlockhash: string | null;
  /** Solana only: the AUTHORITY for expiry. Block height has no timestamp. */
  readonly lastValidBlockHeight: number | null;
  readonly status: WalletTransactionIntentStatus;
  readonly failureStage: WalletTransactionFailureStage | null;
  readonly activityId: string | null;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly cancelledAt: string | null;
  readonly txHash: string | null;
  /** Structural label only (`ErrorKind:shortSha256`); never a raw provider message. */
  readonly failureReason: string | null;
  readonly createdAt: string;
}

export interface CreateWalletTransactionIntentInput {
  readonly intentId: string;
  readonly sessionId: string;
  readonly walletAddress: string;
  readonly family: WalletTransactionFamily;
  readonly chainAlias: string | null;
  readonly chainId: number | null;
  readonly payload: WalletTransactionPayload;
  readonly decoded: DecodedWalletTransaction;
  readonly preview: WalletTransactionPreview;
  readonly feeBounds: WalletTransactionFeeBounds;
  readonly proposalDigest: string;
  readonly proposalDigestVersion: string;
  readonly recentBlockhash: string | null;
  readonly lastValidBlockHeight: number | null;
  readonly expiresAt: string;
}

// ── Strict row parsing ─────────────────────────────────────────────────

export const SELECT_COLUMNS =
  "intent_id, session_id, wallet_address, family, chain_alias, chain_id, "
  + "payload_json, decoded_json, preview_json, fee_bounds_json, "
  + "proposal_digest, proposal_digest_version, recent_blockhash, last_valid_block_height, "
  + "status, failure_stage, activity_id, expires_at, consumed_at, cancelled_at, "
  + "tx_hash, failure_reason, created_at";

/**
 * A row read back from PostgreSQL is EXTERNAL INPUT (rule 04): it crossed
 * serialization and a process boundary, and the JSONB columns carry no type at
 * all. This is the ONE place that turns it into the typed DTO, so nothing
 * downstream casts and nothing downstream re-validates.
 *
 * It THROWS on a malformed row rather than returning a partial intent. A money
 * row we cannot parse is not a money row we may act on, and a silent
 * best-effort mapping here would reach the confirm path as an intent with an
 * empty preview and no fee bounds.
 */
/** A sha256 digest as this build writes it: 64 lowercase hex characters. */
const PROPOSAL_DIGEST_HEX = /^[0-9a-f]{64}$/;

function malformedRow(field: string, detail: string): never {
  // No value is interpolated: a money row we could not parse must not leak its
  // (untrusted) contents into a log line. The field name and the shape it
  // failed is enough to locate the row from its id, which the caller has.
  throw new Error(`wallet_transaction_intents row is malformed: ${field} ${detail}`);
}

function requireRowString(r: Record<string, unknown>, key: string): string {
  const value = r[key];
  if (typeof value !== "string" || value.length === 0) {
    malformedRow(key, "is not a non-empty string");
  }
  return value as string;
}

function optionalRowString(r: Record<string, unknown>, key: string): string | null {
  const value = r[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") malformedRow(key, "is not a string or null");
  return value;
}

function requireRowEnum<T extends string>(
  r: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = r[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    malformedRow(key, `is not one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

/**
 * A numeric column that may be null, coerced through Number and REJECTED unless
 * it lands on a safe integer. `Number("123abc")` is `NaN` and `Number(2n**60n)`
 * silently loses precision; a money row that depends on `chain_id` or
 * `last_valid_block_height` must not carry either past this boundary.
 */
function safeIntegerOrNull(r: Record<string, unknown>, key: string): number | null {
  const value = r[key];
  if (value === null || value === undefined) return null;
  const asNumber = typeof value === "bigint" ? Number(value) : Number(value as never);
  if (!Number.isSafeInteger(asNumber)) malformedRow(key, "is not a safe integer");
  return asNumber;
}

/**
 * A row read back from PostgreSQL is EXTERNAL INPUT (rule 04): it crossed
 * serialization and a process boundary, and the JSONB columns carry no type at
 * all. This is the ONE place that turns it into the typed DTO, so nothing
 * downstream casts and nothing downstream re-validates.
 *
 * It THROWS on a malformed row rather than returning a partial intent. A money
 * row we cannot parse is not a money row we may act on, and a silent
 * best-effort mapping here would reach the confirm path as an intent with an
 * empty preview and no fee bounds.
 *
 * The scalar columns are validated too, not only the JSONB ones: the family and
 * status against their closed vocabularies, the numeric columns against
 * `Number.isSafeInteger`, and the proposal digest against the hex shape this
 * build emits. The digest VERSION is deliberately NOT enum-checked here - an
 * unknown version is a valid row that the confirm path refuses with a specific
 * message, so it must survive the read to be refused honestly.
 */
export function parseDurableIntentRow(r: Record<string, unknown>): WalletTransactionIntent {
  const family = requireRowEnum(r, "family", WALLET_TRANSACTION_FAMILIES);
  const payload: WalletTransactionPayload =
    family === "eip155"
      ? { family: "eip155", evm: EvmTransactionPayloadSchema.parse(r.payload_json) }
      : { family: "solana", solana: SolanaTransactionPayloadSchema.parse(r.payload_json) };

  const proposalDigest = requireRowString(r, "proposal_digest");
  if (!PROPOSAL_DIGEST_HEX.test(proposalDigest)) {
    malformedRow("proposal_digest", "is not a 64-character lowercase hex sha256");
  }

  const failureStageRaw = r.failure_stage;
  const failureStage: WalletTransactionFailureStage | null =
    failureStageRaw === null || failureStageRaw === undefined
      ? null
      : requireRowEnum(r, "failure_stage", WALLET_TRANSACTION_FAILURE_STAGES);

  return {
    intentId: requireRowString(r, "intent_id"),
    sessionId: requireRowString(r, "session_id"),
    walletAddress: requireRowString(r, "wallet_address"),
    family,
    chainAlias: optionalRowString(r, "chain_alias"),
    chainId: safeIntegerOrNull(r, "chain_id"),
    payload,
    decoded: DecodedWalletTransactionSchema.parse(r.decoded_json),
    preview: WalletTransactionPreviewSchema.parse(r.preview_json),
    feeBounds: WalletTransactionFeeBoundsSchema.parse(r.fee_bounds_json),
    proposalDigest,
    proposalDigestVersion: requireRowString(r, "proposal_digest_version"),
    recentBlockhash: optionalRowString(r, "recent_blockhash"),
    lastValidBlockHeight: safeIntegerOrNull(r, "last_valid_block_height"),
    status: requireRowEnum(r, "status", WALLET_TRANSACTION_INTENT_STATUSES),
    failureStage,
    activityId: r.activity_id === null || r.activity_id === undefined ? null : String(r.activity_id),
    expiresAt: toIso(r.expires_at as string | Date),
    consumedAt: toIsoOrNull(r.consumed_at as string | Date | null),
    cancelledAt: toIsoOrNull(r.cancelled_at as string | Date | null),
    txHash: optionalRowString(r, "tx_hash"),
    failureReason: optionalRowString(r, "failure_reason"),
    createdAt: toIso(r.created_at as string | Date),
  };
}
