/**
 * The seam between Vex and whatever runs its local services (Postgres +
 * pgvector, the embeddings server).
 *
 * Today the only provider is Docker Compose (`docker/docker-provider.ts`). The
 * native runtime - bundled binaries supervised by main - will be the second
 * implementation of this same interface, and the runtime host
 * (`runtime-host.ts`) is the one place that turns a provider's outcome into
 * process-wide state, so neither provider writes `setDbConnection` itself.
 *
 * The start vocabulary deliberately reuses today's compose-up kinds so the
 * renderer's remediation screens keep mapping one-to-one whichever provider
 * produced the outcome.
 */

import type { DbConnection } from "../database/connection-state.js";

/** Which implementation runs the local services. */
export type RuntimeProviderId = "docker" | "native";

/** Outcome of a start, in the compose-up vocabulary the renderer already maps. */
export type RuntimeStartKind =
  | "running"
  | "reused"
  | "port_collision"
  | "foreign_listener"
  | "unhealthy"
  | "failed";

/** Where the running services can be reached. Main-process only. */
export interface RuntimeEndpoints {
  readonly db: DbConnection;
  readonly embeddings: {
    /** OpenAI-compatible `/v1` base URL. */
    readonly baseUrl: string;
    /** Per-launch key the server requires, or null when it requires none. */
    readonly apiKey: string | null;
  };
}

export interface RuntimeStartOutcome<Detail> {
  readonly kind: RuntimeStartKind;
  /**
   * Present exactly when `kind` is `running` or `reused`. A degraded or failed
   * runtime may still know its ports, but nothing may be published that points
   * at a runtime that is not usable.
   */
  readonly endpoints: RuntimeEndpoints | null;
  /** The provider's own full result, for that provider's IPC surface to shape. */
  readonly detail: Detail;
}

/** `stopped` is the only outcome that proves the services are gone. */
export type RuntimeStopKind = "stopped" | "not_running" | "failed";

export interface RuntimeStopOutcome<Detail> {
  readonly kind: RuntimeStopKind;
  readonly detail: Detail;
}

export interface RuntimeStartOptions {
  readonly signal: AbortSignal;
  readonly onLogLine?: (stream: "stdout" | "stderr", line: string) => void;
}

export interface LocalRuntimeProvider<Input, StartDetail, StopDetail> {
  readonly id: RuntimeProviderId;
  /**
   * Start (or reuse) the services. Rejects with an `AbortError` when
   * `options.signal` aborted before the start settled, so cancellation is one
   * contract for every provider rather than a provider-specific failure kind.
   */
  start(input: Input, options: RuntimeStartOptions): Promise<RuntimeStartOutcome<StartDetail>>;
  stop(): Promise<RuntimeStopOutcome<StopDetail>>;
}

export function isUsableStart(kind: RuntimeStartKind): boolean {
  return kind === "running" || kind === "reused";
}
