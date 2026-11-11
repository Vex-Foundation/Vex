import { CH, EV } from "../../shared/ipc/channels.js";
import { portfolioReadInputSchema } from "../../shared/schemas/portfolio.js";
import type { PortfolioReadInput } from "../../shared/schemas/portfolio.js";
import { portfolioHistoryInputSchema } from "../../shared/schemas/portfolio-history.js";
import type { PortfolioHistoryInput } from "../../shared/schemas/portfolio-history.js";
import { tokenHistoryReadInputSchema } from "../../shared/schemas/token-history.js";
import type { TokenHistoryReadInput } from "../../shared/schemas/token-history.js";
import {
  activityProgressEventSchema,
  activityResolvedEventSchema,
  agentScanReadInputSchema,
  portfolioRefreshInputSchema,
} from "../../shared/schemas/agent-scan-feed.js";
import type { AgentScanReadInput } from "../../shared/schemas/agent-scan-feed.js";
import type { PortfolioBridge } from "../../shared/types/bridge/agent/portfolio.js";
import { invokeWithSchema, subscribe } from "../_dispatch.js";

export const portfolio = {
  read(input: PortfolioReadInput) {
    return invokeWithSchema(CH.portfolio.read, input, portfolioReadInputSchema);
  },
  readHistory(input: PortfolioHistoryInput) {
    return invokeWithSchema(
      CH.portfolio.readHistory,
      input,
      portfolioHistoryInputSchema,
    );
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
  refresh() {
    return invokeWithSchema(CH.portfolio.refresh, {}, portfolioRefreshInputSchema);
  },
  onActivityResolved(cb) {
    return subscribe(EV.portfolio.activityResolved, activityResolvedEventSchema, cb);
  },
  onActivityProgress(cb) {
    return subscribe(EV.portfolio.activityProgress, activityProgressEventSchema, cb);
  },
} satisfies PortfolioBridge;
