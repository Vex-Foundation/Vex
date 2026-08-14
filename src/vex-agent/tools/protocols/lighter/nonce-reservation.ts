import { ErrorCodes, VexError } from "../../../../errors.js";
import { withTransaction } from "@vex-agent/db/client.js";
import * as lighterNonceStateRepo from "@vex-agent/db/repos/lighter-nonce-state.js";
import * as lighterOrderExecutionIntentsRepo from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import type { LighterOrderReadyForSignerPlan } from "./execution-plan.js";

export interface LighterOrderNonceReservation {
  readonly kind: "lighter_order_nonce_reservation";
  readonly intentId: string;
  readonly sessionId: string;
  readonly reservationId: string;
  readonly nonceValue: string;
  readonly environment: LighterOrderReadyForSignerPlan["environment"];
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
}

export interface ReserveLighterOrderNonceDeps {
  readonly transaction: typeof withTransaction;
  readonly nonceState: Pick<typeof lighterNonceStateRepo, "reserveObservedWith">;
  readonly intents: Pick<typeof lighterOrderExecutionIntentsRepo, "attachNonceReservationWith">;
}

export function lighterOrderNonceReservationId(intentId: string): string {
  return `lighter-order:${intentId}`;
}

export async function reserveLighterOrderNonceForSigning(
  plan: LighterOrderReadyForSignerPlan,
  deps: ReserveLighterOrderNonceDeps = defaultDeps(),
): Promise<LighterOrderNonceReservation> {
  return deps.transaction(async (client) => {
    const reservationId = lighterOrderNonceReservationId(plan.intentId);
    const reserved = await deps.nonceState.reserveObservedWith(client, {
      environment: plan.nonceScope.environment,
      accountIndex: plan.nonceScope.accountIndex,
      apiKeyIndex: plan.nonceScope.apiKeyIndex,
      reservationId,
    });
    if (reserved === null || reserved.reservedNonce === null || reserved.reservationId === null) {
      throw new VexError(
        ErrorCodes.LIGHTER_INVALID_REQUEST,
        "No observed Lighter nonce is available to reserve for this order.",
        "Refresh Lighter API-key metadata for the account, then prepare the order again.",
      );
    }
    assertReservationMatchesPlan(plan, reserved);

    const intent = await deps.intents.attachNonceReservationWith(client, {
      intentId: plan.intentId,
      sessionId: plan.sessionId,
      environment: plan.environment,
      accountIndex: plan.accountIndex,
      apiKeyIndex: plan.apiKeyIndex,
      reservationId: reserved.reservationId,
      nonceValue: reserved.reservedNonce,
    });
    if (intent === null) {
      throw new VexError(
        ErrorCodes.LIGHTER_INVALID_REQUEST,
        `Lighter order execution intent ${plan.intentId} could not attach the nonce reservation.`,
        "Restart from a fresh Lighter order preview and approval preparation.",
      );
    }

    return {
      kind: "lighter_order_nonce_reservation",
      intentId: plan.intentId,
      sessionId: plan.sessionId,
      reservationId: reserved.reservationId,
      nonceValue: reserved.reservedNonce,
      environment: plan.environment,
      accountIndex: plan.accountIndex,
      apiKeyIndex: plan.apiKeyIndex,
    };
  });
}

function assertReservationMatchesPlan(
  plan: LighterOrderReadyForSignerPlan,
  row: lighterNonceStateRepo.LighterNonceStateRow,
): void {
  if (
    row.environment !== plan.nonceScope.environment
    || row.accountIndex !== plan.nonceScope.accountIndex
    || row.apiKeyIndex !== plan.nonceScope.apiKeyIndex
    || row.status !== "reserved"
  ) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Reserved Lighter nonce does not match the prepared order scope.",
      "Refresh Lighter API-key metadata and prepare the order again.",
    );
  }
}

function defaultDeps(): ReserveLighterOrderNonceDeps {
  return {
    transaction: withTransaction,
    nonceState: lighterNonceStateRepo,
    intents: lighterOrderExecutionIntentsRepo,
  };
}
