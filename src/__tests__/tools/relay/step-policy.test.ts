/**
 * Relay closed step policy (Wave-2 W2, B3 + Codex pin) — table-driven.
 *
 * Only `approve`→allowance and `deposit`→bridge_deposit are signable, every item
 * must sign on the ORIGIN chain, and every other step id (authorize/swap/send +
 * unknown) is default-DENIED. This covers the role map, the origin-only chain
 * rule, non-transaction rejection, and the first-offender abort.
 */

import { describe, it, expect } from "vitest";

import { classifyRelayBridgeSteps, type RelayStepRejectionReason } from "@tools/relay/step-policy.js";
import type { RelayQuoteResponse } from "@tools/relay/types.js";

const ORIGIN = 8453;
const DEST = 4663;
const OTHER = 1;
const TO = "0x2222222222222222222222222222222222222222";

function step(id: string, kind: string, chainIds: number[]) {
  return { id, kind, items: chainIds.map((chainId) => ({ data: { to: TO, value: "0", data: "0x", chainId } })) };
}
function quote(...steps: unknown[]): RelayQuoteResponse {
  return { steps } as unknown as RelayQuoteResponse;
}

describe("classifyRelayBridgeSteps — accepted (closed role map, origin-only)", () => {
  it("approve → allowance, deposit → bridge_deposit, order preserved", () => {
    const result = classifyRelayBridgeSteps(
      quote(step("approve", "transaction", [ORIGIN]), step("deposit", "transaction", [ORIGIN])),
      ORIGIN,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.steps.map((s) => [s.stepId, s.role, s.chainId])).toEqual([
        ["approve", "allowance", ORIGIN],
        ["deposit", "bridge_deposit", ORIGIN],
      ]);
      // The raw step is passed through so the handler broadcasts its items.
      expect(result.steps[1]!.step.id).toBe("deposit");
    }
  });

  it("a native bridge (single deposit, no approve) is accepted", () => {
    const result = classifyRelayBridgeSteps(quote(step("deposit", "transaction", [ORIGIN])), ORIGIN);
    expect(result.ok && result.steps).toHaveLength(1);
  });

  it("a deposit step with NO tx-data items is REJECTED pre-intent (blocker 4 — nothing to sign)", () => {
    const result = classifyRelayBridgeSteps(quote({ id: "deposit", kind: "transaction", items: [{}] }), ORIGIN);
    expect(result).toMatchObject({ ok: false, reason: "missing_step_transaction", stepId: "deposit" });
  });

  it("an approve step whose items carry NO transaction data is REJECTED pre-intent (blocker 4)", () => {
    const result = classifyRelayBridgeSteps(quote({ id: "approve", kind: "transaction", items: [{}, {}] }), ORIGIN);
    expect(result).toMatchObject({ ok: false, reason: "missing_step_transaction", stepId: "approve" });
  });

  it("a deposit step with MORE than one origin tx item is rejected pre-intent (ambiguous, exactly-one)", () => {
    const result = classifyRelayBridgeSteps(quote(step("deposit", "transaction", [ORIGIN, ORIGIN])), ORIGIN);
    expect(result).toMatchObject({ ok: false, reason: "missing_step_transaction", stepId: "deposit" });
  });
});

// Each row is a single offending step; the classifier must reject with the named
// reason. `expectRole` on the accepted rows above already covers the role map.
type RejectRow = { readonly label: string; readonly step: unknown; readonly reason: RelayStepRejectionReason };

const REJECTIONS: readonly RejectRow[] = [
  { label: "authorize id", step: step("authorize", "transaction", [ORIGIN]), reason: "unsupported_step_id" },
  { label: "swap id", step: step("swap", "transaction", [ORIGIN]), reason: "unsupported_step_id" },
  { label: "send id", step: step("send", "transaction", [ORIGIN]), reason: "unsupported_step_id" },
  { label: "unknown id (default-DENY)", step: step("frobnicate", "transaction", [ORIGIN]), reason: "unsupported_step_id" },
  { label: "signature kind on a valid id", step: step("deposit", "signature", [ORIGIN]), reason: "unsupported_step_kind" },
  { label: "deposit targeting the DESTINATION chain", step: step("deposit", "transaction", [DEST]), reason: "step_chain_not_origin" },
  { label: "approve targeting an unrelated chain", step: step("approve", "transaction", [OTHER]), reason: "step_chain_not_origin" },
  { label: "deposit with a mixed origin+destination item set", step: step("deposit", "transaction", [ORIGIN, DEST]), reason: "step_chain_not_origin" },
];

describe("classifyRelayBridgeSteps — rejected (default-DENY + origin-only)", () => {
  for (const row of REJECTIONS) {
    it(`${row.label} → ${row.reason}`, () => {
      const result = classifyRelayBridgeSteps(quote(row.step), ORIGIN);
      expect(result).toMatchObject({ ok: false, reason: row.reason });
    });
  }

  it("returns the FIRST offending step (abort before signing a partial set)", () => {
    const result = classifyRelayBridgeSteps(
      quote(step("approve", "transaction", [ORIGIN]), step("swap", "transaction", [ORIGIN]), step("deposit", "transaction", [ORIGIN])),
      ORIGIN,
    );
    expect(result).toMatchObject({ ok: false, reason: "unsupported_step_id", stepId: "swap" });
  });
});
