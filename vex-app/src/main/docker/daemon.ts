/**
 * Daemon lifecycle helpers for the compose flow (codex turn 6 fix).
 *
 * `composeUp` cannot trust `dockerBootstrap → Continue` to mean the
 * daemon will still be up when compose lands — the user could have
 * stopped Docker Desktop, the macOS reboot may have killed the engine,
 * Docker Desktop on Linux might still be initializing. So we re-probe
 * here and, if needed, kick `performStart()` and poll for readiness.
 */

import { runSpawn } from "./spawn-runner.js";
import { performStart, type StartResult } from "./start.js";

const DAEMON_CHECK_TIMEOUT_MS = 15_000;
const DAEMON_READY_POLL_INTERVAL_MS = 3_000;
const DAEMON_READY_TOTAL_MS = 120_000;

export type DaemonReadinessKind =
  | "ready"
  | "auto_started"
  | "user_action_required"
  | "unsupported"
  | "failed";

export interface DaemonReadiness {
  readonly kind: DaemonReadinessKind;
  readonly message: string;
  readonly startResult?: StartResult | null;
}

export async function checkDockerDaemon(
  signal?: AbortSignal
): Promise<{ ok: boolean; reason: string }> {
  const result = await runSpawn(
    "docker",
    ["info", "--format", "{{json .ServerVersion}}"],
    { signal, timeoutMs: DAEMON_CHECK_TIMEOUT_MS }
  );
  if (result.code === 0) {
    const version = result.stdout.trim().replace(/^"|"$/g, "");
    if (version.length > 0 && version !== "null") {
      return { ok: true, reason: `Server ${version}` };
    }
    return { ok: false, reason: "docker info returned empty ServerVersion" };
  }
  if (result.timedOut) {
    return { ok: false, reason: "docker info timed out (daemon socket unreachable)" };
  }
  if (/snap-confine/i.test(result.stderr)) {
    return {
      ok: false,
      reason:
        "Docker CLI is the snap wrapper without required capabilities (cap_dac_override). Install docker-ce from docker.com instead.",
    };
  }
  if (/permission denied/i.test(result.stderr)) {
    return {
      ok: false,
      reason: "Permission denied on Docker socket — add your user to the `docker` group and re-login.",
    };
  }
  return {
    ok: false,
    reason: result.stderr.trim() || `docker info exited with ${result.code ?? "unknown"}`,
  };
}

export async function ensureDockerDaemonReady(opts: {
  readonly signal?: AbortSignal;
  readonly onStatus?: (message: string) => void;
}): Promise<DaemonReadiness> {
  const { signal, onStatus } = opts;
  const initial = await checkDockerDaemon(signal);
  if (initial.ok) {
    return { kind: "ready", message: initial.reason };
  }

  // Some failures are not "daemon stopped" but "CLI/socket misconfigured".
  // Trying to autostart in those cases will not help — fail fast.
  const unrecoverable =
    /snap-confine/i.test(initial.reason) ||
    /permission denied/i.test(initial.reason);
  if (unrecoverable) {
    return {
      kind: "failed",
      message: initial.reason,
      startResult: null,
    };
  }

  onStatus?.("Docker daemon is not responding — attempting to start it…");
  const startResult = await performStart(signal);
  if (
    startResult.kind === "user_action_required" ||
    startResult.kind === "unsupported" ||
    startResult.kind === "failed"
  ) {
    return {
      kind: startResult.kind,
      message: startResult.message,
      startResult,
    };
  }

  // `started` or `already_running` — poll for readiness.
  const deadline = Date.now() + DAEMON_READY_TOTAL_MS;
  let lastReason = "polling";
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      return {
        kind: "failed",
        message: "Aborted while waiting for Docker daemon to become ready.",
        startResult,
      };
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, DAEMON_READY_POLL_INTERVAL_MS)
    );
    const probe = await checkDockerDaemon(signal);
    if (probe.ok) {
      return {
        kind: "auto_started",
        message: `Docker daemon ready: ${probe.reason}`,
        startResult,
      };
    }
    lastReason = probe.reason;
    onStatus?.(`Waiting for Docker daemon… (${lastReason})`);
  }
  return {
    kind: "failed",
    message: `Docker daemon did not become ready within ${
      DAEMON_READY_TOTAL_MS / 1000
    }s. Last probe: ${lastReason}`,
    startResult,
  };
}
