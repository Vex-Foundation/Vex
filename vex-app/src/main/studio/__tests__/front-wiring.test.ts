/**
 * THE WINDOWS BRANCH IS WIRED, AND THE GATE IS THE ONLY THING REFUSING IT.
 *
 * Two claims that are easy to confuse and must be proved apart:
 *
 *   1. THE GATE IS OPEN (`WINDOWS_TRANSPORT_PROVEN`), so nothing below runs
 *      behind an injected seam: the branch these cases drive is the one a
 *      Windows user gets.
 *   2. THAT PATH brings a front up, publishes the endpoint only after `BOUND`,
 *      hands every admitted connection to the registry as the wire contract,
 *      and takes the child down on quit.
 *
 * The platform is injected for the same reason `planStudioEndpoint` already
 * takes it: a publication path provable only on Windows is a publication path
 * whose wiring rests on a CI job.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StudioDuplexTransport } from "@vex-agent/mcp/duplex-transport.js";
import type { StudioListenerDeps } from "../mcp-host/listener.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
}));

const {
  closeStudioListener,
  resetStudioListenerForTests,
  startStudioListener,
  studioListenerCause,
  studioListenerEndpoint,
  studioListenerPhase,
} = await import("../mcp-host/listener.js");
const { WINDOWS_TRANSPORT_PROVEN } = await import("../mcp-host/endpoint.js");
const {
  closeStudioAdmission,
  openStudioAdmission,
  resetStudioAdmissionForTests,
  setStudioAdmissionEpochForTests,
  studioAdmissionEpoch,
  studioAdmissionPermanentlyClosed,
  STUDIO_ADMISSION_EPOCH_MAX,
} = await import("../mcp-host/admission.js");
const {
  beginStudioReadinessEpoch,
  markStudioRuntimeReady,
  resetStudioReadinessForTests,
} = await import("../readiness.js");
const { FakeFront } = await import("./fake-front.js");

let fronts: InstanceType<typeof FakeFront>[];
let admitted: StudioDuplexTransport[];

function deps(over: Partial<StudioListenerDeps> = {}): StudioListenerDeps {
  return {
    onConnection: (wire) => admitted.push(wire),
    onTransition: () => undefined,
    precondition: () => null,
    platform: "win32",
    front: {
      locate: () =>
        Promise.resolve({
          kind: "found" as const,
          command: "C:\\Vex\\resources\\bridge\\vex-pipe-front.exe",
        }),
      spawnFront: () => {
        const front = new FakeFront({ generation: 0x9000 + fronts.length });
        fronts.push(front);
        return front;
      },
    },
    ...over,
  };
}

/** Answer the bootstrap as soon as the front exists, then let the bind settle. */
async function completeBringUp(): Promise<void> {
  for (let attempt = 0; attempt < 20 && fronts.length === 0; attempt += 1) {
    await Promise.resolve();
  }
  fronts[fronts.length - 1]?.completeHandshake();
}

beforeEach(() => {
  fronts = [];
  admitted = [];
  resetStudioListenerForTests();
  resetStudioAdmissionForTests();
  // ADMISSION IS TWO QUESTIONS, and the front asks the composed one: the vault
  // must be unlocked AND the settlement barrier open before a connection is
  // admitted rather than refused before a byte is read.
  markStudioRuntimeReady(beginStudioReadinessEpoch());
  openStudioAdmission();
});

afterEach(() => {
  resetStudioListenerForTests();
  resetStudioAdmissionForTests();
  resetStudioReadinessForTests();
});

describe("the gate", () => {
  it("is OPEN, so every case below runs on the SHIPPED default", () => {
    // This describe held two cases: that the constant was still false, and that
    // a false gate refused the plan with `windows_transport_disabled` while
    // spawning nothing. Both went with the flip - that cause has no producer
    // any more, and the injected `windowsTransportProven` seam that drove them
    // is gone from `StudioListenerDeps`. What is left is the claim that matters
    // now: the front cases below reach a front through production's own default
    // rather than through a seam that faked the gate open (contract 1.6,
    // measured on runs 33646484002, 33650332655 and 33663385959).
    expect(WINDOWS_TRANSPORT_PROVEN).toBe(true);
  });
});

describe("the win32 branch runs end to end", () => {
  it("publishes only after BOUND, and then reports the pipe as the endpoint", async () => {
    const started = startStudioListener(deps());
    await completeBringUp();
    const outcome = await started;

    expect(outcome).toMatchObject({ started: true });
    const endpoint = studioListenerEndpoint();
    expect({
      phase: studioListenerPhase(),
      // The pipe MAIN derived, from the same hash input as the unix socket.
      derived: endpoint !== null && endpoint.startsWith("\\\\.\\pipe\\vex-studio-"),
    }).toEqual({ phase: "listening", derived: true });
  });

  it("hands the front the name MAIN derived, and the front never derives one", async () => {
    const started = startStudioListener(deps());
    await completeBringUp();
    await started;
    expect(fronts[0]?.hello()?.pipeName).toBe(studioListenerEndpoint());
  });

  it("delivers an admitted connection to the registry as the WIRE contract", async () => {
    const started = startStudioListener(deps());
    await completeBringUp();
    await started;

    fronts[0]?.sendOpen(1);
    expect(admitted).toHaveLength(1);
    // The registry receives the same shape it receives from a socket: it cannot
    // tell the two apart, which is the whole promise of the seam.
    const wire = admitted[0];
    expect({
      destroyed: wire?.destroyed,
      writableEnded: wire?.writableEnded,
      readableEnded: wire?.readableEnded,
    }).toEqual({ destroyed: false, writableEnded: false, readableEnded: false });
  });

  it("REFUSES before a byte is read while the settlement barrier is still closed", async () => {
    const started = startStudioListener(deps());
    await completeBringUp();
    await started;

    // A host that cannot serve answers before it reads. On this transport that
    // is a `REFUSE` frame carrying main's exact ack line, and no connection
    // object, no handshake-pending slot and no read ever exist.
    resetStudioReadinessForTests();
    fronts[0]?.sendOpen(1);
    expect(admitted).toHaveLength(0);
    const refusals = fronts[0]?.controlOfType("REFUSE") ?? [];
    expect(refusals).toHaveLength(1);
    const line: unknown = JSON.parse(refusals[0]?.bytes ?? "{}");
    expect(line).toMatchObject({ ok: false, code: "locked" });
  });

  it("refuses with the resolver's own cause when the binary is not installed", async () => {
    const outcome = await startStudioListener(
      deps({
        front: {
          locate: () =>
            Promise.resolve({
              kind: "unavailable" as const,
              detail: "the pipe front is missing from this installation",
            }),
        },
      }),
    );
    expect(outcome.started).toBe(false);
    expect(studioListenerCause()).toBe("front_unavailable");
  });

  it("FAILS CLOSED when Windows will not confirm the pipe's protection", async () => {
    const started = startStudioListener(deps());
    for (let attempt = 0; attempt < 20 && fronts.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    // firstInstance and messageMode confirmed, rejectRemote NOT. The listener
    // is never published: a wallet transport whose cross-user access cannot be
    // demonstrated is not opened (rule 90).
    fronts[0]?.completeHandshake({ flagsApplied: 0x06 });
    const outcome = await started;

    expect(outcome.started).toBe(false);
    expect(studioListenerCause()).toBe("pipe_security_unconfirmed");
    expect(studioListenerPhase()).toBe("stopped");
  });

  it("takes the child down on quit", async () => {
    const listenerDeps = deps();
    const started = startStudioListener(listenerDeps);
    await completeBringUp();
    await started;

    await closeStudioListener(Promise.resolve(), listenerDeps, 2_500);
    // The QUIT carries what REMAINS of main's one absolute budget, and the
    // child is killed rather than left holding a pipe nobody owns.
    expect(fronts[0]?.controlOfType("QUIT").map((frame) => frame.deadlineMs)).toEqual([
      2_500,
    ]);
    expect(fronts[0]?.killed).toBe(1);
    expect(studioListenerEndpoint()).toBeNull();
  });
});

describe("the admission epoch boundary", () => {
  it("does not wrap or reset, and a restarted front is handed the SAME epoch", async () => {
    const started = startStudioListener(deps());
    await completeBringUp();
    await started;
    const first = studioAdmissionEpoch();
    expect(fronts[0]?.hello()?.initialAdmissionEpoch).toBe(first);

    // A lock raises it once. A FRONT restart raises nothing: killing the child
    // does not invalidate the stale continuations living in main, which are
    // exactly what the fence exists to stop (protocol 5.2).
    closeStudioAdmission();
    expect(studioAdmissionEpoch()).toBe(first + 1);
    fronts[0]?.exit(1);
    // The replacement waits for the corpse: the pipe name belongs to the
    // process, not to `kill()`.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(fronts).toHaveLength(2);
    expect(fronts[1]?.hello()?.initialAdmissionEpoch).toBe(first + 1);
  });

  it("CLOSES ADMISSION PERMANENTLY at the u32 ceiling instead of wrapping", () => {
    setStudioAdmissionEpochForTests(STUDIO_ADMISSION_EPOCH_MAX);
    openStudioAdmission();
    expect(studioAdmissionPermanentlyClosed()).toBe(false);

    closeStudioAdmission();

    // A wrap would silently reissue an epoch a purged ADMIT still names, and
    // that order would execute. The remedy is an APPLICATION restart: opening
    // is refused for the life of the process, and a front restart is never
    // offered as a remedy because the new front gets the same spent value.
    expect({
      epoch: studioAdmissionEpoch(),
      closed: studioAdmissionPermanentlyClosed(),
    }).toEqual({ epoch: STUDIO_ADMISSION_EPOCH_MAX, closed: true });

    openStudioAdmission();
    expect(studioAdmissionPermanentlyClosed()).toBe(true);
  });
});
