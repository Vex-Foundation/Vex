/**
 * The canonical vocabulary reaching the two PRE-EXISTING feeds.
 *
 * This is the seam that lets the UI stop reading `productType`/`tradeSide`.
 * Two halves are pinned:
 *
 *  - the SQL fragment that DERIVES a canonical `activityKind` for a legacy
 *    `proj_activity` row (`legacyActivityKindSql`), and
 *  - the pure row mapper carrying `activityKind`/`eventRole` through to its
 *    DTO (the twin MOVES mapper retired with the `listMoves` pipeline).
 *
 * Deriving matters. If a legacy row's `activityKind` were simply null, the
 * renderer could not drop `productType`/`tradeSide` without flattening every
 * historical bridge and send into an unlabelled "activity" — losing semantics
 * the Moves block renders today. `eventRole`, by contrast, MUST stay null on a
 * legacy row: `proj_activity` has no event-role concept and inventing one would
 * assert something the data cannot support.
 */

import { describe, expect, it } from "vitest";
import { legacyActivityKindSql } from "../legacy-activity-kind.js";
import { mapEntry } from "../token-history-db-mappers.js";
import { NEUTRAL_ACTIVITY_KIND } from "@shared/agent-activity-vocabulary.js";
import type { PageRow } from "../token-history-db-types.js";

// ── The derivation fragment ───────────────────────────────────────────────

describe("legacyActivityKindSql", () => {
  const sql = legacyActivityKindSql("a.product_type");

  it("maps every legacy product this build knows to a canonical kind", () => {
    expect(sql).toContain("a.product_type = 'bridge'");
    expect(sql).toContain("'send', 'transfer'");
    expect(sql).toContain("'spot', 'trade'");
  });

  it("falls back to the explicit NEUTRAL kind, never to a swap", () => {
    // `perps` and anything else unknown must NOT be presented as a trade.
    expect(sql).toContain(`ELSE '${NEUTRAL_ACTIVITY_KIND}'`);
    expect(sql).not.toContain("ELSE 'spot'");
    expect(sql).not.toContain("ELSE 'swap'");
  });

  it("qualifies against the caller's own column", () => {
    expect(legacyActivityKindSql("aa.product_type")).toContain("aa.product_type");
  });
});

// ── token-history entries ─────────────────────────────────────────────────

function pageRow(overrides: Partial<PageRow> = {}): PageRow {
  return {
    source_kind: "activity",
    source_rank: 1,
    source_id: "00000000000000000001",
    created_at: new Date("2026-05-21T10:00:00.000Z"),
    cursor_ts: "2026-05-21T10:00:00.000000Z",
    namespace: "kyberswap",
    product_type: "spot",
    trade_side: "buy",
    chain: "base",
    dest_chain: null,
    input_token_address: "0xin",
    input_amount: "1.5",
    output_token_address: "0xout",
    output_amount: "0.0005",
    input_value_usd: "1.5",
    output_value_usd: "1.49",
    unit_price_usd: null,
    capture_status: "executed",
    tx_ref: "0xdead",
    input_token_symbol: "USDC",
    input_token_local_symbol: null,
    output_token_symbol: "WETH",
    output_token_local_symbol: null,
    to_address: null,
    status: null,
    failure_code: null,
    executed_amount_in_raw: null,
    executed_amount_out_raw: null,
    token_in_decimals: null,
    token_out_decimals: null,
    provider_order_id: null,
    legs: null,
    last_checked_at: null,
    activity_kind: "swap",
    event_role: null,
    ...overrides,
  };
}

describe("mapEntry vocabulary", () => {
  it("carries the derived kind on a legacy swap entry", () => {
    const entry = mapEntry(pageRow({ activity_kind: NEUTRAL_ACTIVITY_KIND }));
    expect(entry.kind).toBe("swap");
    if (entry.kind !== "swap") return;
    expect(entry.activityKind).toBe(NEUTRAL_ACTIVITY_KIND);
    expect(entry.eventRole ?? null).toBeNull();
  });

  it("carries the derived kind on a legacy bridge entry", () => {
    const entry = mapEntry(
      pageRow({ product_type: "bridge", dest_chain: "arbitrum", activity_kind: "bridge" }),
    );
    expect(entry.kind).toBe("bridge");
    if (entry.kind !== "bridge") return;
    expect(entry.activityKind).toBe("bridge");
    expect(entry.eventRole ?? null).toBeNull();
  });

  it("carries the real vocabulary on an agent_activity swap entry", () => {
    const entry = mapEntry(
      pageRow({
        source_kind: "agent_activity",
        source_rank: 2,
        status: "confirmed",
        activity_kind: "lend",
        event_role: "lend_deposit",
        product_type: "lend",
        executed_amount_in_raw: "1500000",
        token_in_decimals: 6,
      }),
    );
    // The union discriminant stays `swap` — the shape fits — while the engine
    // vocabulary rides `activityKind`. Neither field has to lie.
    expect(entry.kind).toBe("swap");
    if (entry.kind !== "swap") return;
    expect(entry.activityKind).toBe("lend");
    expect(entry.eventRole).toBe("lend_deposit");
    expect(entry.productType).toBe("lend");
  });

  it("carries the real vocabulary on an agent_activity bridge entry", () => {
    const entry = mapEntry(
      pageRow({
        source_kind: "agent_activity",
        source_rank: 2,
        product_type: "bridge",
        dest_chain: "arbitrum",
        status: "pending",
        activity_kind: "bridge",
        event_role: "bridge_fill_expected",
      }),
    );
    expect(entry.kind).toBe("bridge");
    if (entry.kind !== "bridge") return;
    expect(entry.activityKind).toBe("bridge");
    expect(entry.eventRole).toBe("bridge_fill_expected");
  });

  it("tolerates a row predating the columns", () => {
    const { activity_kind: _k, event_role: _r, ...legacy } = pageRow();
    const entry = mapEntry(legacy as PageRow);
    if (entry.kind !== "swap") return;
    expect(entry.activityKind ?? null).toBeNull();
    expect(entry.eventRole ?? null).toBeNull();
  });
});
