/**
 * The `wallet_wrap_intents` DTO, its column list, and the STRICT row parser
 * that turns a PostgreSQL row into it.
 *
 * Split from the sibling `../wallet-wrap-intents.ts` for the same reason the
 * 087 pair is split: this file changes when the ROW SHAPE or its validation
 * does; the parent changes when a CAS predicate or a lifecycle transition does.
 * Every symbol here is re-exported from the parent, so the parent stays the
 * single public gate of the repo.
 *
 * The contract identity is THREE columns and ONE DTO field. The migration keeps
 * `wrapped_native_address` / `_symbol` / `_decimals` flat so its payload-target
 * CHECK can compare the address against `payload_json ->> 'to'` in SQL; the DTO
 * carries the composed `WrapContractIdentity` because everything above this
 * boundary binds the identity as a unit into the proposal digest.
 */

import {
  WALLET_WRAP_FAILURE_STAGES,
  WALLET_WRAP_INTENT_STATUSES,
  WRAP_DIRECTIONS,
  WalletWrapFeeBoundsSchema,
  WrapAmountSchema,
  WrapContractIdentitySchema,
  WrapPreviewSchema,
  WrapTransactionPayloadSchema,
  type WalletWrapFailureStage,
  type WalletWrapFeeBounds,
  type WalletWrapIntentStatus,
  type WrapContractIdentity,
  type WrapPreview,
  type WrapTransactionPayload,
} from "../../contracts/wallet-wrap-intent.js";
import { toIso, toIsoOrNull } from "../wallet-intent-lifecycle.js";

// ── DTO ────────────────────────────────────────────────────────────────

export type WrapDirection = (typeof WRAP_DIRECTIONS)[number];

export interface WalletWrapIntent {
  readonly intentId: string;
  readonly sessionId: string;
  readonly walletAddress: string;
  /** EVM only: the table has no family column, so both are NOT NULL. */
  readonly chainAlias: string;
  readonly chainId: number;
  readonly direction: WrapDirection;
  /** Frozen at prepare from the verified registry; a later registry edit cannot move it. */
  readonly contract: WrapContractIdentity;
  /** Base units, decimal digits, positive. Never a number: wei exceeds a safe integer. */
  readonly amountRaw: string;
  readonly payload: WrapTransactionPayload;
  readonly preview: WrapPreview;
  readonly feeBounds: WalletWrapFeeBounds;
  readonly proposalDigest: string;
  readonly proposalDigestVersion: string;
  readonly status: WalletWrapIntentStatus;
  readonly failureStage: WalletWrapFailureStage | null;
  readonly activityId: string | null;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly cancelledAt: string | null;
  readonly txHash: string | null;
  /** Structural label only (`ErrorKind:shortSha256`); never a raw provider message. */
  readonly failureReason: string | null;
  readonly createdAt: string;
}

export interface CreateWalletWrapIntentInput {
  readonly intentId: string;
  readonly sessionId: string;
  readonly walletAddress: string;
  readonly chainAlias: string;
  readonly chainId: number;
  readonly direction: WrapDirection;
  readonly contract: WrapContractIdentity;
  readonly amountRaw: string;
  readonly payload: WrapTransactionPayload;
  readonly preview: WrapPreview;
  readonly feeBounds: WalletWrapFeeBounds;
  readonly proposalDigest: string;
  readonly proposalDigestVersion: string;
  readonly expiresAt: string;
}

// ── Strict row parsing ─────────────────────────────────────────────────

export const SELECT_COLUMNS =
  "intent_id, session_id, wallet_address, chain_alias, chain_id, direction, "
  + "wrapped_native_address, wrapped_native_symbol, wrapped_native_decimals, amount_raw, "
  + "payload_json, preview_json, fee_bounds_json, "
  + "proposal_digest, proposal_digest_version, "
  + "status, failure_stage, activity_id, expires_at, consumed_at, cancelled_at, "
  + "tx_hash, failure_reason, created_at";

/** A sha256 digest as this build writes it: 64 lowercase hex characters. */
const PROPOSAL_DIGEST_HEX = /^[0-9a-f]{64}$/;

function malformedRow(field: string, detail: string): never {
  // No value is interpolated: a money row we could not parse must not leak its
  // (untrusted) contents into a log line. The field name and the shape it
  // failed is enough to locate the row from its id, which the caller has.
  throw new Error(`wallet_wrap_intents row is malformed: ${field} ${detail}`);
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
 * A NOT NULL numeric column, coerced through Number and REJECTED unless it
 * lands on a safe integer. `Number("123abc")` is `NaN` and `Number(2n**60n)`
 * silently loses precision; `chain_id` selects the chain a wrap is signed on
 * and `wrapped_native_decimals` scales what the operator is shown, so neither
 * may carry either past this boundary.
 */
function requireSafeInteger(r: Record<string, unknown>, key: string): number {
  const value = r[key];
  if (value === null || value === undefined) malformedRow(key, "is null");
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
 * The scalar columns are validated too, not only the JSONB ones: the direction
 * and status against their closed vocabularies, the numeric columns against
 * `Number.isSafeInteger`, the amount against the positive-base-units shape, and
 * the proposal digest against the hex shape this build emits. The digest
 * VERSION is deliberately NOT enum-checked here - an unknown version is a valid
 * row that the confirm path refuses with a specific message, so it must survive
 * the read to be refused honestly.
 */
export function parseWrapIntentRow(r: Record<string, unknown>): WalletWrapIntent {
  const proposalDigest = requireRowString(r, "proposal_digest");
  if (!PROPOSAL_DIGEST_HEX.test(proposalDigest)) {
    malformedRow("proposal_digest", "is not a 64-character lowercase hex sha256");
  }

  const failureStageRaw = r.failure_stage;
  const failureStage: WalletWrapFailureStage | null =
    failureStageRaw === null || failureStageRaw === undefined
      ? null
      : requireRowEnum(r, "failure_stage", WALLET_WRAP_FAILURE_STAGES);

  return {
    intentId: requireRowString(r, "intent_id"),
    sessionId: requireRowString(r, "session_id"),
    walletAddress: requireRowString(r, "wallet_address"),
    chainAlias: requireRowString(r, "chain_alias"),
    chainId: requireSafeInteger(r, "chain_id"),
    direction: requireRowEnum(r, "direction", WRAP_DIRECTIONS),
    contract: WrapContractIdentitySchema.parse({
      address: r.wrapped_native_address,
      symbol: r.wrapped_native_symbol,
      decimals: requireSafeInteger(r, "wrapped_native_decimals"),
    }),
    amountRaw: WrapAmountSchema.parse(requireRowString(r, "amount_raw")),
    payload: WrapTransactionPayloadSchema.parse(r.payload_json),
    preview: WrapPreviewSchema.parse(r.preview_json),
    feeBounds: WalletWrapFeeBoundsSchema.parse(r.fee_bounds_json),
    proposalDigest,
    proposalDigestVersion: requireRowString(r, "proposal_digest_version"),
    status: requireRowEnum(r, "status", WALLET_WRAP_INTENT_STATUSES),
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
