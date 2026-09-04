/**
 * HOW MAIN STARTS THE FRONT: the seven stdio slots, the minimal environment,
 * and the child handle the supervisor drives.
 *
 * Separated from `front-supervisor.ts` because it has its OWN reason to change.
 * Supervision changes when the protocol or the restart policy does; this
 * changes when packaging does - the slot shape Node produces, what `'overlapped'`
 * means on a given platform, which environment variables the Windows loader
 * needs, where the packaged resources sit. Those two have never wanted to move
 * together, and the seam is also what lets every lifecycle test drive a
 * scripted child instead of a process.
 *
 * ## Why `child_process.spawn`, and not `utilityProcess`
 *
 * The whole protocol lives on stdio slots 3 to 6 (`pipe-front-protocol.md`
 * section 1), and Electron's `utilityProcess.fork` cannot carry extra stdio
 * slots: its `stdio` option covers the first three and its data path is a
 * MessagePort. `spawn` with an explicit seven-entry array is the only way to
 * hand a child four additional inherited pipe handles, which is exactly what
 * the B4.2a spike measured. Its result is recorded in `pipe-front-protocol.md`
 * section 1; the instrument was deleted at stage B4.3b under its own removal
 * condition.
 */

import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { Duplex, Readable } from "node:stream";

import type { FrontPlaneStreams } from "./front-planes.js";

/** The child, as the supervisor needs it. Injected so the tests own the wire. */
export interface FrontChild {
  readonly pid: number | undefined;
  readonly planes: FrontPlaneStreams;
  /** Slot 2. `null` only in a test double that does not model it. */
  readonly stderr: Readable | null;
  onExit(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
  kill(): void;
}

export type FrontSpawn = (command: string) => FrontChild;

/** The seven-slot stdio shape, as one named constant the tests read. */
export const FRONT_STDIO: readonly (
  | "pipe"
  | "ignore"
  | "overlapped"
)[] = [
  // 0: NEVER WRITTEN. Main holds it open and its EOF is the front's
  // parent-death signal (protocol 8). Any byte main wrote here is fail-closed
  // in the front, so main writes none.
  "pipe",
  // 1: the front never writes stdout, which is the whole reason no framed
  // stream lives there: a stray print cannot corrupt a protocol plane.
  "ignore",
  // 2: structural codes and counts.
  "pipe",
  // 3-6: the four framed planes. 'overlapped' is a win32-only mode; on every
  // other platform Node treats it as 'pipe', which is why the same array is
  // used unconditionally.
  "overlapped",
  "overlapped",
  "overlapped",
  "overlapped",
];

/**
 * The ONLY environment variables the front inherits.
 *
 * An ALLOW-LIST, not a filtered copy of main's. Main's environment carries
 * provider credentials, database URLs and whatever the user's shell exported,
 * and none of it is anything a process whose entire job is a named pipe needs.
 * What remains is what WINDOWS itself needs to load a binary: `SystemRoot` and
 * `windir` are read by the loader and by the security APIs the front calls to
 * build its descriptor, and a child started without them fails in ways that
 * look like a corrupt installation.
 */
const FRONT_ENV_ALLOW_LIST: readonly string[] = ["SystemRoot", "windir"];

/**
 * THE PRODUCTION SPAWN.
 *
 * `windowsHide` keeps a console window from appearing behind the app. `cwd` is
 * the binary's own directory, which is the packaged resources directory, so no
 * relative path the child might resolve can reach the user's project.
 */
export function spawnStudioPipeFront(command: string): FrontChild {
  const env: Record<string, string> = {};
  for (const name of FRONT_ENV_ALLOW_LIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const child = spawn(command, [], {
    stdio: [...FRONT_STDIO],
    windowsHide: true,
    env,
    cwd: dirname(command),
  });
  const slot = (index: number): Duplex => {
    const stream = child.stdio[index];
    if (stream === null || stream === undefined) {
      throw new Error(`the front's stdio slot ${String(index)} was not created`);
    }
    // Node types slot 3+ as `Readable | Writable | null` because the shape
    // depends on the request. A 'pipe' or 'overlapped' entry above slot 2 is a
    // DUPLEX socket, which the B4.2a spike measured on Windows and which the
    // null check above is the runtime half of.
    return stream as Duplex;
  };
  return {
    pid: child.pid,
    stderr: child.stderr,
    planes: {
      controlDown: slot(3),
      controlUp: slot(4),
      dataDown: slot(5),
      dataUp: slot(6),
    },
    onExit: (listener) => {
      child.on("exit", (code) => {
        listener(code);
      });
    },
    onError: (listener) => {
      child.on("error", listener);
    },
    kill: () => {
      child.kill();
    },
  };
}
