/**
 * A SCRIPTED PTY: the deterministic stand-in for node-pty.
 *
 * It is a fake in the strict sense - it implements the real `PtyAdapter`
 * contract and exposes the controls a test needs (emit, exit, and the
 * pause/resume state the flow-control accounting is supposed to drive). Nothing
 * downstream of it is mocked: the flow-control counters, the exit sequencing,
 * the resize discipline and the authoritative mirror under test are the real
 * ones, which is the only way those tests can catch a regression in them.
 *
 * A real shell cannot do this job. Proving that the pty PAUSES above the high
 * watermark means observing a call that a real pty answers by not draining a
 * pipe, and proving trailing output is captured means emitting after `exit` at
 * a chosen moment.
 */

import type { TerminalPortEvent } from "@shared/schemas/terminal.js";
import type { HostPort } from "../host-service.js";
import type { LaunchProbe, PtyAdapter, PtySpawner } from "../types.js";

export class ScriptedPty implements PtyAdapter {
  readonly pid = 4242;
  process = "bash";
  paused = false;
  killed = false;
  killSignal: string | undefined;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];

  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.push(listener);
    return {
      dispose: () => {
        this.dataListeners = this.dataListeners.filter((item) => item !== listener);
      },
    };
  }

  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): { dispose(): void } {
    this.exitListeners.push(listener);
    return {
      dispose: () => {
        this.exitListeners = this.exitListeners.filter((item) => item !== listener);
      },
    };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  /**
   * Signal the process, AND REPORT ITS EXIT, because that is what a pty does.
   *
   * This fake used to record the signal and stop, which made it unfaithful in
   * the one way that mattered: a real node-pty answers a kill by firing
   * `onExit` once the process is reaped, and the host now WAITS for that event
   * before announcing an exit - a signal delivered is not a process reaped, and
   * main releases a terminal's capacity and its project lease on the answer.
   * A fake that never exits turns that correct wait into a timeout, so tests
   * would have measured the backstop instead of the behaviour.
   *
   * Fired on a MICROTASK, not synchronously: node-pty delivers exit on a later
   * turn, and answering on the caller's own stack would re-enter the exit
   * sequencing from inside the kill that triggered it.
   *
   * `ignoresKill` models the process that does not die on request - the case
   * the force-kill backstop exists for.
   */
  ignoresKill = false;

  kill(signal?: string): void {
    this.killed = true;
    this.killSignal = signal;
    if (this.ignoresKill || this.exitReported) return;
    this.exitReported = true;
    queueMicrotask(() => {
      this.exit(0, 9);
    });
  }

  private exitReported = false;

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /* Test controls */

  emit(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data);
  }

  exit(exitCode: number, signal?: number): void {
    for (const listener of [...this.exitListeners]) {
      listener(signal === undefined ? { exitCode } : { exitCode, signal });
    }
  }
}

/** A spawner that hands back one scripted pty and records what it was asked for. */
export function scriptedSpawner(pty: ScriptedPty): {
  spawn: PtySpawner;
  calls: Array<{ executable: string; args: readonly string[]; cwd: string; env: Record<string, string> }>;
} {
  const calls: Array<{
    executable: string;
    args: readonly string[];
    cwd: string;
    env: Record<string, string>;
  }> = [];
  return {
    calls,
    spawn: (executable, args, options) => {
      calls.push({ executable, args, cwd: options.cwd, env: options.env });
      return pty;
    },
  };
}

/**
 * A spawner that mints a FRESH scripted pty per spawn, and records each launch.
 *
 * `scriptedSpawner` hands the SAME object to every spawn, which is adequate for
 * a suite asserting about one terminal and wrong for anything about several:
 * two terminals sharing one pty share its `killed` flag and its data listeners,
 * so "every pty was killed" and "this terminal's output" both become
 * unfalsifiable. A revive restores a whole workspace and a shutdown must
 * account for every process it owns, so those need one object per process.
 */
export function scriptedSpawnerPool(): {
  spawn: PtySpawner;
  ptys: ScriptedPty[];
  calls: Array<{ executable: string; args: readonly string[]; cwd: string }>;
} {
  const ptys: ScriptedPty[] = [];
  const calls: Array<{ executable: string; args: readonly string[]; cwd: string }> = [];
  return {
    ptys,
    calls,
    spawn: (executable, args, options) => {
      calls.push({ executable, args, cwd: options.cwd });
      const pty = new ScriptedPty();
      ptys.push(pty);
      return pty;
    },
  };
}

/**
 * A launch probe over an in-memory filesystem description.
 *
 * A table seam rather than real files: "exists but is not a directory" and
 * "resolves on PATH but is not a regular file" are awkward to create on a real
 * disk and impossible to create identically on three platforms, and those are
 * exactly the rows the validation table has to cover.
 */
export function fakeProbe(options: {
  directories?: readonly string[];
  files?: readonly string[];
  executables?: Readonly<Record<string, string>>;
  cwdByPid?: Readonly<Record<number, string>>;
}): LaunchProbe {
  const directories = new Set(options.directories ?? []);
  const files = new Set(options.files ?? []);
  const executables = options.executables ?? {};
  const cwdByPid = options.cwdByPid ?? {};
  return {
    stat: (target) =>
      Promise.resolve(
        directories.has(target)
          ? { isDirectory: true, isFile: false, isSymbolicLink: false }
          : files.has(target)
            ? { isDirectory: false, isFile: true, isSymbolicLink: false }
            : null,
      ),
    findExecutable: (command) => Promise.resolve(executables[command] ?? null),
    readCwd: (pid) => Promise.resolve(cwdByPid[pid] ?? null),
  };
}

/**
 * A `HostPort` that records what the host sent and can inject what a window
 * sends.
 *
 * It lives here, beside the scripted pty, because BOTH host suites need it: the
 * scripted one and the real-pty one. Two copies of a recording double drift -
 * one grows a helper the other lacks, and the two suites quietly stop asserting
 * the same shape of the data plane.
 */
export class RecordingPort implements HostPort {
  readonly sent: TerminalPortEvent[] = [];
  closed = false;
  private listener: ((value: unknown) => void) | null = null;

  postMessage(value: unknown): void {
    this.sent.push(value as TerminalPortEvent);
  }

  onMessage(listener: (value: unknown) => void): void {
    this.listener = listener;
  }

  close(): void {
    this.closed = true;
  }

  receive(value: unknown): void {
    this.listener?.(value);
  }

  eventsOfKind<K extends TerminalPortEvent["kind"]>(
    kind: K,
  ): Array<Extract<TerminalPortEvent, { kind: K }>> {
    return this.sent.filter((event) => event.kind === kind) as Array<
      Extract<TerminalPortEvent, { kind: K }>
    >;
  }
}
