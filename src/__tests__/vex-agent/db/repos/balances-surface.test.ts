/**
 * Façade-surface guard for the balances repo structural split (A-013).
 *
 * `src/vex-agent/db/repos/balances.ts` was split into sibling modules under
 * `./balances/` (types, mappers, write, read, snapshots, history, aggregate, valuation)
 * while the original path stays a compatibility façade. This test pins the
 * EXACT public runtime surface so a later edit cannot silently drop, rename, or
 * add an export. Behavior of each symbol is covered by the dedicated
 * balances.test.ts suite; here we only assert presence + runtime typeof + the
 * exact runtime export-key set. Type-only re-exports (BalanceRow / ChainSummary
 * / PortfolioSnapshot / SnapshotWalletFilter / InsertSnapshotArgs /
 * InsertSnapshotResult / AggregateSnapshot) are imported below so
 * `tsc --noEmit` rejects any signature drift.
 */

import { describe, it, expect } from "vitest";

import * as balancesFacade from "../../../../vex-agent/db/repos/balances.js";

import {
  upsertBalance,
  replaceBalancesForChain,
  getBalances,
  getBalancesByChain,
  getTotalUsd,
  insertSnapshot,
  getLatestSnapshot,
  getSnapshotHistory,
  getAggregateSnapshots,
  getLatestAggregateSnapshot,
  getPortfolioValuation,
  getAssetHolding,
  DEFAULT_VALUATION_STATEMENT_TIMEOUT_MS,
} from "../../../../vex-agent/db/repos/balances.js";

// Type-only imports must compile against the façade re-exports.
import type {
  BalanceRow,
  ChainSummary,
  PortfolioSnapshot,
  SnapshotWalletFilter,
  InsertSnapshotArgs,
  InsertSnapshotResult,
  AggregateSnapshot,
  PortfolioValuation,
  AssetHolding,
} from "../../../../vex-agent/db/repos/balances.js";

describe("balances façade — public surface", () => {
  it("exposes every expected function with the correct runtime typeof", () => {
    expect(typeof upsertBalance).toBe("function");
    expect(typeof replaceBalancesForChain).toBe("function");
    expect(typeof getBalances).toBe("function");
    expect(typeof getBalancesByChain).toBe("function");
    expect(typeof getTotalUsd).toBe("function");
    expect(typeof insertSnapshot).toBe("function");
    expect(typeof getLatestSnapshot).toBe("function");
    expect(typeof getSnapshotHistory).toBe("function");
    expect(typeof getAggregateSnapshots).toBe("function");
    expect(typeof getLatestAggregateSnapshot).toBe("function");
    expect(typeof getPortfolioValuation).toBe("function");
    expect(typeof getAssetHolding).toBe("function");
    expect(typeof DEFAULT_VALUATION_STATEMENT_TIMEOUT_MS).toBe("number");
  });

  it("named re-exports are identity-equal to the namespace import", () => {
    expect(balancesFacade.upsertBalance).toBe(upsertBalance);
    expect(balancesFacade.replaceBalancesForChain).toBe(replaceBalancesForChain);
    expect(balancesFacade.getBalances).toBe(getBalances);
    expect(balancesFacade.getBalancesByChain).toBe(getBalancesByChain);
    expect(balancesFacade.getTotalUsd).toBe(getTotalUsd);
    expect(balancesFacade.insertSnapshot).toBe(insertSnapshot);
    expect(balancesFacade.getLatestSnapshot).toBe(getLatestSnapshot);
    expect(balancesFacade.getSnapshotHistory).toBe(getSnapshotHistory);
    expect(balancesFacade.getAggregateSnapshots).toBe(getAggregateSnapshots);
    expect(balancesFacade.getLatestAggregateSnapshot).toBe(
      getLatestAggregateSnapshot,
    );
    expect(balancesFacade.getPortfolioValuation).toBe(getPortfolioValuation);
    expect(balancesFacade.getAssetHolding).toBe(getAssetHolding);
    expect(balancesFacade.DEFAULT_VALUATION_STATEMENT_TIMEOUT_MS).toBe(
      DEFAULT_VALUATION_STATEMENT_TIMEOUT_MS,
    );
  });

  it("type-only re-exports compile against the façade", () => {
    // Compile-time assertions only — exercise each re-exported type so the
    // file fails `tsc --noEmit` if any interface/type drops off the façade.
    const row: BalanceRow | null = null;
    const chain: ChainSummary | null = null;
    const snapshot: PortfolioSnapshot | null = null;
    const filter: SnapshotWalletFilter | null = null;
    const insertArgs: InsertSnapshotArgs | null = null;
    const insertResult: InsertSnapshotResult | null = null;
    const aggregate: AggregateSnapshot | null = null;
    const valuation: PortfolioValuation | null = null;
    const holding: AssetHolding | null = null;
    expect(row).toBeNull();
    expect(chain).toBeNull();
    expect(snapshot).toBeNull();
    expect(filter).toBeNull();
    expect(insertArgs).toBeNull();
    expect(insertResult).toBeNull();
    expect(aggregate).toBeNull();
    expect(valuation).toBeNull();
    expect(holding).toBeNull();
  });

  it("exports EXACTLY the expected runtime keys — no more, no less", () => {
    const keys = Object.keys(balancesFacade).sort();
    expect(keys).toEqual(
      [
        "upsertBalance",
        "replaceBalancesForChain",
        "getBalances",
        "getBalancesByChain",
        "getTotalUsd",
        "insertSnapshot",
        "getLatestSnapshot",
        "getSnapshotHistory",
        "getAggregateSnapshots",
        "getLatestAggregateSnapshot",
        "getPortfolioValuation",
        "getAssetHolding",
        "DEFAULT_VALUATION_STATEMENT_TIMEOUT_MS",
      ].sort(),
    );
  });
});
