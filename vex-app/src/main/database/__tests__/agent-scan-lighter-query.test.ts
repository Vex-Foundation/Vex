/**
 * `agent-scan-lighter-query` - the SQL SHAPE of the feed's Lighter arm, and the
 * four ways a filter can exclude it.
 *
 * SQL-text assertions are the right instrument here for the same reason the
 * sibling `agent-scan-db.test.ts` uses them: these are statements about the
 * predicate the reader COMPILES, and each one pins a specific way the reader
 * could leak or lose rows. That the compiled statement then RUNS and returns
 * the right rows is a property only a database can prove, and
 * `agent-scan-lighter.int.test.ts` proves it against real Postgres.
 */

import { describe, expect, it } from "vitest";

import { buildAgentScanLighterPageQuery } from "../agent-scan-lighter-query.js";
import type { AgentScanFilters } from "@shared/schemas/agent-scan-feed.js";

const WALLETS = ["0xAAAA", "0xaaaa"] as const;
const PROJECT_WALLETS = ["0xAAAA"] as const;
const SESSION = "11111111-2222-4333-8444-555555555555";

function plan(filters: AgentScanFilters = {}, extra: {
  readonly projectWallets?: readonly string[] | null;
  readonly cursor?: { createdAt: string; sourceId: string; sourceRank: number } | null;
} = {}) {
  return buildAgentScanLighterPageQuery({
    wallets: WALLETS,
    projectWallets: extra.projectWallets ?? null,
    filters,
    cursor: extra.cursor ?? null,
  });
}

/** The plan, asserted present - the arm was not excluded. */
function sqlOf(filters: AgentScanFilters = {}, extra: Parameters<typeof plan>[1] = {}) {
  const built = plan(filters, extra);
  expect(built).not.toBeNull();
  if (built === null) throw new Error("unreachable");
  return built;
}

// ── Mandatory predicates ──────────────────────────────────────────────────

describe("the Lighter arm's mandatory predicates", () => {
  /**
   * Migration 152: a fill with no intent is HELD - Vex observed it before it
   * could prove which order owns it. The account may trade outside Vex, so a
   * held row is somebody's trading that this feed has no right to attribute to
   * the agent. This predicate is not a filter and no caller can remove it.
   */
  it("reads ONLY attributed fills - a held row can never be selected", () => {
    expect(sqlOf().sql).toContain("f.execution_intent_id IS NOT NULL");
  });

  /**
   * A CORRELATED EXISTS, never a JOIN. Migration 124 is unique on
   * `(environment, wallet_address)` and NOT on the resolved account, so two of
   * the user's wallets can resolve to one Lighter account - and a JOIN would
   * then emit the same fill once per wallet, with the same cursor id behind
   * each copy.
   */
  it("scopes by a correlated EXISTS over the onboarding workflows, not a JOIN", () => {
    const { sql, params } = sqlOf();
    expect(sql).toContain("EXISTS (");
    expect(sql).toContain("FROM lighter_onboarding_workflows w");
    expect(sql).toContain("w.environment = f.environment");
    expect(sql).toContain("w.resolved_account_index = f.account_index");
    expect(sql).toContain("w.wallet_address = ANY($1::text[])");
    expect(sql).not.toContain("JOIN lighter_onboarding_workflows");
    // The allow-list is the FIRST bound parameter, before any optional one -
    // the same position it holds on the activity arm.
    expect(params[0]).toEqual([...WALLETS]);
  });

  /**
   * A workflow that reached `ready_to_trade` can fall back to a deposit or
   * failure state while its resolved account stays recorded. History has to
   * survive that: yesterday's fills do not stop being the user's because
   * onboarding regressed today.
   */
  it("puts NO workflow_state condition on the scope", () => {
    expect(sqlOf().sql).not.toContain("workflow_state");
  });

  it("never selects a fill through a LEFT JOIN that could widen the scope", () => {
    // The only join on this statement is the LATERAL that reads the market's
    // observed position, which cannot add a fill row.
    const { sql } = sqlOf();
    expect(sql).toContain("LEFT JOIN LATERAL");
    expect(sql).toContain("FROM lighter_position_market_state s");
    expect(sql.match(/JOIN/g)).toEqual(["JOIN"]);
  });
});

// ── Project and session narrowing ─────────────────────────────────────────

describe("the Lighter arm's narrowing predicates", () => {
  /**
   * Both wallet predicates sit on the SAME workflow row. Two independent
   * existence claims would say "some wallet of the inventory resolves to this
   * account AND some wallet of the project does", which is a weaker statement
   * than "one wallet does both" and would reach accounts the project does not
   * own.
   */
  it("intersects the project selection on the SAME workflow row", () => {
    const { sql, params } = sqlOf({}, { projectWallets: PROJECT_WALLETS });
    const existsBlock = sql.slice(
      sql.indexOf("FROM lighter_onboarding_workflows w"),
      sql.indexOf("ORDER BY"),
    );
    expect(existsBlock).toContain("w.wallet_address = ANY($1::text[])");
    expect(existsBlock).toContain("w.wallet_address = ANY($2::text[])");
    expect(params[1]).toEqual([...PROJECT_WALLETS]);
    // Exactly one EXISTS over the workflows table.
    expect(sql.match(/FROM lighter_onboarding_workflows/g)).toHaveLength(1);
  });

  it("omits the project predicate entirely when no project was named", () => {
    expect(sqlOf().sql.match(/w\.wallet_address = ANY/g)).toHaveLength(1);
  });

  /**
   * `lighter_fills.execution_intent_id` has no foreign key because ONE column
   * points at three owning tables (migration 152's own comment): an order
   * execution intent (115), a lifecycle intent (140) and an OCO execution
   * intent (148). Asking only one of them would make session narrowing drop
   * every close and every triggered protective leg.
   */
  it("resolves the session through ALL THREE owning intent tables", () => {
    const { sql, params } = sqlOf({ sessionId: SESSION });
    expect(sql).toContain("FROM lighter_order_execution_intents i");
    expect(sql).toContain("FROM lighter_order_lifecycle_intents l");
    expect(sql).toContain("FROM lighter_oco_execution_intents o");
    expect(sql).toContain("i.intent_id = f.execution_intent_id");
    expect(sql).toContain("l.intent_id = f.execution_intent_id");
    expect(sql).toContain("o.intent_id = f.execution_intent_id");
    expect(params).toContain(SESSION);
  });

  it("omits the session predicate entirely when no session was named", () => {
    expect(sqlOf().sql).not.toContain("session_id");
  });
});

// ── Keyset boundary ───────────────────────────────────────────────────────

describe("the Lighter arm's keyset boundary", () => {
  it("issues no boundary on the first page", () => {
    expect(sqlOf().sql).not.toContain("f.traded_at <");
  });

  /**
   * The SAME 3-field boundary the activity arm applies, with THIS arm's rank
   * literal. Both arms must read the same boundary or the merged page would
   * skip or repeat rows across the seam.
   */
  it("compares (traded_at, rank 1, id) with the id as a BIGINT", () => {
    const { sql, params } = sqlOf({}, {
      cursor: { createdAt: "2026-05-21T10:00:00.123456Z", sourceId: "500", sourceRank: 0 },
    });
    expect(sql).toMatch(/f\.traded_at < \$\d+::timestamptz/);
    expect(sql).toMatch(/f\.traded_at = \$\d+::timestamptz AND 1 < \$\d+::int/);
    expect(sql).toMatch(/AND 1 = \$\d+::int AND f\.id < \$\d+::bigint/);
    expect(params).toContain("2026-05-21T10:00:00.123456Z");
    expect(params).toContain("500");
    expect(params).toContain(0);
  });

  it("renders the cursor timestamp at MICROSECOND precision, exactly as the other arm does", () => {
    expect(sqlOf().sql).toContain(`'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`);
    expect(sqlOf().sql).toContain("AS cursor_ts");
  });

  it("orders newest-first with a deterministic id tie-break and asks for limit + 1", () => {
    const { sql, params } = sqlOf();
    expect(sql).toContain("ORDER BY f.traded_at DESC, f.id DESC");
    expect(params[params.length - 1]).toBe(51);
  });

  it("selects its own arm rank as a literal, for the merge and the cursor", () => {
    expect(sqlOf().sql).toContain("1 AS source_rank");
    expect(sqlOf().sql).toContain("f.id::text AS source_id");
  });
});

// ── Clamps ────────────────────────────────────────────────────────────────

describe("the Lighter arm's clamps", () => {
  /**
   * `LEFT(...)` is applied to DISPLAY TEXT only. Clamping a number produces a
   * different, valid-looking number; on a money surface an overlength amount
   * must fail the read loudly instead.
   */
  it("clamps display text and NOTHING else", () => {
    const { sql } = sqlOf();
    for (const column of [
      "f.environment",
      "f.market_symbol",
      "f.side",
      "f.trade_type",
      "f.position_effect",
      "f.fee_side",
      "f.integrator_fee_estimate_basis",
      "f.integrator_fee_estimate_tick_source",
      "f.base_asset_symbol",
      "f.quote_asset_symbol",
      "f.integrator_fee_asset_symbol",
    ]) {
      expect(sql).toContain(`LEFT(${column},`);
    }
    for (const column of [
      "f.base_size",
      "f.price",
      "f.quote_notional",
      "f.usd_amount",
      "f.block_height",
      "f.position_size_before",
      "f.entry_quote_before",
      "f.account_pnl",
      "f.integrator_fee_charged_raw",
      "f.integrator_fee_estimated_raw",
      "f.integrator_fee_estimated_usd",
      "f.exchange_fee_charged_raw",
      "f.exchange_fee_estimated_usd",
      "f.provider_trade_id",
      "f.provider_order_id",
      "f.execution_intent_id",
    ]) {
      expect(sql).not.toContain(`LEFT(${column},`);
      expect(sql).toContain(column);
    }
  });

  it("reads the market's newest observed position through a LATERAL on the fill's own scope", () => {
    const { sql } = sqlOf();
    expect(sql).toContain("s.environment  = f.environment");
    expect(sql).toContain("s.account_index = f.account_index");
    expect(sql).toContain("s.market_index  = f.market_index");
    expect(sql).toContain("AS position_observed_at");
    expect(sql).toContain("AS position_open");
    expect(sql).toContain("AS position_now");
  });
});

// ── Exclusion ─────────────────────────────────────────────────────────────

describe("filters that exclude the Lighter arm entirely", () => {
  it("excludes it when kinds is non-empty and does not name lighter_fill", () => {
    expect(plan({ kinds: ["swap"] })).toBeNull();
  });

  it("excludes it when protocols is non-empty and does not name lighter", () => {
    expect(plan({ protocols: ["kyberswap"] })).toBeNull();
  });

  /** A venue is not a chain family, and a fill has no chain of its own to claim one. */
  it("excludes it whenever a chainFamily is named", () => {
    expect(plan({ chainFamily: "eip155" })).toBeNull();
    expect(plan({ chainFamily: "solana" })).toBeNull();
  });

  /** A fill is settled the moment the venue matched it: `confirmed` is its only status. */
  it("excludes it when statuses is non-empty and does not name confirmed", () => {
    expect(plan({ statuses: ["pending"] })).toBeNull();
    expect(plan({ statuses: ["failed", "superseded_unproven"] })).toBeNull();
  });

  it("keeps it when a non-empty filter DOES name it", () => {
    expect(plan({ kinds: ["swap", "lighter_fill"] })).not.toBeNull();
    expect(plan({ protocols: ["lighter"] })).not.toBeNull();
    expect(plan({ statuses: ["confirmed", "pending"] })).not.toBeNull();
  });

  /**
   * An EMPTY array means "no restriction", exactly as an absent field does -
   * the filter schema says so, and reading it as "nothing matches" would make a
   * cleared filter chip silently empty the arm.
   */
  it("is NOT excluded by empty filter arrays", () => {
    expect(plan({ kinds: [], protocols: [], statuses: [] })).not.toBeNull();
  });
});

// ── Injection ─────────────────────────────────────────────────────────────

describe("the Lighter arm's parameter binding", () => {
  it("never interpolates a caller value into the SQL text", () => {
    const hostile = "'; DROP TABLE lighter_fills; --";
    const built = sqlOf({ sessionId: hostile as string });
    expect(built.sql).not.toContain("DROP TABLE");
    expect(built.params).toContain(hostile);
  });
});
