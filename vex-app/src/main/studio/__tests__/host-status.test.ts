/**
 * The Vex Studio host-status contract (stage B0).
 *
 * Three things are proved here, and they are different kinds of claim:
 *
 *   1. THE WIRE ENUM AND THE READINESS BARRIER AGREE. A table test, because
 *      shared code cannot import from main and the two lists are therefore
 *      reconciled rather than shared. Rule 10's "wire names come from machine
 *      artifacts, never convention" applies to an internal contract for the
 *      same reason it applies to a provider's: a hand-spelled member that
 *      happens to be correct today is still a defect.
 *   2. THE PAYLOAD CANNOT CARRY AN ENDPOINT. The security property of this
 *      whole surface, asserted against `.strict()` rather than assumed.
 *   3. THE CACHE COALESCES AND THE TRANSITIONS ARRIVE. Behavior, through the
 *      module's public functions.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  STUDIO_MAX_CONNECTIONS_WIRE,
  studioHostStatusSchema,
  studioHostUnavailableCauseSchema,
  type StudioHostStatus,
} from "@shared/schemas/studio.js";
import { STUDIO_UNREADY_CODES } from "../readiness.js";
import { STUDIO_MAX_CONNECTIONS } from "../mcp-host.js";
import {
  getStudioHostStatus,
  onStudioHostStatus,
  publishStudioHostStatus,
  resetStudioHostStatusForTests,
} from "../host-status.js";

function status(over: Partial<StudioHostStatus> = {}): StudioHostStatus {
  return {
    state: "running",
    cause: null,
    connectionCount: 0,
    maxConnections: 16,
    atCapacity: false,
    ...over,
  } as StudioHostStatus;
}

beforeEach(() => {
  resetStudioHostStatusForTests();
});

describe("the wire contract is reconciled with its owners", () => {
  it.each(STUDIO_UNREADY_CODES)(
    "represents the readiness barrier's %s code on the wire",
    (code) => {
      expect(studioHostUnavailableCauseSchema.options).toContain(code);
    },
  );

  it("mirrors the host's established-connection bound", () => {
    // The renderer renders "n of 16" from the payload rather than from a
    // constant of its own, so the two must not drift.
    expect(STUDIO_MAX_CONNECTIONS_WIRE).toBe(STUDIO_MAX_CONNECTIONS);
  });

  it("keeps the host's own refusal causes distinct from the barrier's", () => {
    // Not every unavailable cause comes from readiness: the host can refuse
    // before it ever consults the barrier. Pinned so that folding these into
    // the barrier's list is a deliberate edit, not an accident.
    expect(studioHostUnavailableCauseSchema.options).toContain("not_configured");
    expect(studioHostUnavailableCauseSchema.options).toContain(
      "endpoint_unavailable",
    );
  });
});

describe("the payload's redaction contract", () => {
  it("REJECTS an endpoint field", () => {
    // The whole reason this surface publishes codes and counts instead of the
    // host's own state object. A unix socket path or pipe name is the address
    // of a privileged local listener.
    const parsed = studioHostStatusSchema.safeParse({
      ...status(),
      endpoint: "/run/user/1000/vex-studio-abc.sock",
    });
    expect(parsed.success).toBe(false);
  });

  it("REJECTS a prose cause", () => {
    // Deliberately off-contract input, so it is built as `unknown` rather than
    // through the typed helper: the point is what the SCHEMA does with a value
    // the type system would have refused.
    const parsed = studioHostStatusSchema.safeParse({
      ...status(),
      state: "unavailable",
      cause: "Vex Studio is still starting, so this action was not queued.",
    });
    expect(parsed.success).toBe(false);
  });

  it("requires a cause exactly when the state is unavailable", () => {
    expect(
      studioHostStatusSchema.safeParse(status({ state: "unavailable", cause: null }))
        .success,
    ).toBe(false);
    expect(
      studioHostStatusSchema.safeParse(status({ state: "running", cause: "starting" }))
        .success,
    ).toBe(false);
    expect(
      studioHostStatusSchema.safeParse(
        status({ state: "unavailable", cause: "endpoint_unavailable" }),
      ).success,
    ).toBe(true);
  });
});

describe("the cache", () => {
  it("starts as unavailable/starting rather than null", () => {
    // A renderer mounting during boot gets a renderable answer, not a null it
    // would have to special-case into a fourth visual state.
    expect(getStudioHostStatus()).toEqual({
      state: "unavailable",
      cause: "starting",
      connectionCount: 0,
      maxConnections: 16,
      atCapacity: false,
    });
  });

  it("publishes a transition to every subscriber and caches it", () => {
    const seen: StudioHostStatus[] = [];
    onStudioHostStatus((next) => seen.push(next));

    publishStudioHostStatus(status({ state: "running" }));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.state).toBe("running");
    // The pull channel and the push event read the same value, so they cannot
    // disagree.
    expect(getStudioHostStatus().state).toBe("running");
  });

  it("COALESCES an identical consecutive payload", () => {
    const listener = vi.fn();
    onStudioHostStatus(listener);

    publishStudioHostStatus(status({ connectionCount: 3 }));
    publishStudioHostStatus(status({ connectionCount: 3 }));
    publishStudioHostStatus(status({ connectionCount: 3 }));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce across a changed field", () => {
    const listener = vi.fn();
    onStudioHostStatus(listener);

    publishStudioHostStatus(status({ connectionCount: 1 }));
    publishStudioHostStatus(status({ connectionCount: 2 }));

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("returns an idempotent unsubscribe", () => {
    const listener = vi.fn();
    const off = onStudioHostStatus(listener);
    off();
    off();

    publishStudioHostStatus(status({ state: "locked" }));

    expect(listener).not.toHaveBeenCalled();
  });

  it("contains a throwing listener so the host's teardown still completes", () => {
    // `publishStudioHostStatus` runs inside the synchronous lock teardown,
    // between destroying sockets and advancing the dispatch fence. A listener
    // that throws there must not abort that sequence.
    const healthy = vi.fn();
    onStudioHostStatus(() => {
      throw new Error("listener blew up");
    });
    onStudioHostStatus(healthy);

    expect(() => {
      publishStudioHostStatus(status({ state: "locked" }));
    }).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});
