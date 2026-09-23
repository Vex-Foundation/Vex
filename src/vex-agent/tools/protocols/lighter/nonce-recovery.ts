import type { LighterEnvironment } from "@tools/lighter/types.js";
import * as nonces from "@vex-agent/db/repos/lighter-nonce-state.js";
import * as orders from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import * as oco from "@vex-agent/db/repos/lighter-oco-execution-intents.js";
import * as lifecycle from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import { repairLighterOrderIntent } from "./order-repair.js";
import { repairLighterOcoIntent } from "./oco-order-repair.js";
import { repairLighterOrderLifecycleIntent } from "./order-lifecycle-repair.js";
import {
  getConfiguredLighterForeignNonceOwner,
  type LighterForeignNonceOwnerKind,
  type LighterForeignNonceOwnerReconciler,
} from "./foreign-nonce-owners.js";

export interface LighterNonceRecoveryDeps {
  readonly nonces: Pick<typeof nonces, "listBlockedForAccount">;
  readonly orders: Pick<typeof orders, "findByIntentIdAnySession">;
  readonly oco: Pick<typeof oco, "findByIntentIdAnySession">;
  readonly lifecycle: Pick<typeof lifecycle, "findByIntentIdAnySession">;
  readonly repairOrder: (intent: orders.LighterOrderExecutionIntentRow) => Promise<object>;
  readonly repairOco: (intent: oco.LighterOcoExecutionIntentRow) => Promise<object>;
  readonly repairLifecycle: (intent: lifecycle.LighterOrderLifecycleIntentRow) => Promise<object>;
  /** Main-process owners (leverage, fees); `null` when that service is not installed. */
  readonly foreignOwner: (kind: LighterForeignNonceOwnerKind) => LighterForeignNonceOwnerReconciler | null;
}

const DEFAULT_DEPS: LighterNonceRecoveryDeps = {
  nonces, orders, oco, lifecycle,
  repairOrder: repairLighterOrderIntent,
  repairOco: repairLighterOcoIntent,
  repairLifecycle: repairLighterOrderLifecycleIntent,
  foreignOwner: getConfiguredLighterForeignNonceOwner,
};

const FOREIGN_OWNER_PREFIXES: ReadonlyArray<readonly [string, LighterForeignNonceOwnerKind]> = [
  ["lighter-leverage:", "leverage"],
  ["lighter-fees:", "fees"],
];

/** Guidance for a reservation this recovery could not resolve, by owner kind. */
function unresolvedOwnerGuidance(reservationId: string | null): string {
  if (reservationId?.startsWith("lighter-leverage:")) {
    return "A leverage change holds this reservation. Vex releases it automatically once its signed transaction expires unused; "
      + "the user can also press Reconcile on that market's leverage row in Settings > Lighter. Do not retry the trade yet.";
  }
  if (reservationId?.startsWith("lighter-fees:")) {
    return "A fee authorization holds this reservation. Vex releases it automatically once its signed transaction expires unused. Do not retry the trade yet.";
  }
  if (reservationId?.startsWith("lighter-withdrawal:")) {
    return "A withdrawal holds this reservation. The withdrawal repair resolves it from Lighter evidence; check it with lighter.withdraw.status. Do not retry the trade yet.";
  }
  return "The pending action is not a matching local order. Preserve the reservation; do not reset it or retry the trade.";
}

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
      } else {
        const kind = FOREIGN_OWNER_PREFIXES.find(([prefix]) => reservationId?.startsWith(prefix))?.[1];
        const reconcile = kind === undefined ? null : deps.foreignOwner(kind);
        if (reconcile !== null) {
          const report = await reconcile(reservation);
          if (report !== null) {
            reports.push(report);
            handled = true;
          }
        }
      }
      if (!handled) {
        reports.push({
          kind: "unresolved_reservation_owner",
          apiKeyIndex: reservation.apiKeyIndex,
          reservationId,
          resolution: "degraded",
          guidance: unresolvedOwnerGuidance(reservationId),
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

export interface LighterForeignNonceOwnerSweepDeps {
  readonly nonces: Pick<typeof nonces, "listBlockedWithReservationPrefixes" | "find">;
  readonly foreignOwner: LighterNonceRecoveryDeps["foreignOwner"];
}

const DEFAULT_SWEEP_DEPS: LighterForeignNonceOwnerSweepDeps = {
  nonces,
  foreignOwner: getConfiguredLighterForeignNonceOwner,
};

/** Reservations examined per background run; one install rarely holds more than one. */
export const LIGHTER_FOREIGN_NONCE_OWNER_SWEEP_LIMIT = 5;

/**
 * Background release for reservations held by a leverage change or a fee
 * authorization. Orders, OCOs and lifecycle actions have their own sweeps;
 * nothing ran these, so one interrupted leverage change locked the account's
 * trading until the person found the Settings Reconcile button.
 *
 * Each owner's reconciler is expiry-gated and evidence-only, and never derives
 * account auth, signs, submits or retries. A reservation is counted as advanced
 * only when a fresh read shows it is no longer held.
 */
export async function recoverLighterForeignNonceOwnersInBackground(
  deps: LighterForeignNonceOwnerSweepDeps = DEFAULT_SWEEP_DEPS,
): Promise<{ examined: number; advanced: number; awaiting: number; degraded: number; errors: number }> {
  const rows = await deps.nonces.listBlockedWithReservationPrefixes(
    FOREIGN_OWNER_PREFIXES.map(([prefix]) => prefix),
    LIGHTER_FOREIGN_NONCE_OWNER_SWEEP_LIMIT,
  );
  let advanced = 0;
  let awaiting = 0;
  let degraded = 0;
  let errors = 0;
  for (const row of rows) {
    const kind = FOREIGN_OWNER_PREFIXES.find(([prefix]) => row.reservationId?.startsWith(prefix))?.[1];
    const reconcile = kind === undefined ? null : deps.foreignOwner(kind);
    if (reconcile === null) {
      degraded += 1;
      continue;
    }
    try {
      const report = await reconcile(row);
      if (report === null) {
        degraded += 1;
        continue;
      }
      const after = await deps.nonces.find(row.environment, row.accountIndex, row.apiKeyIndex);
      if (after === null || after.status === "observed" || after.reservationId !== row.reservationId) advanced += 1;
      else awaiting += 1;
    } catch {
      errors += 1;
    }
  }
  return { examined: rows.length, advanced, awaiting, degraded, errors };
}
