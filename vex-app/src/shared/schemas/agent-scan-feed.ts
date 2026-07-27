/**
 * Agent Scan feed schemas — the read-only, global-scope, full-history activity
 * feed. Backs `vex:portfolio:listAgentScan`.
 *
 * WHAT THIS IS. `portfolio-moves` answers "what did the agent do in THIS
 * session"; `token-history` answers "what happened to THIS token". Agent Scan
 * answers "what has the agent ever done", across every wallet in the configured
 * inventory, filterable and keyset-paginated. It is the first surface built on
 * the canonical `agent_activity` vocabulary alone (see
 * `../agent-activity-vocabulary.ts`) — there is NO legacy `proj_activity` /
 * `wallet_intents` arm here, deliberately: the legacy arms keep serving the two
 * feeds that already union them, and this feed does not inherit the SPOT
 * taxonomy they were built on.
 *
 * SINGLE ARM, SINGLE CURSOR. Because there is exactly one source table, the
 * cursor is a plain 2-field keyset — `{ createdAt, sourceId }` over
 * `(created_at DESC, id DESC)` — with no `sourceRank` tie-breaker
 * (`token-history.ts`'s 3-field cursor needs one only because it orders a
 * 3-table UNION). `createdAt` is the EXACT microsecond serialization SQL
 * produced (`to_char(… 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`), never a `Date`
 * round-trip: `new Date(…).toISOString()` truncates to milliseconds, and two
 * rows written in the same millisecond would then straddle the boundary — the
 * page would skip or repeat rows. `sourceId` is `agent_activity.id` (BIGSERIAL)
 * as a bounded decimal string, because a bigint beyond 2^53 cannot survive a
 * JSON number.
 *
 * ROW MODEL (owner decision). One row per LOGICAL activity, with its execution
 * detail nested in `legs` — the same model the existing feeds use. A bridge
 * therefore appears ONCE, as its `bridge_fill_expected` row, with its
 * allowance / deposit / fee / observed-fill / refund legs attached; it is NOT
 * exploded into per-leg chronological duplicates.
 *
 * TOLERANT READER (LAW, see `../agent-activity-vocabulary.ts`). `activityKind`,
 * `eventRole`, `status`, `failureCode`, `failureReason`, `protocol`,
 * `chainFamily` and every leg `role` cross IPC as BOUNDED OPEN STRINGS. Three
 * live outages in this repo came from re-declaring an engine enum as a closed
 * DTO enum; a value the engine mints and this build has never heard of must
 * render as a neutral row, never fail output validation and blank the page.
 * Bounded is not negotiable either — tolerant means "unknown values pass", not
 * "unbounded strings pass".
 *
 * INPUT IS THE OPPOSITE. Filters compile straight into SQL, so their
 * vocabularies are CLOSED and their arrays hard-capped. `statuses` and
 * `chainFamily` are enums here precisely because a value outside the set can
 * only be a bug or an attack — there is nothing to degrade gracefully to.
 * `sessionId` NARROWS the read; it can never widen it (main always applies the
 * inventory wallet allow-list first — see `agent-scan-db.ts`).
 *
 * AMOUNT HONESTY. A leg carries the requested and executed columns as AUDIT
 * data and, separately, `displayAmount` — the ONE value that leg may honestly
 * show, resolved main-side by the shared `agent-activity-amount.ts` rules
 * (contract C20). Render `displayAmount`. Rendering `amountHuman` for a
 * confirmed row would put a quote-time estimate on screen as if it were
 * settlement, which is the exact bug C20 exists to prevent.
 *
 * SYMBOLS. `symbol` is the STORED symbol after `sanitizeTokenSymbol` (untrusted
 * provider metadata — any token can self-declare it). `displaySymbol` is a
 * SEPARATE main-resolved label that may carry the native-asset annotation
 * (`NATIVE (ETH)`). They cannot be one field: the sanitizer rejects spaces and
 * parentheses by design, so an annotated symbol would sanitize to `null` and
 * vanish (`src/tools/evm-chains/native-currency.ts`'s own doc records this).
 *
 * URLS ARE RESOLVED IN MAIN. Unlike `token-history`'s `txRefs`, this DTO ships
 * ready-built `explorerUrl`s. They are built ONLY through the curated
 * `../explorer-links.ts` allowlist — the same map that feeds main's
 * external-link gate — so a URL here is on the allowlist by construction and a
 * provider-supplied URL can never reach the renderer. An unresolvable chain
 * yields `null` (a non-interactive row), never a guessed host.
 */

import { z } from "zod";
import {
  ACTIVITY_KIND_MAX_LENGTH,
  ACTIVITY_STATUS_MAX_LENGTH,
  EVENT_ROLE_MAX_LENGTH,
} from "../agent-activity-vocabulary.js";
import { TOKEN_SYMBOL_MAX_LENGTH } from "../token-symbol-sanitizer.js";
import { bridgeAmountBasisSchema } from "./bridge-legs.js";

// ── Bounds ────────────────────────────────────────────────────────────────

/** Server-side page cap. Shared by the SQL `LIMIT` and this schema's `.max(...)`. */
export const AGENT_SCAN_PAGE_SIZE = 50;

/**
 * Upper bound on nested legs per entry. Far above any real execution's leg
 * count (a bridge tops out around six), so a genuine row never loses a leg —
 * a pathological row fails validation LOUDLY instead of silently truncating
 * (OWNER RULE 2026-07-23: feed outputs are never truncated).
 */
export const AGENT_SCAN_BRIDGE_LEGS_MAX = 64;

/** Filter array caps — an unbounded `IN (…)` list is an unbounded query plan. */
export const AGENT_SCAN_FILTER_KINDS_MAX = 8;
export const AGENT_SCAN_FILTER_PROTOCOLS_MAX = 12;

/**
 * Length bounds for the feed's DISPLAY-ONLY text columns, shared by this
 * schema's `.max(...)` and the reader's SQL `LEFT(...)` clamps so the two can
 * never drift apart (the same discipline `MOVE_TOKEN_SYMBOL_MAX` enforces for
 * symbols).
 *
 * Clamping is only ever applied to display text. Amounts and USD figures are
 * NOT in this table on purpose: silently clamping a number produces a WRONG
 * number, so those fields stay strict and fail loudly instead.
 *
 * `failureReason` is 500 because the engine already redacts and hard-caps it at
 * 500 chars at its own repo boundary.
 */
export const AGENT_SCAN_TEXT_BOUNDS = {
  protocol: 64,
  chainSlug: 64,
  chainFamily: 32,
  tokenAddress: 128,
  txRef: 128,
  providerOrderId: 128,
  failureCode: 64,
  failureReason: 500,
} as const;

const PROTOCOL_MAX_LENGTH = AGENT_SCAN_TEXT_BOUNDS.protocol;
const CHAIN_SLUG_MAX_LENGTH = AGENT_SCAN_TEXT_BOUNDS.chainSlug;
const CHAIN_FAMILY_MAX_LENGTH = AGENT_SCAN_TEXT_BOUNDS.chainFamily;
const TOKEN_ADDRESS_MAX_LENGTH = AGENT_SCAN_TEXT_BOUNDS.tokenAddress;
const TX_REF_MAX_LENGTH = AGENT_SCAN_TEXT_BOUNDS.txRef;
const PROVIDER_ORDER_ID_MAX_LENGTH = AGENT_SCAN_TEXT_BOUNDS.providerOrderId;
const FAILURE_CODE_MAX_LENGTH = AGENT_SCAN_TEXT_BOUNDS.failureCode;
const FAILURE_REASON_MAX_LENGTH = AGENT_SCAN_TEXT_BOUNDS.failureReason;
const EXPLORER_URL_MAX_LENGTH = 512;
/**
 * A base-unit integer for a 256-bit token amount is 78 digits; a `formatUnits`
 * result adds a decimal point and a leading zero. Money fields are STRICT — an
 * over-length amount fails loudly rather than being clamped into a wrong number.
 */
const AMOUNT_MAX_LENGTH = 96;
const USD_MAX_LENGTH = 32;
/** Room for a sanitized symbol plus the ` (TICKER)` native annotation. */
const DISPLAY_SYMBOL_MAX_LENGTH = TOKEN_SYMBOL_MAX_LENGTH + 32;
/** `agent_activity.id` is BIGSERIAL — a signed bigint is at most 19 digits. */
const SOURCE_ID_PATTERN = /^[0-9]{1,19}$/;

// ── Cursor ────────────────────────────────────────────────────────────────

export const agentScanCursorSchema = z
  .object({
    /**
     * The EXACT microsecond SQL serialization of the last row's `created_at`
     * (`precision: 6`). A millisecond-precision value — i.e. anything that has
     * been through a JS `Date` — is REJECTED: it would reopen keyset gaps and
     * duplicates at sub-millisecond ties.
     */
    createdAt: z.string().datetime({ offset: true, precision: 6 }),
    /** `agent_activity.id` as an unsigned decimal string, bounded to bigint width. */
    sourceId: z
      .string()
      .regex(SOURCE_ID_PATTERN, "sourceId must be a decimal bigint string"),
  })
  .strict();
export type AgentScanCursor = z.infer<typeof agentScanCursorSchema>;

// ── Input ─────────────────────────────────────────────────────────────────

/** CLOSED — compiles to a SQL predicate (`failed` expands to `definitively_failed`). */
export const agentScanStatusFilterSchema = z.enum(["pending", "confirmed", "failed"]);
export type AgentScanStatusFilter = z.infer<typeof agentScanStatusFilterSchema>;

/** CLOSED — compiles to a SQL predicate against `agent_activity.chain_family`. */
export const agentScanChainFamilyFilterSchema = z.enum(["eip155", "solana"]);
export type AgentScanChainFamilyFilter = z.infer<typeof agentScanChainFamilyFilterSchema>;

/**
 * Every filter is optional and bounded. `kinds` and `protocols` stay OPEN
 * strings (a user may legitimately filter on a kind this build predates) but
 * are length- and count-capped; they reach SQL only as bound array parameters,
 * never as interpolated text.
 */
export const agentScanFiltersSchema = z
  .object({
    kinds: z
      .array(z.string().min(1).max(ACTIVITY_KIND_MAX_LENGTH))
      .max(AGENT_SCAN_FILTER_KINDS_MAX)
      .optional(),
    statuses: z.array(agentScanStatusFilterSchema).max(3).optional(),
    protocols: z
      .array(z.string().min(1).max(PROTOCOL_MAX_LENGTH))
      .max(AGENT_SCAN_FILTER_PROTOCOLS_MAX)
      .optional(),
    chainFamily: agentScanChainFamilyFilterSchema.optional(),
    /**
     * NARROWS the read to one session. It can never WIDEN it: main resolves the
     * inventory wallet allow-list server-side and applies it unconditionally,
     * so this is an additional `AND`, never a replacement scope.
     */
    sessionId: z.string().uuid().optional(),
  })
  .strict();
export type AgentScanFilters = z.infer<typeof agentScanFiltersSchema>;

export const agentScanReadInputSchema = z
  .object({
    cursor: agentScanCursorSchema.nullable().default(null),
    filters: agentScanFiltersSchema.default({}),
  })
  .strict();
export type AgentScanReadInput = z.infer<typeof agentScanReadInputSchema>;

// ── Output: shared pieces ─────────────────────────────────────────────────

/** One end of a bridge route: the provider-native chain id plus its slug. */
export const agentScanChainRefSchema = z
  .object({
    chainId: z.number().int().nullable(),
    slug: z.string().max(CHAIN_SLUG_MAX_LENGTH).nullable(),
  })
  .strict();
export type AgentScanChainRef = z.infer<typeof agentScanChainRefSchema>;

/**
 * One side of an activity's token movement.
 *
 * RENDER `displayAmount`. The `amountHuman` / `amountRaw` pair is the
 * QUOTE-TIME REQUESTED echo and `executedAmount*` is receipt-derived truth;
 * both are kept for audit and detail views. Which one a given row may honestly
 * show depends on its lifecycle status, and that decision is made ONCE, in
 * main, by `agent-activity-amount.ts` (contract C20) — showing a confirmed
 * row's requested echo would present a quote as settlement.
 */
export const agentScanTokenLegSchema = z
  .object({
    /** Token contract address / mint as recorded; identity, never a display label. */
    address: z.string().max(TOKEN_ADDRESS_MAX_LENGTH).nullable(),
    /**
     * The STORED symbol after `sanitizeTokenSymbol`. UNTRUSTED: any token can
     * self-declare it, so it must never override `address` identity or earn a
     * brand icon on its own.
     */
    symbol: z.string().max(TOKEN_SYMBOL_MAX_LENGTH).nullable(),
    /**
     * Main-resolved display label. Equals `symbol` except for an EVM native
     * leg, where the chain-agnostic `NATIVE` sentinel is annotated with the
     * chain's real ticker (`NATIVE (ETH)`). Never round-trips through the
     * symbol sanitizer, which rejects the annotation's spaces/parentheses.
     */
    displaySymbol: z.string().max(DISPLAY_SYMBOL_MAX_LENGTH).nullable(),
    decimals: z.number().int().min(0).max(255).nullable(),
    /** REQUESTED (quote-time) human amount — audit only; see the doc above. */
    amountHuman: z.string().max(AMOUNT_MAX_LENGTH).nullable(),
    /** REQUESTED base-unit amount — audit only. */
    amountRaw: z.string().max(AMOUNT_MAX_LENGTH).nullable(),
    /**
     * EXECUTED human amount AS STORED. Frequently `null` even when
     * `executedAmountRaw` is set — the repair-sweep decoders deliberately
     * populate only the raw column.
     */
    executedAmountHuman: z.string().max(AMOUNT_MAX_LENGTH).nullable(),
    /** EXECUTED base-unit amount — receipt/transfer-delta truth. */
    executedAmountRaw: z.string().max(AMOUNT_MAX_LENGTH).nullable(),
    /** THE honest, renderable amount for this leg's status (C20). `null` = show nothing. */
    displayAmount: z.string().max(AMOUNT_MAX_LENGTH).nullable(),
    /**
     * QUOTE-TIME USD estimate (`usd_in/out_est`) as a decimal string; `null`
     * when unpriced (never a fabricated 0). There is no settlement-time USD
     * repricing anywhere in this feed, so this stays an estimate even for a
     * confirmed row and must be rendered with an explicit `~ … est.` marker.
     */
    usdEst: z.string().max(USD_MAX_LENGTH).nullable(),
  })
  .strict();
export type AgentScanTokenLeg = z.infer<typeof agentScanTokenLegSchema>;

/**
 * The Vex integrator fee actually recorded on the row (migration 050),
 * token-denominated. `null` when the row records no fee.
 */
export const agentScanVexFeeSchema = z
  .object({
    tokenSymbol: z.string().max(TOKEN_SYMBOL_MAX_LENGTH).nullable(),
    amountHuman: z.string().max(AMOUNT_MAX_LENGTH).nullable(),
  })
  .strict();
export type AgentScanVexFee = z.infer<typeof agentScanVexFeeSchema>;

/**
 * One execution leg nested under a logical entry.
 *
 * DELIBERATELY NOT `bridge-legs.ts`'s `BridgeLeg`. That contract closes `role`
 * to a fixed enum and `coerceBridgeLegs` SILENTLY DROPS any leg it cannot
 * parse — acceptable where it was born, unacceptable for a full-history audit
 * surface whose whole promise is that nothing is hidden. Here `role` is a
 * bounded OPEN string and every leg the DB returns is mapped, so a role added
 * by a future migration shows up as an unlabelled-but-present leg instead of
 * vanishing from the audit trail. `explorerUrl` is resolved in MAIN through the
 * curated allowlist (`bridge-legs.ts` deliberately ships no URL because ITS
 * consumer resolves renderer-side; this feed's does not).
 */
export const agentScanBridgeLegSchema = z
  .object({
    /** `agent_activity.event_role` for this leg — tolerant open string. */
    role: z.string().max(EVENT_ROLE_MAX_LENGTH).nullable(),
    /** The leg's OWN execution chain id (provider-native; read with `chainFamily`). */
    chainId: z.number().int().nullable(),
    chainFamily: z.string().max(CHAIN_FAMILY_MAX_LENGTH).nullable(),
    chainSlug: z.string().max(CHAIN_SLUG_MAX_LENGTH).nullable(),
    /** EVM tx hash / Solana signature; `null` for a planned or hashless-failed leg. */
    txHash: z.string().max(TX_REF_MAX_LENGTH).nullable(),
    status: z.string().max(ACTIVITY_STATUS_MAX_LENGTH).nullable(),
    failureCode: z.string().max(FAILURE_CODE_MAX_LENGTH).nullable(),
    /** Main-resolved explorer link; `null` when the chain is not curated. */
    explorerUrl: z.string().max(EXPLORER_URL_MAX_LENGTH).nullable(),
  })
  .strict();
export type AgentScanBridgeLeg = z.infer<typeof agentScanBridgeLegSchema>;

// ── Output: entry ─────────────────────────────────────────────────────────

export const agentScanEntrySchema = z
  .object({
    /** `agent_activity.id` as a decimal string — also this row's cursor `sourceId`. */
    id: z.string().min(1).max(32),
    createdAt: z.string().datetime({ offset: true }),
    /**
     * `agent_activity.kind` — `swap | bridge | lend | prediction | wrap` today.
     * TOLERANT open string: see the module header. Use
     * `isAgentActivityKind` to decide whether a label exists.
     */
    activityKind: z.string().max(ACTIVITY_KIND_MAX_LENGTH),
    /** `agent_activity.event_role` — 17 known values today. TOLERANT open string. */
    eventRole: z.string().max(EVENT_ROLE_MAX_LENGTH),
    /**
     * Lifecycle, collapsed in SQL from the stored 3-value enum to `pending |
     * confirmed | failed`. TOLERANT open string for the same reason as the two
     * fields above — a fourth lifecycle state must not blank the page.
     */
    status: z.string().max(ACTIVITY_STATUS_MAX_LENGTH),
    /** Executing protocol/venue (`kyberswap`, `khalani`, `jupiter`, …). */
    protocol: z.string().max(PROTOCOL_MAX_LENGTH).nullable(),
    /** The row's OWN execution chain (for a bridge: the destination, where the fill lands). */
    chainId: z.number().int().nullable(),
    chainFamily: z.string().max(CHAIN_FAMILY_MAX_LENGTH).nullable(),
    chainSlug: z.string().max(CHAIN_SLUG_MAX_LENGTH).nullable(),
    /** Bridge rows only — the route endpoints; `null` on a same-chain activity. */
    fromChain: agentScanChainRefSchema.nullable(),
    toChain: agentScanChainRefSchema.nullable(),
    input: agentScanTokenLegSchema,
    output: agentScanTokenLegSchema,
    /**
     * Whether the legs' `displayAmount`s are independently-verified executed
     * amounts (`executed`) or quoted amounts shown as an estimate
     * (`estimated`). `null` when nothing honest can be shown, and `null` for a
     * plain swap — whose C20 rule blanks rather than mislabels, so it never
     * needs the tag (`agent-activity-amount.ts` documents why).
     */
    amountBasis: bridgeAmountBasisSchema.nullable(),
    vexFee: agentScanVexFeeSchema.nullable(),
    /** Quote-time USD fee estimate (`usd_fee_est`); `null` when absent. */
    usdFeeEst: z.string().max(USD_MAX_LENGTH).nullable(),
    /** Tolerant open string — the closed `failure_code` enum grows per migration. */
    failureCode: z.string().max(FAILURE_CODE_MAX_LENGTH).nullable(),
    /** Redacted, engine-capped free text. Tolerant; clamped to 500 in SQL. */
    failureReason: z.string().max(FAILURE_REASON_MAX_LENGTH).nullable(),
    txHash: z.string().max(TX_REF_MAX_LENGTH).nullable(),
    /** Main-resolved, allowlist-built explorer link for `txHash`; `null` if unresolvable. */
    explorerUrl: z.string().max(EXPLORER_URL_MAX_LENGTH).nullable(),
    /** Provider order id (Khalani orderId / Relay requestId) on bridge rows. */
    providerOrderId: z.string().max(PROVIDER_ORDER_ID_MAX_LENGTH).nullable(),
    /** Every sibling execution leg. `[]` for a single-leg activity. Never truncated. */
    legs: z.array(agentScanBridgeLegSchema).max(AGENT_SCAN_BRIDGE_LEGS_MAX),
    /**
     * Last SUCCESSFUL sweep check of a pending row's provider/chain status.
     * `null` when never checked — the renderer flags a stale pending row
     * "tracking delayed" (see `../bridge-tracking.ts`).
     */
    lastCheckedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type AgentScanEntry = z.infer<typeof agentScanEntrySchema>;

// ── Output: page ──────────────────────────────────────────────────────────

const agentScanPageSchema = z
  .object({
    status: z.literal("available"),
    entries: z.array(agentScanEntrySchema).max(AGENT_SCAN_PAGE_SIZE),
    nextCursor: agentScanCursorSchema.nullable(),
    hasMore: z.boolean(),
  })
  .strict();

/**
 * The ONLY degradation path: the bounded read hit its 2s statement timeout and
 * fails CLOSED rather than rendering as "no history". Every other failure
 * (schema, connection, defect) is a `Result` error from the handler, never this
 * DTO shape.
 */
const agentScanUnavailableSchema = z
  .object({
    status: z.literal("unavailable"),
    reason: z.literal("query_timeout"),
  })
  .strict();

export const agentScanDtoSchema = z.discriminatedUnion("status", [
  agentScanPageSchema,
  agentScanUnavailableSchema,
]);
export type AgentScanDto = z.infer<typeof agentScanDtoSchema>;
