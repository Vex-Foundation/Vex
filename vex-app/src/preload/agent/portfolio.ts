import { CH } from "../../shared/ipc/channels.js";
import { portfolioReadInputSchema } from "../../shared/schemas/portfolio.js";
import type { PortfolioReadInput } from "../../shared/schemas/portfolio.js";
import { tokenHistoryReadInputSchema } from "../../shared/schemas/token-history.js";
import type { TokenHistoryReadInput } from "../../shared/schemas/token-history.js";
import { agentScanReadInputSchema } from "../../shared/schemas/agent-scan-feed.js";
import type { AgentScanReadInput } from "../../shared/schemas/agent-scan-feed.js";
import type { PortfolioBridge } from "../../shared/types/bridge/agent/portfolio.js";
import { invokeWithSchema } from "../_dispatch.js";

export const portfolio = {
  read(input: PortfolioReadInput) {
    return invokeWithSchema(CH.portfolio.read, input, portfolioReadInputSchema);
  },
  listTokenHistory(input: TokenHistoryReadInput) {
    return invokeWithSchema(
      CH.portfolio.listTokenHistory,
      input,
      tokenHistoryReadInputSchema,
    );
  },
  listAgentScan(input: AgentScanReadInput) {
    return invokeWithSchema(
      CH.portfolio.listAgentScan,
      input,
      agentScanReadInputSchema,
    );
  },
} satisfies PortfolioBridge;
