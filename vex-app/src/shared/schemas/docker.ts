/**
 * Schema for `vex.docker.detect()` — the M2 + M3 surface that the
 * System Check screen drives off. Shape per codex turn 4 RED #2:
 * `embeddings` is NOT in this schema (it is part of `EnvState` because
 * EMBEDDING_BASE_URL is user-configured); `modelRunner.tcpReachable`
 * is the Docker-Model-Runner-specific reachability check.
 */

import { z } from "zod";

export const modelRunnerStatusSchema = z.enum(["active", "inactive", "unsupported"]);
export type ModelRunnerStatus = z.infer<typeof modelRunnerStatusSchema>;

export const installMethodSchema = z.enum([
  "desktop_download",
  "linux_manual_instructions",
]);
export type InstallMethod = z.infer<typeof installMethodSchema>;

export const installResultKindSchema = z.enum([
  "completed",
  "guided",
  "degraded",
  "user_cancelled",
  "unsupported",
  "failed",
]);
export type InstallResultKind = z.infer<typeof installResultKindSchema>;

export const installResultSchema = z
  .object({
    kind: installResultKindSchema,
    message: z.string(),
    artifactPath: z.string().nullable(),
    fallbackInstructions: z.string().nullable(),
  })
  .strict();
export type InstallResult = z.infer<typeof installResultSchema>;

export const startResultKindSchema = z.enum([
  "started",
  "already_running",
  "user_action_required",
  "unsupported",
  "failed",
]);
export type StartResultKind = z.infer<typeof startResultKindSchema>;

export const startResultSchema = z
  .object({
    kind: startResultKindSchema,
    message: z.string(),
  })
  .strict();
export type StartResult = z.infer<typeof startResultSchema>;

export const installProgressPhaseSchema = z.enum([
  "starting",
  "downloading",
  "installing",
  "verifying",
  "completed",
  "failed",
]);
export type InstallProgressPhase = z.infer<typeof installProgressPhaseSchema>;

export const installProgressSchema = z
  .object({
    phase: installProgressPhaseSchema,
    message: z.string(),
    percent: z.number().min(0).max(100).nullable(),
  })
  .strict();
export type InstallProgress = z.infer<typeof installProgressSchema>;

export const composeUpKindSchema = z.enum([
  "running",
  "reused",
  "port_collision",
  "unhealthy",
  "failed",
]);
export type ComposeUpKind = z.infer<typeof composeUpKindSchema>;

export const composeUpResultSchema = z
  .object({
    kind: composeUpKindSchema,
    composeOutPath: z.string(),
    installId: z.string(),
    message: z.string(),
    previousInstallHoldingPorts: z.boolean(),
  })
  .strict();
export type ComposeUpResult = z.infer<typeof composeUpResultSchema>;

export const stopPreviousInstallStacksResultSchema = z
  .object({
    stoppedCount: z.number().int().nonnegative(),
    message: z.string(),
  })
  .strict();
export type StopPreviousInstallStacksResult = z.infer<
  typeof stopPreviousInstallStacksResultSchema
>;

export const composeDownKindSchema = z.enum(["stopped", "not_running", "failed"]);
export type ComposeDownKind = z.infer<typeof composeDownKindSchema>;

export const composeDownResultSchema = z
  .object({
    kind: composeDownKindSchema,
    message: z.string(),
  })
  .strict();
export type ComposeDownResult = z.infer<typeof composeDownResultSchema>;

export const composeLogStreamSchema = z.enum(["stdout", "stderr"]);
export type ComposeLogStream = z.infer<typeof composeLogStreamSchema>;

export const composeLogSchema = z
  .object({
    stream: composeLogStreamSchema,
    line: z.string(),
    ts: z.number(),
  })
  .strict();
export type ComposeLog = z.infer<typeof composeLogSchema>;

export const dockerEndpointBlockReasonSchema = z.enum([
  "docker_host_unsupported",
  "context_host_unsupported",
  "context_unverified",
]);
export type DockerEndpointBlockReason = z.infer<
  typeof dockerEndpointBlockReasonSchema
>;

export const dockerEndpointPolicySchema = z
  .object({
    accepted: z.boolean(),
    currentContext: z.string().nullable(),
    dockerHostSet: z.boolean(),
    reason: dockerEndpointBlockReasonSchema.nullable(),
    message: z.string().nullable(),
  })
  .strict();
export type DockerEndpointPolicy = z.infer<typeof dockerEndpointPolicySchema>;

/**
 * The authoritative Docker engine state.
 *
 * Replaces the old `present` + `daemon.running` + `failure` booleans, which
 * could not tell "not installed" apart from "installed but the engine is
 * stopped", had no representation at all for "starting", and collapsed a
 * permission denial into a generic failure.
 *
 * - `not_installed`      no Docker CLI was found in any install directory or on PATH.
 * - `engine_stopped`     the CLI is usable, the engine is not answering.
 * - `engine_starting`    the engine is expected to be coming up because Vex
 *                        just started it. This is NOT inferred from a probe;
 *                        see `main/docker/engine-start-window.ts`.
 * - `ready`              the CLI is usable and the daemon answered.
 * - `permission_denied`  the engine endpoint exists and refused this process.
 * - `error`              the check itself could not complete.
 */
export const dockerEngineStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not_installed") }).strict(),
  z.object({ kind: z.literal("engine_stopped") }).strict(),
  z.object({ kind: z.literal("engine_starting") }).strict(),
  z.object({ kind: z.literal("ready") }).strict(),
  z
    .object({ kind: z.literal("permission_denied"), message: z.string() })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      reason: z.enum(["probe_error", "endpoint_rejected"]),
      message: z.string(),
    })
    .strict(),
]);
export type DockerEngineState = z.infer<typeof dockerEngineStateSchema>;

export const dockerCliSourceSchema = z.enum(["install_dir", "path"]);
export type DockerCliSource = z.infer<typeof dockerCliSourceSchema>;

export interface DockerStatusFlags {
  readonly present: boolean;
  readonly runtimeOK: boolean;
  readonly daemonRunning: boolean;
  readonly daemonStartable: boolean;
}

/**
 * The one place the legacy booleans are derived from `engine.state`.
 *
 * They remain on the wire for consumers that have not migrated yet
 * (`renderer/features/systemCheck/**`, `renderer/features/setup/
 * useSetupOrchestrator.ts`) and are removed once those read `state`. New
 * code must branch on `engine.state`, never on these.
 */
export function deriveDockerStatusFlags(
  state: DockerEngineState,
): DockerStatusFlags {
  const installed =
    state.kind !== "not_installed" && state.kind !== "error";
  const ready = state.kind === "ready";
  return {
    present: installed,
    runtimeOK: ready,
    daemonRunning: ready,
    daemonStartable: installed,
  };
}

export const dockerStatusSchema = z
  .object({
    endpoint: dockerEndpointPolicySchema,
    engine: z
      .object({
        state: dockerEngineStateSchema,
        version: z.string().nullable(),
        /** Which strategy located the CLI. The path itself never crosses
         * the process boundary. */
        cliSource: dockerCliSourceSchema.nullable(),
        /** Derived from `state` - see `deriveDockerStatusFlags`. */
        present: z.boolean(),
        /** Derived from `state` - see `deriveDockerStatusFlags`. */
        runtimeOK: z.boolean(),
      })
      .strict(),
    compose: z
      .object({
        present: z.boolean(),
        version: z.string().nullable(),
      })
      .strict(),
    modelRunner: z
      .object({
        present: z.boolean(),
        status: modelRunnerStatusSchema,
        tcpReachable: z.boolean(),
      })
      .strict(),
    daemon: z
      .object({
        /** Derived from `engine.state` - see `deriveDockerStatusFlags`. */
        running: z.boolean(),
        /** Derived from `engine.state` - see `deriveDockerStatusFlags`. */
        startable: z.boolean(),
      })
      .strict(),
    ports: z
      .object({
        vexPgFree: z.boolean(),
      })
      .strict(),
    disk: z
      .object({
        availableGB: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type DockerStatus = z.infer<typeof dockerStatusSchema>;
