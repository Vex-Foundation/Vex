import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lifecycleIntent, ocoExecutionIntent, orderExecutionIntent } from "../helpers/lighter-intents.js";
import { getLighterClient } from "@tools/lighter/client.js";
import * as orderRepo from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import * as lifecycleRepo from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import * as ocoRepo from "@vex-agent/db/repos/lighter-oco-execution-intents.js";
import * as nonceRepo from "@vex-agent/db/repos/lighter-nonce-state.js";
import { repairLighterOrderIntent } from "@vex-agent/tools/protocols/lighter/order-repair.js";
import { repairLighterOrderLifecycleIntent } from "@vex-agent/tools/protocols/lighter/order-lifecycle-repair.js";
import { repairLighterOcoIntent } from "@vex-agent/tools/protocols/lighter/oco-order-repair.js";

vi.mock("@vex-agent/db/repos/lighter-capital-commitments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/db/repos/lighter-capital-commitments.js")>()),
  retireLighterCapitalCommitment: vi.fn(),
  markLighterCapitalCommitmentSettled: vi.fn(),
}));

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const base = {
  approvalStatus: "approved" as const,
  approvalId: null,
  decidedAt: "2026-09-22T11:58:00.000Z",
  preSubmitRevalidationJson: { checked: true },
  preSubmitRevalidatedAt: "2026-09-22T11:58:01.000Z",
  nonceValue: "9",
  signerTxHash: null,
  submittedTxHash: null,
  sendAttemptStartedAt: null,
  expiresAt: "2026-09-22T11:59:00.000Z",
};

function cases(signed = false) {
  const order = orderExecutionIntent({ ...base,
    executionState: signed ? "signed" : "approval_pending", signerTxHash: signed ? "order-hash" : null });
  const lifecycle = lifecycleIntent({ ...base,
    executionState: signed ? "signed" : "nonce_reserved", signerTxHash: signed ? "lifecycle-hash" : null });
  const oco = ocoExecutionIntent({ ...base,
    executionState: signed ? "signed" : "approval_pending", signerTxHash: signed ? "oco-hash" : null });
  return [
    { kind: "create", row: { ...order, nonceReservationId: `lighter-order:${order.intentId}` },
      repair: repairLighterOrderIntent, repo: orderRepo },
    { kind: "lifecycle", row: { ...lifecycle, nonceReservationId: `lighter-lifecycle:${lifecycle.intentId}` },
      repair: repairLighterOrderLifecycleIntent, repo: lifecycleRepo },
    { kind: "OCO", row: { ...oco, nonceReservationId: `lighter-oco:${oco.intentId}` },
      repair: repairLighterOcoIntent, repo: ocoRepo },
  ] as const;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(getLighterClient(), "getNextNonce").mockRejectedValue(new Error("unexpected provider read"));
  vi.spyOn(nonceRepo, "releaseReservation").mockRejectedValue(new Error("non-atomic release forbidden"));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("interrupted pre-send nonce owners", () => {
  // Each tuple remains correlated through this helper; no provider or signer is involved.
  async function repair(entry: ReturnType<typeof cases>[number]) {
    if (entry.kind === "create") return entry.repair(entry.row);
    if (entry.kind === "lifecycle") return entry.repair(entry.row);
    return entry.repair(entry.row);
  }

  for (const signed of [false, true]) {
    for (const entry of cases(signed)) {
      it(`atomically retires expired ${signed ? "signed" : "unsigned"} ${entry.kind} ownership`, async () => {
        const terminal = signed ? "expired_unsubmitted" : "rejected";
        const retire = vi.spyOn(entry.repo, "expirePreSendNonceReservation")
          .mockResolvedValue({ ...entry.row, executionState: terminal });

        const result = await repair(entry);

        expect(result).toMatchObject({ resolution: "nonce_released_never_submitted", stateAfter: terminal, nonceBlockedAfter: false });
        expect(retire).toHaveBeenCalledWith({
          intentId: entry.row.intentId, sessionId: entry.row.sessionId, environment: entry.row.environment,
          accountIndex: entry.row.accountIndex, apiKeyIndex: entry.row.apiKeyIndex,
          reservationId: entry.row.nonceReservationId, nonceValue: entry.row.nonceValue,
          expectedState: entry.row.executionState, signerTxHash: entry.row.signerTxHash,
        });
        expect(getLighterClient().getNextNonce).not.toHaveBeenCalled();
        expect(nonceRepo.releaseReservation).not.toHaveBeenCalled();
      });

      it(`does not reclaim live ${signed ? "signed" : "unsigned"} ${entry.kind} ownership`, async () => {
        const retire = vi.spyOn(entry.repo, "expirePreSendNonceReservation");
        vi.setSystemTime(Date.parse(base.expiresAt) - 60_000);
        const result = await repair(entry);

        expect(result).toMatchObject({ resolution: "awaiting_submission", nonceBlockedAfter: true });
        expect(retire).not.toHaveBeenCalled();
        expect(getLighterClient().getNextNonce).not.toHaveBeenCalled();
      });

      it(`preserves ${entry.kind} ${signed ? "signed" : "unsigned"} ownership when the atomic predicate refuses`, async () => {
        vi.spyOn(entry.repo, "expirePreSendNonceReservation").mockResolvedValue(null);
        const result = await repair(entry);
        expect(result).toMatchObject({ resolution: "degraded", nonceBlockedAfter: true, stateAfter: entry.row.executionState });
        expect(nonceRepo.releaseReservation).not.toHaveBeenCalled();
      });
    }
  }
});
