import type { AgentScanActivityEntry } from "@shared/schemas/agent-scan-feed.js";
import type { AgentScanLighterFillEntry } from "@shared/schemas/agent-scan-lighter-entry.js";

const SAFETY_SUFFIX = "Do not place an order without my explicit approval.";

export function activityFollowUpMessage(entry: AgentScanActivityEntry): string {
  const legs = `${entry.input.displaySymbol ?? entry.input.symbol} -> ${entry.output.displaySymbol ?? entry.output.symbol}`;
  return [
    "Review this recorded Vex event and start a fresh analysis session.",
    `Event: ${entry.activityKind}${entry.eventRole === null ? "" : ` (${entry.eventRole})`}.`,
    `Route: ${legs}. Status: ${entry.status}.`,
    "Explain what happened, what risk it creates, and what the safest next step is.",
    SAFETY_SUFFIX,
  ].join(" ");
}

export function lighterFillFollowUpMessage(entry: AgentScanLighterFillEntry): string {
  return [
    "Review this recorded Lighter fill and start a fresh analysis session.",
    `Market: ${entry.baseAsset.symbol}/${entry.quoteAsset.symbol} (${entry.environment}).`,
    `Trade: ${entry.side} ${entry.baseSize} at ${entry.price}; position effect: ${entry.positionEffect}.`,
    entry.spot ? "Spot fill." : `Leverage before fill: ${entry.leverage?.display ?? "unknown"}.`,
    "Explain why this fill happened, the resulting exposure, and the safest next step.",
    SAFETY_SUFFIX,
  ].join(" ");
}
