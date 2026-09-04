/**
 * The identity every module of the Uniswap swap handler records under. One
 * constant, one owner - a second literal drifting from these would file
 * `agent_activity` / `protocol_executions` rows under a namespace the repair
 * sweep and the feeds do not expect.
 */

export const TOOL_ID = "uniswap.swap.execute";
export const QUOTE_TOOL_ID = "uniswap.swap.quote";
export const PROTOCOL = "uniswap";
