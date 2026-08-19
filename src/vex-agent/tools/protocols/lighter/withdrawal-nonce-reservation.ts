import { ErrorCodes, VexError } from "../../../../errors.js";
import { withTransaction } from "@vex-agent/db/client.js";
import * as nonceStateRepo from "@vex-agent/db/repos/lighter-nonce-state.js";
import * as withdrawalIntentsRepo from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import type { LighterWithdrawalReadyForSignerPlan } from "./withdrawal-execution-plan.js";

export interface LighterWithdrawalNonceReservation {
  readonly reservationId: string;
  readonly nonceValue: string;
}

export async function reserveLighterWithdrawalNonceForSigning(
  plan: LighterWithdrawalReadyForSignerPlan,
  deps: {
    readonly transaction: typeof withTransaction;
    readonly nonceState: Pick<typeof nonceStateRepo, "reserveObservedWith">;
    readonly intents: Pick<typeof withdrawalIntentsRepo, "attachNonceReservationWith">;
  } = {
    transaction: withTransaction,
    nonceState: nonceStateRepo,
    intents: withdrawalIntentsRepo,
  },
): Promise<LighterWithdrawalNonceReservation> {
  return deps.transaction(async (client) => {
    const reservationId = `lighter-withdrawal:${plan.intentId}`;
    const reserved = await deps.nonceState.reserveObservedWith(client, {
      environment: plan.environment,
      accountIndex: plan.accountIndex,
      apiKeyIndex: plan.apiKeyIndex,
      reservationId,
    });
    if (
      reserved === null
      || reserved.status !== "reserved"
      || reserved.reservationId !== reservationId
      || reserved.reservedNonce === null
    ) {
      throw blocked(`No reconciled ${plan.environment} nonce is available for this withdrawal.`);
    }
    const attached = await deps.intents.attachNonceReservationWith(client, {
      intentId: plan.intentId,
      sessionId: plan.sessionId,
      accountIndex: plan.accountIndex,
      apiKeyIndex: plan.apiKeyIndex,
      reservationId,
      nonceValue: reserved.reservedNonce,
    });
    if (attached === null) throw blocked(`The ${plan.environment} withdrawal could not atomically attach its nonce reservation.`);
    return { reservationId, nonceValue: reserved.reservedNonce };
  });
}

function blocked(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Reconcile the existing Lighter transaction state before preparing a new withdrawal. No retry was submitted.",
  );
}
