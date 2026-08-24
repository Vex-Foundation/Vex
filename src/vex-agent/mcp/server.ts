/**
 * `createStudioMcpServer` - one MCP server instance for one Vex Studio
 * connection.
 *
 * ## The factory is SIDE-EFFECT-FREE, and that is a hard requirement
 *
 * `serveStdio` can call the factory TWICE for a single connection: a modern
 * `server/discover` opening builds a probe instance, and a client that then
 * falls back to a legacy `initialize` makes the entry discard that probe and
 * build a second instance from the same factory
 * (`studio-mcp/sdk-v2-api-pin.md` section 2). So this function only
 * REGISTERS handlers on a fresh `McpServer`. It opens nothing, writes nothing,
 * counts nothing and reserves nothing. Every per-connection resource - the
 * socket, the transport, the in-flight accounting - is owned OUTSIDE, by the
 * host that called `serveStudioMcpConnection`.
 *
 * ## One injected dependency
 *
 * `runCall(projectId, call, options)` is the whole seam. The server holds NO
 * scope: a scope bound at connection time is a stale authorization cache, and
 * `runStudioCall` is the one owner of the per-call atomic snapshot. The
 * handshake binds a projectId and nothing else.
 *
 * ## Progress is GUARDED, cancellation cause is TYPED
 *
 * The SDK does not suppress a progress notification sent without a client
 * token; it writes a spec-invalid frame (pin note section 4.2). So progress is
 * emitted only when `ctx.mcpReq._meta?.progressToken` exists.
 *
 * `ctx.mcpReq.signal` aborts for two very different reasons, and only ONE of
 * them is identifiable: a transport close aborts with the SDK's own
 * `SdkError(SdkErrorCode.ConnectionClosed)` (pin note section 3.3). That is
 * the OWNER's teardown, so its cause comes from the host through `cancelCause`.
 *
 * EVERY other abort of this signal came from `_oncancel`, which passes
 * `notification.params.reason` straight to `abort()` (pin note section 4.3).
 * That parameter is OPTIONAL: a client that cancels without a reason aborts
 * with `undefined`, which Node turns into an `AbortError` DOMException. So the
 * classification cannot key on "is the reason a string" - that misreads a
 * reasonless cancellation as a disconnect and would write `disconnect` into a
 * durable audit column for an action the client itself cancelled. It keys on
 * the ConnectionClosed error instead, and everything else is `cancelled`.
 *
 * The client's reason is never READ, whatever its type: it is untrusted agent
 * text and must not become the value Vex records.
 */

import { McpServer, SdkError, SdkErrorCode, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { randomUUID } from "node:crypto";

import type { JsonSchema } from "../tools/types.js";
import type { StudioToolCall } from "./admission.js";
import { buildStudioInventory, type StudioTool } from "./inventory/index.js";
import { STUDIO_MCP_INSTRUCTIONS } from "./instructions.js";
import type {
  RunStudioCallOptions,
  StudioCallOutcome,
  StudioCancelCause,
} from "./outcome.js";
import { studioOutcomeToCallToolResult } from "./server-result.js";
import type { JsonRpcWireTransport } from "./socket-transport.js";

/**
 * The entry's own transport slot. `Transport` is declared but not exported by
 * `@modelcontextprotocol/server/stdio`, so the type is read back off the
 * entry's options rather than re-declared, which keeps it pinned to the
 * installed SDK instead of to a copy that could drift.
 */
type ServeStdioTransport = NonNullable<
  NonNullable<Parameters<typeof serveStdio>[1]>["transport"]
>;

/** The server identity an MCP client sees. */
export const STUDIO_MCP_SERVER_NAME = "vex-studio";

/** The ONE injected executor. Implemented by `main/studio/approval-service.ts`. */
export type StudioRunCall = (
  projectId: string,
  call: StudioToolCall,
  options: RunStudioCallOptions,
) => Promise<StudioCallOutcome>;

export interface StudioMcpServerDeps {
  /** Bound by the handshake. The server never loads a scope from it. */
  readonly projectId: string;
  readonly runCall: StudioRunCall;
  /**
   * The OWNER's typed teardown cause, asked only when the abort did not come
   * from the client. Absent means `disconnect`, which is the honest fact for
   * "the wire went away and nobody said why".
   */
  readonly cancelCause?: () => StudioCancelCause;
  /** Reported for the model-visible history. Never carries tool arguments. */
  readonly onCallSettled?: (event: StudioCallLogEvent) => void;
  /** Server version reported in `serverInfo`. */
  readonly version?: string;
}

export interface StudioCallLogEvent {
  readonly toolName: string;
  readonly outcomeKind: StudioCallOutcome["kind"];
  readonly durationMs: number;
}

/**
 * The `_meta` key that marks the hot set. Clients that eagerly load tool
 * descriptions read it; the 134 protocol tools stay discoverable through
 * `vex_ToolSearch` instead of being pulled into a context window up front.
 */
const ALWAYS_LOAD_META_KEY = "anthropic/alwaysLoad";

/**
 * The Vex `_meta` key that carries a tool's required environment variable
 * NAMES. NAMES ONLY, never values: the list is metadata that never varies by
 * environment, and an unmet variable is answered at CALL time with a typed
 * `configuration_unavailable` result naming the variable and the remedy
 * (`mcp/availability.ts`). An array because the key is the wire contract and a
 * tool that later needs two variables must not change its shape.
 */
const REQUIRES_ENV_META_KEY = "vex/requiresEnv";

/**
 * The JSON Schema a Vex tool declares, as the SDK's adapter wants it.
 *
 * `fromJsonSchema` dispatches on `$schema`: absent or 2020-12 selects the
 * default Ajv2020 engine, and an unsupported dialect throws at validator
 * construction (pin note section 5.4). Vex schemas declare no `$schema` at
 * all, which is the 2020-12 path, so no rewriting happens here. The cast is
 * the boundary between Vex's own `JsonSchema` vocabulary and the SDK's
 * `JsonSchemaType`; a lint asserts no exported schema declares a dialect.
 */
function toStandardSchema(schema: JsonSchema): ReturnType<typeof fromJsonSchema> {
  return fromJsonSchema(schema as unknown as Parameters<typeof fromJsonSchema>[0]);
}

/**
 * Is this abort reason the SDK's own connection-closed error?
 *
 * The one abort the owner is entitled to name. `SdkError.isInstance` is the
 * SDK's brand-based guard (it must be called on the class, never detached),
 * and the code is checked as well as the brand so a future SDK error class on
 * this signal is not silently read as a disconnect.
 */
function isConnectionClosedAbort(reason: unknown): boolean {
  return (
    SdkError.isInstance(reason) && reason.code === SdkErrorCode.ConnectionClosed
  );
}

/**
 * The trusted cause for ONE aborted call.
 *
 * The abort reason's CONTENT is never read. See the module header: only the
 * SDK's ConnectionClosed error identifies an owner teardown, and every other
 * abort of this signal - including one carrying no reason at all - is the
 * client's own `notifications/cancelled`.
 */
function typedCancelCause(
  signal: AbortSignal,
  owner: (() => StudioCancelCause) | undefined,
): StudioCancelCause {
  if (!isConnectionClosedAbort(signal.reason)) return "cancelled";
  try {
    return owner?.() ?? "disconnect";
  } catch {
    return "disconnect";
  }
}

export function createStudioMcpServer(deps: StudioMcpServerDeps): McpServer {
  const server = new McpServer(
    { name: STUDIO_MCP_SERVER_NAME, version: deps.version ?? "0.0.0" },
    {
      capabilities: { tools: {} },
      // Delivered on BOTH eras from this one option: the legacy `initialize`
      // result and the modern `server/discover` result both spread it
      // (pin note section 6).
      instructions: STUDIO_MCP_INSTRUCTIONS,
    },
  );

  for (const tool of buildStudioInventory()) {
    registerStudioTool(server, tool, deps);
  }

  return server;
}

function registerStudioTool(
  server: McpServer,
  tool: StudioTool,
  deps: StudioMcpServerDeps,
): void {
  server.registerTool(
    tool.publicName,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: toStandardSchema(tool.inputSchema),
      annotations: tool.annotations,
      ...studioToolMeta(tool),
    },
    async (args: unknown, ctx): Promise<ReturnType<typeof studioOutcomeToCallToolResult>> => {
      const startedAt = Date.now();
      const token = ctx.mcpReq._meta?.progressToken;
      const options: RunStudioCallOptions = {
        signal: ctx.mcpReq.signal,
        cancelCause: () => typedCancelCause(ctx.mcpReq.signal, deps.cancelCause),
        // GUARDED. With no client token the SDK would happily write a
        // token-less, spec-invalid progress frame, so the guard lives here.
        ...(token === undefined
          ? {}
          : {
              onProgress: (): void => {
                void ctx.mcpReq
                  .notify({
                    method: "notifications/progress",
                    params: {
                      progressToken: token,
                      progress: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
                      message: "Waiting for a person to decide this action in Vex.",
                    },
                  })
                  .catch(() => {
                    // A progress frame that cannot be written changes nothing
                    // about the call: the answer still travels on the response.
                  });
              },
            }),
      };

      const outcome = await deps.runCall(
        deps.projectId,
        {
          name: tool.publicName,
          args: (args ?? {}) as Record<string, unknown>,
          toolCallId: `studio-${randomUUID()}`,
        },
        options,
      );
      deps.onCallSettled?.({
        toolName: tool.publicName,
        outcomeKind: outcome.kind,
        durationMs: Date.now() - startedAt,
      });
      return studioOutcomeToCallToolResult(outcome);
    },
  );
}

/**
 * The `_meta` block for ONE tool, or nothing.
 *
 * Assembled in one place so the two keys cannot drift apart: a tool that is
 * both hot and env-gated must carry both, and a spread that built `_meta`
 * twice would keep only the last one.
 */
function studioToolMeta(tool: StudioTool): { _meta?: Record<string, unknown> } {
  const meta: Record<string, unknown> = {};
  if (tool.alwaysLoad) meta[ALWAYS_LOAD_META_KEY] = true;
  if (tool.requiresEnv !== undefined) {
    meta[REQUIRES_ENV_META_KEY] = [tool.requiresEnv];
  }
  return Object.keys(meta).length === 0 ? {} : { _meta: meta };
}

export interface StudioConnectionHandle {
  /** Tears down the pinned instance and the wire. Idempotent. */
  readonly close: () => Promise<void>;
}

/**
 * Serve ONE connection through the era-owning entry.
 *
 * `serveStdio` is the entry, never `Server.connect`: it is what makes both a
 * 2025-era `initialize` and a 2026-era `server/discover` work on the same
 * socket, and it is what owns the probe-then-fallback dance. `legacy: 'serve'`
 * is deliberate - Vex serves the older era rather than rejecting it, because
 * every installed client today opens with `initialize`.
 */
export function serveStudioMcpConnection(
  transport: JsonRpcWireTransport,
  deps: StudioMcpServerDeps,
  onError?: (error: Error) => void,
): StudioConnectionHandle {
  const handle: StdioServerHandle = serveStdio(
    () => createStudioMcpServer(deps),
    {
      legacy: "serve",
      transport: transport as unknown as ServeStdioTransport,
      ...(onError === undefined ? {} : { onerror: onError }),
    },
  );
  let closed: Promise<void> | null = null;
  return {
    close: (): Promise<void> => {
      closed ??= handle.close();
      return closed;
    },
  };
}
