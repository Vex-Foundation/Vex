/**
 * Relay closed step policy (Wave-2 W2, B3 + Codex pin).
 *
 * The CLOSED, default-DENY contract that decides which `/quote/v2` steps Vex may
 * sign, and what `agent_activity` role each carries. Pure + typed: it makes NO
 * IO and records NO activity — the handler (W3b) consumes the result and owns
 * recording/aborting (C1). It classifies; it never broadcasts.
 *
 * RULES:
 *  - Only `approve` and `deposit` step ids are signable. Every other id —
 *    `authorize`/`swap`/`send` AND any unknown id — is REJECTED (default-DENY;
 *    plain bridging needs only approve+deposit this phase, swap-bridges are out
 *    of scope).
 *  - A signable step must be `kind:"transaction"` (a `signature`/permit step is
 *    rejected — bounded signing surface).
 *  - A signable step MUST carry EXACTLY ONE origin-chain transaction item. An
 *    approve/deposit step with NO transaction data (nothing to broadcast) is a
 *    typed rejection HERE, at policy time (pre-intent) — never a post-intent
 *    discovery inside the staged loop (blocker 4). This mirrors `planRelayStepTx`'s
 *    exactly-one-item invariant so a shape that cannot be signed is caught before
 *    any pending plan or in-flight guard exists.
 *  - EVERY item's tx `chainId` MUST equal the origin chain (B3 — stricter than
 *    "not destination"): the deposit + its approval sign on ORIGIN; the fill is
 *    solver-signed on the destination and Vex NEVER signs a destination-chain
 *    step. Any non-origin chainId → reject BEFORE any intent/sign.
 *  - Role map (closed): `approve` → `allowance`, `deposit` → `bridge_deposit`
 *    (the `agent_activity` roles W-SPINE's repo exposes). Truthful roles only.
 *  - EXACTLY ONE DEPOSIT STEP. A plain bridge moves the principal once. A quote
 *    carrying two deposit steps is rejected HERE, before any signable step is
 *    returned: the approve binding proves an allowance equal to the principal,
 *    and a second deposit against that same grant (or against an allowance that
 *    already existed) would move the principal twice on one consent. The
 *    downstream handler also requires the deposit to be the LAST signable step,
 *    but that is a second reader of the same fact; the invariant belongs to the
 *    only owner that sees the whole step list.
 *  - THE APPROVAL SHAPE IS `reset -> exact grant -> deposit`, or a prefix of
 *    it: at most one grant, at most one reset before it, and every approval
 *    strictly BEFORE the deposit step. Each approval's spender MUST be the
 *    deposit step's own target (`@tools/evm-chains/erc20-approve-step-guard.ts`, rule 1). This is
 *    the CROSS-STEP half of the approve binding, and it lives here because this
 *    is the only place that sees the whole step list: a quote whose approval
 *    hands the user's origin token to an address the plan never calls is
 *    rejected pre-intent, before an intent exists, before a wallet is resolved
 *    and before anything is signed. The per-step half (token, sender, and the
 *    allowance bound to the principal Vex derived) runs in `planRelayStepTx`,
 *    where the derived numbers are.
 */

import {
  verifyApprovalSequence,
  verifyApproveStepAuthorizesDeposit,
  type ApprovalSequenceEntry,
  type Erc20ApproveStepVerdict,
} from "@tools/evm-chains/erc20-approve-step-guard.js";

import type { RelayQuoteResponse, RelayStep, RelayStepItemData } from "./types.js";

/** `agent_activity` event role for a signable Relay bridge step. */
export type RelayStepRole = "allowance" | "bridge_deposit";

export type RelayStepRejectionReason =
  | "unsupported_step_id"
  | "unsupported_step_kind"
  | "step_chain_not_origin"
  | "missing_step_transaction"
  | "approve_not_bound_to_deposit"
  | "unsupported_deposit_step_count";

/** One accepted, origin-scoped signable step + its role (original quote order). */
export interface RelaySignableStep {
  readonly stepId: string;
  readonly role: RelayStepRole;
  /** Always the origin chain id (asserted for every item). */
  readonly chainId: number;
  /** The originating step — the handler broadcasts its `items[].data` in order. */
  readonly step: RelayStep;
}

export type RelayStepPolicyResult =
  | { readonly ok: true; readonly steps: readonly RelaySignableStep[] }
  | {
      readonly ok: false;
      readonly reason: RelayStepRejectionReason;
      readonly stepId: string;
      readonly detail: string;
    };

/** Closed step-id → role map. Absence from this map is a default-DENY rejection. */
const STEP_ID_ROLE: Readonly<Record<string, RelayStepRole>> = {
  approve: "allowance",
  deposit: "bridge_deposit",
};

/**
 * Classify a `/quote/v2`'s steps under the closed policy. Returns the ordered
 * signable steps (with roles) on success, or the FIRST offending step's typed
 * rejection — the handler aborts pre-sign on any rejection and never signs a
 * partially-approved step set.
 */
export function classifyRelayBridgeSteps(
  quote: RelayQuoteResponse,
  originChainId: number,
): RelayStepPolicyResult {
  const signable: RelaySignableStep[] = [];

  for (const step of quote.steps) {
    const role = STEP_ID_ROLE[step.id];
    if (!role) {
      return {
        ok: false,
        reason: "unsupported_step_id",
        stepId: step.id,
        detail: `Relay step "${step.id}" is not an allowed bridging step (only approve/deposit are signable).`,
      };
    }
    if (step.kind !== "transaction") {
      return {
        ok: false,
        reason: "unsupported_step_kind",
        stepId: step.id,
        detail: `Relay step "${step.id}" is kind "${step.kind}" — only transaction steps are signable.`,
      };
    }
    let originTxItems = 0;
    for (const item of step.items) {
      if (!item.data) continue;
      if (item.data.chainId !== originChainId) {
        return {
          ok: false,
          reason: "step_chain_not_origin",
          stepId: step.id,
          detail: `Relay step "${step.id}" targets chain ${item.data.chainId}, not the origin chain ${originChainId}. Vex signs only origin-chain steps; the fill is solver-signed on the destination.`,
        };
      }
      originTxItems++;
    }
    // Blocker 4: a signable step with no transaction to sign (or an ambiguous
    // multi-tx shape) is rejected BEFORE the intent exists — never discovered
    // mid-staging after a pending plan has been persisted.
    if (originTxItems !== 1) {
      return {
        ok: false,
        reason: "missing_step_transaction",
        stepId: step.id,
        detail: `Relay step "${step.id}" (${role}) must carry exactly one origin-chain transaction to sign (found ${originTxItems}). A signable step with no transaction data is rejected pre-intent.`,
      };
    }
    signable.push({ stepId: step.id, role, chainId: originChainId, step });
  }

  const approveBinding = bindApproveStepsToDeposit(signable);
  if (approveBinding !== null) return approveBinding;

  const depositCount = countDeposits(signable);
  if (depositCount !== 1) {
    return {
      ok: false,
      reason: "unsupported_deposit_step_count",
      stepId: "deposit",
      detail: `Relay returned ${depositCount} deposit steps for this bridge; Vex signs a plain bridge, which is exactly one. Nothing was signed. Get a fresh relay__bridge_quote_get for this route and retry.`,
    };
  }

  return { ok: true, steps: signable };
}

/** How many classified steps carry the deposit role. */
function countDeposits(signable: readonly RelaySignableStep[]): number {
  let deposits = 0;
  for (const entry of signable) {
    if (entry.role === "bridge_deposit") deposits++;
  }
  return deposits;
}

/** The single origin transaction a classified step carries, or `null`. */
function stepTransaction(entry: RelaySignableStep): RelayStepItemData | null {
  for (const item of entry.step.items) {
    if (item.data) return item.data;
  }
  return null;
}

/**
 * Rule 1 of the approve binding across the WHOLE step list, plus THE ORDER.
 *
 * Every approval step must be a canonical, value-free `approve` naming this
 * quote's own deposit target (rule 1,
 * `verifyApproveStepAuthorizesDeposit`), and the approvals as a set must form
 * the only shape a bridge may sign: `reset -> exact grant -> deposit`, or any
 * shorter prefix of it (`verifyApprovalSequence`). Relay's own order is the
 * STEP INDEX, which is the order the handler broadcasts in, so an approval that
 * sits at or after the deposit step is an allowance created after the only
 * transaction that justified it.
 *
 * Returns the rejection, or `null` when the steps bind. A quote with no approve
 * step binds trivially: Relay omits the step when the allowance already covers
 * the deposit, and every native-origin quote measured live carries none.
 */
function bindApproveStepsToDeposit(
  signable: readonly RelaySignableStep[],
): RelayStepPolicyResult | null {
  const rejection = (entry: RelaySignableStep, detail: string): RelayStepPolicyResult => ({
    ok: false,
    reason: "approve_not_bound_to_deposit",
    stepId: entry.stepId,
    detail: `Relay step "${entry.stepId}" is a token approval Vex will not sign: ${detail}. Nothing was signed. Get a fresh relay__bridge_quote_get for this route and retry.`,
  });

  const depositIndex = signable.findIndex((entry) => entry.role === "bridge_deposit");
  const depositEntry = signable.at(depositIndex === -1 ? signable.length : depositIndex);
  const depositTx = depositEntry === undefined ? null : stepTransaction(depositEntry);
  const approvalEntries: ApprovalSequenceEntry[] = [];

  for (const [index, entry] of signable.entries()) {
    if (entry.role !== "allowance") continue;
    const approvalTx = stepTransaction(entry);
    if (approvalTx === null) {
      // The classifier above already proved every signable step carries exactly
      // one origin transaction, so this is unreachable today. It refuses rather
      // than passing, because an approval whose transaction this gate could not
      // read is an approval it did not check.
      return rejection(entry, "the approval step carries no transaction to read");
    }
    let value: bigint;
    try {
      value = BigInt(approvalTx.value);
    } catch {
      // `planRelayStepTx` owns the canonicalization refusal; a value that is not
      // an integer is refused here too, because this gate must not admit a step
      // whose native charge it could not read.
      return rejection(entry, "its native value is not an integer, so Vex cannot read what it would send");
    }
    const verdict: Erc20ApproveStepVerdict = verifyApproveStepAuthorizesDeposit(
      { to: approvalTx.to, data: approvalTx.data, value },
      { depositTarget: depositTx?.to ?? null },
    );
    if (!verdict.ok) return rejection(entry, verdict.detail);
    approvalEntries.push({ position: index, allowance: verdict.allowance });
  }

  const sequence = verifyApprovalSequence(approvalEntries, depositIndex === -1 ? null : depositIndex);
  if (!sequence.ok) {
    // The LAST approval is the one the sequence rule objects to on every shape
    // it names, so it is the step the message points at.
    const offending = signable.filter((entry) => entry.role === "allowance").at(-1);
    if (offending !== undefined) return rejection(offending, sequence.detail);
  }
  return null;
}
