/**
 * A REAL MCP STDIO CLIENT against the shipped `vex-mcp` bridge.
 *
 * The owner of one bridge process and its JSON-RPC framing, extracted from
 * `studio-mcp-live.spec.ts` so the acceptance spec reads as the walk it is
 * rather than as a transport implementation. Same seam github-mcp-server draws
 * (`agents-colab/github-mcp-server/e2e/e2e_test.go`): `setupMCPClient` is a
 * helper that owns the client session and hands the test back something it can
 * call tools on, and every test body is assertions. Its README states plainly
 * what the harness proves and what it does not, which is the other half of the
 * pattern and lives in the spec's own header here.
 *
 * Written by hand rather than pulled from a client SDK because the repository
 * ships `@modelcontextprotocol/core` and `/server` and no client package, and a
 * new dependency is outside this walk's ownership. The protocol schemas from
 * `core` still do the validating, so nothing about the wire is asserted from
 * memory.
 *
 * THE CALLER OWNS THE SESSION: `openBridgeSession` returns a handle whose
 * `close` must run in a `finally`, exactly as before the extraction.
 *
 * ## Lifecycle
 *
 * SHUTDOWN follows the MCP specification's own sequence, which is also the one
 * VS Code implements for its stdio servers
 * (`agents-colab/vscode/src/vs/workbench/contrib/mcp/node/mcpStdioStateHandler.ts`,
 * proven by `.../test/node/mcpStdioStateHandler.test.ts`): end stdin, wait a
 * grace period, SIGTERM, wait the same grace again, SIGKILL. Every step AWAITS
 * the child's `close` event, so `close()` resolving means the process is gone
 * and reaped rather than merely signalled. A child still open after SIGKILL
 * makes `close()` THROW, because the only way that happens is a descendant
 * holding the session's stdio, and a caller told nothing would report a clean
 * run over a live pipe.
 *
 * A REQUEST THAT MISSES ITS DEADLINE closes the bridge before it rejects: the
 * peer has already failed its contract, and rejecting alone would leave the
 * caller with a dead request and a live child.
 *
 * BOUNDS: stderr retention and the stdout line-framing buffer both have an
 * explicit byte bound. Stderr uses the bounded-capture policy (leading bytes
 * kept, the rest counted and reported). The framing buffer REJECTS instead: a
 * line longer than the bound is not a big message, it is a peer that never
 * framed, and continuing to buffer it would trade a diagnosis for an
 * out-of-memory.
 *
 * MALFORMED FRAMES are counted, never silently skipped. A frame that is
 * addressed to a request this client is waiting on fails THAT request with the
 * reason; anything else increments a counter that `diagnostics()` reports and
 * that the caller archives beside the run.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { CallToolResultSchema } from "@modelcontextprotocol/core";
import { createBoundedTextCapture } from "./bounded-text-capture.js";

/** How long one MCP request may wait for its response, by default. */
export const MCP_REQUEST_TIMEOUT_MS = 60_000;

/**
 * How long each shutdown step waits before escalating.
 *
 * 10s is the MCP specification's own figure and the VS Code default; the walk
 * has no reason to differ, and tests override it to stay quick.
 */
export const BRIDGE_SHUTDOWN_GRACE_MS = 10_000;

/** Retention bound for the bridge's stderr. Diagnostics, not payload. */
export const BRIDGE_STDERR_LIMIT_BYTES = 1_048_576;

/**
 * The longest single stdout line this client buffers before declaring the peer
 * unframed. Generous next to any tool result the bridge returns, and far below
 * the memory a runaway writer would otherwise take.
 */
export const BRIDGE_MAX_LINE_BYTES = 8_388_608;

/**
 * The MCP revision this client offers.
 *
 * Read from the machine artifact rather than from convention:
 * `node_modules/@modelcontextprotocol/core/dist/auth-CUe6YdwF.mjs` defines
 * `LATEST_PROTOCOL_VERSION = "2025-11-25"`, and
 * `@modelcontextprotocol/server` gates its own priming behaviour on
 * `>= "2025-11-25"`. The constant is not re-exported from either package's
 * entry point, which is why it is spelled here with its source; the negotiated
 * value the server answers with is asserted by the caller rather than assumed.
 */
export const CLIENT_PROTOCOL_VERSION = "2025-11-25";

/** A JSON-RPC 2.0 id, as the specification allows one. */
export type JsonRpcId = number | string;

/**
 * One decoded JSON-RPC response.
 *
 * A discriminated union because the specification's section 5 says a response
 * object carries `result` OR `error`, never both and never neither. Modelling
 * it as two optional fields let a peer that answered both (or answered
 * neither) pass validation and be read as a success, which is the defect this
 * shape removes.
 */
export type JsonRpcResponse =
  | { readonly kind: "result"; readonly id: JsonRpcId; readonly result: unknown }
  | {
      readonly kind: "error";
      readonly id: JsonRpcId;
      readonly code: number;
      readonly message: string;
      readonly data: unknown;
    };

/** What one line of the peer's stdout turned out to be. */
export type JsonRpcFrame =
  | { readonly kind: "response"; readonly response: JsonRpcResponse }
  /** No id: a notification the peer sent us, not an answer to anything. */
  | { readonly kind: "notification"; readonly method: string }
  /** Structurally wrong. `id` is present when the frame still named one. */
  | { readonly kind: "malformed"; readonly id: JsonRpcId | undefined; readonly reason: string };

const jsonRpcIdSchema = z.union([z.number(), z.string()]);
const jsonRpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});
const jsonRpcEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: jsonRpcIdSchema.optional(),
    method: z.string().optional(),
  })
  .loose();

/**
 * Decide what a parsed stdout line is, without touching any session state.
 *
 * Pure on purpose: the discrimination rule is the part worth a table test, and
 * that test must not have to spawn a process. `value` is whatever `JSON.parse`
 * produced.
 */
export function readJsonRpcFrame(value: unknown): JsonRpcFrame {
  const asRecord = z.record(z.string(), z.unknown()).safeParse(value);
  if (!asRecord.success || Array.isArray(value)) {
    return { kind: "malformed", id: undefined, reason: "the line is not a JSON object" };
  }
  const record = asRecord.data;
  const envelope = jsonRpcEnvelopeSchema.safeParse(record);
  if (!envelope.success) {
    const id = jsonRpcIdSchema.safeParse(record["id"]);
    return {
      kind: "malformed",
      id: id.success ? id.data : undefined,
      reason: 'the frame is not a JSON-RPC 2.0 envelope (no `jsonrpc: "2.0"`, or a non-scalar id)',
    };
  }
  const id = envelope.data.id;
  const hasResult = Object.hasOwn(record, "result");
  const hasError = Object.hasOwn(record, "error");
  if (id === undefined) {
    if (envelope.data.method !== undefined && !hasResult && !hasError) {
      return { kind: "notification", method: envelope.data.method };
    }
    return { kind: "malformed", id: undefined, reason: "a response frame carries no `id`" };
  }
  if (hasResult && hasError) {
    return { kind: "malformed", id, reason: "the frame carries both `result` and `error`" };
  }
  if (!hasResult && !hasError) {
    return { kind: "malformed", id, reason: "the frame carries neither `result` nor `error`" };
  }
  if (hasError) {
    const failure = jsonRpcErrorSchema.safeParse(record["error"]);
    if (!failure.success) {
      return { kind: "malformed", id, reason: "the `error` member has no numeric code and message" };
    }
    return {
      kind: "response",
      response: {
        kind: "error",
        id,
        code: failure.data.code,
        message: failure.data.message,
        data: failure.data.data,
      },
    };
  }
  return { kind: "response", response: { kind: "result", id, result: record["result"] } };
}

/** The installed `[mcp_servers.vex]` block, as the installer's key allowlist writes it. */
const installedVexEntrySchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  tool_timeout_sec: z.number(),
});

export type InstalledVexEntry = z.infer<typeof installedVexEntrySchema>;

/** The `[mcp_servers.vex]` entry the installer wrote, parsed by a real TOML parser. */
export function readInstalledVexEntry(configTomlPath: string): InstalledVexEntry {
  const document = parseToml(fs.readFileSync(configTomlPath, "utf8"));
  const servers = z
    .object({ mcp_servers: z.object({ vex: z.unknown() }) })
    .safeParse(document);
  if (!servers.success) {
    throw new Error(
      `${configTomlPath} carries no [mcp_servers.vex] section; the installer ` +
        "writes one for every project whose agent selection includes Codex CLI",
    );
  }
  return installedVexEntrySchema.parse(servers.data.mcp_servers.vex);
}

/** Text content joined out of an MCP tool result. */
export function toolResultText(result: z.infer<typeof CallToolResultSchema>): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("\n");
}

/** What the transport saw that the assertions never look at directly. */
export interface BridgeDiagnostics {
  /** Stdout lines that were not JSON at all. */
  readonly nonJsonLines: number;
  /** JSON lines that were not a usable JSON-RPC response frame. */
  readonly malformedFrames: number;
  /** Server-to-client notifications, which are normal and are not answers. */
  readonly notifications: number;
  /** Response frames whose id matched no in-flight request. */
  readonly uncorrelatedResponses: number;
  /** Stderr bytes past the retention bound. */
  readonly droppedStderrBytes: number;
  /**
   * How the child ended, or null while it is still running.
   *
   * The fact that makes `close()` checkable without a clock: a session that
   * only signalled and returned reports `null` here, and one that waited out
   * the escalation reports the signal that ended the peer.
   */
  readonly exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null;
}

/** One live stdio session against the bridge binary. The caller owns `close`. */
export interface BridgeSession {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): void;
  /** Everything the bridge wrote to stderr, for the failure report. */
  stderr(): string;
  /** Framing and correlation counters, for the evidence archive. */
  diagnostics(): BridgeDiagnostics;
  close(): Promise<void>;
}

/** Tunables the acceptance walk leaves at their defaults and tests shorten. */
export interface BridgeSessionOptions {
  readonly shutdownGraceMs?: number;
  readonly maxLineBytes?: number;
  readonly maxStderrBytes?: number;
  readonly requestTimeoutMs?: number;
}

interface PendingWaiter {
  resolve(value: unknown): void;
  reject(cause: Error): void;
}

/**
 * Spawn the bridge exactly as the installed config names it and speak
 * newline-delimited JSON-RPC to it, which is the MCP stdio transport.
 */
export function openBridgeSession(
  entry: InstalledVexEntry,
  env: Readonly<Record<string, string>>,
  options: BridgeSessionOptions = {},
): BridgeSession {
  const shutdownGraceMs = options.shutdownGraceMs ?? BRIDGE_SHUTDOWN_GRACE_MS;
  const maxLineBytes = options.maxLineBytes ?? BRIDGE_MAX_LINE_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? BRIDGE_STDERR_LIMIT_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? MCP_REQUEST_TIMEOUT_MS;

  const child = spawn(entry.command, [...entry.args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  const pending = new Map<number, PendingWaiter>();
  let nextId = 1;
  let stdoutBuffer = "";
  const stderrCapture = createBoundedTextCapture("vex-mcp stderr", maxStderrBytes);
  let closed: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let framingViolation: string | null = null;
  let nonJsonLines = 0;
  let malformedFrames = 0;
  let notifications = 0;
  let uncorrelatedResponses = 0;

  const stderrText = (): string => {
    const report = stderrCapture.dropReport();
    return report === "" ? stderrCapture.text() : `${stderrCapture.text()}\n${report}\n`;
  };

  // The method each id was sent for, so a JSON-RPC error names what failed.
  const methods = new Map<number, string>();
  const methodOf = (id: JsonRpcId): string =>
    typeof id === "number" ? methods.get(id) ?? `request ${String(id)}` : String(id);

  const failAllPending = (cause: Error): void => {
    for (const waiter of pending.values()) waiter.reject(cause);
    pending.clear();
  };

  /**
   * Hand a frame to the request that is waiting for it.
   *
   * Returns false when nothing was waiting, which the caller counts rather
   * than ignores: every id this client mints is a number, so a string id or an
   * unknown number belongs to no request it made.
   */
  const settle = (id: JsonRpcId, settleWith: (waiter: PendingWaiter) => void): boolean => {
    if (typeof id !== "number") return false;
    const waiter = pending.get(id);
    if (waiter === undefined) return false;
    pending.delete(id);
    settleWith(waiter);
    return true;
  };

  const handleLine = (line: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A non-JSON line on an MCP stdio stream is the server's own noise. It is
      // counted and kept with the stderr evidence rather than thrown away.
      nonJsonLines += 1;
      stderrCapture.append(`[stdout non-json] ${line}\n`);
      return;
    }
    const frame = readJsonRpcFrame(parsed);
    if (frame.kind === "notification") {
      notifications += 1;
      return;
    }
    if (frame.kind === "malformed") {
      malformedFrames += 1;
      stderrCapture.append(`[stdout malformed frame] ${frame.reason}: ${line}\n`);
      const id = frame.id;
      if (id !== undefined) {
        settle(id, (waiter) => {
          waiter.reject(
            new Error(
              `${methodOf(id)}: the server's response frame is malformed - ${frame.reason}`,
            ),
          );
        });
      }
      return;
    }
    const response = frame.response;
    const correlated = settle(response.id, (waiter) => {
      if (response.kind === "error") {
        waiter.reject(
          new Error(
            `${methodOf(response.id)}: the server answered error ` +
              `${String(response.code)}: ${response.message}`,
          ),
        );
        return;
      }
      waiter.resolve(response.result);
    });
    if (!correlated) uncorrelatedResponses += 1;
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (framingViolation !== null) return;
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line === "") continue;
      handleLine(line);
    }
    // REJECT, not truncate: a pending line past the bound means the peer is not
    // framing, and buffering more of it would replace a diagnosis with an OOM.
    const pendingBytes = Buffer.byteLength(stdoutBuffer, "utf8");
    if (pendingBytes > maxLineBytes) {
      framingViolation =
        `the vex-mcp bridge wrote ${String(pendingBytes)} bytes with no newline, past the ` +
        `${String(maxLineBytes)}-byte line bound; the stdio transport is newline-delimited JSON-RPC`;
      stdoutBuffer = "";
      failAllPending(new Error(`${framingViolation}. Its stderr:\n${stderrText()}`));
      child.kill("SIGKILL");
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrCapture.append(chunk);
  });

  // `close` rather than `exit`: it fires once the process is gone AND its stdio
  // is drained, which is what "the child is finished" has to mean here.
  child.on("close", (code, signal) => {
    closed = { code, signal };
    failAllPending(
      new Error(
        `the vex-mcp bridge exited (code ${String(code)}, signal ${String(signal)}) ` +
          `before answering. Its stderr:\n${stderrText()}`,
      ),
    );
  });
  child.on("error", (cause: Error) => {
    failAllPending(new Error(`the vex-mcp bridge could not be spawned: ${cause.message}`));
  });

  const write = (payload: Record<string, unknown>): void => {
    if (closed !== null) {
      throw new Error(`the vex-mcp bridge has already exited; its stderr:\n${stderrText()}`);
    }
    if (framingViolation !== null) throw new Error(framingViolation);
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  /** Resolves true when the child has closed, false when `ms` elapsed first. */
  const waitForClose = async (ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (closed !== null) {
        resolve(true);
        return;
      }
      const onClose = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.removeListener("close", onClose);
        resolve(false);
      }, ms);
      timer.unref();
      child.once("close", onClose);
    });

  /**
   * End stdin, then SIGTERM, then SIGKILL, AWAITING `close` at every step.
   *
   * The MCP shutdown sequence, as VS Code implements it for the same transport.
   * Returning means the child is gone and reaped, so a caller's `finally` can
   * be trusted to have left no process behind.
   *
   * A child that has not closed even after SIGKILL THROWS rather than returning
   * quietly: SIGKILL cannot be ignored, so a missing `close` means the process
   * group still holds this session's stdio - a descendant it spawned outlives
   * it - and a caller told nothing would report a clean run over a live pipe.
   */
  const closeBridge = async (): Promise<void> => {
    if (closed !== null) return;
    try {
      child.stdin.end();
    } catch {
      // An stdin already in an error state is not a reason to skip the rest
      // of the sequence; the signals below still have to run.
    }
    if (await waitForClose(shutdownGraceMs)) return;
    child.kill("SIGTERM");
    if (await waitForClose(shutdownGraceMs)) return;
    child.kill("SIGKILL");
    if (await waitForClose(shutdownGraceMs)) return;
    throw new Error(
      `the vex-mcp bridge (pid ${String(child.pid)}) did not close within ` +
        `${String(shutdownGraceMs)}ms of SIGKILL; SIGKILL cannot be ignored, so a ` +
        "descendant it spawned is still holding this session's stdio and has to be " +
        `ended by hand. Its stderr:\n${stderrText()}`,
    );
  };

  return {
    async request(method, params) {
      const id = nextId;
      nextId += 1;
      methods.set(id, method);
      const answer = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      write({ jsonrpc: "2.0", id, method, params });
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          pending.delete(id);
          // A bridge that missed its deadline is UNHEALTHY, and leaving it
          // running would hand the caller a rejected request and a live child
          // still holding this run's pipes. So the rejection waits for the
          // shutdown sequence, exactly as the timeout path in
          // `codex-live-runner.ts` does, and reports a cleanup that failed
          // instead of hiding it behind the deadline.
          void (async () => {
            let cleanup = "the bridge has been closed";
            try {
              await closeBridge();
            } catch (cause) {
              cleanup = `closing the bridge then FAILED: ${cause instanceof Error ? cause.message : String(cause)}`;
            }
            reject(
              new Error(
                `${method} did not answer within ${String(requestTimeoutMs)}ms; ` +
                  `${cleanup}. The bridge's stderr so far:\n${stderrText()}`,
              ),
            );
          })();
        }, requestTimeoutMs);
      });
      try {
        return await Promise.race([answer, deadline]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    notify(method, params) {
      write({ jsonrpc: "2.0", method, params });
    },
    stderr() {
      return stderrText();
    },
    diagnostics() {
      return {
        nonJsonLines,
        malformedFrames,
        notifications,
        uncorrelatedResponses,
        droppedStderrBytes: stderrCapture.droppedBytes(),
        exit: closed,
      };
    },
    close: closeBridge,
  };
}
