/**
 * The native provider: bundled Postgres (this slice) plus the embeddings
 * server (slice 9, the llama supervisor) behind the `LocalRuntimeProvider`
 * seam.
 *
 * WHY EMBEDDINGS ARE INJECTED. `RuntimeEndpoints` requires both endpoints,
 * and that requirement is the point: the runtime host publishes only a usable
 * runtime, and setup does not continue without embeddings (D14). Making
 * `embeddings` optional to fit a Postgres-only slice would weaken that
 * contract for every consumer, permanently, to suit a transitional state. So
 * the provider takes the embeddings half as a dependency with the two
 * operations it needs, and the llama supervisor will be that dependency.
 * Nothing in production constructs this provider until slice 10 wires both
 * halves and the `VEX_RUNTIME=native` opt-in.
 *
 * Order: Postgres first, then embeddings; stop the reverse. A start whose
 * embeddings half fails leaves Postgres running (it is healthy, and `stop()`
 * stops it), but yields no endpoints, so nothing is published.
 */

import { AbortError } from "../../ipc/cancel-helpers.js";
import type { LocalRuntimeProvider, RuntimeEndpoints, RuntimeStartKind, RuntimeStopKind } from "../provider.js";
import type { PgStartResult, PgStopResult, PostgresSupervisor } from "./postgres-supervisor.js";

export type EmbeddingsEndpoint = RuntimeEndpoints["embeddings"];

/** The embeddings half of the native runtime (slice 9 implements it). */
export interface NativeEmbeddingsService {
  start(signal: AbortSignal): Promise<
    | { readonly kind: "ready"; readonly endpoint: EmbeddingsEndpoint }
    | { readonly kind: Exclude<RuntimeStartKind, "running" | "reused">; readonly message: string }
  >;
  stop(): Promise<{ readonly kind: RuntimeStopKind; readonly message: string }>;
}

export interface NativeStartDetail {
  readonly postgres: PgStartResult;
  /** null when Postgres did not come up, so embeddings were not attempted. */
  readonly embeddings: { readonly kind: string; readonly message: string } | null;
}

export interface NativeStopDetail {
  readonly postgres: PgStopResult;
  readonly embeddings: { readonly kind: RuntimeStopKind; readonly message: string };
}

/** Postgres' fast-stop window inside the 20 s quit slot (6.5). */
export const NATIVE_PG_STOP_DEADLINE_MS = 15_000;

export function createNativeProvider(deps: {
  readonly postgres: PostgresSupervisor;
  readonly embeddings: NativeEmbeddingsService;
}): LocalRuntimeProvider<void, NativeStartDetail, NativeStopDetail> {
  return {
    id: "native",

    async start(_input, options) {
      const postgres = await deps.postgres.start(options.signal);
      if (postgres.connection === null) {
        return { kind: postgres.kind, endpoints: null, detail: { postgres, embeddings: null } };
      }
      const embeddings = await deps.embeddings.start(options.signal);
      if (options.signal.aborted) throw new AbortError("native runtime start cancelled");
      if (embeddings.kind !== "ready") {
        return {
          kind: embeddings.kind,
          endpoints: null,
          detail: { postgres, embeddings: { kind: embeddings.kind, message: embeddings.message } },
        };
      }
      return {
        kind: postgres.kind,
        endpoints: { db: postgres.connection, embeddings: embeddings.endpoint },
        detail: { postgres, embeddings: { kind: "ready", message: "ready" } },
      };
    },

    async stop() {
      const embeddings = await deps.embeddings.stop();
      const postgres = await deps.postgres.stop({ deadlineMs: NATIVE_PG_STOP_DEADLINE_MS });
      const kinds = [embeddings.kind, postgres.kind];
      const kind: RuntimeStopKind = kinds.includes("failed")
        ? "failed"
        : kinds.every((k) => k === "not_running")
          ? "not_running"
          : "stopped";
      return { kind, detail: { postgres, embeddings } };
    },
  };
}
