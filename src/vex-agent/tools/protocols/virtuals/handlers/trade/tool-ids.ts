/**
 * The identity every module of the Virtuals curve trade lane records under.
 *
 * One constant, one owner. A second literal drifting from these would file
 * `agent_activity` / `protocol_executions` rows under a namespace the repair
 * sweep, the feeds and the AgentScan mapper do not expect.
 */

export const QUOTE_TOOL_ID = "virtuals.trade.quote";
export const TRADE_TOOL_ID = "virtuals.trade.execute";
export const PROTOCOL = "virtuals";

/** The model-visible names, used inside refusals so a retry is actionable. */
export const QUOTE_PUBLIC_NAME = "virtuals__agent_trade_quote";
export const TRADE_PUBLIC_NAME = "virtuals__agent_trade_execute";
