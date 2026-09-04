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
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { CallToolResultSchema } from "@modelcontextprotocol/core";

/** How long one MCP request may wait for its response. */
export const MCP_REQUEST_TIMEOUT_MS = 60_000;

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

/**
 * The JSON-RPC envelope, validated before the payload inside it is handed to a
 * protocol schema. Two boundaries, two validations: this one proves the frame
 * is a response to OUR request, the protocol schema proves the result is the
 * shape the specification names.
 */
const jsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
    .optional(),
});

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

/** One live stdio session against the bridge binary. The caller owns `close`. */
export interface BridgeSession {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): void;
  /** Everything the bridge wrote to stderr, for the failure report. */
  stderr(): string;
  close(): Promise<void>;
}

/**
 * Spawn the bridge exactly as the installed config names it and speak
 * newline-delimited JSON-RPC to it, which is the MCP stdio transport.
 */
export function openBridgeSession(
  entry: InstalledVexEntry,
  env: Readonly<Record<string, string>>,
): BridgeSession {
  const child = spawn(entry.command, [...entry.args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  const pending = new Map<number, { resolve(value: unknown): void; reject(cause: Error): void }>();
  let nextId = 1;
  let stdoutBuffer = "";
  let stderrText = "";
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  // The method each id was sent for, so a JSON-RPC error names what failed.
  const methods = new Map<number, string>();
  const methodOf = (id: number | string): string =>
    typeof id === "number" ? methods.get(id) ?? `request ${String(id)}` : String(id);

  const failAllPending = (cause: Error): void => {
    for (const waiter of pending.values()) waiter.reject(cause);
    pending.clear();
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A non-JSON line on an MCP stdio stream is the server's own noise;
        // it is kept with the stderr evidence rather than thrown away.
        stderrText += `[stdout non-json] ${line}\n`;
        continue;
      }
      const framed = jsonRpcResponseSchema.safeParse(parsed);
      // A notification from the server carries no `id` and is not an answer to
      // anything this client asked; it is not an error either.
      if (!framed.success) continue;
      // Every id this client mints is a number, so a string id belongs to
      // nothing it is waiting for.
      const id = framed.data.id;
      if (typeof id !== "number") continue;
      const waiter = pending.get(id);
      if (waiter === undefined) continue;
      pending.delete(id);
      if (framed.data.error !== undefined) {
        waiter.reject(
          new Error(
            `${methodOf(id)}: the server answered error ` +
              `${String(framed.data.error.code)}: ${framed.data.error.message}`,
          ),
        );
        continue;
      }
      waiter.resolve(framed.data.result);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrText += chunk;
  });

  child.on("exit", (code, signal) => {
    exited = { code, signal };
    failAllPending(
      new Error(
        `the vex-mcp bridge exited (code ${String(code)}, signal ${String(signal)}) ` +
          `before answering. Its stderr:\n${stderrText}`,
      ),
    );
  });
  child.on("error", (cause: Error) => {
    failAllPending(new Error(`the vex-mcp bridge could not be spawned: ${cause.message}`));
  });

  const write = (payload: Record<string, unknown>): void => {
    if (exited !== null) {
      throw new Error(`the vex-mcp bridge has already exited; its stderr:\n${stderrText}`);
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
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
          reject(
            new Error(
              `${method} did not answer within ${String(MCP_REQUEST_TIMEOUT_MS)}ms. ` +
                `The bridge's stderr so far:\n${stderrText}`,
            ),
          );
        }, MCP_REQUEST_TIMEOUT_MS);
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
      return stderrText;
    },
    async close() {
      if (exited !== null) return;
      child.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        timer.unref();
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
