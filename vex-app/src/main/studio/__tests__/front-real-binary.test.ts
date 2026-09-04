/**
 * THE REAL FRONT, THE REAL PIPE, THE REAL BYTES. Windows only.
 *
 * Everything else in this stage runs against a scripted fake, which proves that
 * main's half of the protocol is correct against the bytes the specification
 * names. It cannot prove the things only Windows can answer, and rule 10 is
 * explicit that those are exactly the things that ship broken behind a green
 * suite:
 *
 *   - that four `'overlapped'` stdio slots actually materialise as duplex
 *     handles a Go child can take over;
 *   - that the front's security descriptor READBACK confirms `rejectRemote`,
 *     `firstInstance` and `messageMode` on a real pipe, rather than reporting
 *     what it asked for;
 *   - that a real client can connect to that pipe and receive main's refusal
 *     line, byte for byte, relayed by a process that composed none of it;
 *   - that `LOCK_ACK` comes back inside its 1000 ms deadline under real I/O.
 *
 * `describe.skipIf` rather than a silent early return: a skipped suite is
 * visible in the reporter and names its reason. On CI the vex-app-windows job
 * builds the binary before `pnpm test`, so the build step's own failure fails
 * the job before a skip could hide anything.
 */

import { existsSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { locateStudioPipeFront } from "../installer/bridge-path.js";
import {
  FRONT_LOCK_ACK_DEADLINE_MS,
  FRONT_MAX_RAW,
} from "../mcp-host/front-handshake.js";
import { FrontSupervisor } from "../mcp-host/front-supervisor.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
);

/**
 * The DEV layout the resolver produces, which is where `bridge/build.sh` puts
 * the artifact. Asked of the resolver rather than rebuilt here, so this suite
 * fails when the resolver's layout drifts instead of quietly testing a path
 * production never uses.
 */
async function frontBinary(): Promise<string | null> {
  const location = await locateStudioPipeFront({
    packaged: false,
    repoRoot: REPO_ROOT,
  });
  return location.kind === "found" ? location.command : null;
}

const command = process.platform === "win32" ? await frontBinary() : null;
const reason =
  process.platform !== "win32"
    ? `the pipe front is a Windows component and this runner is ${process.platform}`
    : command === null
      ? "the built pipe front is missing; run `bash bridge/build.sh windows amd64`"
      : null;

/**
 * Wait for a CONDITION, bounded by a real deadline, and report whether it held.
 *
 * The only wall clock in this suite, and it is bounding a real Windows I/O
 * round trip rather than standing in for one: the assertion is what became
 * true, and the bound is the deadline the production code itself applies.
 */
async function pollUntil(
  condition: () => boolean,
  withinMs: number,
): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
}

/** A pipe name unique to this run, so parallel suites cannot collide. */
function testPipeName(): string {
  return `\\\\.\\pipe\\vex-studio-test-${String(process.pid)}-${String(Date.now())}`;
}

const REFUSAL_LINE =
  '{"ok":false,"code":"malformed","message":"No Vex Studio handshake arrived."}\n';

let supervisor: FrontSupervisor | null = null;

afterEach(() => {
  supervisor?.dispose();
  supervisor = null;
});

describe.skipIf(reason !== null)("the packaged pipe front on Windows", () => {
  it("brings the pipe up with every required flag CONFIRMED", async () => {
    const pipeName = testPipeName();
    supervisor = new FrontSupervisor({
      pipeName,
      command: command ?? "",
      admissionEpoch: () => 3,
      timeoutRefusalBytes: REFUSAL_LINE,
      refuseBeforeRead: () => null,
      onConnection: () => undefined,
      onTransition: () => undefined,
    });

    // Reaching `serving` at all is the whole readback assertion: `BOUND` is
    // emitted only after runtime readback, and main refuses to serve unless
    // rejectRemote, firstInstance and messageMode all came back confirmed.
    await expect(supervisor.start()).resolves.toEqual({ started: true });
    expect(supervisor.currentState()).toBe("serving");
    expect(supervisor.failure()).toBeNull();
  }, 30_000);

  it("relays MAIN's refusal line to a real client, byte for byte", async () => {
    const pipeName = testPipeName();
    // Refuse before a byte is read, which is what a locked Vex does. The front
    // writes these exact bytes and closes WITHOUT EVER READING; it composed
    // none of them.
    supervisor = new FrontSupervisor({
      pipeName,
      command: command ?? "",
      admissionEpoch: () => 3,
      timeoutRefusalBytes: REFUSAL_LINE,
      refuseBeforeRead: () => REFUSAL_LINE,
      onConnection: () => undefined,
      onTransition: () => undefined,
    });
    await supervisor.start();

    const received = await new Promise<string>((resolve, reject) => {
      const socket = connect(pipeName);
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
      socket.on("error", reject);
    });

    expect(received).toBe(REFUSAL_LINE);
  }, 30_000);

  it("answers LOCK inside its deadline, and reports what it closed", async () => {
    const pipeName = testPipeName();
    supervisor = new FrontSupervisor({
      pipeName,
      command: command ?? "",
      admissionEpoch: () => 3,
      timeoutRefusalBytes: REFUSAL_LINE,
      refuseBeforeRead: () => null,
      onConnection: () => undefined,
      onTransition: () => undefined,
    });
    await supervisor.start();

    const front = supervisor;
    front.lock();
    // WAIT ON THE EFFECT, not on the clock: the acknowledgement returns the
    // supervisor to `serving`, and it must do so before main's own deadline
    // would have killed the child. A fixed sleep would have measured the sleep.
    const settled = await pollUntil(
      () => front.currentState() !== "locking" || front.failure() !== null,
      FRONT_LOCK_ACK_DEADLINE_MS,
    );
    expect({
      settled,
      state: front.currentState(),
      failure: front.failure(),
      restarts: front.restartsUsed(),
    }).toEqual({ settled: true, state: "serving", failure: null, restarts: 0 });
  }, 30_000);

  it("agrees with the front about the raw handle bound", () => {
    // The front refuses to serve on ANY difference in the six frozen numbers
    // (protocol 5.1), so a `serving` state in the first case already proves
    // agreement. This states the number the agreement is about, so a change on
    // either side reads as a deliberate protocol change here too.
    expect(FRONT_MAX_RAW).toBe(21);
  });
});

describe("the Windows real-front precondition", () => {
  it("names why it is skipped, when it is", () => {
    // A skip that says nothing is a suite nobody notices has stopped running.
    if (reason === null) {
      expect(existsSync(command ?? "")).toBe(true);
      return;
    }
    expect(reason.length).toBeGreaterThan(20);
  });
});
