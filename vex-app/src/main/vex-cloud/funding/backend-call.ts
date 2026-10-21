/**
 * One way for every funding owner to call Vex Cloud with the stored session
 * and to turn the backend's answer into a named refusal with a sentence the
 * user can act on.
 *
 * Every refusal reason of plan 15.2 has its own kind here (`REASON_KINDS`).
 * A 401 removes the stored session first, like the account read does, so the
 * app is never left half signed in. A reason this build does not know is
 * reported by its token, never collapsed into "unexpected error".
 */

import type { Result } from "@shared/ipc/result.js";
import type { VexError } from "@shared/ipc/result.js";
import { formatVexExact } from "@shared/vex-cloud-money.js";
import type { VexCloudCall, VexCloudCallFailure } from "../api-client.js";
import {
  CANCELLED_DETAIL,
  INVALID_RESPONSE_DETAIL,
  refused,
  UNAVAILABLE_DETAIL,
  type VexCloudOutcome,
  type VexCloudRefusalKind,
} from "../outcome.js";

export interface SessionPort {
  readonly readSession: () => Promise<Result<string | null>>;
  readonly clearSession: () => Promise<Result<void>>;
}

export const NOT_SIGNED_IN_DETAIL = "You are not signed in to Vex Cloud. Sign in under Settings, Vex Cloud, then try again.";
const SESSION_EXPIRED_DETAIL = "Your Vex Cloud session expired. Sign in again under Settings, Vex Cloud. Nothing was changed.";

/** The stored bearer, or the refusal that explains why there is none. */
export async function requireBearer(port: SessionPort): Promise<VexCloudOutcome<string>> {
  const stored = await port.readSession();
  if (!stored.ok) return refused("vault", stored.error.message, stored.error as VexError);
  if (stored.data === null) return refused("not_signed_in", NOT_SIGNED_IN_DETAIL);
  return { ok: true, value: stored.data };
}

const REASON_KINDS: Readonly<Record<string, { readonly kind: VexCloudRefusalKind; readonly detail: string }>> = {
  below_minimum: {
    kind: "below_minimum",
    detail: "Vex Cloud refused the amount: it is under the $5 minimum at the current rate. Nothing was moved; enter a larger amount.",
  },
  destination_not_linked: {
    kind: "destination_not_linked",
    detail: "Vex Cloud refused the destination: that wallet is not linked to your account. Nothing was moved; pick a linked wallet.",
  },
  account_paused: {
    kind: "account_paused",
    detail: "Vex Cloud paused this account for review, so funds cannot leave it right now. Nothing was moved.",
  },
  insufficient_withdrawable: {
    kind: "insufficient_withdrawable",
    detail: "That is more than can be withdrawn now. Only finalized deposits can leave; funds reserved for running requests and pending deposits cannot. Nothing was moved.",
  },
  daily_limit_exceeded: {
    kind: "daily_limit_exceeded",
    detail: "That is above your daily withdrawal limit. Nothing was moved; enter a smaller amount or try again tomorrow.",
  },
  idempotency_key_reused: {
    kind: "idempotency_key_reused",
    detail: "Vex Cloud saw this withdrawal request before with different figures, so it refused it. Nothing new was sent; check History, then start a new withdrawal.",
  },
  rate_unavailable: {
    kind: "rate_unavailable",
    detail: "Vex Cloud has no current VEX price right now, so it cannot check the minimum. Nothing was moved; try again in a few minutes.",
  },
  invalid_cursor: {
    kind: "invalid_cursor",
    detail: "That page of history is no longer available. Reload History to start from the newest entries.",
  },
  unsupported_destination: {
    kind: "unsupported_destination",
    detail: "Vex Cloud does not support that cashback destination yet. Nothing was claimed.",
  },
  deposits_unavailable: {
    kind: "deposits_not_open",
    detail: "Deposits are not open yet: this Vex Cloud has no deposit address configured. Nothing was sent.",
  },
  withdrawals_unavailable: {
    kind: "withdrawals_not_open",
    detail: "Withdrawals are not open yet: this Vex Cloud cannot send VEX out right now. Nothing was moved.",
  },
  invalid_limit: {
    kind: "invalid_limit",
    detail: "Vex Cloud refused the page size this version of Vex asked for. Update Vex; nothing was changed.",
  },
  withdrawal_not_found: {
    kind: "withdrawal_not_found",
    detail: "Vex Cloud has no such withdrawal on this account.",
  },
};

/** Reasons that mean THIS app sent something off contract; the field is named. */
const DRIFT_REASONS: ReadonlySet<string> = new Set(["forbidden_field", "invalid_field", "invalid_idempotency_key"]);

const RATE_LIMITED_DETAIL = "Vex Cloud asked Vex to slow down. Nothing was changed; try again in a minute.";

/** The backend's failure as a named refusal. Clears the session on 401. */
export async function backendRefusal<T>(port: SessionPort, failure: VexCloudCallFailure): Promise<VexCloudOutcome<T>> {
  switch (failure.kind) {
    case "cancelled":
      return refused("cancelled", CANCELLED_DETAIL);
    case "invalid_response":
      return refused("invalid_response", INVALID_RESPONSE_DETAIL);
    case "unauthorized": {
      const cleared = await port.clearSession();
      if (!cleared.ok) return refused("vault", cleared.error.message, cleared.error as VexError);
      return refused("not_signed_in", SESSION_EXPIRED_DETAIL);
    }
    case "unavailable": {
      // 503 reasons that are a STATE, not an outage, keep their own kind.
      const known = failure.reason === undefined ? undefined : REASON_KINDS[failure.reason];
      if (known !== undefined) return refused(known.kind, known.detail);
      if (failure.reason === "rate_limited") return refused("unavailable", RATE_LIMITED_DETAIL);
      return refused("unavailable", UNAVAILABLE_DETAIL);
    }
    case "rejected": {
      if (failure.reason !== null && DRIFT_REASONS.has(failure.reason)) {
        return refused(
          "request_rejected",
          `Vex Cloud refused ${failure.field === undefined ? "a field" : `the field "${failure.field}"`} this version of Vex sent (${failure.reason}). Nothing was changed; update Vex.`,
        );
      }
      if (failure.status === 404 && failure.reason === null) {
        return refused("withdrawal_not_found", "Vex Cloud has no such withdrawal on this account.");
      }
      const known = failure.reason === null ? undefined : REASON_KINDS[failure.reason];
      if (known === undefined) {
        return refused(
          "invalid_response",
          `Vex Cloud refused the request (${failure.reason ?? `status ${failure.status}`}). Nothing was changed; update Vex or try again later.`,
        );
      }
      if (known.kind === "daily_limit_exceeded" && failure.remainingWei !== undefined) {
        return refused(
          known.kind,
          `That is above your daily withdrawal limit: you can withdraw up to ${formatVexExact(BigInt(failure.remainingWei))} VEX more today. Nothing was moved.`,
        );
      }
      return refused(known.kind, known.detail);
    }
  }
}

/**
 * Whether a MUTATION's failure PROVES Vex Cloud refused it, so nothing was
 * committed and its idempotency key may be retired.
 *
 * Proof is a refusal the backend names: a 401 (the session check runs before
 * any handler), or a 4xx, 429 or 503 carrying a reason this build knows
 * (every one of them is raised before or instead of the ledger write:
 * `VexVirtualsCompute/src/withdrawals/ledger.ts` `requestWithdrawal`,
 * `src/http/custody-routes.ts`). Everything else does not prove refusal and
 * is an UNKNOWN commit outcome: a body this build cannot read (the write may
 * have committed), a timeout or network error after the send, a 5xx or a
 * throttle without a known reason, an unknown reason, and a cancel that
 * landed while the request was in flight.
 */
export function isDefinitiveRefusal(failure: VexCloudCallFailure): boolean {
  switch (failure.kind) {
    case "unauthorized":
      return true;
    case "rejected":
      if (failure.reason === null) return failure.status === 404;
      return DRIFT_REASONS.has(failure.reason) || REASON_KINDS[failure.reason] !== undefined;
    case "unavailable":
      return failure.reason !== undefined && REASON_KINDS[failure.reason] !== undefined;
    case "invalid_response":
    case "cancelled":
      return false;
  }
}

/** Call with the stored bearer; a failure becomes its named refusal. */
export async function withBearer<T>(
  port: SessionPort,
  run: (bearer: string) => Promise<VexCloudCall<T>>,
): Promise<VexCloudOutcome<T>> {
  const bearer = await requireBearer(port);
  if (!bearer.ok) return bearer;
  const call = await run(bearer.value);
  if (call.ok) return { ok: true, value: call.value };
  return backendRefusal(port, call.failure);
}
