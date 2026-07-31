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
  AgentScanDto,
  AgentScanReadInput,
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
}
