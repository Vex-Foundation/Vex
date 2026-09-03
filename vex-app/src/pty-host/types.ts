/**
 * Runtime-free vocabulary for the pty host, plus the two SEAMS that make it
 * testable without spawning real shells.
 *
 * The seams are narrow on purpose. `PtyAdapter` is exactly the slice of
 * node-pty's `IPty` this host uses, and `PtySpawner` is the one call that
 * produces one. A test supplies a scripted spawner and drives pause/resume,
 * trailing output and exit ordering deterministically; production supplies
 * node-pty. Nothing else in the host is mocked, so the flow-control accounting,
 * the exit sequencing and the mirror under test are the real ones.
 *
 * This file holds no runtime code beyond type declarations so it can be
 * imported from anywhere in the host without dragging node-pty in.
 */

/** An environment with every value present. `undefined` is not a value here. */
export type IProcessEnvironment = Record<string, string>;

export interface PtyDisposable {
  dispose(): void;
}

/**
 * The slice of node-pty's `IPty` this host depends on.
 *
 * `pause`/`resume` are the flow-control primitives - they stop the OS pipe from
 * being drained, which is what makes the producer feel backpressure rather than
 * letting it fill a queue in this process.
 */
export interface PtyAdapter {
  /**
   * The shell's process id, READ LIVE - never snapshotted by an implementer.
   *
   * On Windows this is `0` until ConPTY has connected. node-pty >= 1.2.0-beta.11
   * defers `conptyNative.connect()` onto the conout worker's ready callback
   * (`windowsPtyAgent.js:39` initialises `_innerPid = 0`, `:134` assigns the real
   * one inside `_completePtyConnection`), and `windowsTerminal.js:62` copies that
   * zero into the terminal at construction, refreshing it only in the
   * `ready_datapipe` handler (`:67-69`). A caller that reads this once, at spawn,
   * therefore holds `0` for the rest of the session on Windows - see
   * `terminal-process.ts`, which defers every pid-dependent step to the first
   * data event exactly as VS Code's `TerminalProcess` does
   * (microsoft/node-pty#885).
   *
   * `0` means NOT YET KNOWN. It is never a process that can be signalled or
   * probed.
   */
  readonly pid: number;
  readonly process: string;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): PtyDisposable;
  /**
   * The pty's data socket FAILED, with an error node-pty does not treat as
   * ordinary.
   *
   * This seam exists because node-pty's own socket error handler RETHROWS: it
   * ignores `EAGAIN` and `EIO`/`errno 5`, and then, for anything else, throws
   * the error unless the socket already carries a second `error` listener
   * (`windowsTerminal.js:90-104`, `unixTerminal.js:101-127`). node-pty registers
   * no such listener of its own (`terminal.js:90-94` forwards only `data` and
   * `exit`), so without this seam a conout failure becomes an UNCAUGHT EXCEPTION
   * in the pty host - which takes down every terminal in every project, not just
   * the one whose socket broke.
   *
   * The IMPLEMENTER registers that second listener at spawn, before any consumer
   * subscribes, because a listener attached later is a race against the very
   * error it exists to survive. Only the errors node-pty would have rethrown are
   * forwarded; the ones it classifies as ordinary lifecycle are not, because the
   * exit event already carries them.
   */
  onError(listener: (error: Error) => void): PtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

export interface PtySpawnOptions {
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  readonly env: IProcessEnvironment;
}

export type PtySpawner = (
  executable: string,
  args: readonly string[],
  options: PtySpawnOptions,
) => PtyAdapter;

/**
 * The filesystem facts spawn validation needs.
 *
 * A seam rather than direct `fs` use so the validation TABLE test can enumerate
 * missing directories, files-that-are-not-directories and unresolvable
 * executables without creating any of them on a real disk, where the "not a
 * directory" case is awkward and the permission cases are not reproducible in
 * CI at all.
 */
export interface LaunchProbe {
  /** `null` when the path does not exist. */
  stat(target: string): Promise<{ isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean } | null>;
  /** Resolve an executable to an ABSOLUTE path, or `null` when not found. */
  findExecutable(command: string, cwd: string, env: IProcessEnvironment): Promise<string | null>;
  /** The process's current working directory, by pid. `null` when unknowable. */
  readCwd(pid: number): Promise<string | null>;
}
