/**
 * THE RECORDED DEPOSIT EXECUTION OWNER: every deposit made under an authority
 * other than the funding form goes through {@link executeRecordedDeposit}:
 *
 * | Authority | Who asks | Rule | Card |
 * |---|---|---|---|
 * | `auto_top_up_poller` | the poller, balance below the alert | required, active | none |
 * | `auto_top_up_agent` | the agent deposit tool, restricted session | required, covers the request | none |
 * | `agent_card` | the agent deposit tool | none | the user approved it |
 * | `agent_full_permission` | the agent deposit tool | none | none (full-permission session policy) |
 *
 * THE SEQUENCE (the deepseek-harness asked/decided pair, made durable):
 *
 * 1. reserve the wallet (one deposit per wallet at a time, shared with the form);
 * 2. ASK: write the `asked` row. For a rule this is ONE transaction with the
 *    rule row and its CURRENT cap usage under a per-rule lock: the cap check
 *    and the write that consumes the cap are atomic, and a second in-flight
 *    execution of the rule is a constraint error. Refused admission writes
 *    nothing;
 * 3. plan (fresh reads) unless the caller holds an approved plan;
 * 4. sign through the shared deposit core, whose pre-sign gate re-reads the
 *    rule and its usage (including this row) from durable state and whose
 *    final check re-asks the local authority (expiry, quit, the gate's rule
 *    verdict, the caller's wallet scope);
 * 5. DECIDE exactly once: `confirmed`, `reverted`, `unknown` (sent, outcome
 *    not known: counted, never retried) or `refused` (nothing signed).
 *
 * RECOVERY. Until {@link markRecoveryComplete} ran once in this process (the
 * previous process's undecided rows marked `unknown`), every execution is
 * refused: a row left `asked` by a crash may have been signed, and it must be
 * counted before anything new is admitted.
 */

import { randomUUID } from "node:crypto";
import type { VexCloudSubmitDepositResult } from "@shared/schemas/vex-cloud-funding.js";
import { log } from "../../logger/index.js";
import { refused, type VexCloudOutcome, type VexCloudRefusal } from "../outcome.js";
import {
  executeDeposit,
  planDeposit,
  withWalletReservation,
  type ApprovedDeposit,
  type DepositDeps,
} from "../funding/deposit-core.js";
import type { DepositExecutionAuthority } from "@vex-agent/db/repos/vex-inference-funding.js";
import { RuleExecutionInFlightError, type AutoTopUpRuleRow, type FundingPolicyStore, type RuleUsage } from "./funding-store.js";
import { capsAllow, capsStillHold, type RuleConditions } from "./rule-policy.js";

/** How long a poller-planned deposit stays signable: fresh figures, no human in between. */
export const POLLER_PLAN_TTL_MS = 60_000;

export interface RecordedExecutionDeps {
  readonly deposit: DepositDeps;
  readonly store: FundingPolicyStore;
  /** Live conditions a rule's state depends on (vault, gate, quit, account). */
  readonly conditions: () => Omit<RuleConditions, "depositAddressMatches" | "balanceReadFailing">;
}

let recoveryComplete = false;

/** Run once per process before the first execution: undecided rows from a previous process become `unknown`. */
export async function markRecoveryComplete(store: FundingPolicyStore, now: Date): Promise<void> {
  if (recoveryComplete) return;
  const repaired = await store.markOrphanedExecutionsUnknown(now);
  if (repaired > 0) log.warn(`[vex-cloud:auto-top-up] recovery marked ${repaired} undecided execution(s) unknown`);
  recoveryComplete = true;
}

export function isRecoveryComplete(): boolean {
  return recoveryComplete;
}

/** Test-only. */
export function __resetExecutorForTests(): void {
  recoveryComplete = false;
}

export interface RecordedExecutionRequest {
  readonly authority: DepositExecutionAuthority;
  /** Required for the two rule authorities, `null` for the agent's card and full-permission authorities. */
  readonly ruleId: string | null;
  /** For a rule: the rule version the caller decided on; a different stored version refuses. */
  readonly ruleVersion: number | null;
  readonly sessionId: string | null;
  readonly from: string;
  readonly amountWei: bigint;
  /** An already approved plan (the agent's intent), or `null` to plan with fresh reads (the poller). */
  readonly approved: ApprovedDeposit | null;
  /** The caller's extra local authority, re-asked in the final check (the agent's wallet scope). */
  readonly extraFinal?: () => VexCloudRefusal | null;
}

export interface RecordedExecutionResult extends VexCloudSubmitDepositResult {
  readonly executionId: string;
}

type AdmissionRefusal = { readonly kind: VexCloudRefusal["kind"]; readonly detail: string };

const NOTHING = "Nothing was signed or sent.";

/** The admission decision, run inside the ASK transaction with the locked rule row and its usage. */
function admitUnderRule(
  request: RecordedExecutionRequest,
  conditions: Omit<RuleConditions, "depositAddressMatches" | "balanceReadFailing">,
): (rule: AutoTopUpRuleRow | null, usage: RuleUsage | null) => AdmissionRefusal | null {
  return (rule, usage) => {
    if (rule === null || usage === null) return { kind: "rule_changed", detail: `The auto top-up rule no longer exists. ${NOTHING}` };
    if (request.ruleVersion !== null && rule.version !== request.ruleVersion) {
      return { kind: "rule_changed", detail: `The auto top-up rule changed since this top-up was decided. ${NOTHING}` };
    }
    if (rule.status !== "active" || rule.expiresAt.getTime() <= conditions.now.getTime()) {
      return { kind: "rule_not_active", detail: `The auto top-up rule is ${rule.status === "active" ? "expired" : rule.status}. ${NOTHING}` };
    }
    if (conditions.signedInAccountId !== rule.accountId) {
      return { kind: "rule_not_active", detail: `The auto top-up rule belongs to another Vex Inference account than the one signed in. ${NOTHING}` };
    }
    if (rule.sourceWallet.toLowerCase() !== request.from.toLowerCase()) {
      return { kind: "rule_not_active", detail: `The auto top-up rule is for a different source wallet. ${NOTHING}` };
    }
    if (request.amountWei > rule.amountWei) {
      return { kind: "rule_not_active", detail: `The amount is above the rule's per-top-up amount. ${NOTHING}` };
    }
    const caps = capsAllow(rule, usage, request.amountWei);
    if (!caps.ok) {
      return {
        kind: "rule_cap_reached",
        detail: caps.which === "daily_count"
          ? `The auto top-up rule's daily count is used up (unknown outcomes count). ${NOTHING}`
          : `The auto top-up rule's 30-day VEX cap would be exceeded (unknown outcomes count). ${NOTHING}`,
      };
    }
    return null;
  };
}

/**
 * Record, sign and decide one deposit under `request.authority`. Never
 * retries: an unknown outcome is decided `unknown` and returned as pending.
 */
export async function executeRecordedDeposit(
  deps: RecordedExecutionDeps,
  request: RecordedExecutionRequest,
  signal: AbortSignal,
): Promise<VexCloudOutcome<RecordedExecutionResult>> {
  const isRule = request.authority === "auto_top_up_poller" || request.authority === "auto_top_up_agent";
  if (isRule !== (request.ruleId !== null)) {
    // A caller bug, refused before anything is written.
    return refused("rule_changed", `This deposit's authority does not match its rule. ${NOTHING}`);
  }
  if (!recoveryComplete) {
    return refused("execution_not_ready", `Vex is still reconciling earlier automatic deposits. ${NOTHING} Try again in a moment.`);
  }
  const pinned = deps.deposit.pinnedDepositAddress();
  if (pinned === null) return refused("deposits_not_open", `Deposits are not open in this version of Vex. ${NOTHING}`);

  return withWalletReservation(request.from, async () => {
    const executionId = `vxexec-${randomUUID()}`;
    const askedAt = deps.deposit.now();
    let admission;
    try {
      admission = await deps.store.askExecution<AdmissionRefusal>(
        {
          executionId,
          ruleId: request.ruleId,
          authority: request.authority,
          sessionId: request.sessionId,
          sourceWallet: request.from,
          depositAddress: request.approved?.to ?? pinned,
          amountWei: request.amountWei,
        },
        isRule ? admitUnderRule(request, deps.conditions()) : null,
        askedAt,
      );
    } catch (cause) {
      if (cause instanceof RuleExecutionInFlightError) {
        return refused("rule_execution_in_flight", `An automatic deposit under this rule is already in flight. ${NOTHING}`);
      }
      log.warn(`[vex-cloud:auto-top-up] ask failed type=${cause instanceof Error ? cause.name : typeof cause}`);
      return refused("execution_not_ready", `The deposit could not be recorded before signing, so it was not sent. ${NOTHING}`);
    }
    if (!admission.admitted) return refused(admission.reason.kind, admission.reason.detail);
    log.info(`[vex-cloud:auto-top-up] asked authority=${request.authority} execution=${executionId}`);

    let decided: "confirmed" | "reverted" | "unknown" | "refused" = "refused";
    let txHash: string | null = null;
    let refusalKind: string | null = null;
    try {
      let approved = request.approved;
      if (approved === null) {
        const planned = await planDeposit(deps.deposit, { walletAddress: request.from, amountWei: request.amountWei }, signal);
        if (!planned.ok) {
          refusalKind = planned.refusal.kind;
          return planned;
        }
        approved = {
          from: planned.value.from,
          to: planned.value.to,
          amountWei: planned.value.amountWei,
          feeBound: planned.value.feeBound,
          expiresAtMs: deps.deposit.now().getTime() + POLLER_PLAN_TTL_MS,
        };
      }

      /** Set by the gate from durable state; read by the local final check. */
      let ruleHeldAtGate = !isRule;
      const extraGate = async (): Promise<VexCloudRefusal | null> => {
        if (!isRule || request.ruleId === null) return null;
        const now = deps.deposit.now();
        const rule = await deps.store.readRule(request.ruleId);
        if (rule === null || rule.status !== "active" || rule.expiresAt.getTime() <= now.getTime()) {
          return { kind: "rule_not_active", detail: `The auto top-up rule was paused, revoked or expired before signing. ${NOTHING}` };
        }
        if (request.ruleVersion !== null && rule.version !== request.ruleVersion) {
          return { kind: "rule_changed", detail: `The auto top-up rule changed before signing. ${NOTHING}` };
        }
        if (deps.conditions().signedInAccountId !== rule.accountId) {
          return { kind: "rule_not_active", detail: `The signed-in Vex Inference account changed before signing. ${NOTHING}` };
        }
        // The usage INCLUDES this execution's own `asked` row.
        if (!capsStillHold(rule, await deps.store.readRuleUsage(rule.ruleId, now))) {
          return { kind: "rule_cap_reached", detail: `The auto top-up rule's caps were reached before signing. ${NOTHING}` };
        }
        ruleHeldAtGate = true;
        return null;
      };
      const extraFinal = (): VexCloudRefusal | null => {
        const conditions = deps.conditions();
        if (conditions.quitting) return { kind: "execution_not_ready", detail: `Vex is quitting. ${NOTHING}` };
        if (!ruleHeldAtGate) return { kind: "rule_not_active", detail: `The auto top-up rule was not confirmed before signing. ${NOTHING}` };
        return request.extraFinal?.() ?? null;
      };

      const outcome = await executeDeposit(deps.deposit, approved, signal, {
        extraGate,
        extraFinal,
        onSigning: () => deps.store.markExecutionSubmitted(executionId),
      });
      if (!outcome.ok) {
        refusalKind = outcome.refusal.kind;
        return outcome;
      }
      txHash = outcome.value.txHash;
      decided = outcome.value.status === "pending" ? "unknown" : outcome.value.status;
      return { ok: true, value: { ...outcome.value, executionId } };
    } catch (cause) {
      // A throw after a possible send cannot prove anything: unknown, counted, never retried.
      decided = "unknown";
      refusalKind = "executor_threw";
      log.warn(`[vex-cloud:auto-top-up] execution threw type=${cause instanceof Error ? cause.name : typeof cause} execution=${executionId}`);
      return refused("chain_unavailable", "Vex lost track of this deposit while sending it. It is recorded as unknown and will not be sent again. Check History and the wallet's balance.");
    } finally {
      try {
        await deps.store.decideExecution({
          executionId,
          status: decided,
          txHash: decided === "refused" ? null : txHash,
          refusalKind: decided === "refused" ? refusalKind : decided === "unknown" ? refusalKind : null,
          decidedAt: deps.deposit.now(),
        });
      } catch (cause) {
        // The row stays undecided; the next process start marks it unknown. It still counts.
        log.error(`[vex-cloud:auto-top-up] decide failed execution=${executionId} type=${cause instanceof Error ? cause.name : typeof cause}`);
      }
      log.info(`[vex-cloud:auto-top-up] decided outcome=${decided} execution=${executionId}`);
    }
  });
}
