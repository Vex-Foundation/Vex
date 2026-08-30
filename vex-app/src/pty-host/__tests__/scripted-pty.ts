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

  kill(signal?: string): void {
    this.killed = true;
    this.killSignal = signal;
  }

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
