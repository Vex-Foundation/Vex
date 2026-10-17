/**
 * Pure parser for compose log lines emitted by the main process.
 *
 * Free-form text → discriminated `ParsedLogEvent`. Unmatched lines
 * return `null` (graceful degradation - UI falls back to generic
 * copy when parse misses).
 *
 * Patterns are verified against real emitters in:
 *   - vex-app/src/main/compose/lifecycle.ts (postgres probe + waiting)
 *   - vex-app/src/main/compose/embeddings-health.ts (embeddings probes)
 *   - vex-app/src/main/ipc/docker.ts (terminal "completed" line)
 *   - Docker compose stdout passthrough (Container … {Phase})
 *
 * The parser is COSMETIC ONLY - it never flips the UI state machine.
 * Readiness is driven by the IPC `ComposeUpResult.kind` discriminator;
 * parse events only feed per-service pill substate (codex plan v2
 * SHOULD-FIX #3).
 */

export type ContainerService =
  | "db"
  | "embeddings-model-init"
  | "embeddings-runtime";

export type ContainerPhase =
  | "Starting"
  | "Started"
  | "Waiting"
  | "Healthy"
  | "Exited";

export type ParsedLogEvent =
  | { kind: "postgres.waiting" }
  | {
      kind: "postgres.probe.connecting";
      attempt: number;
      port: number;
    }
  | { kind: "postgres.probe.ready"; attempt: number }
  | {
      kind: "postgres.probe.failed";
      attempt: number;
      message: string;
    }
  | {
      kind: "embeddings.probe.connecting";
      attempt: number;
      port: number;
    }
  | { kind: "embeddings.probe.health_ok" }
  | {
      kind: "embeddings.probe.not_ready";
      attempt: number;
      reason: "health" | "v1_embeddings";
    }
  | {
      kind: "embeddings.probe.ready";
      dim: number;
      attempts: number;
    }
  | { kind: "embeddings.aborted" }
  | {
      kind: "container.state";
      service: ContainerService;
      phase: ContainerPhase;
    }
  | { kind: "compose.completed"; resultKind: string };

const RE_POSTGRES_WAITING = /^Waiting for Postgres to accept connections/i;
const RE_POSTGRES_CONNECTING =
  /^Postgres health probe #(\d+):\s*connecting on 127\.0\.0\.1:(\d+)/;
const RE_POSTGRES_READY = /^Postgres health probe #(\d+):\s*ready\.?$/;
const RE_POSTGRES_FAILED = /^Postgres health probe #(\d+):\s*(.+)$/;
const RE_EMBEDDINGS_CONNECTING =
  /^Embeddings probe #(\d+):\s*GET \/health on 127\.0\.0\.1:(\d+)/;
const RE_EMBEDDINGS_HEALTH_OK = /^Embeddings \/health OK; probing/i;
const RE_EMBEDDINGS_NOT_READY_HEALTH =
  /^Embeddings probe #(\d+):\s*\/health not yet 200/;
const RE_EMBEDDINGS_NOT_READY_V1 =
  /^Embeddings probe #(\d+):\s*\/v1\/embeddings not ready yet/;
const RE_EMBEDDINGS_READY =
  /^Embeddings runtime ready \(dim=(\d+),\s*attempts=(\d+)\)/;
const RE_EMBEDDINGS_ABORTED = /^Embeddings probe aborted/i;
const RE_CONTAINER_STATE =
  /^\s*Container\s+vex-[a-f0-9-]+-(db|embeddings-model-init|embeddings-runtime)-\d+\s+(Starting|Started|Waiting|Healthy|Exited)\s*$/;
const RE_COMPOSE_COMPLETED = /^Compose bootstrap completed:\s*(.+?)\.?$/;

function toInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

export function parseComposeLog(line: string): ParsedLogEvent | null {
  if (RE_POSTGRES_WAITING.test(line)) {
    return { kind: "postgres.waiting" };
  }

  let m = RE_POSTGRES_CONNECTING.exec(line);
  if (m !== null) {
    const attempt = toInt(m[1]);
    const port = toInt(m[2]);
    if (attempt !== null && port !== null) {
      return { kind: "postgres.probe.connecting", attempt, port };
    }
  }

  m = RE_POSTGRES_READY.exec(line);
  if (m !== null) {
    const attempt = toInt(m[1]);
    if (attempt !== null) {
      return { kind: "postgres.probe.ready", attempt };
    }
  }

  // Failure pattern is a superset of the connecting/ready patterns -
  // check it AFTER the more specific ones above.
  m = RE_POSTGRES_FAILED.exec(line);
  if (m !== null && m[2] !== undefined && !m[2].startsWith("connecting") && m[2] !== "ready" && m[2] !== "ready.") {
    const attempt = toInt(m[1]);
    if (attempt !== null) {
      return { kind: "postgres.probe.failed", attempt, message: m[2] };
    }
  }

  m = RE_EMBEDDINGS_CONNECTING.exec(line);
  if (m !== null) {
    const attempt = toInt(m[1]);
    const port = toInt(m[2]);
    if (attempt !== null && port !== null) {
      return { kind: "embeddings.probe.connecting", attempt, port };
    }
  }

  if (RE_EMBEDDINGS_HEALTH_OK.test(line)) {
    return { kind: "embeddings.probe.health_ok" };
  }

  m = RE_EMBEDDINGS_NOT_READY_HEALTH.exec(line);
  if (m !== null) {
    const attempt = toInt(m[1]);
    if (attempt !== null) {
      return {
        kind: "embeddings.probe.not_ready",
        attempt,
        reason: "health",
      };
    }
  }

  m = RE_EMBEDDINGS_NOT_READY_V1.exec(line);
  if (m !== null) {
    const attempt = toInt(m[1]);
    if (attempt !== null) {
      return {
        kind: "embeddings.probe.not_ready",
        attempt,
        reason: "v1_embeddings",
      };
    }
  }

  m = RE_EMBEDDINGS_READY.exec(line);
  if (m !== null) {
    const dim = toInt(m[1]);
    const attempts = toInt(m[2]);
    if (dim !== null && attempts !== null) {
      return { kind: "embeddings.probe.ready", dim, attempts };
    }
  }

  if (RE_EMBEDDINGS_ABORTED.test(line)) {
    return { kind: "embeddings.aborted" };
  }

  m = RE_CONTAINER_STATE.exec(line);
  if (m !== null && m[1] !== undefined && m[2] !== undefined) {
    return {
      kind: "container.state",
      service: m[1] as ContainerService,
      phase: m[2] as ContainerPhase,
    };
  }

  m = RE_COMPOSE_COMPLETED.exec(line);
  if (m !== null && m[1] !== undefined) {
    return { kind: "compose.completed", resultKind: m[1] };
  }

  return null;
}
