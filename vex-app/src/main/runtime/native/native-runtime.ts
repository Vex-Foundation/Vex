/**
 * The process-wide native runtime: the bundled Postgres and the embeddings
 * server, assembled from their supervisors behind one runtime host.
 *
 * Main starts it at boot when the runtime mode is native (plan D8); the
 * migrate handler joins that start, so the renderer never drives it. The
 * start is single-flight and, once usable, reused; a failed start may be
 * retried by the next caller. The first run's model download happens inside
 * the embeddings half, before llama-server may launch.
 */

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
  RUNTIME_DIR,
} from "../runtime-paths.js";
import { getPgPassword } from "../secrets/pg-password.js";
import { productionPgPasswordDeps } from "../secrets/production-deps.js";
import type { RuntimeStartKind } from "../provider.js";
import { publishNativeEmbeddings } from "./embedding-env.js";
import { LlamaSupervisor, type LlamaStartResult } from "./llama-supervisor.js";
import { EMBEDDING_MODEL_SPEC, ensureModel } from "./model-store.js";
import {
  createNativeProvider,
  type NativeStartDetail,
  type NativeStopDetail,
} from "./native-provider.js";
import { createPostgresSupervisor } from "./postgres-supervisor.js";

export interface NativeRuntimeStart {
  /** `unavailable`: a bundled binary is missing (packaging or a dev build). */
  readonly kind: RuntimeStartKind | "unavailable";
  readonly message: string;
}

type NativeHost = RuntimeHost<void, NativeStartDetail, NativeStopDetail>;

let host: NativeHost | null = null;
/** Aborted by stop(): an in-flight model download must not outlive the app. */
let lifetime = new AbortController();

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
  const llamaSupervisor = new LlamaSupervisor({
    launch: {
      binaryPath: llama.binaryPath,
      modelPath: path.join(modelsDir(RUNTIME_DIR), EMBEDDING_MODEL_SPEC.fileName),
      cacheDir,
    },
    onUnhealthy: (reason) => log.error(`[runtime:native] embeddings server unhealthy: ${reason}`),
  });

  let lastLoggedTenth = -1;
  const embeddings = {
    async start(): Promise<LlamaStartResult> {
      const model = await ensureModel({
        dir: modelsDir(RUNTIME_DIR),
        signal: lifetime.signal,
        onProgress: (progress) => {
          if (progress.phase !== "downloading") return;
          const tenth = Math.floor((progress.receivedBytes / progress.totalBytes) * 10);
          if (tenth !== lastLoggedTenth) {
            lastLoggedTenth = tenth;
            log.info(`[runtime:native] embeddings model download ${String(tenth * 10)}%`);
          }
        },
      });
      if (model.kind === "disk_full") {
        return { kind: "failed", reason: `Not enough disk space for the embeddings model (${String(model.availableBytes)} bytes free).` };
      }
      if (model.kind === "unavailable") {
        return { kind: "failed", reason: `The embeddings model could not be downloaded: ${model.message}` };
      }
      return llamaSupervisor.start();
    },
    stop: () => llamaSupervisor.stop(),
    onEndpointChange: llamaSupervisor.onEndpointChange.bind(llamaSupervisor),
  };

  const provider = createNativeProvider({ postgres, embeddings });
  return createRuntimeHost(provider, { onEmbeddings: publishNativeEmbeddings });
}

/** Start (or join, or reuse) the native runtime. Never rejects. */
export async function startNativeRuntime(): Promise<NativeRuntimeStart> {
  const end = beginCriticalOp(CRITICAL_OP.localRuntime);
  try {
    if (host === null) {
      const built = await buildHost();
      if (!("start" in built)) {
        log.error(`[runtime:native] cannot start: ${built.message}`);
        return built;
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
    return { kind: outcome.kind, message };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`[runtime:native] start threw: ${message}`);
    return { kind: "failed", message };
  } finally {
    end();
  }
}

/** Stop both servers (quit). Postgres gets its fast-stop window. */
export async function stopNativeRuntime(): Promise<void> {
  lifetime.abort();
  lifetime = new AbortController();
  if (host === null) return;
  const outcome = await host.stop();
  log.info(`[runtime:native] stop ${outcome.kind}: ${outcome.detail.postgres.message}`);
}
