/**
 * The native provider: the bundled Postgres (`postgres-supervisor.ts`) and
 * the embeddings server (`llama-supervisor.ts`) behind the
 * `LocalRuntimeProvider` seam.
 *
 * WHY BOTH HALVES ARE INJECTED, AND NOT `embeddings` MADE OPTIONAL.
 * `RuntimeEndpoints` requires both endpoints, and that requirement is the
 * point: the runtime host publishes only a usable runtime, and setup does not
 * continue without embeddings (D14). Loosening it to fit a slice that only
 * ships Postgres would weaken the contract for every consumer, for good, to
 * suit a transitional state. So the provider takes the two supervisors as
 * they are; the embeddings half is typed as exactly the `start`/`stop` of
 * `LlamaSupervisor`, so the real one drops in and tests pass a stand-in.
 * Nothing in production constructs this provider until slice 10 wires it
 * (and the `VEX_RUNTIME=native` opt-in).
 *
 * Order: Postgres first, then embeddings; stop the reverse. A start whose
 * embeddings half fails leaves Postgres running (it is healthy, and `stop()`
 * stops it), but yields no endpoints, so nothing is published.
 */

import { AbortError } from "../../ipc/cancel-helpers.js";
import type { LocalRuntimeProvider, RuntimeStopKind } from "../provider.js";
import type { LlamaStartResult, LlamaSupervisor } from "./llama-supervisor.js";
import type { PgStartResult, PgStopResult, PostgresSupervisor } from "./postgres-supervisor.js";

export interface NativeStartDetail {
  readonly postgres: PgStartResult;
  /** null when Postgres did not come up, so embeddings were not attempted. */
  readonly embeddings: LlamaStartResult | null;
}

export interface NativeStopDetail {
  readonly postgres: PgStopResult;
}

/** Postgres' fast-stop window inside the 20 s quit slot (6.5). */
export const NATIVE_PG_STOP_DEADLINE_MS = 15_000;

export function createNativeProvider(deps: {
  readonly postgres: PostgresSupervisor;
  readonly embeddings: Pick<LlamaSupervisor, "start" | "stop">;
}): LocalRuntimeProvider<void, NativeStartDetail, NativeStopDetail> {
  return {
    id: "native",

    async start(_input, options) {
      const postgres = await deps.postgres.start(options.signal);
      if (postgres.connection === null) {
        return { kind: postgres.kind, endpoints: null, detail: { postgres, embeddings: null } };
      }
      const embeddings = await deps.embeddings.start();
      if (options.signal.aborted) throw new AbortError("native runtime start cancelled");
      if (embeddings.kind !== "ready") {
        return { kind: "failed", endpoints: null, detail: { postgres, embeddings } };
      }
      return {
        kind: postgres.kind,
        endpoints: {
          db: postgres.connection,
          embeddings: { baseUrl: embeddings.endpoint.baseUrl, apiKey: embeddings.endpoint.apiKey },
        },
        detail: { postgres, embeddings },
      };
    },

    async stop() {
      // llama-server is stateless; its stop settles only once it is gone.
      await deps.embeddings.stop();
      const postgres = await deps.postgres.stop({ deadlineMs: NATIVE_PG_STOP_DEADLINE_MS });
      const kind: RuntimeStopKind = postgres.kind;
      return { kind, detail: { postgres } };
    },
  };
}
