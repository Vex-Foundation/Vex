/**
 * Reducer hook that folds a stream of `ParsedLogEvent`s into the two
 * user-facing service pills ("Postgres" + "Embeddings"). The
 * `embeddings-model-init` container is collapsed into the Embeddings
 * substate (not a separate pill) per codex plan v2 SHOULD-FIX #6.
 *
 * The reducer is a pure derivation — it does NOT trigger the
 * orchestrator's phase transitions, only feeds visual subState. Phase
 * flips still come from the `composeUpAbortable` promise + IPC kind.
 */

import { useMemo } from "react";
import type {
  AggregatedServiceState,
  ServiceName,
} from "./types.js";
import type { ParsedLogEvent } from "./parseComposeLog.js";

function initial(service: ServiceName): AggregatedServiceState {
  return {
    service,
    status: "starting",
    detail: service === "Postgres" ? "waiting" : "model loading",
  };
}

function applyEvent(
  state: Map<ServiceName, AggregatedServiceState>,
  event: ParsedLogEvent,
): Map<ServiceName, AggregatedServiceState> {
  const next = new Map(state);
  const pg = next.get("Postgres") ?? initial("Postgres");
  const emb = next.get("Embeddings") ?? initial("Embeddings");

  switch (event.kind) {
    case "postgres.waiting":
      next.set("Postgres", {
        ...pg,
        status: "starting",
        detail: "waiting for daemon",
      });
      return next;

    case "postgres.probe.connecting":
      next.set("Postgres", {
        ...pg,
        status: "probing",
        detail: `probe #${event.attempt} on :${event.port}`,
      });
      return next;

    case "postgres.probe.ready":
      next.set("Postgres", {
        ...pg,
        status: "ready",
        detail: `probe #${event.attempt} ready`,
      });
      return next;

    case "postgres.probe.failed":
      // Transient retry — `probeDbHealth` emits failure lines during
      // normal polling and the next attempt may succeed. Terminal
      // failure surfaces via the IPC `composeUpKind` (unhealthy /
      // failed) and gets dispatched to the right error body by the
      // orchestrator (codex post-impl SHOULD-FIX #1).
      next.set("Postgres", {
        ...pg,
        status: "probing",
        detail: `probe #${event.attempt} - ${event.message}`,
      });
      return next;

    case "embeddings.probe.connecting":
      next.set("Embeddings", {
        ...emb,
        status: "probing",
        detail: `probe #${event.attempt} on :${event.port}`,
      });
      return next;

    case "embeddings.probe.health_ok":
      next.set("Embeddings", {
        ...emb,
        status: "probing",
        detail: "/health OK, checking inference",
      });
      return next;

    case "embeddings.probe.not_ready":
      next.set("Embeddings", {
        ...emb,
        status: "probing",
        detail:
          event.reason === "health"
            ? `probe #${event.attempt} - model loading`
            : `probe #${event.attempt} - runtime warming`,
      });
      return next;

    case "embeddings.probe.ready":
      next.set("Embeddings", {
        ...emb,
        status: "ready",
        detail: `dim=${event.dim} · ${event.attempts} attempt${event.attempts === 1 ? "" : "s"}`,
      });
      return next;

    case "embeddings.aborted":
      next.set("Embeddings", {
        ...emb,
        status: "failed",
        detail: "probe aborted",
      });
      return next;

    case "container.state":
      // db / embeddings-runtime / embeddings-model-init container
      // transitions feed substate, never overwrite a higher-fidelity
      // probe state. `Healthy` → ready, `Exited` only matters for
      // init container (model cache done), else terminal failure.
      if (event.service === "db") {
        if (event.phase === "Healthy") {
          next.set("Postgres", {
            ...pg,
            status: pg.status === "ready" ? "ready" : "probing",
            detail: pg.status === "ready" ? pg.detail : "container healthy",
          });
        } else if (event.phase === "Starting" || event.phase === "Started") {
          if (pg.status === "starting") {
            next.set("Postgres", {
              ...pg,
              detail: "container starting",
            });
          }
        }
      } else if (event.service === "embeddings-model-init") {
        if (event.phase === "Starting" || event.phase === "Started") {
          if (emb.status === "starting") {
            next.set("Embeddings", {
              ...emb,
              detail: "model init starting",
            });
          }
        } else if (event.phase === "Exited" && emb.status === "starting") {
          // Init container always exits after caching the model — this
          // is the normal "model is cached, now waiting for runtime"
          // transition, not a failure.
          next.set("Embeddings", { ...emb, detail: "model ready" });
        }
      } else if (event.service === "embeddings-runtime") {
        if (event.phase === "Starting" || event.phase === "Started") {
          if (emb.status === "starting") {
            next.set("Embeddings", {
              ...emb,
              detail: "runtime starting",
            });
          }
        }
      }
      return next;

    case "compose.completed":
      // Cosmetic — orchestrator already knows from IPC. No-op here.
      return next;
  }
}

/**
 * Pure reducer (testable without React) — runs once per render via
 * `useMemo`. If `events` is the same reference between renders, the
 * memoized result is reused; the orchestrator owns the event buffer
 * and only re-creates it on each new log line.
 */
export function aggregateServiceState(
  events: readonly ParsedLogEvent[],
): AggregatedServiceState[] {
  let state = new Map<ServiceName, AggregatedServiceState>([
    ["Postgres", initial("Postgres")],
    ["Embeddings", initial("Embeddings")],
  ]);
  for (const event of events) {
    state = applyEvent(state, event);
  }
  // Stable ordering: Postgres first, Embeddings second.
  return [state.get("Postgres")!, state.get("Embeddings")!];
}

export function useAggregatedServiceState(
  events: readonly ParsedLogEvent[],
): AggregatedServiceState[] {
  return useMemo(() => aggregateServiceState(events), [events]);
}
