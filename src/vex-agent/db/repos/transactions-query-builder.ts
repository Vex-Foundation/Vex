/**
 * Transactions repo — per-half SQL builders + keyset-cursor plumbing.
 *
 * `getTransactions` (transactions.ts) assembles its UNION ALL feed query from
 * the three half-builders below (agent_activity / success / failure), each
 * sharing the same `push`/`params` binder and the same keyset boundary
 * (`tsParam`/`rankParam`/`idParam`) so the cursor comparison is identical
 * across halves. See transactions.ts's module doc for the full three-half
 * feed semantics, filters, and pagination contract these builders implement.
 */

import type { DecodedCursor } from "./transactions-cursor.js";
import { failureToolsForProduct } from "./transactions-failure-tools.js";

// Microsecond-precision UTC render of created_at, used BOTH as the keyset
// boundary value (compared via ::timestamptz) and as the minted cursor's
// cursorTs. Round-trips losslessly through ::timestamptz.
const CURSOR_TS_EXPR = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * THE VEX FEE, FROM ONE WHOLE SOURCE (R1 Step 2) — a READ projection, never a
 * second write.
 *
 * The problem it fixes: on the five venues that charge the fee as its own
 * on-chain transfer (relay/khalani bridges, Uniswap, Trench trade and launch)
 * the fee lives on a SIBLING leg row, and that leg is not a feed row — so the
 * logical row the user and the agent actually read reported no fee at all.
 *
 * Three rules, each of which a naive per-field COALESCE would break:
 *
 * 1. ONE SOURCE WINS WHOLE. All six fee fields switch on `vex_fee_source`, so a
 *    mixed tuple — an own-row symbol beside a sibling amount — is
 *    unrepresentable.
 * 2. THE OWN-ROW SOURCE IS GATED ON `status = 'confirmed'`, exactly as the
 *    sibling source already is. The own-row `vex_fee_*` columns are written at
 *    INTENT time while the row is still pending, and that handler's own comment
 *    says why: this row's status is what says whether the fee was actually
 *    COLLECTED. Without the gate a pending swap would report a PLANNED fee as
 *    collected.
 * 3. ANOMALIES FAIL CLOSED. Two confirmed fee legs on one execution, or an
 *    own-row fee AND a confirmed sibling, report NO exact fee and set
 *    `vex_fee_anomaly` for the mapper to log. Reporting one exact-looking fee
 *    while knowingly omitting another is a money field stating less than the
 *    truth with no marker. Summing is not an option until split-fee semantics
 *    are defined (identical token identity and decimals proven first).
 *
 * No DB constraint forbids two fee legs today; a partial unique index would make
 * it structurally impossible but could also reject a future legitimate split
 * fee, so it stays a named follow-up rather than part of this change.
 */
const VEX_FEE_LATERALS = `
    LEFT JOIN LATERAL (
      SELECT fee.token_in_address                                     AS vex_fee_token_address,
             fee.token_in_symbol                                      AS vex_fee_token_symbol,
             fee.token_in_decimals                                    AS vex_fee_token_decimals,
             COALESCE(fee.executed_amount_in_raw,   fee.amount_in_raw)   AS vex_fee_amount_raw,
             COALESCE(fee.executed_amount_in_human, fee.amount_in_human) AS vex_fee_amount_human,
             fee.usd_vex_fee_est                                      AS usd_vex_fee_est,
             count(*) OVER ()                                         AS fee_leg_count
        FROM agent_activity fee
       WHERE fee.protocol_execution_id = agent_activity.protocol_execution_id
         AND fee.id        <> agent_activity.id
         AND fee.event_role IN ('bridge_fee','swap_fee','trench_fee','pools_fee')
         AND fee.status     = 'confirmed'
       ORDER BY fee.event_index ASC
       LIMIT 1
    ) fee_leg ON TRUE
    LEFT JOIN LATERAL (
      SELECT (agent_activity.vex_fee_amount_raw IS NOT NULL
              AND agent_activity.status = 'confirmed')                AS own_ok,
             (fee_leg.vex_fee_amount_raw IS NOT NULL
              AND fee_leg.fee_leg_count = 1)                          AS sibling_ok,
             (fee_leg.vex_fee_amount_raw IS NOT NULL
              AND fee_leg.fee_leg_count > 1)                          AS multiplicity
    ) fee_flags ON TRUE
    LEFT JOIN LATERAL (
      SELECT CASE
               WHEN fee_flags.own_ok AND fee_flags.sibling_ok THEN NULL
               WHEN fee_flags.own_ok THEN 'in_transaction'
               WHEN fee_flags.sibling_ok THEN 'separate_leg'
             END::text AS vex_fee_source,
             CASE
               WHEN fee_flags.own_ok AND fee_flags.sibling_ok THEN 'own_and_sibling'
               WHEN fee_flags.multiplicity THEN 'multiple_fee_legs'
             END::text AS vex_fee_anomaly
    ) fee_pick ON TRUE`;

/**
 * Build the per-half keyset predicate for DESC ordering on
 * (created_at, sourceRank, id). `sourceRank` is a constant per half so the
 * comparison is specialised (index-friendly) rather than a row-value compare.
 * Returns "" when no cursor (first page).
 */
function keysetPredicate(
  sourceRank: 0 | 1 | 2,
  cursor: DecodedCursor | null | undefined,
  tsParam: number,
  rankParam: number,
  idParam: number,
): string {
  if (!cursor) return "";
  return (
    `AND (created_at < $${tsParam}::timestamptz` +
    ` OR (created_at = $${tsParam}::timestamptz AND ${sourceRank} < $${rankParam}::int)` +
    ` OR (created_at = $${tsParam}::timestamptz AND ${sourceRank} = $${rankParam}::int AND id < $${idParam}::int))`
  );
}

/** Shared keyset-bind params every half's builder needs. */
interface HalfKeysetParams {
  cursor: DecodedCursor | null | undefined;
  tsParam: number;
  rankParam: number;
  idParam: number;
  push: (value: unknown) => number;
}

export function buildActivityHalf(
  params: HalfKeysetParams & {
    addresses: string[];
    namespace?: string;
    txHash?: string;
    productType?: string;
  },
): string {
  const { addresses, namespace, txHash, productType, cursor, tsParam, rankParam, idParam, push } = params;

  // ── AGENT_ACTIVITY half (agent_activity) ──────────────────────────────
  const activityConds: string[] = [`wallet_address = ANY($${push(addresses)}::text[])`];
  if (namespace !== undefined) activityConds.push(`protocol = $${push(namespace)}`);
  if (txHash !== undefined) {
    // A bridge's logical row (`bridge_fill_expected`) carries the FILL hash; its
    // deposit / refund / extra-fill hashes live on sibling legs. Match the row
    // when its OWN tx_hash matches (this alone covers swaps — each swap leg is
    // its own feed row) OR — for a bridge logical row only — when ANY sibling
    // leg of the same execution carries the hash, so `agent_scan txHash=` finds
    // a bridge by a deposit / refund / extra-fill hash and returns the logical
    // row with its legs (Codex FIX-ROUND-1 m7). The EXISTS is gated on the
    // logical role so it never widens a swap leg's own-hash match.
    const txHashParam = push(txHash);
    activityConds.push(
      `(tx_hash = $${txHashParam}` +
        ` OR (event_role = 'bridge_fill_expected' AND EXISTS (` +
        `SELECT 1 FROM agent_activity sib` +
        ` WHERE sib.protocol_execution_id = agent_activity.protocol_execution_id` +
        ` AND sib.tx_hash = $${txHashParam})))`,
    );
  }
  // A bridge (migration 045) fans out into per-leg rows; only its LOGICAL row
  // (`event_role = 'bridge_fill_expected'`) is a feed row — its allowance/
  // deposit/observed-fill/refund siblings ride the row's `legs[]` array, never
  // as their own feed rows. Swaps keep emitting every leg row (allowance +
  // swap) exactly as before (behavior preserved). `lend`/`prediction`
  // (migration 049, W5) are ONE-role-per-on-chain-tx like swaps — no logical/
  // leg split — so every row of those kinds is its own feed row, including
  // closeAll's N independent `predict_close`/`predict_claim` rows (R5: each is
  // an independent user-facing outcome, never aggregated into one row's legs).
  // `launch` (migration 062) joins the one-role-per-on-chain-tx group: a Trench
  // create is a single transaction with a single `token_launch` row, so every
  // launch row is its own feed row. Its prebuy is a LEG of that same row, not a
  // sibling — there is deliberately no second `swap` row to fold in.
  // `wrap` (migration 051) and `yield` (migration 053) were written correctly
  // and then read by nobody: a successful Pendle trade recorded a receipt-truth
  // `kind = 'yield'` row that this predicate excluded, while a FAILED one still
  // reached the feed through the failure half — the agent saw only its own
  // losses. The vocabulary-lockstep test beside this file now fails the build
  // when a migration adds a kind these feeds do not know.
  activityConds.push(
    "(kind = 'swap' OR kind = 'lend' OR kind = 'prediction' OR kind = 'wrap' OR kind = 'yield' OR kind = 'launch' OR kind = 'claim' OR kind = 'transfer' OR event_role = 'bridge_fill_expected')",
  );
  // LEG roles are not feed rows. The kind↔role CHECK (migrations 050/063/066)
  // admits approval legs on the swap/yield/launch arms and Vex fee legs
  // (`trench_fee`, `swap_fee`, `pools_fee`) on swap/launch — all of them children of the
  // logical row above, not sibling trades. Admitting by `kind` alone rendered
  // a Trench/Uniswap fee transfer as a standalone "spot" trade. `bridge_fee`
  // needs no entry here: its whole `kind = 'bridge'` arm is already admitted
  // only through `event_role = 'bridge_fill_expected'`.
  activityConds.push(
    "event_role NOT IN ('allowance', 'allowance_reset', 'trench_fee', 'swap_fee', 'pools_fee')",
  );
  // productType now maps to `kind`: 'spot' → swap rows (derive to the same
  // "spot" product the success half stores), 'bridge' → bridge logical rows,
  // 'lend' → lend rows, 'prediction' → prediction rows, 'wrap' → wrap rows,
  // 'yield' → yield rows, 'launch' → launch rows, 'claim' → creator-fee
  // claims. Any OTHER productType
  // (perps/order) has no agent_activity representation → exclude the half
  // entirely (no param bind needed).
  if (productType === "spot") activityConds.push("kind = 'swap'");
  else if (productType === "bridge") activityConds.push("kind = 'bridge'");
  else if (productType === "lend") activityConds.push("kind = 'lend'");
  else if (productType === "prediction") activityConds.push("kind = 'prediction'");
  else if (productType === "wrap") activityConds.push("kind = 'wrap'");
  else if (productType === "yield") activityConds.push("kind = 'yield'");
  else if (productType === "launch") activityConds.push("kind = 'launch'");
  else if (productType === "claim") activityConds.push("kind = 'claim'");
  else if (productType === "transfer") activityConds.push("kind = 'transfer'");
  else if (productType !== undefined) activityConds.push("FALSE");
  const activityKeyset = keysetPredicate(0, cursor, tsParam, rankParam, idParam);

  return `
    SELECT
      'agent_activity'::text AS source,
      0 AS source_rank,
      id,
      protocol AS namespace,
      CASE
        WHEN kind = 'bridge' THEN 'bridge'
        WHEN kind = 'lend' THEN 'lend'
        WHEN kind = 'prediction' THEN 'prediction'
        -- A launch is NOT a spot trade. Folding it into the ELSE would state a
        -- route, a price and a counterparty that a token creation never had —
        -- migration 051 records the cost of exactly that mistake, for wrap.
        WHEN kind = 'launch' THEN 'launch'
        -- A creator-fee CLAIM is its own product (migration 082). It is not a
        -- launch: it pays two assets out, months later, from a token that
        -- already exists - and it is certainly not the ELSE arm's spot trade,
        -- which would state a route, a price and a counterparty it never had.
        WHEN kind = 'claim' THEN 'claim'
        -- A wallet SEND is its own product (migration 084). The ELSE arm would
        -- render it as a spot trade, stating a route, a price and a
        -- counterparty that moving your own funds to an address never had.
        WHEN kind = 'transfer' THEN 'transfer'
        WHEN kind = 'wrap' THEN 'wrap'
        -- Pendle (migration 053) is its OWN product. The ELSE arm would state
        -- a route, a price and a counterparty that a py.mint (1 -> 2) or a
        -- claim (no input leg) never had — the same falsehood 051 records.
        WHEN kind = 'yield' THEN 'yield'
        ELSE 'spot'
      END AS product_type,
      NULL::text AS trade_side,
      COALESCE(chain_slug, chain_id::text) AS chain,
      COALESCE(token_in_symbol, token_in_address) AS input_token,
      -- FIX2-SPINE C20 (finding 5): no human-amount COALESCE here — the TS
      -- mapper derives inputAmount from raw + decimals per the row's status
      -- (see module doc). This column stays a placeholder so the UNION ALL's
      -- column count/order matches the success half exactly.
      NULL::text AS input_amount,
      COALESCE(token_out_symbol, token_out_address) AS output_token,
      NULL::text AS output_amount,
      COALESCE(usd_out_est, usd_in_est) AS value_usd,
      NULL::text AS capture_status,
      status AS status,
      failure_code,
      failure_reason,
      chain_id,
      protocol,
      NULL::text AS tool_id,
      NULL::int AS duration_ms,
      protocol_execution_id,
      event_index,
      event_role,
      token_in_address,
      token_in_symbol,
      token_in_decimals,
      token_out_address,
      token_out_symbol,
      token_out_decimals,
      amount_in_human,
      amount_in_raw,
      amount_out_human,
      amount_out_raw,
      executed_amount_in_human,
      executed_amount_in_raw,
      executed_amount_out_human,
      executed_amount_out_raw,
      usd_in_est,
      usd_out_est,
      usd_fee_est,
      usd_network_gas_est,
      usd_venue_fee_est,
      usd_destination_prepay_est,
      -- The Vex fee, from ONE WHOLE SOURCE (R1 Step 2). See the two LATERALs at
      -- the bottom of this half: all six fields switch on the SAME discriminator,
      -- so a mixed tuple (own-row symbol beside a sibling amount) is
      -- unrepresentable. This is a READ PROJECTION and writes nothing — copying
      -- the fee onto the logical row would make one charge appear on two rows of
      -- one execution and break the documented
      -- SUM(usd_vex_fee_est) WHERE status='confirmed' revenue invariant.
      CASE fee_pick.vex_fee_source
        WHEN 'in_transaction' THEN agent_activity.usd_vex_fee_est
        WHEN 'separate_leg' THEN fee_leg.usd_vex_fee_est
      END AS usd_vex_fee_est,
      -- The Vex fee in TOKEN units (050 Part 2) — the exact fact behind the
      -- nullable USD estimate above. Projected because the transactions
      -- inspect view spreads this row straight into agent-visible output:
      -- without it the agent still sees only a null usd_vex_fee_est and
      -- cannot tell "no fee" from "no price".
      CASE fee_pick.vex_fee_source
        WHEN 'in_transaction' THEN agent_activity.vex_fee_token_address
        WHEN 'separate_leg' THEN fee_leg.vex_fee_token_address
      END AS vex_fee_token_address,
      CASE fee_pick.vex_fee_source
        WHEN 'in_transaction' THEN agent_activity.vex_fee_token_symbol
        WHEN 'separate_leg' THEN fee_leg.vex_fee_token_symbol
      END AS vex_fee_token_symbol,
      CASE fee_pick.vex_fee_source
        WHEN 'in_transaction' THEN agent_activity.vex_fee_token_decimals
        WHEN 'separate_leg' THEN fee_leg.vex_fee_token_decimals
      END AS vex_fee_token_decimals,
      CASE fee_pick.vex_fee_source
        WHEN 'in_transaction' THEN agent_activity.vex_fee_amount_raw
        WHEN 'separate_leg' THEN fee_leg.vex_fee_amount_raw
      END AS vex_fee_amount_raw,
      CASE fee_pick.vex_fee_source
        WHEN 'in_transaction' THEN agent_activity.vex_fee_amount_human
        WHEN 'separate_leg' THEN fee_leg.vex_fee_amount_human
      END AS vex_fee_amount_human,
      -- Mapper-internal, NOT an IPC DTO field: which whole source won, and
      -- whether the row hit an anomaly that made us report no exact fee at all.
      fee_pick.vex_fee_source,
      fee_pick.vex_fee_anomaly,
      usd_source,
      from_chain_id,
      from_chain_slug,
      to_chain_id,
      to_chain_slug,
      chain_family,
      provider_order_id,
      provider_status,
      -- Wave P (migration 065): the DERIVED stalled-verification signal. The
      -- agent otherwise sees a bare pending status and cannot tell "still
      -- mining" from "we have been unable to check for forty minutes" — the
      -- blind-retry failure mode the agent-facing-errors decree names.
      -- R1 Step 1c (migration 067): a DIRECTLY-confirmed row reports exactly
      -- 1 -- one look, which concluded. That 1 is derived for tool_response
      -- ONLY: a status-only confirmation that really did fail five checks must
      -- keep reporting five, or the row lies about our own knowledge. The
      -- amount-evidence arms deliberately do NOT touch this counter -- no
      -- verification check failed, so migration 065's stall gauge stays true.
      CASE WHEN confirmation_source = 'tool_response' THEN 1
           ELSE verification_attempts END AS verification_attempts,
      -- Precedence, highest first. The three settlement_source decline/conflict
      -- values only ever exist on a row that is ALREADY confirmed -- its status
      -- question is answered and the only open question is the money, so they
      -- must outrank a stale status provenance. A row whose amounts are
      -- quarantined must not keep reporting from_tool_response, which would
      -- say "we read this off our own receipt" about a figure we refused to
      -- write. Below them, a REAL verifier reason outranks a handler reason:
      -- after ten receipt_unavailable checks a bridge must say so, not repeat
      -- the provider_fill_unverified the handler wrote at t=0.
      CASE
        WHEN settlement_source = 'conflict_quarantined' THEN 'amount_evidence_conflict'
        WHEN settlement_source = 'amounts_undecodable'  THEN 'amounts_undecodable'
        WHEN settlement_source = 'amounts_incomplete'   THEN 'amounts_incomplete'
        WHEN confirmation_source = 'tool_response'      THEN 'from_tool_response'
        WHEN verification_attempts > 0                  THEN last_verification_reason
        WHEN pending_reason IS NOT NULL                 THEN pending_reason
        ELSE COALESCE(confirmation_source, last_verification_reason)
      END AS last_verification_reason,
      -- Bridge legs (B8): every leg of the execution, the canonical expected
      -- fill INCLUDED (REVISION 4), aggregated with NO LIMIT (OWNER RULE — never
      -- truncated). NULL on swap rows.
      CASE WHEN kind = 'bridge' THEN (
        SELECT jsonb_agg(jsonb_build_object(
          'eventIndex', leg.event_index,
          'role', leg.event_role,
          'chainId', leg.chain_id,
          'chainSlug', leg.chain_slug,
          'chainFamily', leg.chain_family,
          'txHash', leg.tx_hash,
          'status', leg.status,
          'failureCode', leg.failure_code
        ) ORDER BY leg.event_index)
        FROM agent_activity leg
        WHERE leg.protocol_execution_id = agent_activity.protocol_execution_id
      ) END AS legs,
      tx_hash,
      created_at,
      ${CURSOR_TS_EXPR} AS cursor_ts
    FROM agent_activity
    ${VEX_FEE_LATERALS}
    WHERE ${activityConds.join(" AND ")} ${activityKeyset}`;
}

export function buildSuccessHalf(
  params: HalfKeysetParams & {
    addresses: string[];
    productType?: string;
    namespace?: string;
    txHash?: string;
  },
): string {
  const { addresses, productType, namespace, txHash, cursor, tsParam, rankParam, idParam, push } = params;

  // ── SUCCESS half (proj_activity) ──────────────────────────────────────
  const successConds: string[] = [
    `wallet_address = ANY($${push(addresses)}::text[])`,
    // D26 — the mirror of the failure half's guard (see buildFailureHalf): once
    // an agent_activity row exists for this execution, IT is the source of
    // truth, and the quote-derived `proj_activity` capture of the same
    // execution must not render alongside it.
    //
    // The guard is NOT Pendle-specific and no longer has a Pendle emitter: the
    // four Pendle families that once ALSO wrote a legacy `_tradeCapture` have
    // since been changed to `capture: "none"` (every Pendle handler now states
    // "NO `_tradeCapture`" at its return). It stays because the invariant is
    // general — any venue emitting both halves for one execution would render
    // the same trade TWICE — and because it is what keeps HISTORICAL dual-written
    // rows from doubling now that the activity half knows `kind = 'yield'`.
    // `execution_id` is nullable in proj_activity; a NULL never matches, so a
    // historical row with no agent_activity twin (everything written before
    // migration 053, which is deliberately NOT backfilled) still renders.
    "NOT EXISTS (SELECT 1 FROM agent_activity aa WHERE aa.protocol_execution_id = proj_activity.execution_id)",
  ];
  if (productType !== undefined) successConds.push(`product_type = $${push(productType)}`);
  if (namespace !== undefined) successConds.push(`namespace = $${push(namespace)}`);
  if (txHash !== undefined) successConds.push(`external_refs->>'txHash' = $${push(txHash)}`);
  const successKeyset = keysetPredicate(1, cursor, tsParam, rankParam, idParam);

  return `
    SELECT
      'success'::text AS source,
      1 AS source_rank,
      id,
      namespace,
      product_type AS product_type,
      trade_side,
      chain,
      input_token,
      input_amount,
      output_token,
      output_amount,
      value_usd,
      capture_status,
      NULL::text AS status,
      NULL::text AS failure_code,
      NULL::text AS failure_reason,
      NULL::bigint AS chain_id,
      NULL::text AS protocol,
      NULL::text AS tool_id,
      NULL::int AS duration_ms,
      execution_id AS protocol_execution_id,
      NULL::smallint AS event_index,
      NULL::text AS event_role,
      NULL::text AS token_in_address,
      NULL::text AS token_in_symbol,
      NULL::smallint AS token_in_decimals,
      NULL::text AS token_out_address,
      NULL::text AS token_out_symbol,
      NULL::smallint AS token_out_decimals,
      NULL::text AS amount_in_human,
      NULL::text AS amount_in_raw,
      NULL::text AS amount_out_human,
      NULL::text AS amount_out_raw,
      NULL::text AS executed_amount_in_human,
      NULL::text AS executed_amount_in_raw,
      NULL::text AS executed_amount_out_human,
      NULL::text AS executed_amount_out_raw,
      NULL::numeric AS usd_in_est,
      NULL::numeric AS usd_out_est,
      NULL::numeric AS usd_fee_est,
      NULL::numeric AS usd_network_gas_est,
      NULL::numeric AS usd_venue_fee_est,
      NULL::numeric AS usd_destination_prepay_est,
      NULL::numeric AS usd_vex_fee_est,
      NULL::text AS vex_fee_token_address,
      NULL::text AS vex_fee_token_symbol,
      NULL::smallint AS vex_fee_token_decimals,
      NULL::text AS vex_fee_amount_raw,
      NULL::text AS vex_fee_amount_human,
      NULL::text AS vex_fee_source,
      NULL::text AS vex_fee_anomaly,
      NULL::text AS usd_source,
      NULL::bigint AS from_chain_id,
      NULL::text AS from_chain_slug,
      NULL::bigint AS to_chain_id,
      NULL::text AS to_chain_slug,
      NULL::text AS chain_family,
      NULL::text AS provider_order_id,
      NULL::text AS provider_status,
      0 AS verification_attempts,
      NULL::text AS last_verification_reason,
      NULL::jsonb AS legs,
      external_refs->>'txHash' AS tx_hash,
      created_at,
      ${CURSOR_TS_EXPR} AS cursor_ts
    FROM proj_activity
    WHERE ${successConds.join(" AND ")} ${successKeyset}`;
}

export function buildFailureHalf(
  params: HalfKeysetParams & {
    sessionId: string | null;
    productType?: string;
    namespace?: string;
    txHash?: string;
  },
): string {
  const { sessionId, productType, namespace, txHash, cursor, tsParam, rankParam, idParam, push } = params;

  const failTools = failureToolsForProduct(productType);
  // An empty allowlist (unknown productType) means the failure half matches
  // nothing; ANY('{}') achieves that without a special case.
  const failConds: string[] = [
    // FIX-SPINE C9 (finding 1) — NOT `success = false` alone: a freshly
    // created intent row (execution_status='intent') ALSO has
    // success=false until it completes, so filtering on success alone
    // would show every in-flight intent as an already-failed transaction.
    "execution_status = 'failed'",
    `session_id = $${push(sessionId)}`,
    `tool_id = ANY($${push(failTools)}::text[])`,
    // FIX-SPINE C9 (finding 2) — this toolId's failure-tool-allowlist
    // membership exists precisely so a PRE-agent_activity failure (before
    // any row could be created) still surfaces; once an agent_activity row
    // exists for this SAME execution, IT is the source of truth — never
    // show the same attempt twice under two different sources.
    "NOT EXISTS (SELECT 1 FROM agent_activity aa WHERE aa.protocol_execution_id = protocol_executions.id)",
  ];
  if (namespace !== undefined) failConds.push(`namespace = $${push(namespace)}`);
  if (txHash !== undefined) failConds.push(`external_refs->>'txHash' = $${push(txHash)}`);
  const failureKeyset = keysetPredicate(2, cursor, tsParam, rankParam, idParam);

  // NOTE: select ONLY bounded columns — NEVER params, result, or trade_capture.
  return `
    SELECT
      'failure'::text AS source,
      2 AS source_rank,
      id,
      namespace,
      NULL::text AS product_type,
      NULL::text AS trade_side,
      NULL::text AS chain,
      NULL::text AS input_token,
      NULL::text AS input_amount,
      NULL::text AS output_token,
      NULL::text AS output_amount,
      NULL::numeric AS value_usd,
      NULL::text AS capture_status,
      'failed'::text AS status,
      NULL::text AS failure_code,
      NULL::text AS failure_reason,
      NULL::bigint AS chain_id,
      NULL::text AS protocol,
      tool_id,
      duration_ms,
      id AS protocol_execution_id,
      NULL::smallint AS event_index,
      NULL::text AS event_role,
      NULL::text AS token_in_address,
      NULL::text AS token_in_symbol,
      NULL::smallint AS token_in_decimals,
      NULL::text AS token_out_address,
      NULL::text AS token_out_symbol,
      NULL::smallint AS token_out_decimals,
      NULL::text AS amount_in_human,
      NULL::text AS amount_in_raw,
      NULL::text AS amount_out_human,
      NULL::text AS amount_out_raw,
      NULL::text AS executed_amount_in_human,
      NULL::text AS executed_amount_in_raw,
      NULL::text AS executed_amount_out_human,
      NULL::text AS executed_amount_out_raw,
      NULL::numeric AS usd_in_est,
      NULL::numeric AS usd_out_est,
      NULL::numeric AS usd_fee_est,
      NULL::numeric AS usd_network_gas_est,
      NULL::numeric AS usd_venue_fee_est,
      NULL::numeric AS usd_destination_prepay_est,
      NULL::numeric AS usd_vex_fee_est,
      NULL::text AS vex_fee_token_address,
      NULL::text AS vex_fee_token_symbol,
      NULL::smallint AS vex_fee_token_decimals,
      NULL::text AS vex_fee_amount_raw,
      NULL::text AS vex_fee_amount_human,
      NULL::text AS vex_fee_source,
      NULL::text AS vex_fee_anomaly,
      NULL::text AS usd_source,
      NULL::bigint AS from_chain_id,
      NULL::text AS from_chain_slug,
      NULL::bigint AS to_chain_id,
      NULL::text AS to_chain_slug,
      NULL::text AS chain_family,
      NULL::text AS provider_order_id,
      NULL::text AS provider_status,
      0 AS verification_attempts,
      NULL::text AS last_verification_reason,
      NULL::jsonb AS legs,
      external_refs->>'txHash' AS tx_hash,
      created_at,
      ${CURSOR_TS_EXPR} AS cursor_ts
    FROM protocol_executions
    WHERE ${failConds.join(" AND ")} ${failureKeyset}`;
}

export function normalizeSourceRank(value: unknown): 0 | 1 | 2 {
  const n = Number(value);
  return n === 1 ? 1 : n === 2 ? 2 : 0;
}
