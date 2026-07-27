/**
 * Token history schemas — read-only, global-scope per-token TX history
 * (chronos-shell). Backs `vex:portfolio:listTokenHistory`.
 *
 * Input identity is REQUIRED and exact: `{ chainId, tokenAddress }`. There is
 * no symbol-only lookup — name/symbol are display metadata elsewhere, never a
 * query input, so a spoofed symbol can never redirect the read (mirrors
 * `portfolio.ts`'s address-keyed aggregation policy). `tokenAddress` shape is
 * validated PER CHAIN FAMILY (EVM 0x-hex vs Solana base58, derived from
 * `chainId` via `familyForChainId`) and, for EVM, lower-cased at the boundary
 * so every downstream comparison (SQL + JS) works against one canonical
 * casing — mirrors `NORMALIZED_TOKEN_ADDRESS_SQL` in `portfolio-db.ts`.
 *
 * Pagination is a strict 3-field keyset cursor — `{ createdAt, sourceRank,
 * sourceId }` — NOT an opaque token (unlike the root `transactions.ts`
 * feed's base64 codec): the vex-app IPC boundary prefers a self-describing,
 * schema-validated shape over an opaque blob. `createdAt` carries
 * MICROSECOND precision (`precision: 6`) because the underlying UNION
 * (`proj_activity` + `wallet_intents` + `agent_activity`, Agent Scan plan
 * §4.7) can tie at millisecond resolution; losing sub-millisecond precision
 * would reopen keyset gaps/dupes at ties (see
 * `src/vex-agent/db/repos/transactions-cursor.ts`, read-only reference —
 * not imported, root `src/` cannot cross the vex-app boundary). `sourceRank`
 * is FIXED per arm (agent_activity=2, activity=1, intent=0); `sourceId` is a
 * STRING because the three arms' native ids are different types
 * (`agent_activity.id` / `proj_activity.id` BIGSERIAL/SERIAL vs
 * `wallet_intents.intent_id` TEXT) — the DB layer renders both as comparable
 * text (zero-padded for the numeric arms) so one cursor shape works for the
 * whole UNION.
 *
 * Output is the discriminated `status` union the round-3 plan closure
 * specifies: `"available"` (a normal page, degrading gracefully) vs
 * `"unavailable"` (the read hit its 2s statement timeout — SQLSTATE 57014 —
 * and fails CLOSED rather than rendering as "no history"). This is the ONLY
 * degradation path; every other failure (schema, connection, defect) is a
 * `Result` error from the handler, never this DTO shape.
 *
 * Entries are a discriminated `kind` union (`swap` | `bridge` | `transfer`)
 * — modelling the real shape difference between a same-chain trade, a
 * cross-chain bridge (origin/destination chain + legs can be on different
 * numeric chains), and a Vex-executed wallet send (no trade economics at
 * all). A swap entry sourced from `agent_activity` additionally carries
 * `status`/`failureCode` (both `null` for a legacy `proj_activity`-sourced
 * swap): `pending`/`failed` attempts are surfaced here too, not just
 * confirmed fills — mirrors `db/repos/transactions.ts`'s compatibility feed
 * naming (root `src/`, read-only reference — NOT imported). Jupiter Lend
 * deposit/withdraw and Jupiter prediction buy/sell/claim/close (migration
 * 049, W5) reuse this SAME `kind: "swap"` shape — one role per on-chain tx,
 * like a plain swap — distinguished only by `productType` (`lend`/
 * `prediction`), never a dedicated `kind` variant. Quantities
 * travel as DECIMAL STRINGS (never floats — some are raw base-unit integers
 * up to 78 digits, well past JS safe-integer range) and carry a
 * `unitProvenance` tag: `"human"` (a dotted decimal the engine already
 * formatted for display — mirrors `MovesBlock.tsx`'s `amountDisplay`
 * discipline, which renders ONLY dotted-decimal strings) or `"unknown"`. The
 * renderer must render a quantity ONLY when `unitProvenance === "human"` —
 * never guess-format an unproven value.
 *
 * `txRefs` carries `{ chainId, ref }` pairs (never a URL) bounded to 4 (a
 * multi-hop bridge can have more than one linkable hash) — the renderer
 * builds the actual explorer URL via `shared/explorer-links.ts`, which stays
 * the single allow-listed source of truth for external hosts.
 *
 * A leg's `valueUsd` carries a `usdProvenance` tag (Codex final review round 2
 * finding 7 / contract C35), mirroring `amount`'s `unitProvenance` machinery:
 * `"recorded"` (the legacy `proj_activity` capture's own USD column — success-
 * only by construction) vs `"estimated"` (`agent_activity.usd_in/out_est` — a
 * QUOTE-TIME price computed BEFORE dispatch, never re-derived from the
 * settled fill, regardless of the swap's `status`). The renderer must render
 * an `"estimated"` figure with an explicit `~ … est.` marker — it must never
 * read as bare execution-time USD.
 */

import { z } from "zod";
import { familyForChainId } from "../chains/display.js";
import {
  ACTIVITY_KIND_MAX_LENGTH,
  EVENT_ROLE_MAX_LENGTH,
} from "../agent-activity-vocabulary.js";
import { evmAddressSchema } from "./wallets.js";
import {
  bridgeAmountBasisSchema,
  bridgeLegsSchema,
} from "./bridge-legs.js";

// Solana base58 shape — mirrors `wallets/base-chain.ts`'s PRIVATE
// `solanaAddressSchema` (deliberately not re-exported by the `wallets.js`
// barrel) and `portfolio.ts`'s own local pattern, which documents the same
// "mirror, don't reach past the barrel" precedent for the identical reason.
const SOLANA_TOKEN_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const AMOUNT_MAX_LENGTH = 96;
const USD_MAX_LENGTH = 32;
const CHAIN_DISPLAY_MAX_LENGTH = 64;
const REF_MAX_LENGTH = 128;

/** Server-side page cap. Shared by the SQL LIMIT and this schema's `.max(...)`. */
export const TOKEN_HISTORY_PAGE_SIZE = 50;

// ── Cursor ──────────────────────────────────────────────────────────────

export const tokenHistoryCursorSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true, precision: 6 }),
    sourceRank: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    sourceId: z.string().min(1).max(64),
  })
  .strict();
export type TokenHistoryCursor = z.infer<typeof tokenHistoryCursorSchema>;

// ── Input ───────────────────────────────────────────────────────────────

export const tokenHistoryReadInputSchema = z
  .object({
    chainId: z.number().int(),
    tokenAddress: z.string().min(1).max(128),
    cursor: tokenHistoryCursorSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const family = familyForChainId(value.chainId);
    const valid =
      family === "solana"
        ? SOLANA_TOKEN_ADDRESS_PATTERN.test(value.tokenAddress)
        : evmAddressSchema.safeParse(value.tokenAddress).success;
    if (!valid) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid token address for this chain family.",
        path: ["tokenAddress"],
      });
    }
  })
  .transform((value) => ({
    ...value,
    tokenAddress:
      familyForChainId(value.chainId) === "evm"
        ? value.tokenAddress.toLowerCase()
        : value.tokenAddress,
  }));
export type TokenHistoryReadInput = z.infer<typeof tokenHistoryReadInputSchema>;

// ── Shared entry pieces ───────────────────────────────────────────────────

/**
 * One quantity value with its proof-of-unit tag. `value: null` means the
 * underlying column was absent; a non-null value with `unitProvenance:
 * "unknown"` is NOT display-ready — only `"human"` is.
 */
const amountFieldSchema = z
  .object({
    value: z.string().max(AMOUNT_MAX_LENGTH).nullable(),
    unitProvenance: z.enum(["human", "unknown"]),
  })
  .strict();
export type AmountField = z.infer<typeof amountFieldSchema>;

/** USD figure as a decimal string; `null` means unpriced (never a fabricated 0). */
const usdValueSchema = z.string().max(USD_MAX_LENGTH).nullable();

/**
 * Provenance tag for a leg's `valueUsd` (contract C35): `"recorded"` is the
 * legacy `proj_activity` capture's own USD column (success-only feed —
 * treated as execution-time truth); `"estimated"` is `agent_activity`'s
 * `usd_in/out_est` — a QUOTE-TIME price computed before dispatch, never
 * re-priced from the settled fill. Unlike `unitProvenance`'s status-dependent
 * honesty (C20), USD provenance does NOT depend on `status` — a `confirmed`
 * agent_activity row's USD figure is STILL a quote-time estimate; there is no
 * settlement-time repricing anywhere in this feed.
 */
const usdProvenanceSchema = z.enum(["recorded", "estimated"]);
export type UsdProvenance = z.infer<typeof usdProvenanceSchema>;

/**
 * One USD figure with its provenance tag — mirrors `amountFieldSchema`'s
 * value+proof shape. `value: null` means unpriced (never a fabricated 0);
 * the renderer must render an `"estimated"` value with an explicit `~ … est.`
 * marker (see `TokenHistoryScreen.tsx`'s `usdText`), never as bare execution
 * USD.
 */
const usdFieldSchema = z
  .object({
    value: usdValueSchema,
    usdProvenance: usdProvenanceSchema,
  })
  .strict();
export type UsdField = z.infer<typeof usdFieldSchema>;

/**
 * On-chain reference for one hop. `ref` is a tx hash (EVM) or signature
 * (Solana) — never a URL; the renderer resolves the explorer link itself.
 */
const txRefSchema = z
  .object({
    chainId: z.number().int(),
    ref: z.string().min(1).max(REF_MAX_LENGTH),
  })
  .strict();
export type TokenHistoryTxRef = z.infer<typeof txRefSchema>;

const txRefsSchema = z.array(txRefSchema).max(4);

/** One swap/bridge leg — token identity (untrusted display metadata) + amount + USD. */
const tokenLegSchema = z
  .object({
    /** Raw effective token identity as recorded (address or symbol) — internal use only, never rendered raw. */
    token: z.string().max(REF_MAX_LENGTH).nullable(),
    /** Sanitized captured symbol — display-only, untrusted (see `token-symbol-sanitizer.ts`). */
    symbol: z.string().max(64).nullable(),
    /** Sanitized wallet-local fallback symbol (same untrust posture). */
    localSymbol: z.string().max(64).nullable(),
    amount: amountFieldSchema,
    valueUsd: usdFieldSchema,
  })
  .strict();

// ── Entries ───────────────────────────────────────────────────────────────

/** `agent_activity`-only lifecycle status; `null` for a legacy swap row. */
const tokenHistorySwapStatusSchema = z.enum(["pending", "confirmed", "failed"]);

/**
 * The CANONICAL activity vocabulary (`../agent-activity-vocabulary.ts`),
 * carried by the swap and bridge entries so the UI can key off it instead of
 * `productType`/`tradeSide`.
 *
 * MIND THE NAME. This union's own `kind` discriminant (`swap`/`bridge`/
 * `transfer`) describes the DTO SHAPE and is deliberately untouched; the engine
 * vocabulary rides `activityKind`. A Jupiter Lend row is therefore
 * `kind: "swap"` (one role per on-chain tx, the swap shape fits) AND
 * `activityKind: "lend"` — neither field has to lie.
 *
 *  - `agent_activity` rows carry the real `kind`/`event_role` columns.
 *  - LEGACY `proj_activity` rows DERIVE `activityKind` server-side from
 *    `product_type` (`bridge`→`bridge`, `send`/`transfer`→`transfer`,
 *    `spot`/`trade`→`swap`, anything else→the neutral `activity`) and always
 *    leave `eventRole` null — that table has no event-role concept and
 *    inventing one would assert what the data cannot support.
 *
 * TOLERANT open strings, bounded, and OPTIONAL as well as nullable — NOT
 * `.default(null)` like the bridge fields below. A default keeps old PAYLOADS
 * parsing but makes the key REQUIRED in the inferred type, forcing every
 * existing construction site to be edited in lockstep. Optional keeps old
 * payloads AND old call sites working while the canonical vocabulary rolls out
 * across surfaces. `undefined` and `null` mean the same thing here — "this
 * entry carries no canonical vocabulary" — so consumers read
 * `activityKind ?? null` and never branch on the difference.
 */
const activityKindFieldSchema = z
  .string()
  .max(ACTIVITY_KIND_MAX_LENGTH)
  .nullable()
  .optional();
const eventRoleFieldSchema = z
  .string()
  .max(EVENT_ROLE_MAX_LENGTH)
  .nullable()
  .optional();

const swapEntrySchema = z
  .object({
    kind: z.literal("swap"),
    id: z.string().min(1).max(64),
    createdAt: z.string().datetime({ offset: true }),
    chain: z.string().max(CHAIN_DISPLAY_MAX_LENGTH),
    venue: z.string().max(CHAIN_DISPLAY_MAX_LENGTH).nullable(),
    tradeSide: z.string().max(16).nullable(),
    /**
     * Tolerant string, NOT an enum: `spot` (a real swap) or, for an
     * `agent_activity` row, derived from `kind` — `lend`/`prediction`
     * (migration 049, W5) share this SAME `kind: "swap"` entry shape (no
     * dedicated DTO variant — they are one-role-per-tx like a swap, unlike a
     * bridge's multi-leg shape), distinguished only by this field, mirroring
     * `portfolio-moves.ts`'s `MoveItem.productType` convention.
     */
    productType: z.string().max(32).nullable(),
    activityKind: activityKindFieldSchema,
    eventRole: eventRoleFieldSchema,
    input: tokenLegSchema,
    output: tokenLegSchema,
    unitPriceUsd: usdValueSchema,
    captureStatus: z.string().max(32).nullable(),
    /** `agent_activity` only — a pending/failed swap/lend/prediction ATTEMPT, not just fills. */
    status: tokenHistorySwapStatusSchema.nullable(),
    /** `agent_activity` only — tolerant string (same doctrine as `captureStatus`
     * above: a closed re-declared enum here would risk an empty-page-on-drift
     * bug). `null` unless `status === "failed"`. */
    failureCode: z.string().nullable(),
    txRefs: txRefsSchema,
  })
  .strict();

const bridgeEntrySchema = z
  .object({
    kind: z.literal("bridge"),
    id: z.string().min(1).max(64),
    createdAt: z.string().datetime({ offset: true }),
    /** Origin chain (legacy: `proj_activity.chain`; agent_activity: `from_chain_slug`/`from_chain_id`). */
    originChain: z.string().max(CHAIN_DISPLAY_MAX_LENGTH),
    /** Destination chain (legacy: `meta.destChain`; agent_activity: `to_chain_slug`/`to_chain_id`); `null` if absent. */
    destinationChain: z.string().max(CHAIN_DISPLAY_MAX_LENGTH).nullable(),
    venue: z.string().max(CHAIN_DISPLAY_MAX_LENGTH).nullable(),
    activityKind: activityKindFieldSchema,
    eventRole: eventRoleFieldSchema,
    input: tokenLegSchema,
    output: tokenLegSchema,
    captureStatus: z.string().max(32).nullable(),
    txRefs: txRefsSchema,
    /**
     * agent_activity-sourced bridges (Agent Scan Phase 2) — the durable
     * lifecycle of the logical `bridge_fill_expected` row: `pending` (still
     * settling, tracked automatically), `confirmed`, or `failed`. `null` on a
     * legacy `proj_activity`-sourced bridge (which is success-only). Defaults
     * to `null` so legacy payloads still parse.
     */
    status: tokenHistorySwapStatusSchema.nullable().default(null),
    /**
     * agent_activity bridges only — the closed `failure_code` enum when
     * `status === "failed"`. `"bridge_refunded"` distinguishes a
     * money-returned outcome (NOT a success) from `"bridge_failed"`. Tolerant
     * string (same doctrine as the swap `failureCode`). `null` otherwise.
     */
    failureCode: z.string().nullable().default(null),
    /** agent_activity bridges only — provider order id (Khalani orderId / Relay requestId); `null` otherwise. */
    providerOrderId: z.string().max(128).nullable().default(null),
    /**
     * agent_activity bridges only (BINDING Q2) — whether the leg amounts are
     * the independently-verified executed amounts (`"executed"`) or the quoted
     * amounts shown as an estimate (`"estimated"`); `null` when no honest
     * amount is shown. The renderer marks an `"estimated"` amount so it never
     * reads as settled truth.
     */
    amountBasis: bridgeAmountBasisSchema.nullable().default(null),
    /**
     * agent_activity bridges only (B8) — every leg (allowances, deposit, the
     * canonical expected fill, extra observed fills, refunds), each carrying
     * its chain + hash + status for per-leg explorer links and audit. `[]` on
     * a legacy bridge. NEVER truncated (OWNER RULE).
     */
    legs: bridgeLegsSchema.default([]),
    /**
     * agent_activity bridges only (R12) — the timestamp of the last SUCCESSFUL
     * sweep check of a pending bridge's provider order status
     * (`agent_activity.last_checked_at`); `null` when never checked or on a
     * legacy bridge. The renderer flags a pending bridge "tracking delayed" when
     * this (or `createdAt` if null) is stale (see `shared/bridge-tracking.ts`).
     * Defaults to `null` so legacy payloads still parse.
     */
    lastCheckedAt: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();

const transferEntrySchema = z
  .object({
    kind: z.literal("transfer"),
    id: z.string().min(1).max(64),
    createdAt: z.string().datetime({ offset: true }),
    /** `wallet_intents.chain_alias` — free-text, model-supplied; display only. */
    chain: z.string().max(CHAIN_DISPLAY_MAX_LENGTH).nullable(),
    toAddress: z.string().max(REF_MAX_LENGTH),
    amount: amountFieldSchema,
    /** The matched token identity — always the caller's own validated `tokenAddress` (matched by address). */
    token: z.string().max(REF_MAX_LENGTH).nullable(),
    status: z.string().max(32),
    txRefs: txRefsSchema,
  })
  .strict();

export const tokenHistoryEntrySchema = z.discriminatedUnion("kind", [
  swapEntrySchema,
  bridgeEntrySchema,
  transferEntrySchema,
]);
export type TokenHistoryEntry = z.infer<typeof tokenHistoryEntrySchema>;

// ── Output ────────────────────────────────────────────────────────────────
//
// Cost basis was retired (Agent Scan plan §4.7): it read `proj_pnl_lots`,
// which the PnL/lot-projection teardown deletes. No replacement — the DTO
// simply no longer carries it; the screen's Activity feed is the whole page.

const tokenHistoryPageSchema = z
  .object({
    status: z.literal("available"),
    entries: z.array(tokenHistoryEntrySchema).max(TOKEN_HISTORY_PAGE_SIZE),
    nextCursor: tokenHistoryCursorSchema.nullable(),
    hasMore: z.boolean(),
  })
  .strict();

const tokenHistoryUnavailableSchema = z
  .object({
    status: z.literal("unavailable"),
    reason: z.literal("query_timeout"),
  })
  .strict();

export const tokenHistoryDtoSchema = z.discriminatedUnion("status", [
  tokenHistoryPageSchema,
  tokenHistoryUnavailableSchema,
]);
export type TokenHistoryDto = z.infer<typeof tokenHistoryDtoSchema>;
