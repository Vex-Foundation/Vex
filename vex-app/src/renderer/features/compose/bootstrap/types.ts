/**
 * Local types for the compose bootstrap state machine and parsed log
 * events. Kept here (not in `@shared/`) because they're cosmetic and
 * UI-shaped — the canonical IPC contracts live in
 * `@shared/schemas/docker.ts`.
 */

import type { ComposeUpResult } from "@shared/schemas/docker.js";

/**
 * UI state machine driven by the `composeUpAbortable` promise lifecycle
 * + IPC `composeUpResultSchema.kind` discriminator. Per-kind error
 * states give us distinct copy without overloading a single "error"
 * bucket (codex plan v2 SHOULD-FIX #3).
 */
export type Phase =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "cancelling" }
  | { kind: "ready"; result: ComposeUpResult }
  | {
      kind: "error.port_collision";
      message: string;
      previousInstallHoldingPorts: boolean;
    }
  | { kind: "error.foreign_listener"; message: string }
  | { kind: "error.unhealthy"; message: string }
  | { kind: "error.failed"; message: string }
  | { kind: "error.cancelled" };

/**
 * User-facing service names aggregated from the underlying Docker
 * services. The compose stack runs three containers
 * (`db`, `embeddings-model-init`, `embeddings-runtime`) but the UI
 * presents two logical pills: "Postgres" and "Embeddings" — the init
 * container is an implementation detail that exits quickly once the
 * model is cached, so it gets folded into the Embeddings substate
 * instead of its own pill.
 */
export type ServiceName = "Postgres" | "Embeddings";

export type ServiceStatus =
  | "starting"
  | "probing"
  | "ready"
  | "failed";

export interface AggregatedServiceState {
  readonly service: ServiceName;
  readonly status: ServiceStatus;
  readonly detail: string;
}
