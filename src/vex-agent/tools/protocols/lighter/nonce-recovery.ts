import type { LighterEnvironment } from "@tools/lighter/types.js";
import * as nonces from "@vex-agent/db/repos/lighter-nonce-state.js";
import * as orders from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import * as oco from "@vex-agent/db/repos/lighter-oco-execution-intents.js";
import * as lifecycle from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import { repairLighterOrderIntent } from "./order-repair.js";
import { repairLighterOcoIntent } from "./oco-order-repair.js";
import { repairLighterOrderLifecycleIntent } from "./order-lifecycle-repair.js";

export interface LighterNonceRecoveryDeps {
  readonly nonces: Pick<typeof nonces, "listBlockedForAccount">;
  readonly orders: Pick<typeof orders, "findByIntentIdAnySession">;
  readonly oco: Pick<typeof oco, "findByIntentIdAnySession">;
  readonly lifecycle: Pick<typeof lifecycle, "findByIntentIdAnySession">;
  readonly repairOrder: (intent: orders.LighterOrderExecutionIntentRow) => Promise<object>;
  readonly repairOco: (intent: oco.LighterOcoExecutionIntentRow) => Promise<object>;
  readonly repairLifecycle: (intent: lifecycle.LighterOrderLifecycleIntentRow) => Promise<object>;
}

const DEFAULT_DEPS: LighterNonceRecoveryDeps = {
  nonces, orders, oco, lifecycle,
  repairOrder: repairLighterOrderIntent,
  repairOco: repairLighterOcoIntent,
  repairLifecycle: repairLighterOrderLifecycleIntent,
};

interface ReservationOwner {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonceReservationId: string | null;
  readonly nonceValue: string | null;
}

function ownsReservation(owner: ReservationOwner, reservation: nonces.LighterNonceStateRow): boolean {
  return owner.environment === reservation.environment
    && owner.accountIndex === reservation.accountIndex
    && owner.apiKeyIndex === reservation.apiKeyIndex
    && owner.nonceReservationId === reservation.reservationId
    && owner.nonceValue === reservation.reservedNonce;
}

/** Target the actual account/key owner, never an unrelated oldest-first page. */
export async function checkLighterNonceRecovery(
  input: { readonly environment: LighterEnvironment; readonly accountIndex: number },
  deps: LighterNonceRecoveryDeps = DEFAULT_DEPS,
) {
  const reservations = await deps.nonces.listBlockedForAccount(input.environment, input.accountIndex);
  const reports: Array<Record<string, unknown>> = [];
  let unavailable = false;
  for (const reservation of reservations) {
    if (reservation.environment !== input.environment || reservation.accountIndex !== input.accountIndex) {
      throw new Error("Lighter recovery reservation scope mismatch.");
    }
    const reservationId = reservation.reservationId;
    let handled = false;
    try {
      if (reservationId?.startsWith("lighter-order:")) {
        const owner = await deps.orders.findByIntentIdAnySession(reservationId.slice("lighter-order:".length));
        if (owner !== null && ownsReservation(owner, reservation)) {
          reports.push({ kind: "create_order", ...await deps.repairOrder(owner) });
          handled = true;
        }
      } else if (reservationId?.startsWith("lighter-oco:")) {
        const owner = await deps.oco.findByIntentIdAnySession(reservationId.slice("lighter-oco:".length));
        if (owner !== null && ownsReservation(owner, reservation)) {
          reports.push({ ...await deps.repairOco(owner) });
          handled = true;
        }
      } else if (reservationId?.startsWith("lighter-lifecycle:")) {
        const owner = await deps.lifecycle.findByIntentIdAnySession(reservationId.slice("lighter-lifecycle:".length));
        if (owner !== null && ownsReservation(owner, reservation)) {
          reports.push({ kind: "lifecycle_action", ...await deps.repairLifecycle(owner) });
          handled = true;
        }
      }
      if (!handled) {
        reports.push({
          kind: "unresolved_reservation_owner",
          apiKeyIndex: reservation.apiKeyIndex,
          reservationId,
          resolution: "degraded",
          guidance: "The pending action is not a matching local order. Preserve the reservation; do not reset it or retry the trade.",
        });
      }
    } catch {
      unavailable = true;
      reports.push({
        kind: "recovery_unavailable", apiKeyIndex: reservation.apiKeyIndex,
        resolution: "degraded",
        guidance: "The pending action could not be checked. Keep it blocked and try checking again later.",
      });
    }
  }
  // A report describes one observed owner. Another request may have reserved
  // the key while it was being checked, so only a fresh read can report clear.
  const remaining = await deps.nonces.listBlockedForAccount(input.environment, input.accountIndex);
  const status = remaining.length === 0 ? "ready" as const : unavailable ? "unavailable" as const : "blocked" as const;
  return {
    source: "vex_lighter_nonce_recovery" as const,
    environment: input.environment,
    accountIndex: input.accountIndex,
    status,
    checkedReservations: reservations.length,
    remainingReservations: remaining.length,
    reports,
    message: status === "ready"
      ? "No pending transaction is blocking this account. Review current orders and positions before placing a fresh trade."
      : status === "unavailable"
        ? "Vex could not confirm the pending action. Try checking again when Lighter is reachable; do not repeat the trade yet."
        : "A previous action still holds this account's trading reservation. Its outcome is not confirmed; do not repeat the trade yet.",
  };
}
