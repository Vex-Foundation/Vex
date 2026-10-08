import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLighterClient } from "@tools/lighter/client.js";
import * as intentsRepo from "@vex-agent/db/repos/lighter-oco-execution-intents.js";
import * as nonceRepo from "@vex-agent/db/repos/lighter-nonce-state.js";
import {
  LIGHTER_OCO_RETIRE_EXPIRED_APPROVED_BEFORE_RESERVATION,
  repairUnresolvedLighterOcoInBackground,
} from "@vex-agent/tools/protocols/lighter/oco-order-repair.js";
import { ocoExecutionIntent } from "../../helpers/lighter-intents.js";

beforeEach(() => {
  vi.spyOn(intentsRepo, "listUnresolved").mockResolvedValue([]);
  vi.spyOn(getLighterClient(), "getNextNonce").mockRejectedValue(new Error("unexpected provider read"));
  vi.spyOn(nonceRepo, "releaseReservation").mockRejectedValue(new Error("unexpected nonce release"));
});
afterEach(() => vi.restoreAllMocks());

describe("expired approved OCO recovery before reservation", () => {
  it("defaults on and counts retired consent without any provider or nonce operation", async () => {
    const row = ocoExecutionIntent({ executionState: "rejected", ambiguousReason: "consent_expired_before_reservation" });
    const retire = vi.spyOn(intentsRepo, "retireExpiredApprovedBeforeReservation").mockResolvedValue([row]);

    expect(LIGHTER_OCO_RETIRE_EXPIRED_APPROVED_BEFORE_RESERVATION).toBe(true);
    expect(await repairUnresolvedLighterOcoInBackground({ environment: "rhc", limit: 2 }))
      .toEqual({ examined: 1, advanced: 1, awaiting: 0, degraded: 0, errors: 0 });
    expect(retire).toHaveBeenCalledWith({ environment: "rhc", limit: 2 });
    expect(retire.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(intentsRepo.listUnresolved).mock.invocationCallOrder[0]);
    expect(getLighterClient().getNextNonce).not.toHaveBeenCalled();
    expect(nonceRepo.releaseReservation).not.toHaveBeenCalled();
  });

  it("leaves the prior sweep path intact with the switch off", async () => {
    const retire = vi.spyOn(intentsRepo, "retireExpiredApprovedBeforeReservation");
    expect(await repairUnresolvedLighterOcoInBackground({}, { retireApprovedBeforeReservation: false }))
      .toEqual({ examined: 0, advanced: 0, awaiting: 0, degraded: 0, errors: 0 });
    expect(retire).not.toHaveBeenCalled();
    expect(intentsRepo.listUnresolved).toHaveBeenCalledWith(undefined, 5);
  });

  it("bounds the retirement batch and permits a repository override", async () => {
    const retire = vi.fn<typeof intentsRepo.retireExpiredApprovedBeforeReservation>().mockResolvedValue([]);
    await repairUnresolvedLighterOcoInBackground({ limit: 200 }, { retireIntents: retire });
    expect(retire).toHaveBeenCalledWith({ environment: undefined, limit: 5 });
  });

  it("reports retirement failure while continuing reserved-intent recovery", async () => {
    const retire = vi.spyOn(intentsRepo, "retireExpiredApprovedBeforeReservation")
      .mockRejectedValue(new Error("isolated fixture failure"));
    const row = ocoExecutionIntent({ executionState: "expired_unsubmitted", nonceReservationId: null });
    vi.mocked(intentsRepo.listUnresolved).mockResolvedValue([row]);
    expect(await repairUnresolvedLighterOcoInBackground())
      .toEqual({ examined: 1, advanced: 1, awaiting: 0, degraded: 0, errors: 1 });
    expect(retire).toHaveBeenCalledTimes(1);
    expect(getLighterClient().getNextNonce).not.toHaveBeenCalled();
  });
});
