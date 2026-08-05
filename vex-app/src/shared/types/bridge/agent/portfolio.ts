import type { Result } from "../../../ipc/result.js";
import type {
  PortfolioDto,
  PortfolioReadInput,
} from "../../../schemas/portfolio.js";
import type {
  TokenHistoryDto,
  TokenHistoryReadInput,
} from "../../../schemas/token-history.js";
import type {
  ActivityProgressEvent,
  ActivityResolvedEvent,
  AgentScanDto,
  AgentScanReadInput,
  PortfolioRefreshOutput,
} from "../../../schemas/agent-scan-feed.js";

/**
 * Portfolio — read-only wallet-scoped reads (stage 3 + move 0.3 + chronos-shell).
 *
 * `read` resolves a server-side wallet address allow-list (the configured
 * inventory for `{ scope: "global" }`, or the session's wallet scope for
 * `{ scope: "session", sessionId }`) and aggregates `proj_balances` +
 * `proj_portfolio_snapshots` into a renderer-safe DTO. An empty allow-list
 * resolves to the empty portfolio DTO, never an error.
 *
 * `listTokenHistory` resolves the GLOBAL configured wallet inventory (same
 * allow-list as `read`'s `scope: "global"`) and reads one token's full
 * activity + executed-transfer history, keyset-paginated. A `{status:
 * "unavailable"}` DTO is a genuine degraded-success shape (the read hit its
 * bounded statement timeout) — never an error `Result`.
 *
 * `listAgentScan` (Agent Scan) resolves that SAME global inventory allow-list
 * and reads the agent's FULL activity history from `agent_activity` alone —
 * filterable and keyset-paginated. Its optional `filters.sessionId` NARROWS the
 * read to one session; it can never widen it past the inventory. Like
 * `listTokenHistory`, a `{status: "unavailable"}` DTO is a genuine
 * degraded-success shape (the bounded read timed out), never an error `Result`.
 *
 * The renderer never supplies a wallet address.
 */
export interface PortfolioBridge {
  readonly read: (input: PortfolioReadInput) => Promise<Result<PortfolioDto>>;
  readonly listTokenHistory: (
    input: TokenHistoryReadInput,
  ) => Promise<Result<TokenHistoryDto>>;
  readonly listAgentScan: (
    input: AgentScanReadInput,
  ) => Promise<Result<AgentScanDto>>;
  /**
   * User-initiated portfolio refresh (Wave P — the sidebar refresh button).
   *
   * Runs a full balance sync plus an authoritative snapshot in the engine. The
   * engine holds a single-flight mutex, because `fullBalanceSync` is NOT
   * concurrency-safe: two overlapping calls mint two `snapshotGroupId`s and
   * corrupt the `pnlVsPrev` chain. The handler additionally rate-limits to one
   * call per 30s and returns `{status: "throttled", retryAfterMs}` — a genuine
   * OUTCOME the button renders as feedback, never an error `Result`.
   *
   * Public-address network reads only. No keystore, no signing.
   */
  readonly refresh: () => Promise<Result<PortfolioRefreshOutput>>;
  /**
   * Subscribe to `EV.portfolio.activityResolved` — fired after a pending
   * transaction's terminalizing write has committed. Payload is IDS ONLY; the
   * subscriber's job is to invalidate and re-read.
   */
  readonly onActivityResolved: (
    cb: (event: ActivityResolvedEvent) => void,
  ) => () => void;
  /**
   * Subscribe to `EV.portfolio.activityProgress` — fired after EVERY observation
   * of a row that is still pending, which is the half `onActivityResolved`
   * cannot carry. Payload is ids plus the observation's reason and the row's
   * current check interval; the subscriber's job is still to invalidate and
   * re-read.
   */
  readonly onActivityProgress: (
    cb: (event: ActivityProgressEvent) => void,
  ) => () => void;
}
