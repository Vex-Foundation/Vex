/**
 * Test support for the Vex Inference funding policy: an in-memory
 * `FundingPolicyStore` that implements the repository's contract (one live
 * rule per account, the durable single flight per rule, caps counted over
 * every non-refused row, exactly one decision per execution), a scripted
 * ERC-20 transfer port, a deposit-deps builder, and an in-memory withdrawal
 * origin store with its guard. Shared by the policy,
 * executor, agent deposit and poller suites; not a test file itself.
 */

import { encodeAbiParameters, getAddress, pad, type Address, type Hex, type TransactionReceipt } from "viem";
import type { Erc20TransferPort, TransferBroadcastRequest } from "@tools/evm-chains/erc20-transfer-port.js";
import type { FinalSignedRequest, StagedBroadcastOutcome } from "@tools/evm-chains/staged-broadcast.js";
import type {
  AskExecutionInput,
  AutoTopUpRuleRow,
  BalanceWatchRow,
  DepositExecutionRow,
  NewRuleInput,
  RuleEditInput,
  RuleUsage,
} from "@vex-agent/db/repos/vex-inference-funding.js";
import { RuleExecutionInFlightError, type FundingPolicyStore } from "../../auto-top-up/funding-store.js";
import type { VexCloudAccountResponse } from "../../api-client.js";
import type { DepositDeps } from "../../funding/deposit-core.js";
import {
  createWithdrawalOriginGuard,
  type WithdrawalOriginGuard,
  type WithdrawalOriginMark,
  type WithdrawalOriginStore,
} from "../../funding/withdrawal-origins.js";
import type { VexCloudWithdrawalNotice } from "@shared/schemas/vex-cloud-funding.js";

export const E18 = 10n ** 18n;
export const NOW = new Date("2026-10-21T12:00:00.000Z");
export const VEX = getAddress("0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b");
export const DEPOSIT = getAddress("0x00000000000000000000000000000000000d3905");
export const WALLET = getAddress("0x1111111111111111111111111111111111111111");
export const OTHER_WALLET = getAddress("0x2222222222222222222222222222222222222222");
export const ACCOUNT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const TX_HASH: Hex = `0x${"ab".repeat(32)}`;
const TRANSFER_TOPIC: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DAY_MS = 86_400_000;
/** 0.0001 ETH, the form's default ceiling; the scripted port signs about 0.0000018 ETH. */
export const DEFAULT_FEE_CEILING_WEI = 10n ** 14n;

export class MemoryFundingStore implements FundingPolicyStore {
  alertPercent = 20;
  readonly watch = new Map<string, BalanceWatchRow>();
  readonly rules = new Map<string, AutoTopUpRuleRow>();
  readonly executions: DepositExecutionRow[] = [];

  async readAlertPercent(): Promise<number> {
    return this.alertPercent;
  }
  async writeAlertPercent(percent: number): Promise<number> {
    if (!Number.isInteger(percent) || percent < 1 || percent > 90) throw new RangeError("alert percent");
    this.alertPercent = percent;
    return percent;
  }
  async updateBalanceWatch(accountId: string, decide: (current: BalanceWatchRow | null) => BalanceWatchRow) {
    const before = this.watch.get(accountId) ?? null;
    const after = decide(before);
    this.watch.set(accountId, after);
    return { before, after };
  }
  async readBalanceWatch(accountId: string): Promise<BalanceWatchRow | null> {
    return this.watch.get(accountId) ?? null;
  }
  async readLiveRule(accountId: string): Promise<AutoTopUpRuleRow | null> {
    return [...this.rules.values()].find((rule) => rule.accountId === accountId && (rule.status === "active" || rule.status === "paused")) ?? null;
  }
  async listLiveRules(): Promise<readonly AutoTopUpRuleRow[]> {
    return [...this.rules.values()].filter((rule) => rule.status === "active" || rule.status === "paused");
  }
  async readRule(ruleId: string): Promise<AutoTopUpRuleRow | null> {
    return this.rules.get(ruleId) ?? null;
  }
  async insertRule(input: NewRuleInput): Promise<AutoTopUpRuleRow> {
    if ((await this.readLiveRule(input.accountId)) !== null) throw Object.assign(new Error("unique"), { code: "23505" });
    const row: AutoTopUpRuleRow = {
      ruleId: input.ruleId,
      accountId: input.accountId,
      sourceWallet: input.sourceWallet.toLowerCase(),
      amountWei: input.amountWei,
      maxPerDay: input.maxPerDay,
      monthlyCapWei: input.monthlyCapWei,
      maxNetworkFeeWei: input.maxNetworkFeeWei,
      triggerKind: "below_alert_percent",
      expiresAt: input.expiresAt,
      status: "active",
      version: 1,
      approvedAt: input.approvedAt,
      updatedAt: input.approvedAt,
    };
    this.rules.set(row.ruleId, row);
    return row;
  }
  async editRule(input: RuleEditInput): Promise<AutoTopUpRuleRow | null> {
    const row = this.rules.get(input.ruleId);
    if (row === undefined || row.version !== input.expectedVersion || (row.status !== "active" && row.status !== "paused")) return null;
    const next = { ...row, sourceWallet: input.sourceWallet.toLowerCase(), amountWei: input.amountWei, maxPerDay: input.maxPerDay, monthlyCapWei: input.monthlyCapWei, maxNetworkFeeWei: input.maxNetworkFeeWei, expiresAt: input.expiresAt, approvedAt: input.approvedAt, version: row.version + 1 };
    this.rules.set(row.ruleId, next);
    return next;
  }
  async setRuleStatus(input: { ruleId: string; expectedVersion: number; from: readonly AutoTopUpRuleRow["status"][]; to: AutoTopUpRuleRow["status"] }) {
    const row = this.rules.get(input.ruleId);
    if (row === undefined || row.version !== input.expectedVersion || !input.from.includes(row.status)) return null;
    const next = { ...row, status: input.to, version: row.version + 1 };
    this.rules.set(row.ruleId, next);
    return next;
  }
  async expireRules(now: Date): Promise<number> {
    let n = 0;
    for (const row of this.rules.values()) {
      if ((row.status === "active" || row.status === "paused") && row.expiresAt.getTime() <= now.getTime()) {
        this.rules.set(row.ruleId, { ...row, status: "expired", version: row.version + 1 });
        n += 1;
      }
    }
    return n;
  }
  async readRuleUsage(ruleId: string, now: Date): Promise<RuleUsage> {
    const counted = this.executions.filter((row) => row.ruleId === ruleId && row.status !== "refused");
    return {
      countLastDay: counted.filter((row) => row.askedAt.getTime() > now.getTime() - DAY_MS).length,
      sumLast30DaysWei: counted.filter((row) => row.askedAt.getTime() > now.getTime() - 30 * DAY_MS).reduce((sum, row) => sum + row.amountWei, 0n),
    };
  }
  async askExecution<R>(input: AskExecutionInput, admit: ((rule: AutoTopUpRuleRow | null, usage: RuleUsage | null) => R | null) | null, now: Date) {
    let rule: AutoTopUpRuleRow | null = null;
    let usage: RuleUsage | null = null;
    if (input.ruleId !== null) {
      rule = this.rules.get(input.ruleId) ?? null;
      usage = await this.readRuleUsage(input.ruleId, now);
      if (this.executions.some((row) => row.ruleId === input.ruleId && (row.status === "asked" || row.status === "submitted"))) {
        throw new RuleExecutionInFlightError();
      }
    }
    if (admit !== null) {
      const refusal = admit(rule, usage);
      if (refusal !== null) return { admitted: false as const, reason: refusal };
    }
    const row: DepositExecutionRow = {
      executionId: input.executionId,
      ruleId: input.ruleId,
      authority: input.authority,
      sessionId: input.sessionId,
      sourceWallet: input.sourceWallet.toLowerCase(),
      depositAddress: input.depositAddress.toLowerCase(),
      amountWei: input.amountWei,
      status: "asked",
      refusalKind: null,
      txHash: null,
      askedAt: now,
      decidedAt: null,
    };
    this.executions.push(row);
    return { admitted: true as const, row };
  }
  private replace(executionId: string, patch: Partial<DepositExecutionRow>): DepositExecutionRow | null {
    const index = this.executions.findIndex((row) => row.executionId === executionId);
    if (index < 0) return null;
    const current = this.executions[index];
    if (current === undefined) return null;
    const next: DepositExecutionRow = { ...current, ...patch };
    this.executions[index] = next;
    return next;
  }
  async markExecutionSubmitted(executionId: string): Promise<void> {
    const row = this.executions.find((r) => r.executionId === executionId);
    if (row?.status === "asked") this.replace(executionId, { status: "submitted" });
  }
  async decideExecution(input: { executionId: string; status: Exclude<DepositExecutionRow["status"], "asked" | "submitted">; txHash: string | null; refusalKind: string | null; decidedAt: Date }) {
    const row = this.executions.find((r) => r.executionId === input.executionId);
    if (row === undefined || (row.status !== "asked" && row.status !== "submitted")) return null;
    return this.replace(input.executionId, { status: input.status, txHash: input.txHash, refusalKind: input.refusalKind, decidedAt: input.decidedAt });
  }
  async markOrphanedExecutionsUnknown(now: Date): Promise<number> {
    let n = 0;
    for (const row of [...this.executions]) {
      if (row.status === "asked" || row.status === "submitted") {
        this.replace(row.executionId, { status: "unknown", refusalKind: "process_restarted", decidedAt: now });
        n += 1;
      }
    }
    return n;
  }
  async listRuleExecutions(ruleId: string, limit: number): Promise<readonly DepositExecutionRow[]> {
    return this.executions.filter((row) => row.ruleId === ruleId).reverse().slice(0, limit);
  }

  /** Seed an active rule directly (tests only; production writes rules through the approved card). */
  seedRule(patch: Partial<AutoTopUpRuleRow> = {}): AutoTopUpRuleRow {
    const row: AutoTopUpRuleRow = {
      ruleId: "vxrule-00000000-0000-4000-8000-000000000001",
      accountId: ACCOUNT_ID,
      sourceWallet: WALLET.toLowerCase(),
      amountWei: 6_000n * E18,
      maxPerDay: 2,
      monthlyCapWei: 12_000n * E18,
      maxNetworkFeeWei: DEFAULT_FEE_CEILING_WEI,
      triggerKind: "below_alert_percent",
      expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
      status: "active",
      version: 1,
      approvedAt: NOW,
      updatedAt: NOW,
      ...patch,
    };
    this.rules.set(row.ruleId, row);
    return row;
  }
}

export function accountWith(options: { readonly linked?: readonly string[]; readonly depositAddress?: string | null; readonly availableWei?: bigint; readonly accountId?: string } = {}): VexCloudAccountResponse {
  const zero = { wei: "0", usd_micro_estimate: "0" };
  return {
    account_id: options.accountId ?? ACCOUNT_ID,
    status: { paused: false, drain_mode: false },
    wallets: (options.linked ?? [WALLET.toLowerCase()]).map((address) => ({ address, linked_at: NOW.toISOString() })),
    deposit_address: options.depositAddress === undefined ? DEPOSIT : options.depositAddress,
    balances: {
      available: { wei: String(options.availableWei ?? 0n), usd_micro_estimate: "0" },
      provisional: zero,
      reserved: zero,
      pending_withdrawal: zero,
      claimable: zero,
    },
    rate: {
      available: true,
      source: "twap",
      // 10^15 wei per micro-USD: 1 VEX = $0.001, so the $5 minimum is 5,000 VEX.
      vex_wei_per_micro_usd: "1000000000000000",
      observed_at: NOW.toISOString(),
      age_seconds: 3,
      valid_until: new Date(NOW.getTime() + 600_000).toISOString(),
    },
    limits: { min_deposit_micro_usd: "5000000", min_withdraw_micro_usd: "5000000", provisional_cap_micro_usd: "25000000" },
  };
}

export type ScriptedOutcome = "confirmed" | "reverted" | "ambiguous";

/** A port that walks the real hook order (gate, key, final check) and answers with the scripted outcome. */
export class ScriptedPort implements Erc20TransferPort {
  vexWei = 50_000n * E18;
  nativeWei = 10n ** 17n;
  outcome: ScriptedOutcome = "confirmed";
  readonly broadcasts: TransferBroadcastRequest[] = [];
  signed = 0;
  /** Runs before the pre-sign gate (a pause or revoke landing after admission). */
  beforeGate: (() => void) | null = null;
  /**
   * Runs between the key load and the final check, AWAITED: the window of the
   * pending-nonce read, where a lock, a pause, a revoke, an edit, a quit or
   * the rule's expiry can land.
   */
  beforeFinalCheck: (() => void | Promise<void>) | null = null;
  /** Runs right after the signature, before the outcome is known (a change landing after the final check passed). */
  afterSign: (() => void) | null = null;
  /** The max fee per gas of the request about to be signed (a node filling a higher fee than quoted). */
  signedMaxFeePerGas = 20_000_000n;

  async readVexBalance(): Promise<bigint> {
    return this.vexWei;
  }
  async readNativeBalance(): Promise<bigint> {
    return this.nativeWei;
  }
  async quoteTransferFees() {
    return { gasEstimate: 60_000n, maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 0n };
  }
  async broadcastTransfer(request: TransferBroadcastRequest): Promise<StagedBroadcastOutcome> {
    this.broadcasts.push(request);
    const signed: FinalSignedRequest = {
      to: VEX,
      data: request.data,
      value: 0n,
      gas: 90_000n,
      nonce: 7,
      gasPrice: undefined,
      maxFeePerGas: this.signedMaxFeePerGas,
      maxPriorityFeePerGas: 0n,
    };
    this.beforeGate?.();
    await request.onBeforeSign(signed);
    await request.loadPrivateKey();
    await this.beforeFinalCheck?.();
    await request.onFinalCheck(signed);
    this.signed += 1;
    this.afterSign?.();
    request.onHashStaged(TX_HASH);
    if (this.outcome === "ambiguous") return { kind: "ambiguous", txHash: TX_HASH, stage: "confirm", reason: "receipt timeout" };
    const amount = BigInt(`0x${request.data.slice(74)}`);
    const to = getAddress(`0x${request.data.slice(34, 74)}`);
    const success = this.outcome === "confirmed";
    const receipt: TransactionReceipt = {
      blockHash: `0x${"cd".repeat(32)}`,
      blockNumber: 1n,
      contractAddress: null,
      cumulativeGasUsed: 60_000n,
      effectiveGasPrice: 20_000_000n,
      from: request.from,
      gasUsed: 60_000n,
      logs: success
        ? [{
          address: VEX,
          blockHash: `0x${"cd".repeat(32)}`,
          blockNumber: 1n,
          data: encodeAbiParameters([{ type: "uint256" }], [amount]),
          logIndex: 0,
          transactionHash: TX_HASH,
          transactionIndex: 0,
          removed: false,
          topics: [TRANSFER_TOPIC, pad(request.from), pad(to)],
        }]
        : [],
      logsBloom: `0x${"00".repeat(256)}`,
      status: success ? "success" : "reverted",
      to: VEX,
      transactionHash: TX_HASH,
      transactionIndex: 0,
      type: "eip1559",
    };
    return this.outcome === "confirmed" ? { kind: "confirmed", txHash: TX_HASH, receipt } : { kind: "reverted", txHash: TX_HASH, receipt };
  }
}

export interface DepositWorld {
  account: VexCloudAccountResponse;
  pinned: string | null;
  vaultUnlocked: boolean;
  executionReady: boolean;
  wallets: Address[];
  now: Date;
  keyLoads: number;
  readonly notified: string[];
  readonly port: ScriptedPort;
}

export function depositWorld(): DepositWorld & { readonly deps: DepositDeps } {
  const world: DepositWorld = {
    account: accountWith(),
    pinned: DEPOSIT,
    vaultUnlocked: true,
    executionReady: true,
    wallets: [WALLET, OTHER_WALLET],
    now: NOW,
    keyLoads: 0,
    notified: [],
    port: new ScriptedPort(),
  };
  const deps: DepositDeps = {
    api: {
      readAccount: async () => ({ ok: true, value: world.account }),
      notifyDeposit: async (_bearer, hash) => {
        world.notified.push(hash);
        return { ok: true, value: { accepted: true as const } };
      },
    },
    readSession: async () => ({ ok: true, data: "vxs_test_bearer_000000000001" }),
    clearSession: async () => ({ ok: true, data: undefined }),
    chain: () => world.port,
    listEvmWallets: () => world.wallets.map((address, i) => ({ id: `evm_00000000-0000-4000-8000-00000000000${i + 1}`, address, label: `W${i + 1}`, createdAt: NOW.toISOString() })),
    isVaultUnlocked: () => world.vaultUnlocked,
    isExecutionReady: () => world.executionReady,
    pinnedDepositAddress: () => world.pinned,
    loadPrivateKey: async () => {
      world.keyLoads += 1;
      const key: Hex = `0x${"42".repeat(32)}`;
      return key;
    },
    now: () => world.now,
  };
  return Object.assign(world, { deps });
}

// ── withdrawal origins ───────────────────────────────────────────────────

/** The `vex_inference_withdrawal_origins` contract in memory: insert-once foreign rows, created_here wins. */
export class MemoryWithdrawalOriginStore implements WithdrawalOriginStore {
  readonly rows = new Map<string, WithdrawalOriginMark>();
  private key(accountId: string, withdrawalId: string): string {
    return `${accountId.toLowerCase()}:${withdrawalId}`;
  }
  async recordCreatedHere(accountId: string, withdrawalId: string): Promise<void> {
    this.rows.set(this.key(accountId, withdrawalId), { origin: "created_here", dismissedAt: null });
  }
  async readOrigins(accountId: string, withdrawalIds: readonly string[]): Promise<ReadonlyMap<string, WithdrawalOriginMark>> {
    const out = new Map<string, WithdrawalOriginMark>();
    for (const id of withdrawalIds) {
      const row = this.rows.get(this.key(accountId, id));
      if (row !== undefined) out.set(id, row);
    }
    return out;
  }
  async flagForeign(accountId: string, withdrawalId: string): Promise<boolean> {
    const key = this.key(accountId, withdrawalId);
    if (this.rows.has(key)) return false;
    this.rows.set(key, { origin: "foreign", dismissedAt: null });
    return true;
  }
  async dismissForeign(accountId: string, withdrawalId: string): Promise<boolean> {
    const key = this.key(accountId, withdrawalId);
    const row = this.rows.get(key);
    if (row?.origin !== "foreign") return false;
    this.rows.set(key, { origin: "foreign", dismissedAt: row.dismissedAt ?? NOW });
    return true;
  }
}

/** A guard over an in-memory store that records every notice it emits. */
export function memoryWithdrawalOrigins(now: () => Date = () => NOW): {
  readonly store: MemoryWithdrawalOriginStore;
  readonly guard: WithdrawalOriginGuard;
  readonly emitted: VexCloudWithdrawalNotice[];
} {
  const store = new MemoryWithdrawalOriginStore();
  const emitted: VexCloudWithdrawalNotice[] = [];
  const guard = createWithdrawalOriginGuard({ store, now, emitNotice: (notice) => emitted.push(notice) });
  return { store, guard, emitted };
}
