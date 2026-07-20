/**
 * Portfolio MOVES schemas — read-only per-session executed-trade activity.
 *
 * The MOVES feed surfaces what the agent actually DID on-chain by reading the
 * `proj_activity` projection (success-only by construction), scoped to the
 * session's selected wallets. This is distinct from `approvals.getHistory`,
 * which only carries rows for `restricted`-permission sessions — a `full`
 * mission executes swaps with NO approval rows, so MOVES reads the real
 * activity projection instead.
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
 *                     `trade_side = NULL`) — NOT an enum.
 *   - `captureStatus` is a tolerant `z.string().nullable()` (the engine emits
 *                     `executed`, `open`, `closed`, `cancelled`, `claimed`,
 *                     `pending`, `filled`, … — NOT constrained to an enum).
 * Only `id` (SERIAL) and `createdAt` (NOT NULL, `DEFAULT NOW()`) are non-null.
 */

import { z } from "zod";
import { TOKEN_SYMBOL_MAX_LENGTH } from "../token-symbol-sanitizer.js";

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
 *
 * `missionRunId` is an OPTIONAL narrowing for the mission summary card, which
 * reports a single run of a session that may hold several. It never widens the
 * read: the wallet scope and `session_id` predicates still apply, and main
 * additionally requires the run to belong to this session (see `moves-db.ts`),
 * so a foreign run id returns nothing rather than another session's trades.
 * Omitted → the unchanged whole-session feed.
 */
export const movesReadInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    missionRunId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type MovesReadInput = z.infer<typeof movesReadInputSchema>;

/**
 * One MOVES row — an executed-trade ACTIVITY row (a fill), NOT an execution.
 * Batch captures legitimately produce multiple fills per `execution_id`, so
 * rows are bounded by recency, never collapsed per execution (collapsing would
 * hide individual fills).
 *
 *  - `id`            — `proj_activity.id` (SERIAL) stringified for the renderer.
 *  - `tradeSide`     — `buy`/`sell` for EVM spot; `null` for neutral swaps.
 *  - `productType`   — `proj_activity.product_type` (`spot`, `bridge`, `perps`,
 *                      `send`, …) — tolerant string, NOT an enum; drives the
 *                      renderer's chip (`bridge` → BRIDGE). Nullable for
 *                      tolerance even though the DDL is NOT NULL.
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
    instrumentKey: z.string().nullable(),
    chain: z.string(),
    txRef: z.string().nullable(),
    walletAddress: z.string().nullable(),
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
