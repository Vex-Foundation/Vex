/**
 * Balances repo — proj_balances + proj_portfolio_snapshots.
 *
 * proj_balances: current token balances per wallet+chain+token (upsert/replace).
 * proj_portfolio_snapshots: time-series of portfolio value with per-chain breakdown.
 *
 * Public API module. Internals split into `./balances/` submodules by concern
 * (types, row mappers, write paths, read paths, snapshot insert/latest, history,
 * aggregate per-cycle reads). Consumers import from this module — submodules are
 * implementation detail.
 */

export type {
  BalanceRow,
  ChainSummary,
  PortfolioSnapshot,
  SnapshotWalletFilter,
  InsertSnapshotArgs,
  InsertSnapshotResult,
  AggregateSnapshot,
} from "./balances/types.js";
export {
  upsertBalance,
  replaceBalancesForChain,
} from "./balances/write.js";
export {
  getBalances,
  getBalancesByChain,
  getTotalUsd,
} from "./balances/read.js";
export {
  insertSnapshot,
  getLatestSnapshot,
} from "./balances/snapshots.js";
export {
  getSnapshotHistory,
} from "./balances/history.js";
export {
  getAggregateSnapshots,
  getLatestAggregateSnapshot,
} from "./balances/aggregate.js";
export type {
  AssetHolding,
  PortfolioValuation,
} from "./balances/valuation.js";
export {
  DEFAULT_VALUATION_STATEMENT_TIMEOUT_MS,
  getAssetHolding,
  getPortfolioValuation,
} from "./balances/valuation.js";
