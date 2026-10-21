/**
 * The durable store the Vex Inference funding policy reads and writes, as a
 * port: production is the engine database
 * (`src/vex-agent/db/repos/vex-inference-funding.ts`, migration 178), tests
 * inject an in-memory implementation of the same contract.
 *
 * WHY THE ENGINE DATABASE AND NOT `preferences.json`. The alert percent is
 * the TRIGGER of the auto top-up rule, and the rule and its executions must
 * be durable, transactional and counted under a lock (the caps). Keeping the
 * trigger beside the rule means one owner and one source of truth; the
 * preferences file is a UI-preference store with no transactions.
 */

import * as repo from "@vex-agent/db/repos/vex-inference-funding.js";
import type {
  AskExecutionInput,
  AutoTopUpRuleRow,
  AutoTopUpRuleStatus,
  BalanceWatchRow,
  DepositExecutionRow,
  DepositExecutionStatus,
  NewRuleInput,
  RuleEditInput,
  RuleUsage,
} from "@vex-agent/db/repos/vex-inference-funding.js";

export type { AutoTopUpRuleRow, BalanceWatchRow, DepositExecutionRow, RuleUsage } from "@vex-agent/db/repos/vex-inference-funding.js";
export { RuleExecutionInFlightError } from "@vex-agent/db/repos/vex-inference-funding.js";

export interface FundingPolicyStore {
  readAlertPercent(): Promise<number>;
  writeAlertPercent(percent: number): Promise<number>;
  updateBalanceWatch(
    accountId: string,
    decide: (current: BalanceWatchRow | null) => BalanceWatchRow,
  ): Promise<{ readonly before: BalanceWatchRow | null; readonly after: BalanceWatchRow }>;
  readBalanceWatch(accountId: string): Promise<BalanceWatchRow | null>;
  readLiveRule(accountId: string): Promise<AutoTopUpRuleRow | null>;
  listLiveRules(): Promise<readonly AutoTopUpRuleRow[]>;
  readRule(ruleId: string): Promise<AutoTopUpRuleRow | null>;
  insertRule(input: NewRuleInput): Promise<AutoTopUpRuleRow>;
  editRule(input: RuleEditInput): Promise<AutoTopUpRuleRow | null>;
  setRuleStatus(input: {
    readonly ruleId: string;
    readonly expectedVersion: number;
    readonly from: readonly AutoTopUpRuleStatus[];
    readonly to: AutoTopUpRuleStatus;
  }): Promise<AutoTopUpRuleRow | null>;
  expireRules(now: Date): Promise<number>;
  readRuleUsage(ruleId: string, now: Date): Promise<RuleUsage>;
  askExecution<R>(
    input: AskExecutionInput,
    admit: ((rule: AutoTopUpRuleRow | null, usage: RuleUsage | null) => R | null) | null,
    now: Date,
  ): Promise<{ readonly admitted: true; readonly row: DepositExecutionRow } | { readonly admitted: false; readonly reason: R }>;
  markExecutionSubmitted(executionId: string): Promise<void>;
  decideExecution(input: {
    readonly executionId: string;
    readonly status: Exclude<DepositExecutionStatus, "asked" | "submitted">;
    readonly txHash: string | null;
    readonly refusalKind: string | null;
    readonly decidedAt: Date;
  }): Promise<DepositExecutionRow | null>;
  markOrphanedExecutionsUnknown(now: Date): Promise<number>;
  listRuleExecutions(ruleId: string, limit: number): Promise<readonly DepositExecutionRow[]>;
}

export function productionFundingPolicyStore(): FundingPolicyStore {
  return {
    readAlertPercent: () => repo.readAlertPercent(),
    writeAlertPercent: (percent) => repo.writeAlertPercent(percent),
    updateBalanceWatch: (accountId, decide) => repo.updateBalanceWatch(accountId, decide),
    readBalanceWatch: (accountId) => repo.readBalanceWatch(accountId),
    readLiveRule: (accountId) => repo.readLiveRule(accountId),
    listLiveRules: () => repo.listLiveRules(),
    readRule: (ruleId) => repo.readRule(ruleId),
    insertRule: (input) => repo.insertRule(input),
    editRule: (input) => repo.editRule(input),
    setRuleStatus: (input) => repo.setRuleStatus(input),
    expireRules: (now) => repo.expireRules(now),
    readRuleUsage: (ruleId, now) => repo.readRuleUsage(ruleId, now),
    askExecution: (input, admit, now) => repo.askExecution(input, admit, now),
    markExecutionSubmitted: (executionId) => repo.markExecutionSubmitted(executionId),
    decideExecution: (input) => repo.decideExecution(input),
    markOrphanedExecutionsUnknown: (now) => repo.markOrphanedExecutionsUnknown(now),
    listRuleExecutions: (ruleId, limit) => repo.listRuleExecutions(ruleId, limit),
  };
}
