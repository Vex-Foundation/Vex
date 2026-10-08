/**
 * Public input + outcome types for the atomic lease/status helpers.
 *
 * Extracted from the old monolithic `lease-and-status.ts` so each
 * helper module can import only the types it needs. The barrel
 * (`./index.ts`) re-exports these so callers keep importing from
 * `@vex-agent/engine/runtime/lease-and-status.js` unchanged.
 */

import type { MissionRunStatus } from "../../types.js";
import type {
  LeaseProcessKind,
  RunnerLease,
  RunnerLeaseInfo,
} from "../../../db/repos/runner-leases.js";
import type {
  ControlRequest,
  ControlRequestKind,
} from "../../../db/repos/runtime-control-requests.js";

// ── claimRunLeaseAndFlipToRunning ───────────────────────────────────

export interface ClaimRunInput {
  readonly sessionId: string;
  readonly missionRunId: string;
  readonly fromStatuses: readonly MissionRunStatus[];
  readonly ownerId: string;
  readonly processKind: LeaseProcessKind;
  readonly ttlMs: number;
  /**
   * The token of a claim this caller ALREADY holds, presented to refresh it.
   * Omit for a new claim (every production caller today). A live lease held
   * under any other token - including the same owner id - is `lease_busy`.
   */
  readonly claimToken?: string;
  /**
   * The pending wake row that CAUSED this resume, already locked by the caller.
   * When the run is flipped from `paused_wake`, that row is marked `consumed`
   * in this commit instead of being swept up by the `consumed_by_resume`
   * cancellation; every other pending wake for the session is still cancelled.
   * Only the wake executor's atomic claim passes it.
   */
  readonly consumeWakeId?: string;
}

export type ClaimRunOutcome =
  | {
    readonly outcome: "claimed";
    readonly previousStatus: MissionRunStatus;
    readonly lease: RunnerLease;
    readonly wakeCancelledCount: number;
  }
  | {
    readonly outcome: "lease_busy";
    readonly currentLease: RunnerLeaseInfo;
  }
  | {
    readonly outcome: "status_mismatch";
    readonly currentStatus: MissionRunStatus | null;
  };

// ── claimSessionLease ───────────────────────────────────────────────

export interface ClaimSessionLeaseInput {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly processKind: LeaseProcessKind;
  readonly ttlMs: number;
  /**
   * The token of a claim this caller ALREADY holds, presented to refresh it.
   * Omit for a new claim (every production caller today). A live lease held
   * under any other token - including the same owner id - is `lease_busy`.
   */
  readonly claimToken?: string;
}

export type ClaimSessionLeaseOutcome =
  | { readonly outcome: "claimed"; readonly lease: RunnerLease }
  | { readonly outcome: "lease_busy"; readonly currentLease: RunnerLeaseInfo };

// ── observeAndApplyControl ──────────────────────────────────────────

export interface ObserveControlInput {
  readonly sessionId: string;
  /**
   * The run this checkpoint belongs to — the run-scoping anchor. A control
   * request that names a different run (or names none) is cleared as stale
   * instead of being applied here. `null` only for a session with no run,
   * where every request resolves to the "no active run" no-op.
   */
  readonly missionRunId: string | null;
  readonly kinds: readonly ControlRequestKind[];
}

export type ObserveControlOutcome =
  | { readonly outcome: "no_request" }
  /**
   * A pending request was found but was minted for a DIFFERENT run. It has
   * been cleared and NOT applied; the caller continues as if none existed.
   */
  | { readonly outcome: "stale_cleared"; readonly request: ControlRequest }
  | {
    readonly outcome: "paused_user_applied";
    readonly request: ControlRequest;
    readonly previousStatus: MissionRunStatus;
    readonly wakeCancelledCount: number;
  }
  | {
    readonly outcome: "stop_applied";
    readonly request: ControlRequest;
    readonly previousStatus: MissionRunStatus;
    readonly terminalStatus: "stopped" | "cancelled";
    readonly wakeCancelledCount: number;
  };
