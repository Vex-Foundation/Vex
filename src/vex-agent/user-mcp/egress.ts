/**
 * Where a user MCP server may be reached, and the `fetch` the MCP transport
 * uses to reach it (F12).
 *
 * ENDPOINT. `checkEndpoint` decides the network scope from the URL itself,
 * never from a user choice: a loopback host (`localhost`, `127.0.0.0/8`, `::1`)
 * is "on this computer" and may use `http:` or `https:`; anything else must be
 * `https:` to a public host. A private, LAN, link-local or metadata address is
 * refused. User info and fragments are refused.
 *
 * IP LITERALS ARE SETTLED HERE. The pinning dispatchers decide at DNS lookup
 * time, and Node does not look up an IP literal, so a literal host never
 * reaches them: it is classified here, before any socket can exist.
 *
 * THE FETCH (`createUserMcpFetch`) runs for every request of an MCP exchange:
 *  - it refuses a request to any other origin than the endpoint's, BEFORE it
 *    adds the bearer token, so a token never leaves for another origin;
 *  - it never follows a redirect (`redirect: "error"`);
 *  - it connects through a pinned dispatcher: every resolved address public
 *    (`public` scope) or every one loopback (`local` scope), one address
 *    pinned, certificate checks still against the name;
 *  - it caps each response body at `MAX_RESPONSE_BYTES`.
 *
 * The token is never logged and never part of an error.
 */

import { fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from "undici";
import type { LookupFunction } from "node:net";
import {
  createPinnedLoopbackEgressDispatcher,
  createPinnedPublicEgressDispatcher,
  isEgressRefusal,
  isIpLiteralHost,
  isLoopbackIpAddress,
  isPrivateOrLoopbackHost,
  isPublicIpAddress,
} from "@vex-agent/sync/rpc-egress-policy.js";
import type { UserMcpNetworkScope } from "@vex-agent/db/repos/user-mcp.js";
import { MAX_RESPONSE_BYTES } from "./limits.js";

/** Refusal codes. Bounded words, stored as `last_error` and shown in Settings. */
export type UserMcpRefusalCode =
  | "invalid_url"
  | "not_https"
  | "credentials_in_url"
  | "fragment_in_url"
  | "private_address"
  | "blocked_address"
  | "cross_origin"
  | "response_too_large"
  | "unauthorized"
  | "timeout"
  | "not_mcp"
  | "unreachable";

export class UserMcpEndpointError extends Error {
  override readonly name = "UserMcpEndpointError";
  readonly code: UserMcpRefusalCode;
  constructor(code: UserMcpRefusalCode) {
    super(`user MCP endpoint refused: ${code}`);
    this.code = code;
  }
}

export const MAX_ENDPOINT_CHARS = 2_000;

export type EndpointCheck =
  | { readonly ok: true; readonly endpoint: string; readonly networkScope: UserMcpNetworkScope }
  | { readonly ok: false; readonly code: UserMcpRefusalCode };

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  return isIpLiteralHost(h) && isLoopbackIpAddress(h);
}

export function checkEndpoint(raw: string): EndpointCheck {
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_ENDPOINT_CHARS) return { ok: false, code: "invalid_url" };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, code: "invalid_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, code: "invalid_url" };
  if (url.username.length > 0 || url.password.length > 0) return { ok: false, code: "credentials_in_url" };
  if (url.hash.length > 0 || text.includes("#")) return { ok: false, code: "fragment_in_url" };
  const host = url.hostname;
  if (host.length === 0) return { ok: false, code: "invalid_url" };
  if (isLoopbackHost(host)) return { ok: true, endpoint: url.toString(), networkScope: "local" };
  if (url.protocol !== "https:") return { ok: false, code: "not_https" };
  if (isIpLiteralHost(host)) {
    return isPublicIpAddress(host)
      ? { ok: true, endpoint: url.toString(), networkScope: "public" }
      : { ok: false, code: "private_address" };
  }
  // Address-shaped names (`0x7f.1`, `2130706433`) and the rest of the
  // syntactic table: refused before the resolver is ever asked.
  if (isPrivateOrLoopbackHost(host)) return { ok: false, code: "private_address" };
  return { ok: true, endpoint: url.toString(), networkScope: "public" };
}

export interface UserMcpConnection {
  readonly endpoint: string;
  readonly networkScope: UserMcpNetworkScope;
  /** The bearer token, read from the vault for this one operation; `null` for none. */
  readonly token: string | null;
}

/** The `fetch` shape the MCP transport takes. */
export type UserMcpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface UserMcpFetchHandle {
  readonly fetch: UserMcpFetch;
  /** Set once a response came back 401 or 403, for the refusal code. */
  readonly sawUnauthorized: () => boolean;
  /** Releases the dispatcher's sockets. Always call it. */
  readonly close: () => Promise<void>;
}

export interface UserMcpFetchDeps {
  /** Injected only by tests (the DNS-rebinding case). */
  readonly lookup?: LookupFunction;
}

function dispatcherFor(scope: UserMcpNetworkScope, deps: UserMcpFetchDeps): Dispatcher {
  const options = deps.lookup === undefined ? undefined : { lookup: deps.lookup };
  return scope === "local" ? createPinnedLoopbackEgressDispatcher(options) : createPinnedPublicEgressDispatcher(options);
}

function requestUrl(input: string | URL | { url: string }): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

/** A body that errors once more than `limit` bytes have come through. */
function capBody(body: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      seen += value.byteLength;
      if (seen > limit) {
        await reader.cancel().catch(() => undefined);
        controller.error(new UserMcpEndpointError("response_too_large"));
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

export function createUserMcpFetch(conn: UserMcpConnection, deps: UserMcpFetchDeps = {}): UserMcpFetchHandle {
  const origin = new URL(conn.endpoint).origin;
  const dispatcher = dispatcherFor(conn.networkScope, deps);
  let unauthorized = false;
  const fetchFn: UserMcpFetch = async (input, init) => {
    const url = requestUrl(input as string | URL | { url: string });
    // The origin check comes before the token is added: a request bound
    // anywhere else never carries it.
    if (url.origin !== origin) throw new UserMcpEndpointError("cross_origin");
    const headers = new Headers(init?.headers);
    if (conn.token !== null) headers.set("authorization", `Bearer ${conn.token}`);
    const response = await undiciFetch(url, {
      ...(init as UndiciRequestInit | undefined),
      headers: Object.fromEntries(headers.entries()),
      redirect: "error",
      dispatcher,
    });
    if (response.status === 401 || response.status === 403) unauthorized = true;
    const responseInit = {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
    };
    if (response.body === null) return new Response(null, responseInit);
    return new Response(capBody(response.body as ReadableStream<Uint8Array>, MAX_RESPONSE_BYTES), responseInit);
  };
  return {
    fetch: fetchFn,
    sawUnauthorized: () => unauthorized,
    close: async () => {
      await dispatcher.close().catch(() => undefined);
    },
  };
}

/** The refusal code for a failed operation. Never message text from the server. */
export function classifyFailure(error: unknown, sawUnauthorized: boolean): UserMcpRefusalCode {
  if (sawUnauthorized) return "unauthorized";
  let node: unknown = error;
  for (let depth = 0; depth < 6 && node instanceof Error; depth += 1) {
    if (node instanceof UserMcpEndpointError) return node.code;
    if (node.name === "TimeoutError" || node.name === "AbortError") return "timeout";
    node = node.cause;
  }
  if (isEgressRefusal(error)) return "blocked_address";
  if (error instanceof Error && /timed? ?out/i.test(error.message)) return "timeout";
  if (error instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket/i.test(`${error.message} ${String(error.cause)}`)) {
    return "unreachable";
  }
  return "not_mcp";
}
