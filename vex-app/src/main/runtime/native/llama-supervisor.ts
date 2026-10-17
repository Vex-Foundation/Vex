/**
 * Supervises the bundled `llama-server` (llama.cpp b9115) that serves the
 * embeddings model for the native runtime.
 *
 * Launch, exactly as the Phase 0 gates verified it:
 *
 *   - `--port 0` on 127.0.0.1. The bound port is logged once, AFTER the model
 *     has loaded (`main: server is listening on http://127.0.0.1:<port>`), so
 *     that line is both the port and the ready signal.
 *   - A per-launch API key in `LLAMA_API_KEY`: an orphan from a previous run
 *     answers nobody. `/health` and `/v1/models` stay public, so readiness is
 *     confirmed with a real `/v1/embeddings` call (alias + dimension).
 *   - A minimal environment. llama-server reads every `LLAMA_ARG_*` variable
 *     and `AIP_*` can move its port, so the developer's shell never leaks in.
 *     `LLAMA_CACHE` is required: on macOS b9115 dereferences a NULL `$HOME`
 *     without it and dies with SIGSEGV. Nothing is written there (--offline).
 *   - `cwd` = the binary's directory: ggml looks for its CPU backend modules
 *     next to the executable and then in the current directory.
 *
 * The server is stateless, so stopping is SIGTERM (TerminateProcess on
 * Windows) and, past the deadline, SIGKILL.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { buildEmbeddingBaseUrl, EMBEDDING_DIM, EMBEDDING_MODEL_ALIAS } from "@shared/embedding-defaults.js";
import { log } from "../../logger/index.js";

/** How long the model may take to load before the launch counts as failed. */
const READY_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 30_000;
const STOP_DEADLINE_MS = 5_000;

/**
 * Same arithmetic as the Studio front and the terminal host (VS Code's): a
 * counter from 0 restarts while `<= 5`, so six restarts, and it never resets.
 */
export const LLAMA_MAX_RESTARTS = 5;

const LISTENING = /^main: server is listening on http:\/\/127\.0\.0\.1:(\d+)\s*$/;

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface LlamaLaunch {
  /** Absolute path of the bundled llama-server executable. */
  readonly binaryPath: string;
  /** Absolute path of the verified GGUF (see model-store.ts). */
  readonly modelPath: string;
  /** Directory handed to LLAMA_CACHE; must exist. */
  readonly cacheDir: string;
}

export interface LlamaEndpoint {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly port: number;
}

export type LlamaStartResult =
  | { readonly kind: "ready"; readonly endpoint: LlamaEndpoint }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Plan D9: min(4, cores / 2), at least 1, so the embeddings server never
 * competes with the UI and the agent for the whole machine. ggml's threadpool
 * spin-waits, so more threads than cores is drastically slower, never faster.
 */
export function embeddingThreads(cores: number = os.availableParallelism()): number {
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

export function llamaArgs(modelPath: string, threads: number): string[] {
  return [
    "--model", modelPath,
    "--embeddings",
    "--alias", EMBEDDING_MODEL_ALIAS,
    "--host", "127.0.0.1",
    "--port", "0",
    "--device", "none",
    "-ngl", "0",
    "-np", "1",
    "-t", String(threads),
    "-tb", String(threads),
    "--no-webui",
    "--offline",
  ];
}

/** The ONLY environment the server sees. */
export function llamaEnv(
  apiKey: string,
  cacheDir: string,
  platform: NodeJS.Platform = process.platform,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = { LLAMA_API_KEY: apiKey, LLAMA_CACHE: cacheDir };
  if (platform === "win32") {
    // DLL loading and the C runtime need these on Windows.
    for (const key of ["SystemRoot", "WINDIR"]) {
      const value = parentEnv[key];
      if (value !== undefined) env[key] = value;
    }
  }
  return env;
}

export function parseListeningPort(line: string): number | null {
  const match = LISTENING.exec(line);
  if (match === null) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

/** One real embedding through the key: proves the alias, the dimension and auth. */
export async function probeEmbeddings(endpoint: LlamaEndpoint): Promise<string | null> {
  try {
    const res = await fetch(`${endpoint.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({ input: "vex", model: EMBEDDING_MODEL_ALIAS }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return `embeddings probe returned HTTP ${res.status}`;
    const body = (await res.json()) as { model?: unknown; data?: Array<{ embedding?: unknown }> };
    if (body.model !== EMBEDDING_MODEL_ALIAS) return `embeddings probe reported model ${String(body.model)}`;
    const vector = body.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIM) {
      return `embeddings probe returned ${Array.isArray(vector) ? vector.length : "no"} dimensions, expected ${EMBEDDING_DIM}`;
    }
    return null;
  } catch (error) {
    return `embeddings probe failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

interface LiveServer {
  readonly child: ChildProcess;
  readonly endpoint: LlamaEndpoint;
  readonly exited: Promise<void>;
}

/** Spawn one server and wait until it listens and answers a real embedding. */
async function launch(
  config: LlamaLaunch,
  spawnFn: SpawnFn,
  threads: number,
): Promise<{ readonly kind: "ready"; readonly live: LiveServer } | { readonly kind: "failed"; readonly reason: string }> {
  const apiKey = randomBytes(24).toString("hex");
  const child = spawnFn(config.binaryPath, llamaArgs(config.modelPath, threads), {
    cwd: path.dirname(config.binaryPath),
    env: llamaEnv(apiKey, config.cacheDir),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  const tail: string[] = [];
  const port = await new Promise<number | string>((resolve) => {
    const timer = setTimeout(() => resolve(`no listening line within ${READY_TIMEOUT_MS} ms`), READY_TIMEOUT_MS);
    let buffered = "";
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        tail.push(line);
        if (tail.length > 20) tail.shift();
        const found = parseListeningPort(line);
        if (found !== null) {
          clearTimeout(timer);
          resolve(found);
        }
        newline = buffered.indexOf("\n");
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve(`spawn failed: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(`exited before listening (code ${String(code)}, signal ${String(signal)})`);
    });
  });

  if (typeof port === "string") {
    child.kill("SIGKILL");
    return { kind: "failed", reason: `${port}; last output: ${tail.slice(-5).join(" | ")}` };
  }
  const endpoint: LlamaEndpoint = { baseUrl: buildEmbeddingBaseUrl(port), apiKey, port };
  const probeFailure = await probeEmbeddings(endpoint);
  if (probeFailure !== null) {
    child.kill("SIGKILL");
    return { kind: "failed", reason: probeFailure };
  }
  return { kind: "ready", live: { child, endpoint, exited } };
}

export interface LlamaSupervisorOptions {
  readonly launch: LlamaLaunch;
  /** Called with the new endpoint after every (re)start, and null when it is gone. */
  readonly onEndpoint: (endpoint: LlamaEndpoint | null) => void;
  /** Called once the restart budget is spent. */
  readonly onUnhealthy: (reason: string) => void;
  readonly spawn?: SpawnFn;
  readonly threads?: number;
  /** Delay before restart N (1-based); grows so a crash loop does not spin. */
  readonly restartDelayMs?: (attempt: number) => number;
}

export class LlamaSupervisor {
  private live: LiveServer | null = null;
  private restartCount = 0;
  private stopping = false;
  private readonly spawnFn: SpawnFn;
  private readonly threads: number;

  constructor(private readonly options: LlamaSupervisorOptions) {
    this.spawnFn = options.spawn ?? nodeSpawn;
    this.threads = options.threads ?? embeddingThreads();
  }

  /** The running server's PID, for diagnostics; undefined while none runs. */
  get pid(): number | undefined {
    return this.live?.child.pid;
  }

  async start(): Promise<LlamaStartResult> {
    this.stopping = false;
    const result = await launch(this.options.launch, this.spawnFn, this.threads);
    if (result.kind === "failed") return result;
    this.adopt(result.live);
    return { kind: "ready", endpoint: result.live.endpoint };
  }

  async stop(deadlineMs: number = STOP_DEADLINE_MS): Promise<void> {
    this.stopping = true;
    const live = this.live;
    this.live = null;
    if (live === null) return;
    this.options.onEndpoint(null);
    live.child.kill("SIGTERM");
    const gone = await Promise.race([
      live.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), deadlineMs)),
    ]);
    if (!gone) {
      log.warn("[runtime:llama] llama-server ignored SIGTERM; killing it");
      live.child.kill("SIGKILL");
      await live.exited;
    }
  }

  private adopt(live: LiveServer): void {
    this.live = live;
    this.options.onEndpoint(live.endpoint);
    void live.exited.then(() => {
      if (this.live !== live || this.stopping) return;
      this.live = null;
      this.options.onEndpoint(null);
      void this.restart();
    });
  }

  private async restart(): Promise<void> {
    while (!this.stopping) {
      if (this.restartCount > LLAMA_MAX_RESTARTS) {
        this.options.onUnhealthy("llama-server restart budget exhausted");
        return;
      }
      this.restartCount += 1;
      log.error(`[runtime:llama] restarting llama-server (attempt ${String(this.restartCount)})`);
      const delay = this.options.restartDelayMs?.(this.restartCount) ?? 500 * this.restartCount;
      await new Promise((r) => setTimeout(r, delay));
      if (this.stopping) return;
      const result = await launch(this.options.launch, this.spawnFn, this.threads);
      if (result.kind === "ready") {
        if (this.stopping) {
          result.live.child.kill("SIGTERM");
          return;
        }
        this.adopt(result.live);
        return;
      }
      log.error(`[runtime:llama] restart failed: ${result.reason}`);
    }
  }
}
