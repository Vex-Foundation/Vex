/**
 * Transactions repo (Stage 9; Agent Scan plan §4.1/§11.1 added the
 * `agent_activity` half; FIX-SPINE round 1 fixed feed correctness per Codex
 * findings 1/2/16, C9; FIX2-SPINE round 2 fixed a quote-vs-settlement leak
 * per Codex final-review finding 5/C20) — the unified, keyset-paginated tx
 * feed behind the agent-facing history view.
 *
 * It FUSES three halves into ONE bounded row shape, then keyset-paginates the
 * union:
 *   - AGENT_ACTIVITY half — `agent_activity` rows (source='agent_activity',
 *     sourceRank=0) for the session's selected wallet set. New-format swap
 *     attempts: pending/confirmed/definitively_failed, wallet-scoped like the
 *     success half (agent_activity carries `wallet_address` directly, unlike
 *     `protocol_executions`). Carries the FULL per-leg detail additively (see
 *     `TransactionRow`) — requested vs executed amounts, token addr/symbol/
 *     decimals, failure_reason, protocol_execution_id/event_index/event_role,
 *     usd in/out/fee/source.
 *   - SUCCESS half — proj_activity rows for the session's selected wallet set
 *     (source='success', sourceRank=1). Carries the trade economics (legacy
 *     shape — no per-leg token/amount granularity).
 *   - FAILURE half — protocol_executions for the CURRENT session, restricted
 *     to the trade-impacting failure-tool allowlist (source='failure',
 *     sourceRank=2). Carries NO economics — failures never produced a fill —
 *     and is selected with ONLY bounded columns: `params`, `result`, and
 *     `trade_capture` are NEVER selected (they may hold raw provider/error
 *     payloads — data-exposure invariant).
 *
 *     TWO conditions (FIX-SPINE C9, findings 1/2) keep this half correct:
 *       1. `execution_status = 'failed'` — NOT just `success = false`. Every
 *          freshly-created intent row (Hyperliquid; Agent Scan's own
 *          `createAgentActivityIntent`) starts `success = false` (the column
 *          DEFAULT) with `execution_status = 'intent'` until it completes —
 *          filtering on `success = false` alone would show every IN-FLIGHT
 *          intent as an already-failed transaction.
 *       2. `NOT EXISTS (... agent_activity WHERE protocol_execution_id = …)`
 *          — a Kyber/Uniswap swap execute's toolId IS in the failure-tool
 *          allowlist (its matrix `expectedType` derives to "spot" like any
 *          other spot tool) precisely so a failure that happened BEFORE any
 *          `agent_activity` row could be created still surfaces here. But
 *          once that row exists, `agent_activity` is the source of truth for
 *          THAT SAME execution — this half must not ALSO show it a second
 *          time under a different `source`.
 *
 *   FIX2-SPINE C20 (Codex final-review finding 5) — a `confirmed` row must
 *   NEVER display a quote-time human amount as if it were the settled truth.
 *   The SQL no longer COALESCEs executed/requested human amounts into a
 *   convenience column for the agent_activity half; it selects the raw
 *   executed/requested legs + token decimals (already needed for the
 *   granular fields below) and the TS mapper (`rawToHuman`, BigInt-safe via
 *   viem's `formatUnits`) derives `inputAmount`/`outputAmount` FROM the
 *   status: `confirmed` → executed raw only; `pending` → requested raw only
 *   (labelled via `amountBasis:"requested"` — nothing has settled yet, so
 *   showing the quote is honest, not settlement); any other status (i.e.
 *   `definitively_failed`) → no convenience amount at all, matching "quotes
 *   never masquerade as settlement" (there is no settlement AND the attempt
 *   is no longer in progress, so no display amount claims to represent
 *   truth).
 *
 * Filters: productType filters proj_activity.product_type on the success half
 * and the DERIVED PRODUCT (via the failure-tool allowlist, current + legacy)
 * on the failure half — NEVER trade_side. On the agent_activity half it maps to
 * `kind`: 'spot' → swap rows (migration 044), 'bridge' → bridge rows (migration
 * 045), 'lend' → lend rows, 'prediction' → prediction rows (migration 049, W5);
 * any other requested productType (perps/order) has no agent_activity
 * representation and excludes the half. namespace + txHash filter all three
 * halves where applicable. A null/empty sessionId OMITS the failure half
 * entirely (successes + agent_activity only) — a failure feed is meaningless
 * without a session to scope it to, and must never leak another session's
 * failures.
 *
 * LEND/PREDICTION ROWS (migration 049, W5): one role per on-chain tx — no
 * logical/leg fan-out like bridges. `lend_deposit`/`lend_withdraw`/
 * `lend_borrow_operate` and `predict_buy`/`predict_sell`/`predict_claim`/
 * `predict_close` each surface as their OWN feed row (closeAll's N independent
 * closes each get their own row, per R5 — never aggregated or summarized as
 * one partial-success outcome). They share the swap C20 amount rule (below)
 * with one correction (R5): a `confirmed` lend/prediction row is NOT
 * guaranteed decoder-proven (the Solana settlement decoder may confirm
 * on-chain landing without decodable balance deltas for every protocol/role)
 * — when executed amounts are absent on a confirmed row, the mapper falls
 * back to the quoted amount labelled `amountBasis:"estimated"` rather than
 * showing nothing for an attempt that DID land on-chain.
 *
 * BRIDGE ROWS (migration 045): a bridge fans out into per-leg agent_activity
 * rows, but the feed emits ONE logical row per bridge — its
 * `event_role = 'bridge_fill_expected'` row (productType 'bridge') — with a
 * `legs[]` array carrying that canonical row AND every sibling leg (allowances,
 * deposit, extra observed fills, refunds), each with its own chain + hash +
 * status. Legs are NEVER truncated (OWNER RULE). Swap rows are unchanged (still
 * one feed row per leg). A bridge logical row's `chain`/`chainId` are its own
 * (destination) chain — where the fill hash lives — while `fromChain*`/
 * `toChain*` carry the route endpoints. Bridge display amounts follow BINDING
 * Q2 (executed-if-independently-verified, else the quote shown as an estimate).
 * A `txHash=` lookup is LEG-AWARE for bridges: the logical row surfaces when
 * ANY of its legs (deposit / fill / refund / extra fill) carries the hash, not
 * only its top-level fill hash — so an operator can find a bridge by any of its
 * on-chain hashes (Codex FIX-ROUND-1 m7).
 *
 * Pagination: keyset over the tuple (created_at, sourceRank, id), DESC. The
 * cursor timestamp is the DB-side microsecond rendering of created_at (see
 * `transactions-cursor.ts`) so sub-millisecond ties paginate correctly. Fetches
 * limit+1 to detect `hasMore`; `nextCursor` is minted from the last KEPT row.
 *
 * Migrations: `030_transactions_indexes.sql`, `044_agent_activity.sql`,
 * `045_bridge_activity.sql`, `049_agent_activity_solana_vocabulary.sql`.
 *
 * Public API module (these types + `getTransactions`). Internals split into
 * sibling files by concern: `transactions-types.ts` (row/option types),
 * `transactions-mappers.ts` (row → `TransactionRow` mapping),
 * `transactions-query-builder.ts` (per-half SQL builders + keyset predicate).
 * Consumers import from this module — the siblings are implementation detail.
 */

import { query } from "../client.js";
import { encodeCursor } from "./transactions-cursor.js";
import { mapRow } from "./transactions-mappers.js";
import {
  buildActivityHalf,
  buildFailureHalf,
  buildSuccessHalf,
  normalizeSourceRank,
} from "./transactions-query-builder.js";
import type { GetTransactionsOptions, GetTransactionsResult } from "./transactions-types.js";

export type {
  TransactionSource,
  BridgeLegRow,
  TransactionRow,
  GetTransactionsOptions,
  GetTransactionsResult,
} from "./transactions-types.js";

/**
 * Fetch the unified transaction feed for the session's wallet set. See module
 * doc for the half semantics, filters, and pagination contract.
 */
export async function getTransactions(opts: GetTransactionsOptions): Promise<GetTransactionsResult> {
  const { addresses, sessionId, productType, namespace, txHash, cursor, limit } = opts;
  const hasSession = typeof sessionId === "string" && sessionId.length > 0;

  // Empty wallet set → the agent_activity/success halves match nothing. The
  // failure half is session-scoped, not wallet-scoped, so it can still
  // surface rows; but with no wallets there is no portfolio context to report
  // against, so we keep the same fail-closed posture as the other
  // wallet-scoped views and return [].
  if (addresses.length === 0) {
    return { items: [], nextCursor: null, hasMore: false, failuresScope: "session" };
  }

  const params: unknown[] = [];
  const push = (value: unknown): number => {
    params.push(value);
    return params.length;
  };

  // Cursor binds — shared across all halves so the keyset boundary is identical.
  const tsParam = cursor ? push(cursor.cursorTs) : 0;
  const rankParam = cursor ? push(cursor.sourceRank) : 0;
  const idParam = cursor ? push(cursor.id) : 0;

  const halves: string[] = [
    buildActivityHalf({ addresses, namespace, txHash, productType, cursor, tsParam, rankParam, idParam, push }),
    buildSuccessHalf({ addresses, productType, namespace, txHash, cursor, tsParam, rankParam, idParam, push }),
  ];

  // ── FAILURE half (protocol_executions) ─────────────────────────────────
  // Omitted entirely without a session — never leak another session's failures.
  if (hasSession) {
    halves.push(
      buildFailureHalf({ sessionId, productType, namespace, txHash, cursor, tsParam, rankParam, idParam, push }),
    );
  }

  const limitParam = push(limit + 1);
  const sql = `${halves.join("\n    UNION ALL\n")}
    ORDER BY created_at DESC, source_rank DESC, id DESC
    LIMIT $${limitParam}`;

  const rows = await query<Record<string, unknown>>(sql, params);

  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;
  const items = kept.map(mapRow);

  const lastKept = kept[kept.length - 1];
  const nextCursor = hasMore && lastKept !== undefined
    ? encodeCursor({
        cursorTs: lastKept.cursor_ts as string,
        sourceRank: normalizeSourceRank(lastKept.source_rank),
        id: Number(lastKept.id),
      })
    : null;

  return { items, nextCursor, hasMore, failuresScope: "session" };
}
