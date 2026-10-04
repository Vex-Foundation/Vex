import { scrypt, type ScryptOptions } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Worker, type WorkerOptions } from "node:worker_threads";

/** Calling-thread KDF numbers since the last {@link takeScryptKdfStats}. */
const kdfStats = { derives: 0, offMainDerives: 0, callerBlockedMs: 0 };
/** Test override installed by {@link configureScryptAsyncDeps}. */
let depsOverride: Partial<ScryptAsyncDeps> | null = null;
/** The resident worker, created on the first derive that needs it. */
let host: KdfWorkerHost | null = null;
let consecutiveWorkerFailures = 0;

/**
 * Promise form of `crypto.scrypt`, shared by the wallet keystore and the
 * secret vault KDFs.
 *
 * The derive runs on the libuv threadpool, so an N=2^17 derive (~128 MiB,
 * ~400ms) no longer blocks the calling thread. In the desktop app that thread
 * is the Electron main process, which also hosts the agent engine and every
 * IPC handler, so a synchronous derive froze the whole app for its duration.
 *
 * Same inputs, same options (N/r/p/maxmem) and the same output bytes as
 * `scryptSync`. Parameter validation errors that `scryptSync` would throw are
 * thrown synchronously by `scrypt` inside the executor and so surface as a
 * rejection; runtime KDF errors arrive through the callback and reject too.
 * Callers await it inside the same try/catch that wrapped the sync call.
 *
 * ## Electron: the parameter check is itself a full derive (FLC-6)
 *
 * Measured in the Electron 42 main process: every `crypto.scrypt` call at
 * N=2^17 still froze the calling thread for about 230 to 270 ms, at the very
 * start of the call, even though the derive itself then ran on the threadpool.
 * Plain Node showed no freeze at all. Node checks the parameters by calling
 * the library's scrypt with no output buffer; OpenSSL treats that as "validate
 * only", while Electron's BoringSSL runs the whole KDF. So in the app every
 * vault open and every keystore decrypt cost one full derive ON THE MAIN
 * THREAD plus one on the threadpool. That is the periodic stall K-5 saw: the
 * Lighter position snapshot opens the vault three times per account every
 * five minutes, and a desk order opens it dozens of times.
 *
 * With {@link SCRYPT_KDF_OFF_MAIN_THREAD} on, and only in a runtime where the
 * call blocks its caller this way (Electron), the call is made from one
 * resident worker thread instead. Same `crypto.scrypt`, same arguments, same
 * bytes back; the freeze lands on the worker. Anything the worker cannot do
 * (it would not start, it died, it answered without a key, the request could
 * not be cloned) falls back to today's call on the calling thread, which then
 * resolves or rejects exactly as it always did. Off, or in plain Node, the
 * worker is never created and the call is exactly today's.
 */
export function scryptAsync(
  password: string,
  salt: Uint8Array,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  kdfStats.derives += 1;
  const deps = currentDeps();
  if (!deps.offMainThread || !deps.callerThreadRunsFullKdf || workerDisabled()) {
    return deriveOnCallingThread(password, salt, keylen, options);
  }
  return deriveOnWorker(deps, password, salt, keylen, options).then((key) =>
    key ?? deriveOnCallingThread(password, salt, keylen, options),
  );
}

/**
 * FLC-6 switch. `true`: in Electron, start each derive from a worker thread so
 * the main thread never runs the KDF. `false`: exactly the previous path.
 * Default ON: the output bytes, the errors and the fallback are pinned by
 * `src/__tests__/utils/scrypt-async-off-main-thread.test.ts`.
 */
export const SCRYPT_KDF_OFF_MAIN_THREAD = true;

/**
 * Worker deaths in a row (failed start, crash, unexpected exit) after which
 * this process stops trying the worker and keeps today's path for good.
 */
export const SCRYPT_KDF_WORKER_MAX_CONSECUTIVE_FAILURES = 3;

export interface ScryptAsyncDeps {
  /** The switch; defaults to {@link SCRYPT_KDF_OFF_MAIN_THREAD}. */
  readonly offMainThread: boolean;
  /**
   * Whether `crypto.scrypt` runs a full derive on its calling thread before
   * handing off (Electron's BoringSSL). Defaults to "running in Electron".
   */
  readonly callerThreadRunsFullKdf: boolean;
  /** Creates the resident KDF worker. */
  readonly createWorker: (source: string, options: WorkerOptions) => Worker;
}

/** Numbers only: what the KDF cost the calling thread since the last take. */
export interface ScryptKdfStats {
  /** `scryptAsync` calls. */
  readonly derives: number;
  /** Calls the worker completed (no KDF ran on the calling thread). */
  readonly offMainDerives: number;
  /** Synchronous calling-thread time spent starting derives, in ms. */
  readonly callerBlockedMs: number;
}

/** Returns the KDF numbers since the previous take and starts a new count. */
export function takeScryptKdfStats(): ScryptKdfStats {
  const out: ScryptKdfStats = {
    derives: kdfStats.derives,
    offMainDerives: kdfStats.offMainDerives,
    callerBlockedMs: Math.round(kdfStats.callerBlockedMs * 100) / 100,
  };
  kdfStats.derives = 0;
  kdfStats.offMainDerives = 0;
  kdfStats.callerBlockedMs = 0;
  return out;
}

/**
 * Test seam. Installs `override` over the defaults and returns a restore. Both
 * install and restore stop any running worker and clear the failure count, so
 * no worker or state leaks from one configuration into the next.
 */
export function configureScryptAsyncDeps(override: Partial<ScryptAsyncDeps> | null): () => void {
  const previous = depsOverride;
  depsOverride = override;
  resetWorkerState();
  return () => {
    depsOverride = previous;
    resetWorkerState();
  };
}

function currentDeps(): ScryptAsyncDeps {
  return {
    offMainThread: depsOverride?.offMainThread ?? SCRYPT_KDF_OFF_MAIN_THREAD,
    callerThreadRunsFullKdf:
      depsOverride?.callerThreadRunsFullKdf ?? typeof process.versions.electron === "string",
    createWorker: depsOverride?.createWorker ?? ((source, options) => new Worker(source, options)),
  };
}

/** The previous implementation, unchanged apart from timing the call. */
function deriveOnCallingThread(
  password: string,
  salt: Uint8Array,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const startedAt = performance.now();
    try {
      scrypt(password, salt, keylen, options, (err, derived) => {
        if (err) reject(err);
        else resolve(derived);
      });
    } finally {
      kdfStats.callerBlockedMs += performance.now() - startedAt;
    }
  });
}

/**
 * The worker body. CommonJS source evaluated in the worker, so it needs no
 * file next to the bundle. It answers each request with its id and either a
 * fresh copy of the derived key or `null`; never an error text, never the
 * input. The original output buffer is zeroed once copied. A request it
 * cannot read ends the worker, which sends every waiting derive back to the
 * calling thread.
 */
const KDF_WORKER_SOURCE = `"use strict";
const { parentPort } = require("node:worker_threads");
const { scrypt } = require("node:crypto");
parentPort.on("message", (request) => {
  const id = request.id;
  try {
    scrypt(request.password, request.salt, request.keylen, request.options, (error, derived) => {
      if (error) {
        parentPort.postMessage({ id, key: null });
        return;
      }
      const key = new Uint8Array(derived);
      derived.fill(0);
      parentPort.postMessage({ id, key });
    });
  } catch {
    parentPort.postMessage({ id, key: null });
  }
});
parentPort.on("messageerror", () => process.exit(1));
`;

/**
 * Worker options. `env: {}` keeps the vault-loaded secrets that live in the
 * main process's `process.env` out of the worker; `execArgv: []` keeps
 * per-process flags such as an inspector port from being inherited.
 */
const KDF_WORKER_OPTIONS: WorkerOptions = { eval: true, env: {}, execArgv: [] };

interface PendingDerive {
  readonly keylen: number;
  readonly settle: (key: Buffer | null) => void;
}

/** One live worker, its in-flight requests, and its single death. */
class KdfWorkerHost {
  private readonly pending = new Map<number, PendingDerive>();
  private nextId = 1;
  private dead = false;

  constructor(
    private readonly worker: Worker,
    private readonly onDeath: (host: KdfWorkerHost) => void,
  ) {
    // Idle, the worker never keeps the process alive. While a derive is in
    // flight it does, exactly as the threadpool job it replaces would.
    worker.unref();
    worker.on("message", (message: unknown) => this.receive(message));
    // A reply that cannot be read leaves a request with no answer, so it
    // ends the worker and every waiting derive takes today's path.
    worker.on("messageerror", () => this.stop());
    worker.on("error", () => this.die());
    worker.on("exit", () => this.die());
  }

  request(
    password: string,
    salt: Uint8Array,
    keylen: number,
    options: ScryptOptions,
  ): Promise<Buffer | null> {
    if (this.dead) return Promise.resolve(null);
    return new Promise<Buffer | null>((resolve) => {
      const id = this.nextId;
      this.nextId += 1;
      this.pending.set(id, { keylen, settle: resolve });
      if (this.pending.size === 1) this.worker.ref();
      const startedAt = performance.now();
      try {
        // An exact-size copy of the salt: cloning a pooled Buffer view would
        // carry its whole shared backing store into the worker.
        this.worker.postMessage({ id, password, salt: new Uint8Array(salt), keylen, options });
      } catch {
        // Not cloneable or the port is closed: today's path takes it.
        this.settle(id, null);
      } finally {
        kdfStats.callerBlockedMs += performance.now() - startedAt;
      }
    });
  }

  stop(): void {
    this.die();
    void this.worker.terminate().catch(() => undefined);
  }

  private receive(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const id = "id" in message ? message.id : undefined;
    if (typeof id !== "number") return;
    const key = "key" in message ? message.key : null;
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    if (ArrayBuffer.isView(key) && key.byteLength === entry.keylen) {
      consecutiveWorkerFailures = 0;
      kdfStats.offMainDerives += 1;
      this.settle(id, Buffer.from(key.buffer, key.byteOffset, key.byteLength));
      return;
    }
    // The KDF itself failed in the worker. Not a worker fault: today's path
    // re-runs it on the calling thread and produces today's exact error.
    this.settle(id, null);
  }

  private settle(id: number, key: Buffer | null): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    if (this.pending.size === 0 && !this.dead) this.worker.unref();
    entry.settle(key);
  }

  private die(): void {
    if (this.dead) return;
    this.dead = true;
    this.onDeath(this);
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const entry of waiting) entry.settle(null);
  }
}

function workerDisabled(): boolean {
  return consecutiveWorkerFailures >= SCRYPT_KDF_WORKER_MAX_CONSECUTIVE_FAILURES;
}

function deriveOnWorker(
  deps: ScryptAsyncDeps,
  password: string,
  salt: Uint8Array,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer | null> {
  const live = host ?? startWorker(deps);
  if (live === null) return Promise.resolve(null);
  return live.request(password, salt, keylen, options);
}

function startWorker(deps: ScryptAsyncDeps): KdfWorkerHost | null {
  let worker: Worker;
  try {
    worker = deps.createWorker(KDF_WORKER_SOURCE, KDF_WORKER_OPTIONS);
  } catch {
    consecutiveWorkerFailures += 1;
    return null;
  }
  const started = new KdfWorkerHost(worker, (dying) => {
    if (host === dying) {
      host = null;
      consecutiveWorkerFailures += 1;
    }
  });
  host = started;
  return started;
}

function resetWorkerState(): void {
  const running = host;
  host = null;
  running?.stop();
  consecutiveWorkerFailures = 0;
}
