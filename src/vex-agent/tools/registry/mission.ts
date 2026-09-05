/** Mission tools - only visible in mission setup/run contexts. */

import type { ToolDef } from "../types.js";
import { responseFormatParam } from "@vex-agent/response-format.js";

export const MISSION_TOOLS: readonly ToolDef[] = [
  {
    name: "MissionDraftUpdate", kind: "internal", mutating: false, pressureSafety: "mutating", actionKind: "local_write",
    visibility: { requiresMissionSetup: true },
    description: "Save or update the mission draft during mission setup/edit. Call this before telling the user the mission draft is ready. response_format: 'concise' (default) returns missionId/status/ready/missingFields/nextAction; 'detailed' also echoes the full currentDraft.",
    parameters: { type: "object", properties: {
      response_format: responseFormatParam({
        default: "concise",
        whatDetailedAdds:
          "also echoes the full currentDraft on top of the status, missingFields and "
          + "nextAction 'concise' returns",
      }),
      title: { type: "string", description: "Short mission title" },
      goal: { type: "string", description: "Mission goal or objective" },
      capitalSource: { type: "string", description: "Where starting capital comes from" },
      startingCapital: { type: "string", description: "Starting capital amount and asset" },
      deployedCapital: {
        type: "object",
        description: "The capital this mission actually puts to work, typed so the runtime can measure against it. Save all six parts together or none: raw units require decimals and native-versus-token identity must be structural. wSOL is assetKind token even though it shares native SOL's route mint. Example: 3044 VEX at 18 decimals is amountRaw=\"3044000000000000000000\". This is a measurement base, not a spend limit. Send null to clear it.",
        properties: {
          amountRaw: { type: "string", description: "Integer base-unit amount as a string, digits only. 1.5 ETH is \"1500000000000000000\"." },
          decimals: { type: "number", description: "Decimals needed to read amountRaw (18 for ETH and most ERC-20s, 6 for USDC, 9 for SOL)." },
          chainId: { type: "number", description: "Numeric chain id the asset lives on (1 ethereum, 8453 base, 4663 robinhood, 20011000000 solana)." },
          assetAddress: { type: "string", description: "Token contract address, or 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE for a chain's native coin. On solana this is the base58 mint, sent exactly as given (case matters)." },
          assetKind: { type: "string", enum: ["native", "token"], description: "Structural asset kind: native for the chain account coin, token for an ERC-20/SPL mint. wSOL is token." },
          assetSymbol: { type: "string", description: "Display symbol as agreed with the user, for example VEX or USDC." },
        },
        required: ["amountRaw", "decimals", "chainId", "assetAddress", "assetKind", "assetSymbol"],
        additionalProperties: false,
      },
      allowedWallets: { type: "array", items: { type: "string" }, description: "Wallet addresses or wallet identifiers allowed for the mission" },
      allowedChains: { type: "array", items: { type: "string" }, description: "Allowed chains" },
      allowedProtocols: { type: "array", items: { type: "string" }, description: "Allowed protocols or venues" },
      riskProfile: { type: "string", description: "Risk profile such as conservative, moderate, or aggressive" },
      successCriteria: { type: "array", items: { type: "string" }, description: "Concrete success criteria" },
      stopConditions: { type: "array", items: { type: "string" }, description: "Proposed non-success stop conditions for the contract. The user owns this list - propose, refine with the user, and save updates here. Final acceptance happens via the host Accept contract step, not in chat" },
      deadline: { type: "string", description: "Optional deadline, preferably ISO8601 or an absolute date/time with timezone" },
      durationMinutes: { type: "number", description: "The mission's time-box in whole minutes (e.g. 5, 60). The run auto-finalizes at started_at + this many minutes, regardless of progress. Set this from the goal's stated duration; if omitted, a 60-minute default applies." },
    }, additionalProperties: false },
  },
  {
    name: "MissionStop", kind: "internal", mutating: false, pressureSafety: "safe_at_barrier", actionKind: "local_write",
    visibility: { requiresMissionRun: true },
    description: "Stop the current mission run. Only valid during active mission execution. Call this when a stop condition the user approved has actually been met, or the goal is reached - deferring instead of stopping leaves a finished mission burning budget, and stopping for a reason the contract does not list breaks the agreement the user accepted. goal_reached is success; every other non-emergency reason must match the user-approved mission stopConditions, and emergency_stop is for danger, not for inconvenience. It returns one confirmation sentence naming the reason and your summary, not a result object; the run then winds down through the engine rather than inside this call, so read that sentence as the request being accepted.",
    parameters: { type: "object", properties: {
      reason: { type: "string", enum: ["goal_reached", "deadline_reached", "capital_depleted", "max_loss_hit", "no_viable_opportunity", "emergency_stop"], description: "Stop reason" },
      summary: { type: "string", description: "Concise explanation of why the mission should stop" },
      evidence: { type: "object", description: "Optional structured evidence / metrics" },
    }, required: ["reason", "summary"] },
  },
];
