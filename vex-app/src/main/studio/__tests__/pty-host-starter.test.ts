/**
 * THE RESTART CAP AND THE HEARTBEAT LADDER.
 *
 * Both are bounds on a failure, so both are invisible until the failure
 * happens - and both fail in the direction of "the app looks fine and nothing
 * works". The cap in particular has one property that is easy to get wrong and
 * impossible to notice: it MUST NOT RESET on a successful start. A counter that
 * resets turns a host crashing every thirty seconds into an infinite restart
 * loop, which is precisely what the cap exists to stop.
 *
 * The `fork` seam is what makes this deterministic. Everything else - the
 * counter, the state machine, the timers, the message routing - is the real
 * implementation.
 */

import { EventEmitter } from "node:events";
import type { UtilityProcess } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/vex-userdata",
    getAppPath: () => "/tmp/vex-app",
  },
  utilityProcess: { fork: () => { throw new Error("not used: fork is injected"); } },
  MessageChannelMain: class {
    port1 = { close: () => {} };
    port2 = { close: () => {} };
  },
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
}));

const {
  TERMINAL_HOST_BEAT_INTERVAL_MS,
  TERMINAL_HOST_CONNECTING_BEAT_INTERVAL_MS,
  TERMINAL_HOST_FIRST_WAIT_MULTIPLIER,
  TERMINAL_HOST_MAX_RESTARTS,
} = await import("@shared/schemas/terminal.js");
const { PtyHostStarter } = await import("../pty-host-starter.js");
type PtyHostAvailability = Awaited<
  ReturnType<() => InstanceType<typeof PtyHostStarter>["availability"]>
>;

/**
 * A fake utility process. It IMPLEMENTS `UtilityProcess`, so the compiler - not
 * a cast - is what says the starter is being handed something the real fork
 * seam could have returned. `pid`, `stdout` and `stderr` are the members the
 * starter never touches; they are present because the contract has them, and
 * their absence would be exactly the gap an assertion used to hide.
 */
class FakeChild extends EventEmitter implements UtilityProcess {
  readonly posted: unknown[] = [];
  killed = false;
  readonly pid = 4242;
  readonly stdout = null;
  readonly stderr = null;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

let forked: FakeChild[];
let availability: PtyHostAvailability[];
/** How many times the starter reported an UNEXPECTED host termination. */
let terminations: number;

function build(): InstanceType<typeof PtyHostStarter> {
  return new PtyHostStarter(
    {
      onTerminalExit: () => {},
      onNotice: () => {},
      onAvailabilityChanged: (value) => availability.push(value),
      onHostTerminated: () => (terminations += 1),
    },
    () => {
      const child = new FakeChild();
      forked.push(child);
      return child;
    },
  );
}

beforeEach(() => {
  forked = [];
  availability = [];
  terminations = 0;
});

describe("restart cap", () => {
  it("permits SIX restarts (seven process starts) and then reports a durable unavailable state", () => {
    const starter = build();
    expect(starter.ensureStarted()).toBe(true);
    expect(forked).toHaveLength(1);

    // The comparison is `<=` against a maximum of 5 from a counter starting at
    // 0, so the restart branch is taken for counts 0..5 - SIX restarts. Crash
    // it seven times: the seventh finds the counter spent.
    for (let crash = 0; crash < TERMINAL_HOST_MAX_RESTARTS + 2; crash += 1) {
      forked[forked.length - 1]?.emit("exit", 1);
    }

    // One initial start plus six restarts is SEVEN forked processes. This is
    // VS Code's exact arithmetic, reproduced rather than rounded, because the
    // number that matters is not six or seven - it is that the counter never
    // resets, which the next test pins.
    expect(forked).toHaveLength(TERMINAL_HOST_MAX_RESTARTS + 2);
    expect(starter.availability.state).toBe("unavailable");
    expect(starter.availability.restartCount).toBe(TERMINAL_HOST_MAX_RESTARTS + 1);
    // Past the cap, a request is refused rather than starting another host.
    expect(starter.ensureStarted()).toBe(false);
    expect(forked).toHaveLength(TERMINAL_HOST_MAX_RESTARTS + 2);
  });

  it("NEVER resets the counter on a successful start", () => {
    const starter = build();
    starter.ensureStarted();

    // Crash, restart, run happily for a while (a heartbeat), crash again.
    forked[0]?.emit("exit", 1);
    expect(starter.availability.restartCount).toBe(1);
    forked[1]?.emit("message", { kind: "heartbeat" });
    forked[1]?.emit("exit", 1);

    // A reset here would make a host that crashes every thirty seconds restart
    // forever, which is the exact failure the cap exists to bound.
    expect(starter.availability.restartCount).toBe(2);
  });

  it("does NOT restart after a requested quit", async () => {
    const starter = build();
    starter.ensureStarted();
    const child = forked[0];

    const disposal = starter.dispose();
    // `dispose` awaits the shutdownAll reply; answer it as the host would.
    const envelope = child?.posted[0] as { requestId: string } | undefined;
    child?.emit("message", {
      kind: "reply",
      requestId: envelope?.requestId ?? "",
      outcome: { ok: true, value: null },
    });
    await disposal;
    child?.emit("exit", 0);

    expect(forked).toHaveLength(1);
    expect(starter.availability.state).toBe("stopped");
    expect(child?.killed).toBe(true);
  });

  it("answers every in-flight request host_unavailable when the process dies", async () => {
    const starter = build();
    const pending = starter.send({ kind: "shutdownAll" });
    forked[0]?.emit("exit", 1);

    // Without this, a create issued a millisecond before a crash would hang
    // forever on a reply that can no longer arrive.
    await expect(pending).resolves.toEqual({ ok: false, code: "host_unavailable" });
  });

  /**
   * F1 RECONCILIATION: an unexpected termination is REPORTED, and a quit is not.
   *
   * Main's terminal records outlive the process that made them true, and a
   * restarted host comes up EMPTY - it would answer `unknown_terminal` for
   * every id main still believes in. So the loss is announced, once per death,
   * BEFORE the restart decision.
   *
   * The negative half matters as much: reporting a clean shutdown as a loss
   * would make every quit look like a crash and have the renderer marking tabs
   * dead on the way out of the app.
   */
  it("reports an UNEXPECTED termination once per death, and never a requested quit", async () => {
    const starter = build();
    starter.ensureStarted();

    forked[0]?.emit("exit", 1);
    expect(terminations).toBe(1);
    forked[1]?.emit("exit", 1);
    expect(terminations).toBe(2);

    // Now quit deliberately. The exit that follows is expected, not a loss.
    const child = forked[forked.length - 1];
    const disposal = starter.dispose();
    const envelope = child?.posted[0] as { requestId: string } | undefined;
    child?.emit("message", {
      kind: "reply",
      requestId: envelope?.requestId ?? "",
      outcome: { ok: true, value: null },
    });
    await disposal;
    child?.emit("exit", 0);

    expect(terminations).toBe(2);
  });
});

describe("heartbeat ladder", () => {
  it("uses the LONG connecting window first, then warns, then declares unresponsive", async () => {
    vi.useFakeTimers();
    try {
      const starter = build();
      starter.ensureStarted();
      expect(starter.availability.responsive).toBe(true);

      // The connecting window is deliberately long: a cold start on a slow
      // machine legitimately takes seconds, and warning about that teaches
      // users to ignore the warning.
      await vi.advanceTimersByTimeAsync(TERMINAL_HOST_CONNECTING_BEAT_INTERVAL_MS - 10);
      expect(starter.availability.responsive).toBe(true);

      // First stage: warn only. Still responsive - a laptop waking from sleep
      // misses beats for reasons that have nothing to do with the host.
      await vi.advanceTimersByTimeAsync(20);
      expect(starter.availability.responsive).toBe(true);

      // Second stage: now it is real.
      await vi.advanceTimersByTimeAsync(TERMINAL_HOST_BEAT_INTERVAL_MS + 10);
      expect(starter.availability.responsive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers to responsive on the next beat, and rearms the SHORT window", async () => {
    vi.useFakeTimers();
    try {
      const starter = build();
      starter.ensureStarted();
      await vi.advanceTimersByTimeAsync(
        TERMINAL_HOST_CONNECTING_BEAT_INTERVAL_MS + TERMINAL_HOST_BEAT_INTERVAL_MS + 20,
      );
      expect(starter.availability.responsive).toBe(false);

      forked[0]?.emit("message", { kind: "heartbeat" });
      expect(starter.availability.responsive).toBe(true);

      // After the first beat the window is the SHORT one, so a second silence
      // is detected in seconds rather than in another twenty.
      await vi.advanceTimersByTimeAsync(
        TERMINAL_HOST_BEAT_INTERVAL_MS * TERMINAL_HOST_FIRST_WAIT_MULTIPLIER
          + TERMINAL_HOST_BEAT_INTERVAL_MS
          + 20,
      );
      expect(starter.availability.responsive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("message routing", () => {
  it("DROPS an off-contract message from the host instead of trusting it", () => {
    const starter = build();
    starter.ensureStarted();
    let exits = 0;
    const observed = new PtyHostStarter(
      {
        onTerminalExit: () => (exits += 1),
        onNotice: () => {},
        onAvailabilityChanged: () => {},
        onHostTerminated: () => {},
      },
      () => {
        const child = new FakeChild();
        forked.push(child);
        return child;
      },
    );
    observed.ensureStarted();

    forked[forked.length - 1]?.emit("message", {
      kind: "terminalExit",
      terminalId: "t1",
      // exitCode missing: the schema rejects it, so it never becomes a lease
      // release for a terminal that may still be running.
      signal: null,
    });

    expect(exits).toBe(0);
  });

  it("routes a well-formed terminalExit to the observer", () => {
    let seen: { terminalId: string; exitCode: number } | null = null;
    const starter = new PtyHostStarter(
      {
        onTerminalExit: (terminalId, exitCode) => (seen = { terminalId, exitCode }),
        onNotice: () => {},
        onAvailabilityChanged: () => {},
        onHostTerminated: () => {},
      },
      () => {
        const child = new FakeChild();
        forked.push(child);
        return child;
      },
    );
    starter.ensureStarted();

    forked[0]?.emit("message", {
      kind: "terminalExit",
      terminalId: "t1",
      exitCode: 0,
      signal: null,
    });

    expect(seen).toEqual({ terminalId: "t1", exitCode: 0 });
  });
});
