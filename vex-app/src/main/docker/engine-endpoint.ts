/**
 * Docker Engine liveness, probed WITHOUT the Docker CLI.
 *
 * `docker info` can only answer "is the daemon up" when a working CLI is
 * already located; this connects to the engine's local endpoint directly so
 * the two questions ("is Docker installed" and "is the engine answering")
 * stop sharing one boolean.
 *
 * IMPORTANT - this is a HINT, not a decision procedure. `DOCKER_HOST` and
 * Docker contexts can move the endpoint anywhere, so a user with a custom
 * context will fail this probe while having a perfectly reachable engine.
 * Callers must therefore never let `not_running` override a successful
 * `docker info`; only `permission_denied` is used to sharpen a failure that
 * the CLI already reported.
 *
 * The connection outcome is triaged into distinct states because collapsing
 * "nothing is listening", "the socket denied us", and "something else went
 * wrong" into one failure is exactly the error class this task exists to
 * remove.
 */

import { createConnection, type Socket } from "node:net";
import path from "node:path";

export type DockerEngineReachability =
  | { readonly kind: "reachable"; readonly endpoint: string }
  | { readonly kind: "not_running" }
  | { readonly kind: "permission_denied"; readonly endpoint: string }
  | { readonly kind: "unknown"; readonly errorCode: string | null };

const CONNECT_TIMEOUT_MS = 1_500;

/**
 * The DOCUMENTED default local endpoints, in probe order.
 *
 * Windows: `\\.\pipe\docker_engine` is still moby's `DefaultNamedPipe`.
 * macOS/Linux: Docker Desktop's per-user socket is tried before
 * `/var/run/docker.sock`, which on Desktop installs only exists when the
 * user enabled the default-socket option.
 */
export function defaultDockerEngineEndpoints(ctx: {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
}): ReadonlyArray<string> {
  if (ctx.platform === "win32") return ["\\\\.\\pipe\\docker_engine"];
  if (ctx.platform === "darwin") {
    return [
      path.posix.join(ctx.homedir, ".docker/run/docker.sock"),
      "/var/run/docker.sock",
    ];
  }
  if (ctx.platform === "linux") {
    return [
      "/var/run/docker.sock",
      path.posix.join(ctx.homedir, ".docker/desktop/docker.sock"),
    ];
  }
  return [];
}

export function classifyConnectError(
  code: string | null,
  endpoint: string,
): DockerEngineReachability {
  switch (code) {
    // Nothing is listening: pipe/socket absent, or present but refusing.
    case "ENOENT":
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "EPIPE":
      return { kind: "not_running" };
    // The endpoint exists and the OS refused this process.
    case "EACCES":
    case "EPERM":
      return { kind: "permission_denied", endpoint };
    default:
      return { kind: "unknown", errorCode: code };
  }
}

/** Connects once to a single endpoint and triages the outcome. */
export function probeEngineEndpointOnce(
  endpoint: string,
  signal?: AbortSignal,
  timeoutMs: number = CONNECT_TIMEOUT_MS,
): Promise<DockerEngineReachability> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: Socket | null = null;
    const settle = (result: DockerEngineReachability): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket?.removeAllListeners();
      socket?.destroy();
      resolve(result);
    };
    const onAbort = (): void => settle({ kind: "unknown", errorCode: null });
    const timer = setTimeout(
      // A connect that never completes is "alive but not answering", which
      // is neither reachable nor proof that nothing is there.
      () => settle({ kind: "unknown", errorCode: "ETIMEDOUT" }),
      timeoutMs,
    );
    if (signal?.aborted === true) {
      settle({ kind: "unknown", errorCode: null });
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      socket = createConnection({ path: endpoint });
    } catch (cause) {
      const code =
        cause && typeof cause === "object" && "code" in cause
          ? String((cause as { code: unknown }).code)
          : null;
      settle(classifyConnectError(code, endpoint));
      return;
    }
    socket.once("connect", () => settle({ kind: "reachable", endpoint }));
    socket.once("error", (cause: NodeJS.ErrnoException) => {
      settle(classifyConnectError(cause.code ?? null, endpoint));
    });
  });
}

/**
 * Probes the documented default endpoints in order and returns the most
 * informative outcome: a reachable endpoint wins, then a permission denial,
 * then any unknown error, and only otherwise "not running".
 */
export async function probeDockerEngineEndpoint(ctx: {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly signal?: AbortSignal;
  readonly connect?: (
    endpoint: string,
    signal?: AbortSignal,
  ) => Promise<DockerEngineReachability>;
}): Promise<DockerEngineReachability> {
  const connect = ctx.connect ?? probeEngineEndpointOnce;
  const endpoints = defaultDockerEngineEndpoints(ctx);
  let fallback: DockerEngineReachability = { kind: "not_running" };
  for (const endpoint of endpoints) {
    const result = await connect(endpoint, ctx.signal);
    if (result.kind === "reachable") return result;
    if (result.kind === "permission_denied") return result;
    if (result.kind === "unknown" && fallback.kind === "not_running") {
      fallback = result;
    }
  }
  return fallback;
}
