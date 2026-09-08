import type { ActionKind } from "@vex-agent/tools/taxonomy.js";

export const LIGHTER_ORDER_WRITE_ACTION_KIND = "external_post" as const satisfies ActionKind;

export const LIGHTER_ORDER_WRITE_TOOL_IDS = [
  "lighter.order.create",
  "lighter.order.cancel.prepare",
  "lighter.order.cancel",
  "lighter.order.modify.prepare",
  "lighter.order.modify",
  "lighter.order.cancelAll.prepare",
  "lighter.order.cancelAll",
  "lighter.position.close.prepare",
  "lighter.position.close",
] as const;

export type LighterOrderWriteToolId = (typeof LIGHTER_ORDER_WRITE_TOOL_IDS)[number];

export const LIGHTER_ORDER_EXECUTION_STATES = [
  "expired_unsubmitted",
  "previewed",
  "approval_pending",
  "signed",
  "submitted",
  "api_accepted",
  "sequencer_pending",
  "open",
  "partially_filled",
  "filled",
  "canceled",
  "rejected",
  "ambiguous",
] as const;

export type LighterOrderExecutionState = (typeof LIGHTER_ORDER_EXECUTION_STATES)[number];

export const LIGHTER_ORDER_TERMINAL_EXECUTION_STATES = [
  "expired_unsubmitted",
  "filled",
  "canceled",
  "rejected",
] as const satisfies readonly LighterOrderExecutionState[];

const LIGHTER_ORDER_TERMINAL_EXECUTION_STATE_SET = new Set<LighterOrderExecutionState>(
  LIGHTER_ORDER_TERMINAL_EXECUTION_STATES,
);

export function isLighterOrderTerminalExecutionState(
  state: LighterOrderExecutionState,
): boolean {
  return LIGHTER_ORDER_TERMINAL_EXECUTION_STATE_SET.has(state);
}

export const LIGHTER_ORDER_EXECUTION_REQUIRED_BOUNDARIES = [
  "fresh_matching_lighter_order_preview",
  "approval_disclosure_from_persisted_preview_and_live_reads",
  "encrypted_vault_trading_credential_reference",
  "privileged_runtime_signing_only",
  "nonce_lock_per_environment_account_api_key",
  "durable_activity_intent_before_submit",
  "api_acceptance_not_final_execution",
  "provider_evidence_before_terminal_state",
] as const;

export type LighterOrderExecutionRequiredBoundary =
  (typeof LIGHTER_ORDER_EXECUTION_REQUIRED_BOUNDARIES)[number];

export const LIGHTER_ORDER_EXECUTION_BOUNDARY = {
  namespace: "lighter",
  writeActionKind: LIGHTER_ORDER_WRITE_ACTION_KIND,
  writeToolIds: LIGHTER_ORDER_WRITE_TOOL_IDS,
  requiredBoundaries: LIGHTER_ORDER_EXECUTION_REQUIRED_BOUNDARIES,
  executionStates: LIGHTER_ORDER_EXECUTION_STATES,
  terminalStates: LIGHTER_ORDER_TERMINAL_EXECUTION_STATES,
  liveSubmitMilestone: "approval-gated order create",
} as const;


/** Retry a public evidence write once. This callback must never sign or send. */
export async function persistLighterSigningEvidence<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch {
    return await write();
  }
}


/** Execution owners need write acknowledgement, not unrelated database columns. */
export type LighterEvidenceWritePorts<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => Promise<unknown>
    ? (...args: A) => Promise<object | null>
    : never;
};
