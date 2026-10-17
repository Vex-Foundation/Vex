/**
 * The process-wide native runtime: the bundled Postgres and the embeddings
 * server, assembled from their supervisors behind one runtime host.
 *
 * Main starts it at boot when the runtime mode is native (plan D8); the
 * migrate handler joins that start, so the renderer never drives it. The
 * start is single-flight and, once usable, reused; a failed start may be
 * retried by the next caller (the migrate handler, or the runtime screen's
 * Retry). The first run's model download happens inside the embeddings
 * half, before llama-server may launch. Every step is reported to
 * `native-runtime-progress.ts`, which the runtime screen watches.
 *
 * A HOLD gives one caller exclusive use of the runtime: Settings' restart and
 * reset (`local-runtime-maintenance.ts`) stop the servers and start them again
 * (or, for a reset, leave them stopped until the relaunch) without another
 * start slipping in between. While a hold is out, `startNativeRuntime()`
 * waits for its release and then starts, joins or reuses as usual.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { log } from "../../logger/index.js";
import { beginCriticalOp, CRITICAL_OP } from "../../updates/critical-ops.js";
import { createRuntimeHost, type RuntimeHost } from "../runtime-host.js";
import {
  llamaCacheDir,
  locateLlamaBinary,
  locatePostgresBinaries,
  modelsDir,
  pgDataDir,
  RUNTIME_DIR,
} from "../runtime-paths.js";
import { getPgPassword } from "../secrets/pg-password.js";
import { productionPgPasswordDeps } from "../secrets/production-deps.js";
import type { RuntimeStartKind, RuntimeStopKind } from "../provider.js";
import { publishNativeEmbeddings } from "./embedding-env.js";
import { LlamaSupervisor, type LlamaStartResult } from "./llama-supervisor.js";
import { EMBEDDING_MODEL_SPEC, ensureModel } from "./model-store.js";
import {
  createNativeProvider,
  type NativeStartDetail,
  type NativeStopDetail,
} from "./native-provider.js";
import { nativeRuntimeProgress as progress } from "./native-runtime-progress.js";
import { createPostgresSupervisor } from "./postgres-supervisor.js";

export interface NativeRuntimeStart {
  /** `unavailable`: a bundled binary is missing (packaging or a dev build). */
  readonly kind: RuntimeStartKind | "unavailable";
  readonly message: string;
}

export interface NativeRuntimeStop {
  readonly kind: RuntimeStopKind;
  readonly message: string;
}

/** Exclusive use of the runtime; see the header. */
export interface NativeRuntimeHold {
  /** Stop both servers. A stop that did not fail returns the progress to `idle`. */
  stop(): Promise<NativeRuntimeStop>;
  /** The ordinary start, reported on the progress bus; never rejects. */
  start(): Promise<NativeRuntimeStart>;
  /** Let waiting and later starts through. Idempotent. */
  release(): void;
}

type NativeHost = RuntimeHost<void, NativeStartDetail, NativeStopDetail>;

let host: NativeHost | null = null;
let starting: Promise<NativeRuntimeStart> | null = null;
/** Aborted by stop(): an in-flight model download must not outlive the app. */
let lifetime = new AbortController();
/** The hold that is out, if any; `released` settles when it is given back. */
let hold: { readonly released: Promise<void> } | null = null;

async function buildHost(): Promise<NativeHost | NativeRuntimeStart> {
  const pg = await locatePostgresBinaries();
  if (pg.kind === "unavailable") return { kind: "unavailable", message: pg.detail };
  const llama = await locateLlamaBinary();
  if (llama.kind === "unavailable") return { kind: "unavailable", message: llama.detail };

  const cacheDir = llamaCacheDir(RUNTIME_DIR);
  await mkdir(cacheDir, { recursive: true });
  const postgres = createPostgresSupervisor({
    runtimeDir: RUNTIME_DIR,
    binaries: pg.binaries,
    ensurePasswordFile: async () => (await getPgPassword(productionPgPasswordDeps())).composePath,
  });
  // Past the restart budget a ready runtime is no longer ready; Retry starts
  // it again. Restarts within the budget are the provider's to republish.
  postgres.onHealthChange((health) => {
    if (health.kind === "unhealthy" && progress.current().phase === "ready") {
      progress.fail("unhealthy", health.message, "postgres");
    }
  });
  const llamaSupervisor = new LlamaSupervisor({
    launch: {
      binaryPath: llama.binaryPath,
      modelPath: path.join(modelsDir(RUNTIME_DIR), EMBEDDING_MODEL_SPEC.fileName),
      cacheDir,
    },
    onUnhealthy: (reason) => {
      log.error(`[runtime:native] embeddings server unhealthy: ${reason}`);
      if (progress.current().phase === "ready") progress.fail("unhealthy", reason, "embeddings");
    },
  });

  let lastLoggedTenth = -1;
  const embeddings = {
    async start(): Promise<LlamaStartResult> {
      progress.modelChecking();
      const model = await ensureModel({
        dir: modelsDir(RUNTIME_DIR),
        signal: lifetime.signal,
        onProgress: (modelProgress) => {
          progress.model(modelProgress);
          if (modelProgress.phase !== "downloading") return;
          const tenth = Math.floor((modelProgress.receivedBytes / modelProgress.totalBytes) * 10);
          if (tenth !== lastLoggedTenth) {
            lastLoggedTenth = tenth;
            log.info(`[runtime:native] embeddings model download ${String(tenth * 10)}%`);
          }
        },
      });
      if (model.kind === "disk_full") {
        const reason = `Not enough disk space for the embeddings model (${String(model.availableBytes)} bytes free).`;
        progress.fail("disk_full", reason);
        return { kind: "failed", reason };
      }
      if (model.kind === "unavailable") {
        const reason = `The embeddings model could not be downloaded: ${model.message}`;
        progress.fail("offline", reason);
        return { kind: "failed", reason };
      }
      progress.embeddingsStarting();
      return llamaSupervisor.start();
    },
    stop: () => llamaSupervisor.stop(),
    onEndpointChange: llamaSupervisor.onEndpointChange.bind(llamaSupervisor),
  };

  const provider = createNativeProvider({ postgres, embeddings });
  return createRuntimeHost(provider, { onEmbeddings: publishNativeEmbeddings });
}

/**
 * Start (or join, or reuse) the native runtime. Never rejects. Single-flight
 * here, not only in the host, so a caller arriving while the host is still
 * being built joins that start instead of building a second one.
 */
export function startNativeRuntime(): Promise<NativeRuntimeStart> {
  const held = hold;
  if (held !== null) return held.released.then(() => startNativeRuntime());
  return startUnheld();
}

function startUnheld(): Promise<NativeRuntimeStart> {
  starting ??= runStart().finally(() => {
    starting = null;
  });
  return starting;
}

/** Whether a start is in flight: the boot start, a Retry, the migrate handler's. */
export function nativeRuntimeStarting(): boolean {
  return starting !== null;
}

/**
 * Take exclusive use of the runtime, or null while another hold is out or a
 * start is in flight: a restart must never stop a start halfway through.
 */
export function acquireNativeRuntimeHold(): NativeRuntimeHold | null {
  if (hold !== null || starting !== null) return null;
  let open: () => void = () => {};
  const entry = {
    released: new Promise<void>((resolve) => {
      open = resolve;
    }),
  };
  hold = entry;
  let released = false;
  return {
    async stop() {
      const outcome = await stopNativeRuntime();
      if (outcome.kind !== "failed") progress.stopped();
      return outcome;
    },
    start: () => startUnheld(),
    release() {
      if (released) return;
      released = true;
      if (hold === entry) hold = null;
      open();
    },
  };
}

async function runStart(): Promise<NativeRuntimeStart> {
  const end = beginCriticalOp(CRITICAL_OP.localRuntime);
  progress.begin(!existsSync(path.join(pgDataDir(RUNTIME_DIR), "PG_VERSION")));
  try {
    if (host === null) {
      const built = await buildHost();
      if (!("start" in built)) {
        log.error(`[runtime:native] cannot start: ${built.message}`);
        return settle(built);
      }
      host = built;
    }
    const startedAt = Date.now();
    const { outcome, joined } = await host.start(undefined, "native", { signal: lifetime.signal });
    const detail = outcome.detail;
    const message =
      detail.embeddings?.kind === "failed" ? detail.embeddings.reason : detail.postgres.message;
    if (!joined) {
      log.info(`[runtime:native] start ${outcome.kind} in ${String(Date.now() - startedAt)} ms`);
      if (outcome.endpoints === null) log.error(`[runtime:native] start failed: ${message}`);
    }
    return settle({ kind: outcome.kind, message });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`[runtime:native] start threw: ${message}`);
    return settle({ kind: "failed", message });
  } finally {
    end();
  }
}

/** Report how the start ended; a failure a step already reported is kept. */
function settle(start: NativeRuntimeStart): NativeRuntimeStart {
  if (start.kind === "running" || start.kind === "reused") progress.ready();
  else progress.fail(start.kind, start.message);
  return start;
}

/** Stop both servers (quit, or a hold's stop). Postgres gets its fast-stop window. */
export async function stopNativeRuntime(): Promise<NativeRuntimeStop> {
  lifetime.abort();
  lifetime = new AbortController();
  if (host === null) return { kind: "not_running", message: "The local runtime was never started." };
  const outcome = await host.stop();
  log.info(`[runtime:native] stop ${outcome.kind}: ${outcome.detail.postgres.message}`);
  return { kind: outcome.kind, message: outcome.detail.postgres.message };
}
