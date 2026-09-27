/**
 * A local, scriptable stand-in for OpenRouter's chat-completions endpoint.
 *
 * Speaks the OpenAI-compatible wire protocol the real SDK parses: a
 * `text/event-stream` body of `data: {chat.completion.chunk}` events ending in
 * `data: [DONE]`, SSE comment heartbeats (`: OPENROUTER PROCESSING`), JSON
 * error bodies on 4xx/5xx, and a buffered `chat.completion` JSON body for
 * `stream: false` requests.
 *
 * Every request is answered by a {@link ChatHandler} the test supplies, which
 * drives timing explicitly: delay before headers, before the first event,
 * between events, or hang until the client goes away. The server records what
 * it was asked (streaming or buffered, the parsed body, when) and how each
 * response ended (finished, or torn down by the client), and tracks every
 * socket so a test can assert that nothing is left open.
 *
 * Every response carries `Connection: close`, so a finished exchange closes
 * its socket instead of parking it in the client's keep-alive pool: an open
 * request-carrying socket after a round is therefore a real leak, not pool
 * reuse.
 *
 * Sockets that never carried a request are counted separately. Node's fetch
 * (undici) opens one such spare connection right after a request it aborted —
 * plain `fetch` + `AbortController` against this server does the same, with no
 * SDK involved — and parks it, unref'd and empty, until the server's
 * keep-alive timeout closes it. It holds no request and nothing of ours, so it
 * is reported, not treated as a leak.
 *
 * Binds 127.0.0.1 on a random port. Test-only; no production code imports it.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** One request the server received. */
export interface RecordedRequest {
  readonly index: number;
  readonly path: string;
  /** `true` for `stream: true` bodies, `false` for buffered ones. */
  readonly stream: boolean;
  readonly body: Record<string, unknown>;
  /** `performance.now()` when the request body was fully read. */
  readonly receivedAt: number;
}

/** How one response ended, from the server's side. */
export interface ResponseOutcome {
  readonly index: number;
  /** True when the client closed the connection before the response ended. */
  readonly clientAborted: boolean;
  readonly closedAt: number;
}

/** What a handler uses to answer one request. */
export interface ChatResponder {
  readonly request: RecordedRequest;
  /** True once the client has gone away; every helper below is then a no-op. */
  readonly closed: boolean;
  /** Wait `ms`, returning early (with `false`) if the client goes away. */
  sleep(ms: number): Promise<boolean>;
  /** Wait until the client goes away. Never resolves on its own. */
  hang(): Promise<void>;
  /** Send the SSE response head (200, `text/event-stream`). Idempotent. */
  sseHeaders(): void;
  /** One `data:` event carrying a chunk object (sends the head if needed). */
  event(chunk: Record<string, unknown>): void;
  /** One SSE comment line, e.g. the `: OPENROUTER PROCESSING` heartbeat. */
  comment(text?: string): void;
  /** `data: [DONE]` and end the response. */
  done(): void;
  /** Answer with a JSON body and end the response. */
  json(status: number, body: unknown, headers?: Record<string, string>): void;
}

export type ChatHandler = (responder: ChatResponder) => Promise<void>;

export interface SseChatServer {
  /** Base URL to hand the SDK as `serverURL` (no trailing slash). */
  readonly url: string;
  readonly requests: readonly RecordedRequest[];
  readonly outcomes: readonly ResponseOutcome[];
  /** Request-carrying sockets currently open. */
  openSockets(): number;
  /** Open sockets that never carried a byte (the client pool's spares). */
  idleSpareSockets(): number;
  /** TCP connections accepted so far (a request can reuse one). */
  connections(): number;
  /** Resolve once every request-carrying socket has closed; reject after `timeoutMs`. */
  waitForSocketsClosed(timeoutMs?: number): Promise<void>;
  /** Resolve once `count` responses have ended; reject after `timeoutMs`. */
  waitForOutcomes(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

const MODEL = "test/model";

/** A `chat.completion.chunk` event body with the fields the SDK requires. */
export function chunk(
  delta: Record<string, unknown>,
  extra: { readonly finishReason?: string | null; readonly usage?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    id: "gen-local-1",
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: extra.finishReason ?? null }],
    ...(extra.usage !== undefined && { usage: extra.usage }),
  };
}

export const contentChunk = (text: string): Record<string, unknown> =>
  chunk({ role: "assistant", content: text });

export const reasoningChunk = (text: string): Record<string, unknown> =>
  chunk({ role: "assistant", reasoning: text });

export function toolCallChunk(call: {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly args: string;
}): Record<string, unknown> {
  return chunk({
    tool_calls: [
      {
        index: call.index,
        ...(call.id !== undefined && { id: call.id, type: "function" }),
        function: {
          ...(call.name !== undefined && { name: call.name }),
          arguments: call.args,
        },
      },
    ],
  });
}

export const finishChunk = (reason: string): Record<string, unknown> =>
  chunk({}, { finishReason: reason });

export const usageChunk = (prompt: number, completion: number): Record<string, unknown> => ({
  id: "gen-local-1",
  object: "chat.completion.chunk",
  created: 1,
  model: MODEL,
  choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
});

/** A buffered `chat.completion` body for a `stream: false` request. */
export function completionBody(content: string): Record<string, unknown> {
  return {
    id: "gen-local-buffered",
    object: "chat.completion",
    created: 1,
    model: MODEL,
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}

/** An OpenRouter-shaped JSON error body. */
export function errorBody(code: number, message: string): Record<string, unknown> {
  return { error: { code, message } };
}

function parseBody(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed));
    }
  } catch {
    // Not JSON: recorded as an empty body.
  }
  return {};
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => parts.push(part));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

function createResponder(
  request: RecordedRequest,
  res: ServerResponse,
  onClose: (listener: () => void) => void,
  isClosed: () => boolean,
): ChatResponder {
  let headersSent = false;
  const write = (text: string): void => {
    if (isClosed() || res.writableEnded) return;
    res.write(text);
  };
  const sseHeaders = (): void => {
    if (headersSent || isClosed()) return;
    headersSent = true;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "close",
    });
    // Push the head out now, so "headers arrived" and "first event arrived"
    // are separately scriptable.
    res.flushHeaders();
  };
  return {
    request,
    get closed() {
      return isClosed();
    },
    sleep(ms) {
      if (isClosed()) return Promise.resolve(false);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(true), ms);
        onClose(() => {
          clearTimeout(timer);
          resolve(false);
        });
      });
    },
    hang() {
      if (isClosed()) return Promise.resolve();
      return new Promise((resolve) => onClose(resolve));
    },
    sseHeaders,
    event(body) {
      sseHeaders();
      write(`data: ${JSON.stringify(body)}\n\n`);
    },
    comment(text = "OPENROUTER PROCESSING") {
      sseHeaders();
      write(`: ${text}\n\n`);
    },
    done() {
      sseHeaders();
      write("data: [DONE]\n\n");
      if (!isClosed() && !res.writableEnded) res.end();
    },
    json(status, body, headers = {}) {
      if (isClosed() || res.writableEnded) return;
      res.writeHead(status, {
        "content-type": "application/json",
        connection: "close",
        ...headers,
      });
      res.end(JSON.stringify(body));
    },
  };
}

/**
 * Start a server. `handlers[i]` answers the i-th request; requests past the
 * end of the list reuse the LAST handler, so a single handler answers all.
 */
export async function startSseChatServer(
  handlers: readonly ChatHandler[],
): Promise<SseChatServer> {
  if (handlers.length === 0) throw new Error("startSseChatServer needs at least one handler");
  const requests: RecordedRequest[] = [];
  const outcomes: ResponseOutcome[] = [];
  const sockets = new Set<Socket>();
  /** The subset of `sockets` that received at least one byte. */
  const carrying = new Set<Socket>();
  let connectionsAccepted = 0;
  const socketWaiters = new Set<() => void>();
  const outcomeWaiters = new Set<() => void>();

  const notify = (waiters: Set<() => void>): void => {
    for (const waiter of [...waiters]) waiter();
  };

  const server = createServer((req, res) => {
    // Captured now: `res.socket` is detached by the time `close` fires.
    const socket = req.socket;
    void (async () => {
      const raw = await readBody(req);
      const body = parseBody(raw);
      const request: RecordedRequest = {
        index: requests.length,
        path: req.url ?? "",
        stream: body.stream === true,
        body,
        receivedAt: performance.now(),
      };
      requests.push(request);

      let closed = false;
      const closeListeners: Array<() => void> = [];
      res.on("close", () => {
        closed = true;
        // The client went away mid-response. `http.Server` keeps sockets
        // half-open (`allowHalfOpen`), so a client FIN would otherwise leave
        // our side of the socket open forever and mask a real client leak.
        if (!res.writableFinished) socket.destroy();
        outcomes.push({
          index: request.index,
          clientAborted: !res.writableFinished,
          closedAt: performance.now(),
        });
        notify(outcomeWaiters);
        for (const listener of closeListeners.splice(0)) listener();
      });
      const onClose = (listener: () => void): void => {
        if (closed) listener();
        else closeListeners.push(listener);
      };

      const handler = handlers[Math.min(request.index, handlers.length - 1)];
      const responder = createResponder(request, res, onClose, () => closed);
      try {
        await handler(responder);
      } finally {
        // A handler that returns without ending the response hangs up.
        if (!closed && !res.writableEnded) res.end();
      }
    })().catch(() => {
      if (!res.writableEnded) res.destroy();
    });
  });

  server.on("connection", (socket) => {
    connectionsAccepted += 1;
    sockets.add(socket);
    socket.once("data", () => carrying.add(socket));
    socket.on("close", () => {
      sockets.delete(socket);
      carrying.delete(socket);
      notify(socketWaiters);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("sse-chat-server: expected a TCP address");
  }
  const { port } = address satisfies AddressInfo;

  const waitFor = (
    waiters: Set<() => void>,
    ready: () => boolean,
    what: string,
    timeoutMs: number,
  ): Promise<void> => {
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = (): void => {
        if (!ready()) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`sse-chat-server: timed out waiting for ${what}`));
      }, timeoutMs);
      waiters.add(check);
    });
  };

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    outcomes,
    openSockets: () => carrying.size,
    idleSpareSockets: () => sockets.size - carrying.size,
    connections: () => connectionsAccepted,
    waitForSocketsClosed: (timeoutMs = 2_000) =>
      waitFor(socketWaiters, () => carrying.size === 0, "every request socket to close", timeoutMs),
    waitForOutcomes: (count, timeoutMs = 2_000) =>
      waitFor(outcomeWaiters, () => outcomes.length >= count, `${count} responses to end`, timeoutMs),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
