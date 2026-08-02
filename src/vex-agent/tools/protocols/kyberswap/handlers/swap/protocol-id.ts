/**
 * The `agent_activity` / `protocol_executions` namespace every module of the
 * KyberSwap swap handler records under. One constant, one owner — a second
 * literal drifting from this one would file rows under a namespace the
 * settlement decoder is not registered for.
 */
export const PROTOCOL = "kyberswap";
