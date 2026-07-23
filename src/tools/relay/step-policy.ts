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
 */

import type { RelayQuoteResponse, RelayStep } from "./types.js";

/** `agent_activity` event role for a signable Relay bridge step. */
export type RelayStepRole = "allowance" | "bridge_deposit";

export type RelayStepRejectionReason =
  | "unsupported_step_id"
  | "unsupported_step_kind"
  | "step_chain_not_origin"
  | "missing_step_transaction";

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

  return { ok: true, steps: signable };
}
