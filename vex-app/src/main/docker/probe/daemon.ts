/**
 * Async Docker probe runner. Replaces `spawnSync`-based engine helpers
 * (which would freeze Electron's main process — codex turn 3 RED #2)
 * with `execFile` + `AbortController` + per-probe timeout. Pure parsers
 * are unit-testable on string fixtures so we never need Docker installed
 * to run the test suite.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../../logger/index.js";
import { redact } from "../../logger/redact.js";

import {
  parseDockerVersion,
  parseComposeVersion,
  parseModelStatus,
  parseDaemonRunning,
  type ModelStatusKind,
} from "./parsers.js";
import { isPortFree, isModelRunnerEndpointReachable } from "./ports.js";
import { getAvailableDiskGB } from "./disk.js";
import { dockerSpawnEnv } from "../cli-env.js";
import { resolveDockerCli } from "../locate.js";
import { probeDockerEngineEndpoint } from "../engine-endpoint.js";
import {
  clearDockerEngineStartWindow,
  isWithinEngineStartWindow,
} from "../engine-start-window.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_BUFFER = 1024 * 1024;

interface RunResult {
  readonly ok: boolean;
  readonly notFound: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorMessage: string | null;
}

async function runCmd(
  cmd: string,
  args: ReadonlyArray<string>,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<RunResult> {
  const ac = new AbortController();
  const linkedAbort = (): void => ac.abort();
  signal?.addEventListener("abort", linkedAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const { stdout, stderr } = await execFileAsync(cmd, [...args], {
      signal: ac.signal,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      env: dockerSpawnEnv(),
    });
    return { ok: true, notFound: false, stdout, stderr, errorMessage: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err &&
      typeof err === "object" &&
      "code" in err &&
      typeof err.code === "string"
        ? err.code
        : null;
    const stdout =
      err && typeof err === "object" && "stdout" in err
        ? String((err as { stdout: unknown }).stdout ?? "")
        : "";
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr ?? "")
        : "";
    log.warn(
      "[docker-probe] Docker CLI command failed",
      redact({ args, code, message, stderr }),
    );
    return {
      ok: false,
      notFound: code === "ENOENT",
      stdout,
      stderr,
      errorMessage: message,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", linkedAbort);
  }
}

// ── Composite probe ──────────────────────────────────────────────────

import {
  deriveDockerStatusFlags,
  type DockerEngineState,
  type DockerStatus,
} from "@shared/schemas/docker.js";
import { homedir as osHomedir } from "node:os";
import type { DockerEngineReachability } from "../engine-endpoint.js";
import type { DockerEndpointPolicy } from "../endpoint-policy.js";
import { inspectDockerEndpointPolicy } from "../endpoint-policy.js";

interface EngineStateInput {
  readonly cliFound: boolean;
  readonly versionOk: boolean;
  readonly version: string | null;
  readonly versionErrorMessage: string | null;
  readonly endpoint: DockerEndpointPolicy;
  readonly daemonRunning: boolean;
  readonly reachability: DockerEngineReachability;
  readonly startWindowOpen: boolean;
}

/**
 * Resolves the six engine states. Order matters and each branch is a
 * distinct, actionable outcome - "unavailable", "denied" and "unknown" are
 * never folded into one failure.
 *
 * `reachability` is only ever allowed to SHARPEN a failure the CLI already
 * reported. It can never contradict a successful `docker info`, because a
 * user with a custom Docker context has a reachable engine on an endpoint
 * this probe does not know about.
 */
export function classifyEngineState(input: EngineStateInput): DockerEngineState {
  if (!input.cliFound) return { kind: "not_installed" };
  if (!input.versionOk || input.version === null) {
    return {
      kind: "error",
      reason: "probe_error",
      message:
        input.versionErrorMessage !== null
          ? "The Docker CLI was found but did not report a usable version."
          : "The Docker CLI was found but its version output could not be read.",
    };
  }
  if (!input.endpoint.accepted) {
    return {
      kind: "error",
      reason: "endpoint_rejected",
      message:
        input.endpoint.message ??
        "The active Docker endpoint is not a supported local endpoint.",
    };
  }
  if (input.daemonRunning) return { kind: "ready" };
  if (input.reachability.kind === "permission_denied") {
    return {
      kind: "permission_denied",
      message:
        "The Docker engine socket refused this process. Add your user to the Docker group (or grant socket access) and retry.",
    };
  }
  if (input.startWindowOpen) return { kind: "engine_starting" };
  return { kind: "engine_stopped" };
}

export interface DockerProbeOpts {
  readonly signal?: AbortSignal;
  readonly pgPort: number;
  readonly modelRunnerBaseUrl?: string;
  readonly diskTarget: string;
}

export async function probeDocker(opts: DockerProbeOpts): Promise<DockerStatus> {
  const { signal, pgPort, modelRunnerBaseUrl, diskTarget } = opts;

  // Filesystem-first resolution (see `../locate.ts`). This is what makes
  // "Recheck" work after an install: `process.env` is a launch-time snapshot
  // and on Windows a running process can never see a later PATH change, so a
  // PATH-only detector reports "not installed" until Vex restarts.
  const location = resolveDockerCli();
  const dockerCommand = location?.executablePath ?? null;
  const notLocated: RunResult = {
    ok: false,
    notFound: true,
    stdout: "",
    stderr: "",
    errorMessage: null,
  };

  const [versionRes, composeRes, endpoint, reachability, pgFree, diskGB] =
    await Promise.all([
      dockerCommand === null
        ? Promise.resolve(notLocated)
        : runCmd(dockerCommand, ["--version"], signal),
      dockerCommand === null
        ? Promise.resolve(notLocated)
        : runCmd(dockerCommand, ["compose", "version"], signal),
      inspectDockerEndpointPolicy(signal, dockerCommand),
      probeDockerEngineEndpoint({
        platform: process.platform,
        homedir: osHomedir(),
        ...(signal !== undefined ? { signal } : {}),
      }),
      isPortFree("127.0.0.1", pgPort, signal),
      getAvailableDiskGB(diskTarget),
    ]);

  // Per the `findGit` pattern: a candidate is only accepted once spawning
  // its ABSOLUTE path yields a parseable version.
  const engineVersion = versionRes.ok
    ? parseDockerVersion(versionRes.stdout)
    : null;
  const cliUsable = versionRes.ok && engineVersion !== null;
  const composeVersion = composeRes.ok ? parseComposeVersion(composeRes.stdout) : null;
  let modelStatus: ModelStatusKind = "unsupported";
  let daemonRunning = false;
  let mrTcp = false;

  if (dockerCommand !== null && cliUsable && endpoint.accepted) {
    const [modelRes, infoRes, modelRunnerTcp] = await Promise.all([
      runCmd(dockerCommand, ["model", "status"], signal),
      runCmd(dockerCommand, ["info", "--format", "{{json .}}"], signal),
      isModelRunnerEndpointReachable(modelRunnerBaseUrl, signal),
    ]);
    modelStatus = parseModelStatus(modelRes.stdout, modelRes.errorMessage);
    daemonRunning = parseDaemonRunning(infoRes.stdout, infoRes.errorMessage);
    mrTcp = modelRunnerTcp;
  }

  const state = classifyEngineState({
    cliFound: dockerCommand !== null,
    versionOk: versionRes.ok,
    version: engineVersion,
    versionErrorMessage: versionRes.errorMessage,
    endpoint,
    daemonRunning,
    reachability,
    startWindowOpen: isWithinEngineStartWindow(),
  });
  // The engine answered, so the "we just started it" window has served its
  // purpose and must not colour a later stop as "starting".
  if (state.kind === "ready") clearDockerEngineStartWindow();

  const flags = deriveDockerStatusFlags(state);

  return {
    endpoint,
    engine: {
      state,
      version: engineVersion,
      cliSource: location?.source ?? null,
      present: flags.present,
      runtimeOK: flags.runtimeOK,
    },
    compose: {
      present: composeRes.ok,
      version: composeVersion,
    },
    modelRunner: {
      present: modelStatus !== "unsupported",
      status: modelStatus,
      tcpReachable: mrTcp,
    },
    daemon: {
      running: flags.daemonRunning,
      // Startable means Vex can attempt a non-privileged start. Linux Docker
      // Engine may still require user/admin action outside Vex.
      startable: flags.daemonStartable,
    },
    ports: {
      vexPgFree: pgFree,
    },
    disk: {
      availableGB: diskGB,
    },
  };
}
