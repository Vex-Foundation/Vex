/**
 * Portfolio MOVES schemas — read-only per-session executed-trade activity.
 *
 * The MOVES feed surfaces what the agent actually DID on-chain by UNIONing
 * two sources, scoped to the session's selected wallets:
 *   - the legacy `proj_activity` projection (success-only by construction);
 *   - the new-format `agent_activity` table (Agent Scan plan §4.1/§4.7) — one
 *     row per EVM swap ATTEMPT, so `status: "pending" | "failed"` rows are
 *     ALSO surfaced here, not just successes.
 * This is distinct from `approvals.getHistory`, which only carries rows for
 * `restricted`-permission sessions — a `full` mission executes swaps with NO
 * approval rows, so MOVES reads the real activity instead.
 *
 * The renderer sends only `sessionId`; main resolves the concrete wallet
 * address allow-list server-side (the session's wallet scope) so the renderer
 * can never widen the read past its own wallets and never supplies an address.
 *
 * TOLERANT OUTPUT DTO (non-negotiable): every column that is nullable in the
 * `proj_activity` DDL is `.nullable()` here. A narrow output schema would
 * reject a valid `proj_activity` row, which the handler's output validation
 * turns into a contract-violation error — re-creating the empty-MOVES bug this
 * feature fixes. In particular:
 *   - `tradeSide`     is `z.string().nullable()` (neutral Solana swaps emit
 *                     `trade_side = NULL`) — NOT an enum; always `null` on an
 *                     `agent_activity` row (the unified Kyber/Uniswap contract
 *                     dropped the `side` parameter).
 *   - `captureStatus` is a tolerant `z.string().nullable()` (the engine emits
 *                     `executed`, `open`, `closed`, `cancelled`, `claimed`,
 *                     `pending`, `filled`, … — NOT constrained to an enum);
 *                     always `null` on an `agent_activity` row — its lifecycle
 *                     is `status`/`failureCode` instead (a closed vocabulary,
 *                     mirroring `db/repos/transactions.ts`'s compatibility
 *                     feed, root `src/`, read-only reference — NOT imported).
 * Only `id` (SERIAL) and `createdAt` (NOT NULL, `DEFAULT NOW()`) are non-null.
 */

import { z } from "zod";
import { TOKEN_SYMBOL_MAX_LENGTH } from "../token-symbol-sanitizer.js";
import {
  bridgeAmountBasisSchema,
  bridgeLegsSchema,
} from "./bridge-legs.js";

/**
 * Fixed server-side row cap. Shared by BOTH the SQL `LIMIT` and the DTO
 * `.max(...)` so the mapped result can never overflow the output-schema bound
 * (a >cap result would 500-error the whole panel via the handler's output
 * validation). The renderer displays its own, smaller window by slicing.
 */
export const MOVES_MAX = 50;

/**
 * Maximum display-symbol length extracted from a capture item. Re-exports
 * the shared sanitizer's bound so the SQL `LEFT(...)` clamp, the JS-side
 * `sanitizeTokenSymbol` check, and this IPC schema's `.max(...)` can never
 * drift apart.
 */
export const MOVE_TOKEN_SYMBOL_MAX = TOKEN_SYMBOL_MAX_LENGTH;

/**
 * IPC input for `vex.portfolio.listMoves`. `.strict()` rejects any extra key;
 * `sessionId` MUST be a UUID. The renderer never supplies a wallet address —
 * main resolves the session's wallet scope server-side.
 */
export const movesReadInputSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();
export type MovesReadInput = z.infer<typeof movesReadInputSchema>;

/** Which of the two UNIONed sources produced a row (see module header). */
export const moveSourceSchema = z.enum(["success", "agent_activity"]);
export type MoveSource = z.infer<typeof moveSourceSchema>;

/**
 * `agent_activity`-only lifecycle status, collapsed from the DB's 3-value
 * `pending | confirmed | definitively_failed` to a renderer-facing
 * `pending | confirmed | failed` (mirrors `db/repos/transactions.ts`'s
 * compatibility feed naming, root `src/`, read-only reference — NOT
 * imported). `null` on a legacy `success`-sourced row.
 */
export const moveStatusSchema = z.enum(["pending", "confirmed", "failed"]);
export type MoveStatus = z.infer<typeof moveStatusSchema>;

/**
 * One MOVES row — an executed-trade ACTIVITY row (a fill) or, for
 * `source: "agent_activity"`, one swap ATTEMPT (pending/confirmed/failed).
 * Batch captures legitimately produce multiple fills per `execution_id`, so
 * rows are bounded by recency, never collapsed per execution (collapsing would
 * hide individual fills).
 *
 *  - `id`            — source-prefixed (`"success:42"` / `"agent_activity:7"`)
 *                      so ids from the two independent underlying serial
 *                      sequences can never collide as a renderer list key.
 *  - `source`        — which underlying table produced this row.
 *  - `status`        — `agent_activity` only; `null` for `source: "success"`
 *                      (a legacy row's lifecycle is `captureStatus` instead).
 *  - `failureCode`   — `agent_activity` only; the closed `failure_code` enum
 *                      (`route_not_found`, `slippage`, …) when `status ===
 *                      "failed"`; `null` otherwise.
 *  - `tradeSide`     — `buy`/`sell` for EVM spot; `null` for neutral swaps.
 *  - `productType`   — `proj_activity.product_type` (`spot`, `bridge`, `perps`,
 *                      `send`, …) or, for an `agent_activity` row, derived from
 *                      `kind` (`spot`/`bridge`/`lend`/`prediction` — migration
 *                      049, W5, added the last two) — tolerant string, NOT an
 *                      enum; drives the renderer's chip (`bridge` → BRIDGE).
 *                      Nullable for tolerance even though the DDL is NOT NULL.
 *  - `venue`         — `proj_activity.namespace`: the protocol namespace that
 *                      executed the move (e.g. `relay`, `khalani`, `uniswap`) —
 *                      distinguishes bridge venues in the chip. Nullable for
 *                      tolerance even though the DDL is NOT NULL.
 *  - `inputToken` / `inputAmount` / `outputToken` / `outputAmount` — the swap
 *                      legs as the engine recorded them (all nullable).
 *  - `inputTokenSymbol` / `outputTokenSymbol` — bounded, display-only symbols
 *                      recovered from the activity row's exact capture item
 *                      (`protocol_capture_items.trade_capture`); nullable for
 *                      historical/incomplete captures. UNTRUSTED: any on-chain
 *                      token can self-declare this metadata, so the renderer
 *                      must never let it override `inputToken`/`outputToken`
 *                      identity or claim a brand icon without independent
 *                      corroboration — see `token-symbol-sanitizer.ts`.
 *  - `inputTokenLocalSymbol` / `outputTokenLocalSymbol` — a FALLBACK, bounded
 *                      display symbol resolved from THIS WALLET's OWN
 *                      `proj_balances` rows (the balance sync's `token_symbol`
 *                      for that exact `token_address`), consulted ONLY when
 *                      the capture item recorded no usable symbol (the legacy
 *                      "raw contract address" rows). Defaults to `null` so
 *                      pre-existing payloads still parse. EQUALLY UNTRUSTED —
 *                      `proj_balances.token_symbol` is itself provider-
 *                      supplied metadata, so this field is gated by the exact
 *                      same brand-collision rule as the captured symbol (see
 *                      `MovesBlock.tsx`'s `tokenDisplay`) and MUST NEVER grant
 *                      a brand icon on its own.
 *  - `valueUsd`      — notional USD; `null` when the engine could not price it.
 *  - `captureStatus` — the trade-capture lifecycle status string (tolerant).
 *  - `instrumentKey` — opaque instrument identifier; `null` when absent.
 *  - `chain`         — `proj_activity.chain` (NOT NULL in the DDL): the venue
 *                      chain identifier the engine recorded (e.g. `solana`,
 *                      `ethereum`, `base`) — tolerant string, NOT an enum.
 *                      Powers the renderer's block-explorer deep links.
 *  - `txRef`         — the on-chain transaction reference extracted server-side
 *                      as a SINGLE bounded scalar from `external_refs`
 *                      (`txHash` for EVM, `signature` for Solana); `null` when
 *                      the capture recorded neither. The raw `external_refs`
 *                      JSONB is still never shipped to the renderer.
 *  - `walletAddress` — `proj_activity.wallet_address`: the session's OWN wallet
 *                      that executed the move (already server-side scoped to the
 *                      session — never renderer-supplied). Powers the account
 *                      block-explorer link for rows that carry no `txRef` (e.g.
 *                      HyperCore fills). Nullable for tolerance.
 *  - `createdAt`     — activity timestamp (offset ISO; NOT NULL in the DDL).
 */
export const moveItemSchema = z
  .object({
    id: z.string(),
    source: moveSourceSchema,
    tradeSide: z.string().nullable(),
    productType: z.string().nullable(),
    venue: z.string().nullable(),
    inputToken: z.string().nullable(),
    inputTokenSymbol: z.string().min(1).max(MOVE_TOKEN_SYMBOL_MAX).nullable(),
    inputTokenLocalSymbol: z
      .string()
      .min(1)
      .max(MOVE_TOKEN_SYMBOL_MAX)
      .nullable()
      .default(null),
    inputAmount: z.string().nullable(),
    outputToken: z.string().nullable(),
    outputTokenSymbol: z.string().min(1).max(MOVE_TOKEN_SYMBOL_MAX).nullable(),
    outputTokenLocalSymbol: z
      .string()
      .min(1)
      .max(MOVE_TOKEN_SYMBOL_MAX)
      .nullable()
      .default(null),
    outputAmount: z.string().nullable(),
    valueUsd: z.number().nullable(),
    captureStatus: z.string().nullable(),
    /** `agent_activity` only — `null` for a legacy `source: "success"` row. */
    status: moveStatusSchema.nullable(),
    /** `agent_activity` only — tolerant string (mirrors `captureStatus`'s
     * doctrine above: a closed re-declared enum here would risk the same
     * empty-MOVES-on-drift bug this DTO exists to avoid). */
    failureCode: z.string().nullable(),
    instrumentKey: z.string().nullable(),
    chain: z.string(),
    txRef: z.string().nullable(),
    walletAddress: z.string().nullable(),
    /**
     * BRIDGE ROWS ONLY (Agent Scan Phase 2 / R14). A bridge is a from→to
     * event: `chain` above carries the logical row's own execution chain (the
     * destination, where the fill hash lives), while `fromChain`/`toChain`
     * carry the route endpoints for display. `null` on every swap/legacy row.
     */
    fromChain: z.string().nullable().default(null),
    toChain: z.string().nullable().default(null),
    /** Bridge rows only — the provider order id (Khalani orderId / Relay requestId); `null` otherwise. */
    providerOrderId: z.string().max(128).nullable().default(null),
    /**
     * Bridge rows (BINDING Q2) AND `lend`/`prediction` rows (migration 049,
     * W5 design REVISION 1 R3/R5) — whether `inputAmount`/`outputAmount` are
     * the independently-verified executed amounts (`"executed"`) or the
     * quoted amounts shown as an estimate (`"estimated"`); `null` when no
     * honest amount is shown. A PLAIN swap row leaves this `null` (its
     * honesty is C20's status-driven `resolveAgentActivityAmount`, which
     * never needs the estimate label — see that function's doc for why).
     */
    amountBasis: bridgeAmountBasisSchema.nullable().default(null),
    /**
     * Bridge rows only (B8) — every leg (allowances, deposit, the canonical
     * expected fill, extra observed fills, refunds) preserved for audit so a
     * multi-leg bridge shows ONCE with its legs available. `[]` on swap/legacy
     * rows. NEVER truncated (OWNER RULE).
     */
    legs: bridgeLegsSchema.default([]),
    /**
     * Bridge rows only (R12) — the timestamp of the last SUCCESSFUL sweep check
     * of this pending bridge's provider order status (`agent_activity.
     * last_checked_at`); `null` when never checked or on a swap/legacy row. The
     * renderer flags a pending bridge as "tracking delayed" when this (or, when
     * null, `createdAt`) is stale — see `shared/bridge-tracking.ts`. Defaults to
     * `null` so legacy/swap payloads still parse.
     */
    lastCheckedAt: z.string().datetime({ offset: true }).nullable().default(null),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type MoveItem = z.infer<typeof moveItemSchema>;

/**
 * MOVES read result — newest activity first, capped at `MOVES_MAX`. The cap is
 * enforced in the SQL `LIMIT` AND mirrored here so an over-cap result fails
 * closed at the boundary instead of silently truncating downstream.
 */
export const movesDtoSchema = z.array(moveItemSchema).max(MOVES_MAX);
export type MovesDto = z.infer<typeof movesDtoSchema>;
