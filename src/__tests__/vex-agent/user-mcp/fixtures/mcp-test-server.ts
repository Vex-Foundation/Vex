/**
 * A REAL MCP server for the user MCP tests: the installed
 * `@modelcontextprotocol/server` `McpServer`, served over Streamable HTTP
 * (`createMcpHandler`) on loopback, optionally behind a bearer token.
 *
 * Tools (mutable through `state`, so a test can change a schema and watch the
 * recheck turn the tool off):
 *  - `lookup`: declared read-only; echoes its `q` argument.
 *  - `write_note`: NOT read-only; echoes its `text`.
 *  - `big`: returns `size` characters, for the result cap.
 *  - `fails`: returns an `isError` result.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";

export interface TestServerState {
  lookupSchema: Record<string, unknown>;
  lookupReadOnly: boolean;
  /** Tools beyond the four built-ins, for pagination and caps. */
  extraTools: number;
}

export interface TestMcpServer {
  readonly url: string;
  readonly port: number;
  readonly state: TestServerState;
  /** Every request the server saw: method, path and whether it carried the right token. */
  readonly requests: Array<{ method: string; authorized: boolean; authorization: string | null }>;
  readonly close: () => Promise<void>;
}

const schema = (json: Record<string, unknown>) => fromJsonSchema(json as Parameters<typeof fromJsonSchema>[0]);

function buildServer(state: TestServerState): McpServer {
  const server = new McpServer({ name: "vex-test-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.registerTool(
    "lookup",
    {
      description: "Look a word up",
      inputSchema: schema(state.lookupSchema),
      annotations: { readOnlyHint: state.lookupReadOnly },
    },
    async (args: unknown) => ({ content: [{ type: "text", text: `found: ${JSON.stringify(args)}` }] }),
  );
  server.registerTool(
    "write_note",
    {
      description: "Write a note",
      inputSchema: schema({ type: "object", properties: { text: { type: "string" } }, required: ["text"] }),
    },
    async (args: unknown) => ({ content: [{ type: "text", text: `wrote: ${(args as { text: string }).text}` }] }),
  );
  server.registerTool(
    "big",
    {
      description: "Return a long text",
      inputSchema: schema({ type: "object", properties: { size: { type: "integer" } }, required: ["size"] }),
      annotations: { readOnlyHint: true },
    },
    async (args: unknown) => ({ content: [{ type: "text", text: "x".repeat((args as { size: number }).size) }] }),
  );
  server.registerTool(
    "fails",
    { description: "Always fails", inputSchema: schema({ type: "object" }), annotations: { readOnlyHint: true } },
    async () => ({ isError: true, content: [{ type: "text", text: "the upstream index is down" }] }),
  );
  for (let i = 0; i < state.extraTools; i++) {
    server.registerTool(
      `extra_${i}`,
      { description: `Extra ${i}`, inputSchema: schema({ type: "object" }), annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: "text", text: `extra ${i}` }] }),
    );
  }
  return server;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function startTestMcpServer(options: { token?: string; state?: Partial<TestServerState> } = {}): Promise<TestMcpServer> {
  const state: TestServerState = {
    lookupSchema: { type: "object", properties: { q: { type: "string", description: "The word" } }, required: ["q"] },
    lookupReadOnly: true,
    extraTools: 0,
    ...options.state,
  };
  const requests: TestMcpServer["requests"] = [];
  const handler = createMcpHandler(() => buildServer(state));

  const http: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : null;
    const authorized = options.token === undefined || authorization === `Bearer ${options.token}`;
    requests.push({ method: req.method ?? "", authorized, authorization });
    if (!authorized) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const body = await readBody(req);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }
    const request = new Request(`http://${req.headers.host}${req.url ?? "/"}`, {
      method: req.method,
      headers,
      ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
    });
    const response = await handler.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body === null) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    state,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
