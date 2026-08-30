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
  readonly pid: number;
  readonly process: string;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): PtyDisposable;
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
