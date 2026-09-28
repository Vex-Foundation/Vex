/**
 * Typed fakes for the runner lease guard (S-1 lease fencing).
 *
 * `fakeLeaseHandle` is a structurally complete `LeaseHandle` whose lost signal
 * is a real `AbortSignal`, so a runner under test threads it exactly as it
 * threads the production handle. `passThroughLeaseFence` is a module body for
 * `vi.mock("@vex-agent/db/lease-fence.js", ...)` that answers "held" for every
 * fence check and runs the fenced write on a stub client, for runner tests
 * that mock the repos below the fence and only care about what is written.
 */

import type { PoolClient } from "pg";
import { vi } from "vitest";
import type { RunnerLease } from "../../vex-agent/db/repos/runner-leases.js";
import type { LeaseHandle } from "../../vex-agent/engine/runtime/lease-handle.js";
import type { LeaseLostReason } from "../../vex-agent/engine/runtime/lease-guard.js";
import type {
  LeaseFence,
  LeaseFenceOutcome,
  LeaseFenceSite,
  LeaseFenceState,
} from "../../vex-agent/db/lease-fence.js";
import { testPoolClient } from "./pool-client.js";

export interface FakeLeaseHandleInput {
  readonly ownerId: string;
  readonly sessionId?: string;
  readonly claimToken?: string;
}

export function fakeLeaseHandle(input: FakeLeaseHandleInput): LeaseHandle {
  const sessionId = input.sessionId ?? "session-fake";
  const claimToken = input.claimToken ?? `token-${input.ownerId}`;
  const now = new Date();
  const lease: RunnerLease = {
    sessionId,
    missionRunId: null,
    ownerId: input.ownerId,
    processKind: "test",
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: new Date(now.getTime() + 300_000),
    claimToken,
  };
  const controller = new AbortController();
  let reason: LeaseLostReason | null = null;
  return {
    lease,
    ownerId: input.ownerId,
    claimToken,
    fence: { sessionId, claimToken },
    lostSignal: controller.signal,
    lostReason: () => reason,
    markLost: (next: LeaseLostReason) => {
      if (reason !== null) return;
      reason = next;
      controller.abort();
    },
    release: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

export const passThroughLeaseFence = {
  readLeaseFenceWith: async (): Promise<LeaseFenceState> => "held",
  readLeaseFenceState: async (): Promise<LeaseFenceState> => "held",
  logFencedWriteRefused: (): void => {},
  fenceRunWriteWith: async (): Promise<boolean> => true,
  withLeaseFence: async <T>(
    _fence: LeaseFence,
    fn: (client: PoolClient) => Promise<T>,
    _opts: { readonly site: LeaseFenceSite; readonly lockMissionRunId?: string },
  ): Promise<LeaseFenceOutcome<T>> => ({
    fenced: true,
    state: "held",
    value: await fn(testPoolClient({})),
  }),
};
