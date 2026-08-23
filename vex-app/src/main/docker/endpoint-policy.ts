import { runSpawn } from "./spawn-runner.js";

export type DockerEndpointBlockReason =
  | "docker_host_unsupported"
  | "context_host_unsupported"
  | "context_unverified";

export interface DockerEndpointPolicy {
  readonly accepted: boolean;
  readonly currentContext: string | null;
  readonly dockerHostSet: boolean;
  readonly reason: DockerEndpointBlockReason | null;
  readonly message: string | null;
}

interface ClassifyEndpointInput {
  readonly dockerHost: string | null;
  readonly currentContext: string | null;
  readonly contextHost: string | null;
  readonly contextInspectable: boolean;
  readonly dockerCliAvailable: boolean;
}

const CONTEXT_TIMEOUT_MS = 5_000;

function normalizeDockerHost(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function parseDockerContextHost(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed === "null") return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" && parsed.length > 0 ? parsed : null;
  } catch {
    return trimmed;
  }
}

export function isAcceptedLocalDockerHost(host: string | null): boolean {
  if (host === null) return true;
  const lower = host.toLowerCase();
  return (
    lower.startsWith("unix://") ||
    lower.startsWith("npipe://") ||
    lower.startsWith("fd://")
  );
}

export function classifyDockerEndpoint(
  input: ClassifyEndpointInput
): DockerEndpointPolicy {
  const dockerHostSet = input.dockerHost !== null;
  if (!isAcceptedLocalDockerHost(input.dockerHost)) {
    return {
      accepted: false,
      currentContext: input.currentContext,
      dockerHostSet,
      reason: "docker_host_unsupported",
      message:
        "DOCKER_HOST points at an unsupported or remote Docker endpoint. Clear DOCKER_HOST and use a local Docker Desktop or Docker Engine context, then retry.",
    };
  }

  if (!input.dockerCliAvailable) {
    return {
      accepted: true,
      currentContext: null,
      dockerHostSet,
      reason: null,
      message: null,
    };
  }

  if (!input.contextInspectable) {
    return {
      accepted: false,
      currentContext: input.currentContext,
      dockerHostSet,
      reason: "context_unverified",
      message:
        "Vex could not verify that the active Docker context is local. Switch to a local Docker context and retry.",
    };
  }

  if (!isAcceptedLocalDockerHost(input.contextHost)) {
    return {
      accepted: false,
      currentContext: input.currentContext,
      dockerHostSet,
      reason: "context_host_unsupported",
      message:
        "The active Docker context points at a remote Docker endpoint. Switch to a local Docker Desktop or Docker Engine context and retry.",
    };
  }

  return {
    accepted: true,
    currentContext: input.currentContext,
    dockerHostSet,
    reason: null,
    message: null,
  };
}

/**
 * @param dockerCommand absolute path to the located Docker CLI, or `null`
 * when no CLI was found. Passing `null` skips the spawns entirely rather
 * than spending two ENOENT round-trips to learn what the locator already
 * established.
 */
export async function inspectDockerEndpointPolicy(
  signal?: AbortSignal,
  dockerCommand: string | null = "docker"
): Promise<DockerEndpointPolicy> {
  if (dockerCommand === null) {
    return classifyDockerEndpoint({
      dockerHost: normalizeDockerHost(process.env.DOCKER_HOST),
      currentContext: null,
      contextHost: null,
      contextInspectable: false,
      dockerCliAvailable: false,
    });
  }
  const [contextShow, contextHost] = await Promise.all([
    runSpawn(dockerCommand, ["context", "show"], {
      ...(signal !== undefined ? { signal } : {}),
      timeoutMs: CONTEXT_TIMEOUT_MS,
    }),
    runSpawn(
      dockerCommand,
      ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
      {
        ...(signal !== undefined ? { signal } : {}),
        timeoutMs: CONTEXT_TIMEOUT_MS,
      }
    ),
  ]);

  const currentContext =
    contextShow.code === 0 ? contextShow.stdout.trim() || null : null;
  const dockerCliAvailable = contextShow.code === 0 || contextHost.code === 0;
  return classifyDockerEndpoint({
    dockerHost: normalizeDockerHost(process.env.DOCKER_HOST),
    currentContext,
    contextHost:
      contextHost.code === 0 ? parseDockerContextHost(contextHost.stdout) : null,
    contextInspectable: contextHost.code === 0,
    dockerCliAvailable,
  });
}
