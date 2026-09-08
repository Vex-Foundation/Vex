/**
 * The identity every module of the Virtuals agent-launch lane records under.
 *
 * One constant, one owner. A second literal drifting from these would file
 * `agent_activity` / `protocol_executions` / `token_launch_intents` rows under
 * a namespace the keeper sweep, the feeds and the AgentScan mapper do not
 * expect.
 */

export const LAUNCH_PREVIEW_TOOL_ID = "virtuals.launch.preview";
export const LAUNCH_EXECUTE_TOOL_ID = "virtuals.launch.execute";
export const LAUNCH_STATUS_TOOL_ID = "virtuals.launch.status";
export const LAUNCH_CANCEL_TOOL_ID = "virtuals.launch.cancel";
export const PROTOCOL = "virtuals";

/** `token_launch_intents.protocol` and `launched_tokens.launchpad` (migration 110). */
export const VIRTUALS_LAUNCH_PROTOCOL = "virtuals" as const;

/** The venue name every Virtuals launch activity row is filed under. */
export const VIRTUALS_LAUNCH_VENUE = "virtuals-bonding";

/** The model-visible names, used inside refusals so a retry is actionable. */
export const LAUNCH_PREVIEW_PUBLIC_NAME = "virtuals__agent_launch_preview";
export const LAUNCH_EXECUTE_PUBLIC_NAME = "virtuals__agent_launch_execute";
export const LAUNCH_STATUS_PUBLIC_NAME = "virtuals__agent_launch_status";
export const LAUNCH_CANCEL_PUBLIC_NAME = "virtuals__agent_launch_cancel";
