/**
 * THE VEX INFERENCE HOST SEAM (agent-runtime side).
 *
 * The Vex Inference account, its session bearer, the funding owners and the
 * signing path live in the Electron main process
 * (`vex-app/src/main/vex-cloud/`). The agent tools run inside `src/vex-agent`,
 * and a reverse import from the runtime into `vex-app/main` is forbidden
 * (`check:boundaries`). So the runtime declares the interface and owns the
 * registration point; MAIN registers its implementation at startup
 * (main -> runtime is the legal direction), exactly the way
 * `protocols/shared/launch-image-byte-resolver.ts` mounts its resolver.
 *
 * FAIL CLOSED. With no host registered the tools are not offered
 * ({@link vexInferenceToolAvailability}) and a direct call refuses by name;
 * there is no fallback.
 *
 * WHAT CROSSES. Plain data only: amounts as decimal strings with their unit
 * in the field name (`...Wei` is raw VEX at 18 decimals, `...MicroUsd` is
 * millionths of a dollar), never a float, never a key, never the bearer.
 * The host decides authority from durable state it owns (an auto top-up
 * rule); the runtime passes only what IT knows: whether the user approved a
 * card, whether the session is full permission, and the mission wallet
 * policy as a predicate the host re-asks at the signing boundary.
 */

import { resolveInferenceMode } from "@vex-agent/inference/config.js";

/** Robinhood Chain, the only chain a Vex Inference deposit is sent on. */
export const VEX_INFERENCE_CHAIN_ID = 4663 as const;
/**
 * The VEX token (18 decimals). The desktop's shared money module
 * (`vex-app/src/shared/vex-cloud-money.ts`) carries the same constant for the
 * renderer, and a vex-app test asserts the two are equal.
 */
export const VEX_INFERENCE_TOKEN_ADDRESS = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b" as const;

/** The bearer the main process mirrors into the environment while the vault is unlocked. */
export const VEX_INFERENCE_SESSION_ENV = "VEX_CLOUD_SESSION_TOKEN";

// ── availability ─────────────────────────────────────────────────────────

export type VexInferenceUnavailableReason =
  /** The configured inference provider is not Vex Inference (`AGENT_PROVIDER` is not `vexcloud`). */
  | "provider_not_vex_inference"
  /** No Vex Inference session is held (signed out, or the vault is locked). */
  | "not_signed_in"
  /** The desktop app has not mounted the host (a headless or test runtime). */
  | "host_not_mounted";

export type VexInferenceAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: VexInferenceUnavailableReason };

// ── status ───────────────────────────────────────────────────────────────

/** One VEX amount, raw and exact, with the backend's USD estimate when a rate exists. */
export interface VexAmountView {
  readonly wei: string;
  /** Exact decimal VEX (18 decimals, no rounding). */
  readonly vex: string;
  /** The backend's estimate in micro-USD, or `null` when it has no rate. */
  readonly usdMicroEstimate: string | null;
  /** The same estimate as an exact decimal dollar string, or `null`. */
  readonly usdEstimate: string | null;
}

/** A price per one million tokens. */
export interface PricePerMillionView {
  /** Exact USD per 1M tokens, Vex Inference markup included (the gateway's published price). */
  readonly usd: string;
  readonly microUsd: string;
  /** The same price in VEX at the current backend rate, rounded up, or `null` when no rate exists. */
  readonly vexAtCurrentRate: string | null;
}

export interface VexInferenceStatusReport {
  readonly account: { readonly accountId: string; readonly paused: boolean; readonly drainMode: boolean };
  readonly balances: {
    readonly available: VexAmountView;
    readonly provisional: VexAmountView;
    readonly reserved: VexAmountView;
    readonly claimable: VexAmountView;
    /** `null` when this backend does not report it. */
    readonly cashbackPending: VexAmountView | null;
    readonly pendingWithdrawal: VexAmountView;
  };
  readonly rate:
    | {
      readonly available: true;
      readonly vexWeiPerMicroUsd: string;
      readonly source: string;
      readonly ageSeconds: number;
      readonly observedAt: string;
      readonly validUntil: string;
    }
    | { readonly available: false; readonly reason: string };
  readonly alert: {
    readonly percent: number;
    /** The high-water mark of available plus provisional since the last credited deposit. */
    readonly reference: VexAmountView;
    readonly threshold: VexAmountView;
    readonly balance: VexAmountView;
    readonly belowAlert: boolean;
  };
  readonly model:
    | {
      readonly id: string;
      readonly effort: string | null;
      readonly priced: true;
      readonly inputPerMillion: PricePerMillionView;
      readonly outputPerMillion: PricePerMillionView;
      /** `null` with `reasoningNote` when the gateway publishes no separate reasoning price. */
      readonly reasoningPerMillion: PricePerMillionView | null;
      readonly reasoningNote: string | null;
    }
    | { readonly id: string; readonly effort: string | null; readonly priced: false; readonly reason: string };
  readonly usage: {
    readonly items: readonly {
      readonly requestId: string;
      readonly model: string;
      readonly effort: string | null;
      readonly status: string;
      readonly upstreamCostMicroUsd: string | null;
      readonly charged: VexAmountView | null;
      readonly clampReason: string | null;
      readonly createdAt: string;
    }[];
    readonly limit: number;
    readonly hasMore: boolean;
    /** Present if and only if `hasMore`; pass it back verbatim as `usageCursor`. */
    readonly nextCursor?: string;
  };
  readonly deposits: {
    readonly open: boolean;
    readonly state: "open" | "not_pinned" | "backend_not_configured" | "address_mismatch";
    readonly pinnedAddress: string | null;
    readonly backendAddress: string | null;
  };
  readonly autoTopUp:
    | { readonly state: "none" }
    | {
      readonly ruleId: string;
      /** The plan 4.4 state: active, suspended (with the reason), revoked or expired. */
      readonly state: "active" | "suspended" | "revoked" | "expired";
      readonly suspendedReason: string | null;
      readonly sourceWallet: string;
      readonly amountPerTopUp: VexAmountView;
      readonly maxPerDay: number;
      readonly monthlyCap: VexAmountView;
      /**
       * The user-approved ceiling on the network fee of ONE top-up, raw ETH
       * wei (18 decimals); `null` on a rule approved before the ceiling
       * existed, which spends nothing until the user edits it.
       */
      readonly maxNetworkFeeWei: string | null;
      readonly usedLast24Hours: number;
      readonly usedLast30Days: VexAmountView;
      readonly expiresAt: string;
      readonly trigger: "below_alert_percent";
    };
}

export interface VexInferenceStatusRequest {
  readonly modelId: string | null;
  readonly effort: string | null;
  readonly usageLimit: number;
  readonly usageCursor: string | null;
}

// ── deposit ──────────────────────────────────────────────────────────────

export type AgentDepositAmount =
  | { readonly unit: "VEX"; readonly value: string }
  | { readonly unit: "USD"; readonly value: string };

export interface AgentDepositIntentView {
  readonly intentId: string;
  readonly chainId: 4663;
  readonly token: { readonly address: string; readonly symbol: "VEX"; readonly decimals: 18 };
  readonly amount: VexAmountView;
  /** What the model asked for, echoed: `USD` amounts were converted at the backend rate, rounded up to whole wei. */
  readonly requested: AgentDepositAmount;
  readonly from: string;
  readonly depositAddress: string;
  readonly minimum: VexAmountView;
  readonly networkFee: {
    readonly gasLimit: string;
    readonly maxFeePerGasWei: string;
    readonly maxPriorityFeePerGasWei: string;
    readonly maxNetworkFeeWei: string;
    readonly nativeSymbol: "ETH";
    readonly nativeDecimals: 18;
  };
  readonly walletVex: VexAmountView;
  readonly preparedAt: string;
  readonly expiresAt: string;
  /** Whether an ACTIVE auto top-up rule covers this deposit right now (re-checked at confirm). */
  readonly autoTopUp: { readonly covered: true; readonly ruleId: string } | { readonly covered: false; readonly reason: string };
}

export interface VexInferenceRefusal {
  /** A bounded snake_case kind (`deposits_not_open`, `sender_not_linked`, ...). */
  readonly kind: string;
  /** The sanitized sentence: what did not happen and what to do next. */
  readonly detail: string;
}

export type HostOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: VexInferenceRefusal };

export interface AgentDepositPrepareRequest {
  readonly sessionId: string;
  readonly walletAddress: string;
  readonly amount: AgentDepositAmount;
}

/** What the RUNTIME knows about authority. The host adds rule authority from its own durable state. */
export type AgentDepositRuntimeAuthority =
  /** The user approved this exact intent's card (`context.approved`). */
  | { readonly kind: "approved_card"; readonly approvalId: string | null }
  /** The session runs at full permission: the existing policy executes without a card. */
  | { readonly kind: "full_permission" }
  /** Neither: only an active auto top-up rule can authorize it; otherwise a card is needed. */
  | { readonly kind: "none" };

export interface AgentDepositConfirmRequest {
  readonly sessionId: string;
  readonly intentId: string;
  readonly authority: AgentDepositRuntimeAuthority;
  /**
   * The mission and session wallet scope, re-asked at the signing boundary:
   * `null` = the source wallet is still allowed, otherwise the refusal sentence.
   */
  readonly sourceWalletStillAllowed: (address: string) => string | null;
}

export type AgentDepositConfirmResult =
  | {
    readonly kind: "executed";
    readonly status: "confirmed" | "reverted" | "pending";
    readonly txHash: string;
    readonly transferProven: boolean;
    readonly notified: boolean;
    readonly authority: "approved_card" | "full_permission" | "auto_top_up_rule";
    readonly ruleId: string | null;
    readonly executionId: string | null;
    readonly intent: AgentDepositIntentView;
  }
  /** No authority: the card is raised. The intent stays usable until it expires. */
  | { readonly kind: "needs_user_approval"; readonly reason: string; readonly intent: AgentDepositIntentView };

export interface VexInferenceHost {
  readStatus(request: VexInferenceStatusRequest, signal: AbortSignal): Promise<HostOutcome<VexInferenceStatusReport>>;
  prepareAgentDeposit(request: AgentDepositPrepareRequest, signal: AbortSignal): Promise<HostOutcome<AgentDepositIntentView>>;
  /** The intent as prepared, for this session only; never consumes it. */
  peekAgentDeposit(sessionId: string, intentId: string): HostOutcome<AgentDepositIntentView>;
  /**
   * Retire the intent: the user rejected (or let expire) the card bound to it.
   * Synchronous and idempotent; a missing or cross-session id is a no-op.
   * After it, peek and confirm answer `proposal_missing`.
   */
  retireAgentDeposit(sessionId: string, intentId: string): void;
  confirmAgentDeposit(request: AgentDepositConfirmRequest, signal: AbortSignal): Promise<HostOutcome<AgentDepositConfirmResult>>;
}

let currentHost: VexInferenceHost | null = null;

/** Install the main-process implementation. Idempotent: last writer wins. */
export function registerVexInferenceHost(host: VexInferenceHost): void {
  currentHost = host;
}

/** Unmount the host (app teardown, tests). */
export function resetVexInferenceHost(): void {
  currentHost = null;
}

export function getVexInferenceHost(): VexInferenceHost | null {
  return currentHost;
}

/**
 * Whether the Vex Inference tools may be offered right now, read per call
 * (a provider change, a sign-out or a vault lock applies at once).
 */
export function vexInferenceToolAvailability(
  env: Readonly<Record<string, string | undefined>> = process.env,
): VexInferenceAvailability {
  if (resolveInferenceMode(env) !== "vexcloud") return { available: false, reason: "provider_not_vex_inference" };
  if ((env[VEX_INFERENCE_SESSION_ENV]?.trim() ?? "") === "") return { available: false, reason: "not_signed_in" };
  if (currentHost === null) return { available: false, reason: "host_not_mounted" };
  return { available: true };
}

/** The sentence a direct call gets when the tools are not available. */
export function vexInferenceUnavailableSentence(reason: VexInferenceUnavailableReason): string {
  switch (reason) {
    case "provider_not_vex_inference":
      return "Vex Inference tools are unavailable: the inference provider is not Vex Inference. Nothing was read or sent. The user can switch the provider to Vex Inference in Settings.";
    case "not_signed_in":
      return "Vex Inference tools are unavailable: no Vex Inference session is held (signed out, or Vex is locked). Nothing was read or sent. The user can unlock Vex and sign in under Settings, Vex Inference.";
    case "host_not_mounted":
      return "Vex Inference tools are unavailable in this runtime: the desktop app is not running them. Nothing was read or sent.";
  }
}
