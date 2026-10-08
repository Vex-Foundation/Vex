import { spawn, type SpawnOptions } from "node:child_process";

import type { VexError } from "../../errors.js";
import type { LighterSignerBinaryRunRequest } from "./signer-binary-adapter.js";
import {
  destroyQuietly,
  isRecord,
  KILL_DRAIN_GRACE_MS,
  MAX_STDOUT_BYTES,
  signerChildEnvironment,
  signerProcessFailed,
  signerUnavailable,
  withChildState,
  type LighterSignerChildState,
} from "./signer-child-support.js";

/**
 * THE SWITCH. `false` (the default) keeps today's one-shot runner: every
 * signature spawns a fresh helper that reads one request and exits. `true`
 * routes every adapter that was not handed an explicit runner to ONE resident
 * helper child (`--serve` mode) that answers newline-delimited requests.
 *
 * ON for the owner's live canary: it sits on the order path, so `false` is the rollback.
 */
export const LIGHTER_SIGNER_RESIDENT = true;

/**
 * An idle resident helper is stopped after this long. Bounds how long a
 * process that has held a trading key stays alive with nothing to do, and lets
 * a quiet app hold no helper at all. The next signature respawns it.
 */
export const LIGHTER_SIGNER_RESIDENT_IDLE_MS = 120_000;

/** The helper's serve-mode argument (`src/tools/lighter/signer-runtime/serve.go`). */
export const LIGHTER_SIGNER_SERVE_ARGS: readonly string[] = ["--serve"];

/** The read side of a resident child pipe, declared structurally like the one-shot seam. */
export interface LighterResidentSignerReadable {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "data", listener: (chunk: string) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  destroy(): unknown;
  unref?(): unknown;
}

/** The write side of the resident child's stdin: one line per request. */
export interface LighterResidentSignerWritable {
  write(chunk: string): unknown;
  end(): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  destroy(): unknown;
  unref?(): unknown;
}

export interface LighterResidentSignerChildProcess {
  readonly pid?: number | undefined;
  readonly stdout: LighterResidentSignerReadable | null;
  readonly stderr: Pick<LighterResidentSignerReadable, "on" | "off" | "destroy" | "unref"> | null;
  readonly stdin: LighterResidentSignerWritable | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  off(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
  unref(): void;
}

export type LighterResidentSignerSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => LighterResidentSignerChildProcess;

export interface LighterResidentSignerDependencies {
  readonly spawn: LighterResidentSignerSpawn;
  readonly killDrainGraceMs: number;
  readonly idleMs: number;
}

const REAL_RESIDENT_DEPENDENCIES: LighterResidentSignerDependencies = {
  spawn,
  killDrainGraceMs: KILL_DRAIN_GRACE_MS,
  idleMs: LIGHTER_SIGNER_RESIDENT_IDLE_MS,
};

export interface LighterResidentSignerRunner {
  /** Same contract as `LighterSignerBinaryRunner`. */
  readonly run: (request: LighterSignerBinaryRunRequest) => Promise<unknown>;
  /** Stop the resident child now (app quit). A request in flight fails. */
  readonly shutdown: () => void;
}

/** A late pipe or child `error` with no listener is an unhandled event. */
const ignoreLateError = (): void => {};

interface PendingRequest {
  readonly id: string;
  readonly onLine: (line: string) => void;
  readonly onFailure: (error: VexError) => void;
  readonly onClose: () => void;
  readonly onSpawnFailure: () => void;
}

/**
 * One resident helper process and the listeners this runner owns on it.
 *
 * Listeners are registered once per child, not per request, and removed when
 * the child closes; an abandoned child keeps one no-op `error` listener per
 * handle, exactly like the one-shot runner's abandon path.
 */
class ResidentChild {
  readonly binaryPath: string;
  closed = false;
  retired = false;
  pending: PendingRequest | null = null;

  private readonly child: LighterResidentSignerChildProcess;
  private readonly owned: Array<() => void> = [];
  private stdout = "";
  private stdoutBytes = 0;

  constructor(
    child: LighterResidentSignerChildProcess,
    binaryPath: string,
    private readonly onGone: (resident: ResidentChild) => void,
  ) {
    this.child = child;
    this.binaryPath = binaryPath;

    const stdoutPipe = child.stdout;
    if (stdoutPipe !== null) {
      stdoutPipe.setEncoding("utf8");
      const onData = (chunk: string): void => { this.onStdout(chunk); };
      stdoutPipe.on("data", onData);
      this.owned.push(() => { stdoutPipe.off("data", onData); });
      stdoutPipe.unref?.();
    }
    const stderrPipe = child.stderr;
    if (stderrPipe !== null) {
      // Drained without retaining text; helper errors stay structural.
      const onStderr = (): void => {};
      stderrPipe.on("data", onStderr);
      this.owned.push(() => { stderrPipe.off("data", onStderr); });
      stderrPipe.unref?.();
    }
    const stdinPipe = child.stdin;
    if (stdinPipe !== null) {
      const onStdinError = (): void => {
        this.failPending(signerUnavailable("Lighter signer helper input stream failed."));
        this.retire();
      };
      stdinPipe.on("error", onStdinError);
      this.owned.push(() => { stdinPipe.off("error", onStdinError); });
      stdinPipe.unref?.();
    }
    const onError = (): void => {
      if (child.pid === undefined) {
        // Never created: nothing ran, nothing to drain, nothing could sign.
        this.closed = true;
        this.release();
        this.onGone(this);
        const pending = this.pending;
        this.pending = null;
        pending?.onSpawnFailure();
        return;
      }
      this.failPending(signerUnavailable("Lighter signer helper is not available."));
      this.retire();
    };
    child.on("error", onError);
    this.owned.push(() => { child.off("error", onError); });
    const onClose = (): void => {
      this.closed = true;
      this.release();
      this.onGone(this);
      const pending = this.pending;
      this.pending = null;
      pending?.onClose();
    };
    child.on("close", onClose);
    this.owned.push(() => { child.off("close", onClose); });

    // An idle resident helper never holds the host process open; a request in
    // flight is kept alive by its own (referenced) timeout timer.
    child.unref();
  }

  send(pending: PendingRequest, line: string): void {
    this.pending = pending;
    const stdinPipe = this.child.stdin;
    if (stdinPipe === null) {
      this.failPending(signerUnavailable("Lighter signer helper input stream failed."));
      this.retire();
      return;
    }
    try {
      stdinPipe.write(line);
    } catch {
      this.failPending(signerUnavailable("Lighter signer helper input stream failed."));
      this.retire();
    }
  }

  /** Stop this child: no further request goes to it. Idempotent. */
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    this.onGone(this);
    if (this.closed) return;
    try {
      this.child.stdin?.end();
    } catch {
      // The pipe is already gone; the kill below decides.
    }
    try {
      this.child.kill("SIGKILL");
    } catch {
      // A child that is already gone cannot be killed; `close` decides.
    }
  }

  /** The child survived SIGKILL and this process gives up on it. */
  abandon(): void {
    this.release();
    this.child.on("error", ignoreLateError);
    this.child.stdout?.on("error", ignoreLateError);
    this.child.stderr?.on("error", ignoreLateError);
    this.child.stdin?.on("error", ignoreLateError);
    destroyQuietly(this.child.stdout);
    destroyQuietly(this.child.stderr);
    destroyQuietly(this.child.stdin);
    this.child.unref();
  }

  private release(): void {
    for (const undo of this.owned.splice(0)) undo();
  }

  private failPending(error: VexError): void {
    this.pending?.onFailure(error);
  }

  /** Fail the request in flight with `error`, then stop this child. */
  stop(error: VexError): void {
    this.failPending(error);
    this.retire();
  }

  private onStdout(chunk: string): void {
    if (this.retired) return;
    const incoming = Buffer.byteLength(chunk);
    if (this.stdoutBytes + incoming > MAX_STDOUT_BYTES) {
      // Checked BEFORE retaining the chunk, as the one-shot runner does.
      this.stdout = "";
      this.stdoutBytes = 0;
      this.stop(signerUnavailable("Lighter signer helper returned too much output."));
      return;
    }
    this.stdoutBytes += incoming;
    this.stdout += chunk;
    for (;;) {
      const newline = this.stdout.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdout.slice(0, newline);
      this.stdout = this.stdout.slice(newline + 1);
      this.stdoutBytes = Buffer.byteLength(this.stdout);
      const pending = this.pending;
      if (pending === null) {
        // Output nobody asked for: the helper is not following the protocol.
        this.retire();
        return;
      }
      pending.onLine(line);
      if (this.retired) return;
    }
  }
}

/**
 * Build a resident runner over the given dependencies.
 *
 * The per-request contract is the one-shot runner's (`runLighterSignerBinary`),
 * restated for a child that outlives the request:
 *
 *   - requests are SERIALIZED: one is written, the next waits until it has
 *     settled; the per-request timeout starts when the request is written;
 *   - a RESOLVED request means the helper answered that request id with
 *     `ok: true`: a serial helper does no work it was not asked for, so the
 *     answer is proof that nothing for this request is still running
 *     (`"exited"` by the same standard as a closed one-shot child);
 *   - an `ok: false` answer rejects with the one-shot error shape
 *     (`signerProcessFailed`) and `"exited"`; the child stays for the next
 *     request, except after a `panic` answer, when the helper exits by design
 *     and this request settles only after that exit is observed;
 *   - timeout, malformed output (not JSON, not an object, wrong id), stdout
 *     overflow, a stdin failure, a spawn failure and an unexpected exit each
 *     reject with the one-shot message for that failure. The child is killed
 *     and the request settles only after its `close` (`"exited"`) or after
 *     `killDrainGraceMs` (`"unknown"`, child abandoned); the next request
 *     spawns a fresh child;
 *   - a request is NEVER retried: whatever happened to it is its answer;
 *   - the request line (it carries the private key) is written and dropped:
 *     nothing here keeps it, logs it or attaches it to an error;
 *   - a change of binary path (an adapter with a different helper) stops the
 *     current child and starts one for the new path; the path itself is
 *     resolved by the adapter under the unchanged override rules.
 */
export function createLighterResidentSignerRunner(
  dependencies: LighterResidentSignerDependencies = REAL_RESIDENT_DEPENDENCIES,
): LighterResidentSignerRunner {
  let current: ResidentChild | null = null;
  let tail: Promise<void> = Promise.resolve();
  let nextRequestId = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const clearIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const forget = (resident: ResidentChild): void => {
    if (current === resident) current = null;
  };

  const armIdle = (): void => {
    clearIdle();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      const resident = current;
      if (resident !== null && resident.pending === null) resident.retire();
    }, dependencies.idleMs);
    idleTimer.unref?.();
  };

  const acquire = (binaryPath: string): ResidentChild => {
    if (current !== null && (current.binaryPath !== binaryPath || current.retired || current.closed)) {
      current.retire();
      current = null;
    }
    if (current !== null) return current;
    const child = dependencies.spawn(binaryPath, LIGHTER_SIGNER_SERVE_ARGS, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: signerChildEnvironment(process.platform),
    });
    const resident = new ResidentChild(child, binaryPath, forget);
    current = resident;
    return resident;
  };

  const runOne = (request: LighterSignerBinaryRunRequest): Promise<unknown> => {
    clearIdle();
    const resident = acquire(request.binaryPath);
    nextRequestId += 1;
    const id = String(nextRequestId);

    return new Promise((resolve, reject) => {
      let settled = false;
      let failure: VexError | null = null;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (): void => {
        settled = true;
        clearTimeout(timer);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        if (resident.pending === pendingRequest) resident.pending = null;
      };

      const settleExited = (): void => {
        if (settled) return;
        finish();
        reject(withChildState(
          failure ?? signerUnavailable("Lighter signer helper returned invalid output."),
          "exited",
        ));
      };

      const settleUnknown = (): void => {
        if (settled) return;
        finish();
        resident.abandon();
        reject(withChildState(
          failure ?? signerUnavailable("Lighter signer helper did not exit."),
          "unknown",
        ));
      };

      /** Record the first failure, kill the child, and wait for its `close`. */
      const abort = (error: VexError): void => {
        if (settled || failure !== null) return;
        failure = error;
        clearTimeout(timer);
        resident.retire();
        if (resident.closed) {
          settleExited();
          return;
        }
        graceTimer = setTimeout(settleUnknown, dependencies.killDrainGraceMs);
        graceTimer.unref?.();
      };

      const onLine = (line: string): void => {
        if (settled || failure !== null) return;
        let document: unknown;
        try {
          document = JSON.parse(line) as unknown;
        } catch {
          abort(signerUnavailable("Lighter signer helper returned invalid output."));
          return;
        }
        if (!isRecord(document) || document.id !== id) {
          abort(signerUnavailable("Lighter signer helper returned invalid output."));
          return;
        }
        const { id: _answeredId, ...answer } = document;
        if (answer.ok === true) {
          finish();
          armIdle();
          resolve(answer);
          return;
        }
        if (answer.errorCode === "panic") {
          // The helper exits after a panic by design; settle on that exit.
          abort(signerProcessFailed(answer));
          return;
        }
        finish();
        armIdle();
        reject(withChildState(signerProcessFailed(answer), "exited"));
      };

      const pendingRequest: PendingRequest = {
        id,
        onLine,
        onFailure: abort,
        onClose: () => {
          // The child is gone. A failure already recorded wins; otherwise the
          // helper ended without answering, which one-shot reports the same way.
          settleExited();
        },
        onSpawnFailure: () => {
          failure ??= signerUnavailable("Lighter signer helper is not available.");
          settleExited();
        },
      };

      const timer = setTimeout(() => {
        abort(signerUnavailable("Lighter signer helper timed out."));
      }, request.timeoutMs);

      if (resident.closed) {
        pendingRequest.onSpawnFailure();
        return;
      }
      resident.send(
        pendingRequest,
        `${JSON.stringify({ id, request: request.payload })}\n`,
      );
    });
  };

  return {
    run: (request) => {
      const result = tail.then(() => runOne(request));
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    shutdown: () => {
      clearIdle();
      const resident = current;
      current = null;
      resident?.stop(signerUnavailable("Lighter signer helper stopped because Vex is quitting."));
    },
  };
}

let sharedResidentRunner: LighterResidentSignerRunner | null = null;

/** The process-wide resident runner, created on first use. */
export function runLighterSignerResident(request: LighterSignerBinaryRunRequest): Promise<unknown> {
  sharedResidentRunner ??= createLighterResidentSignerRunner();
  return sharedResidentRunner.run(request);
}

/**
 * Stop the process-wide resident helper, if one is running. Called on app
 * quit. Also safe when the switch is off or no helper was ever started. A
 * helper that outlives a crashed host still ends: its stdin closes and serve
 * mode exits at end of input.
 */
export function shutdownLighterResidentSigner(): void {
  sharedResidentRunner?.shutdown();
}

export type { LighterSignerChildState };
