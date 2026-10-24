/**
 * The MCP client for the user's own servers (F12): Streamable HTTP only.
 *
 * Every operation opens a fresh client, runs, and closes inside one budget
 * (`OPERATION_TIMEOUT_MS`) shared by the handshake and the call, through the
 * guarded fetch from `egress.ts`. There is no SSE fallback and no stdio
 * transport: nothing here may spawn a process or open another channel.
 *
 * LISTING walks pages with explicit cursors and stops at
 * `MAX_TOOLS_PER_SERVER`; it reads `annotations.readOnlyHint === true` only.
 * CALLING keeps text parts, falls back to `structuredContent` as JSON, and cuts
 * the text to `MAX_RESULT_CHARS`. A result the server flags `isError` comes
 * back as a failure, its text still capped.
 */

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  classifyFailure,
  createUserMcpFetch,
  UserMcpEndpointError,
  type UserMcpConnection,
  type UserMcpFetchDeps,
  type UserMcpRefusalCode,
} from "./egress.js";
import { MAX_RESULT_CHARS, MAX_TOOLS_PER_SERVER, OPERATION_TIMEOUT_MS } from "./limits.js";

export interface RemoteTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly readOnlyHint: boolean;
}

export interface RemoteCallResult {
  /** The server flagged the result as an error. */
  readonly isError: boolean;
  readonly text: string;
  readonly truncated: boolean;
}

/** An operation failed; `code` is a bounded refusal word, never server text. */
export class UserMcpOperationError extends Error {
  override readonly name = "UserMcpOperationError";
  readonly code: UserMcpRefusalCode;
  constructor(code: UserMcpRefusalCode, cause?: unknown) {
    super(`user MCP operation failed: ${code}`, cause === undefined ? undefined : { cause });
    this.code = code;
  }
}

export interface ClientOptions extends UserMcpFetchDeps {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const CLIENT_INFO = { name: "vex", version: "1.0.0" } as const;

async function withClient<T>(
  conn: UserMcpConnection,
  options: ClientOptions,
  fn: (client: Client, signal: AbortSignal, timeoutMs: number) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? OPERATION_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const handle = createUserMcpFetch(conn, options);
  const client = new Client(CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(conn.endpoint), {
    fetch: handle.fetch,
    requestInit: { redirect: "error" },
    redirectPolicy: "same-origin",
  });
  try {
    await client.connect(transport, { timeout: timeoutMs, signal });
    return await fn(client, signal, timeoutMs);
  } catch (error) {
    if (error instanceof UserMcpOperationError) throw error;
    throw new UserMcpOperationError(classifyFailure(error, handle.sawUnauthorized()), error);
  } finally {
    await client.close().catch(() => undefined);
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toRemoteTool(raw: unknown): RemoteTool | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.length === 0 || raw.name.length > 200) return null;
  const annotations = isRecord(raw.annotations) ? raw.annotations : {};
  return {
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : "",
    inputSchema: raw.inputSchema ?? { type: "object" },
    readOnlyHint: annotations.readOnlyHint === true,
  };
}

export async function listRemoteTools(conn: UserMcpConnection, options: ClientOptions = {}): Promise<readonly RemoteTool[]> {
  return withClient(conn, options, async (client, signal, timeoutMs) => {
    const tools: RemoteTool[] = [];
    const seen = new Set<string>();
    // Page 1 by a raw request: `listTools()` without a cursor would walk every
    // page itself and THROW past its own page cap. Later pages pass the cursor.
    let page = (await client.request({ method: "tools/list" }, { signal, timeout: timeoutMs })) as {
      tools?: unknown[];
      nextCursor?: string;
    };
    for (let pages = 0; pages < 20; pages += 1) {
      for (const raw of page.tools ?? []) {
        const tool = toRemoteTool(raw);
        if (tool === null || seen.has(tool.name)) continue;
        seen.add(tool.name);
        tools.push(tool);
        if (tools.length >= MAX_TOOLS_PER_SERVER) return tools;
      }
      const cursor = page.nextCursor;
      if (typeof cursor !== "string" || cursor.length === 0) break;
      page = (await client.listTools({ cursor }, { signal, timeout: timeoutMs })) as typeof page;
    }
    return tools;
  });
}

function resultText(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = content
    .filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text);
  if (texts.length > 0) return texts.join("\n");
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return "";
}

export async function callRemoteTool(
  conn: UserMcpConnection,
  name: string,
  args: Record<string, unknown>,
  options: ClientOptions = {},
): Promise<RemoteCallResult> {
  return withClient(conn, options, async (client, signal, timeoutMs) => {
    const result = (await client.callTool({ name, arguments: args }, { signal, timeout: timeoutMs })) as Record<string, unknown>;
    const text = resultText(result);
    const truncated = text.length > MAX_RESULT_CHARS;
    return { isError: result.isError === true, text: truncated ? text.slice(0, MAX_RESULT_CHARS) : text, truncated };
  });
}

export { UserMcpEndpointError };
