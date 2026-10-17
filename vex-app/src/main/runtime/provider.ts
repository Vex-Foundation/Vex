/**
 * The seam between Vex and what runs its local services (Postgres +
 * pgvector, the embeddings server).
 *
 * The one provider is the native runtime: bundled binaries supervised by
 * main (`native/native-provider.ts`). The runtime host (`runtime-host.ts`) is
 * the one place that turns a provider's outcome into process-wide state, so
 * the provider never writes `setDbConnection` itself.
 *
 * The start vocabulary keeps the kinds the renderer's remediation screens
 * already map one-to-one.
 */

import type { DbConnection } from "../database/connection-state.js";

/** Which implementation runs the local services. */
export type RuntimeProviderId = "native";

/**
 * Outcome of a start, in the vocabulary the renderer already maps, including
 * `disk_full` (plan 8.4/8.5, with its own remediation copy).
 */
export type RuntimeStartKind =
  | "running"
  | "reused"
  | "port_collision"
  | "foreign_listener"
  | "unhealthy"
  | "failed"
  | "disk_full";

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
   * `options.signal` aborted before the start settled, so cancellation is a
   * contract of the seam rather than a provider-specific failure kind.
   */
  start(input: Input, options: RuntimeStartOptions): Promise<RuntimeStartOutcome<StartDetail>>;
  stop(): Promise<RuntimeStopOutcome<StopDetail>>;
  /**
   * Endpoint changes AFTER a usable start, for providers that supervise their
   * services: a restart can come back on a new port (and a new key), and
   * between the crash and the restart the endpoints are null. The host is
   * the one subscriber and republishes them.
   */
  watch?(listener: (endpoints: RuntimeEndpoints | null) => void): () => void;
}

export function isUsableStart(kind: RuntimeStartKind): boolean {
  return kind === "running" || kind === "reused";
}
