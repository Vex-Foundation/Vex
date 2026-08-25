# MCP TypeScript SDK v2 API pin (ground truth for the socket-backed server)

Scope: the exact API surface of `@modelcontextprotocol/server@2.0.0` and
`@modelcontextprotocol/core@2.0.0` as installed under `/home/kubas/Vex/node_modules`.
Every claim below is either copied verbatim from a `.d.mts`, quoted from the shipped
`.mjs` implementation, or recorded from a node probe whose output is reproduced verbatim.
File paths are relative to the package root (`server/...` or `core/...`).

Probe scripts used for the runtime evidence were run from `/home/kubas/Vex` (so the
package export map resolves) and are reproduced inline where their output is cited.

One transcription note: this repository forbids em dashes in authored content, so em
dashes inside quoted SDK doc comments are rendered here as a plain hyphen. Nothing else
in a quoted block is altered.

---

## 1. The era-owning entry and its custom-transport shape

Entry point: `serveStdio` from `@modelcontextprotocol/server/stdio`
(export map: `"./stdio"` -> `./dist/stdio.mjs`, types `./dist/stdio.d.mts`).

Signature, from `server/dist/stdio.d.mts`:

```ts
declare function serveStdio(factory: McpServerFactory, options?: ServeStdioOptions): StdioServerHandle;
```

It is a synchronous function. It returns immediately; the transport is started in the
background (see the `started` promise in section 1.5 below).

### 1.1 `ServeStdioOptions`

Verbatim from `server/dist/stdio.d.mts`:

```ts
interface ServeStdioOptions {
  legacy?: 'serve' | 'reject';
  transport?: Transport;
  onerror?: (error: Error) => void;
  maxSubscriptions?: number;
}
```

Doc comments carried on those fields, verbatim from the same file:

- `legacy`: "How a 2025-era opening (an `initialize` request, or any claim-less message)
  is handled: `'serve'` (default) - the connection is pinned to a 2025-era instance from
  the same factory and served exactly as a hand-wired stdio server serves it today.
  `'reject'` - the opening request is answered with the unsupported-protocol-version
  error naming the supported modern revisions (claim-less notifications are dropped);
  the connection stays open for a modern opening."
- `transport`: "Bring your own transport (for example a `StdioServerTransport`
  constructed over a Unix domain socket or TCP stream, per the stdio binding's
  custom-transport guidance). Defaults to a `StdioServerTransport` over the current
  process's stdio. The entry owns the transport: it starts it, receives every inbound
  message, and closes it when the connection ends."
- `onerror`: "Callback for out-of-band errors (reporting only; it never alters what is
  written to the wire)."
- `maxSubscriptions`: "Reject a new `subscriptions/listen` with `-32603` 'Subscription
  limit reached' (in-band, before the ack) when this many subscriptions are already open
  on this connection. @default 1024"

`DEFAULT_MAX_SUBSCRIPTIONS` is applied at `server/dist/stdio.mjs`:
`const listenRouter = new StdioListenRouter(options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS);`

### 1.2 `StdioServerHandle`

Verbatim from `server/dist/stdio.d.mts`:

```ts
interface StdioServerHandle {
  /** Tears the connection down: closes the pinned instance (if any) and the underlying transport. */
  close(): Promise<void>;
}
```

`close()` is the only member. Implementation evidence, `server/dist/stdio.mjs`:

```js
return { close: async () => {
    await started.catch(() => {});
    await closeAll();
} };
```

`closeAll()` (same file) tears down in this order: sets `closing = true`, moves state to
`{ phase: 'closed' }`, drains `listenRouter.teardownAll()` writing each result to the wire,
`await current.instance.product.close()` when an instance exists, then `await wire.close()`.

### 1.3 `McpServerFactory` and `McpRequestContext`

Verbatim from `server/dist/createMcpHandler-CLhGwQTn.d.mts`:

```ts
type McpServerFactory = (ctx: McpRequestContext) => McpServer | Server | Promise<McpServer | Server>;

interface McpRequestContext {
  era: 'legacy' | 'modern';
  authInfo?: AuthInfo;
  requestInfo?: Request;
}
```

The doc comment on `McpRequestContext` states, verbatim: "Validated authentication
information passed by the caller of the handler face (pass-through; HTTP only -
`serveStdio` never sets it)" for `authInfo`, and "The original HTTP request being served,
when available (HTTP only - `serveStdio` never sets it)" for `requestInfo`. So under
`serveStdio` the factory only ever sees `{ era }`.

Implementation evidence, `server/dist/stdio.mjs` `connectInstance`:
`const product = await factory({ era });` - the context literal has exactly one key.

### 1.4 `Transport`: what a custom implementation must provide

Verbatim from `server/dist/createMcpHandler-CLhGwQTn.d.mts` (re-exported through
`server/dist/stdio.d.mts` as `Transport`):

```ts
interface Transport {
  start(): Promise<void>;
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
  close(): Promise<void>;
  readonly hasPerRequestStream?: boolean;
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: (<T$1 extends JSONRPCMessage>(message: T$1, extra?: MessageExtraInfo) => void) | undefined;
  sessionId?: string | undefined;
  setProtocolVersion?: ((version: string) => void) | undefined;
  setSupportedProtocolVersions?: ((versions: string[]) => void) | undefined;
}
```

`TransportSendOptions`, same file, is a type with these optional members:
`relatedRequestId`, `resumptionToken`, `onresumptiontoken`, `requestSignal`,
`onRequestStreamEnd`, `headers`. Doc comment on `requestSignal` says, verbatim:
"Transports that share a single channel (stdio, in-memory) ignore it." Same for
`onRequestStreamEnd` and `headers`. `hasPerRequestStream` doc: "Transports that share a
single channel (stdio, in-memory) leave it `undefined`."

**Who calls what, under `serveStdio`** (implementation evidence, `server/dist/stdio.mjs`,
the tail of `serveStdio`):

```js
wire.onmessage = (message) => { queue.push(message); pump(); };
wire.onerror = (error) => { ... };
wire.onclose = () => { ... };
const started = wire.start().catch((error) => { reportError(toError(error)); throw error; });
```

- `serveStdio` **assigns** `onmessage`, `onerror`, `onclose` on the transport you pass.
  Do not set them yourself; they will be overwritten. Your transport must **invoke** them.
- `serveStdio` **calls** `start()` exactly once, immediately, without awaiting the result
  before returning the handle. A rejection is routed to `options.onerror` and re-thrown
  into an unobserved-but-caught promise (`started.catch(() => {})` follows), and awaited
  again inside `handle.close()`.
- `serveStdio` **calls** `close()` on the wire transport from `closeAll()` only.
  Note that `wire.onclose()` alone does NOT call `wire.close()` - see section 3.
- `serveStdio` **calls** `send(message)` on the wire for: error responses it writes
  itself, `subscriptions/listen` replies, listen-routed notifications, teardown results,
  and (indirectly, through the per-instance channel) every response the pinned instance
  produces.
- `setProtocolVersion` is called through the channel: `StdioConnectionChannel.setProtocolVersion`
  is `(version) => { this._wire.setProtocolVersion?.(version); }`, so it is optional-chained
  and safe to omit.
- `setSupportedProtocolVersions` is called by `Protocol.connect` on the **channel**, not on
  your wire transport (`server/dist/src-CX2iR2pK.mjs`: `transport.setSupportedProtocolVersions?.(this._supportedProtocolVersions)`),
  and `StdioConnectionChannel` does not define it, so it is a no-op for a custom wire.

Minimum a custom `Transport` must implement for `serveStdio`: `start()`, `send()`,
`close()`, and it must fire `onmessage(parsedJsonRpcMessage)` for each inbound frame and
`onclose()` exactly once when the peer disconnects. `onerror(error)` is optional but is
the only out-of-band error channel. `sessionId` is optional; when set it lands on
`ctx.sessionId` in handlers (implementation evidence, `server/dist/src-CX2iR2pK.mjs`:
`sessionId: capturedTransport?.sessionId`).

Note: the entry-owned wire transport is **never** handed to a server instance. Comment
verbatim from `server/dist/stdio.mjs`: "The wire transport itself is never handed to an
instance - that is what lets the entry discard an optimistic probe instance (close the
channel) without tearing down the connection." Each pinned/probe instance is connected to
a `StdioConnectionChannel` that writes through to the wire.

### 1.5 `legacy: 'serve' | 'reject'` semantics

`server/dist/stdio.mjs`, `serveStdio`: `const legacyMode = options.legacy ?? 'serve';`

Classification is body-only (there is no header layer on stdio). `classifyOpeningMessage`
in the same file returns `{ kind: 'legacy' }` when either:
- `message.method === 'initialize'` and the params do not carry a valid modern envelope
  claim (`reason: 'initialize'`, plus `requestedVersion` when `params.protocolVersion` is
  a string), or
- the params carry no envelope claim at all (`reason: 'no-claim'`).

Other outcomes: `invalid-envelope` (envelope present but malformed), `unsupported-revision`
(claimed version not in `SUPPORTED_MODERN_PROTOCOL_VERSIONS`), `modern`.

With `legacy: 'serve'` (default): a legacy opening constructs an instance with
`era: 'legacy'` and pins the connection to it.

With `legacy: 'reject'`:

```js
case "legacy": {
    if (legacyMode === "reject") {
        if (isJSONRPCRequest(message)) await answerLegacyRejection(message, opening.reason, opening.requestedVersion);
        return;
    }
    ...
```

`answerLegacyRejection` builds the reply from `modernOnlyStrictRejection(...)` against
`SUPPORTED_MODERN_PROTOCOL_VERSIONS`, reports an `Error` to `options.onerror`
("Rejected 2025-era request on a modern-only stdio connection (…)"), and writes the error
response. Notifications are silently dropped (no branch). The connection is NOT closed.

On a modern-pinned connection, a later legacy `initialize` is also rejected the same way
(`processMessage`, `state.phase === 'pinned' && state.era === 'modern'` branch).

---

## 2. The `server/discover` probe and why the factory must be side-effect-free

**Established fact: `serveStdio` CAN call the factory twice for a single connection.**

### 2.1 Declared behavior

`server/dist/createMcpHandler-CLhGwQTn.d.mts`, doc comment on `McpRequestContext`,
verbatim: "…and `serveStdio` (from `@modelcontextprotocol/server/stdio`) once per
connection - plus once for a `server/discover` probe instance that is discarded again if
the client falls back to `initialize`."

### 2.2 Implementation evidence

`server/dist/stdio.mjs`, `processMessage`, `case 'modern'`:

```js
if (isJSONRPCRequest(message) && message.method === "server/discover") {
    if (state.phase === "probe") { state.instance.channel.deliver(message, ...); return; }
    const instance = await connectInstance("modern", opening.revision);
    if (isTornDown()) { await disposeLateInstance(instance); return; }
    state = { phase: "probe", instance };
    instance.channel.deliver(message, { classification: opening.classification });
    return;
}
```

and, in `case 'legacy'`:

```js
if (state.phase === "probe") {
    await discardProbeInstance(state.instance);
    if (isTornDown()) return;
    state = { phase: "opening" };
}
const instance = await connectInstance("legacy");
```

So: a `server/discover` opening constructs instance #1 (`era: 'modern'`) and parks the
connection in `phase: 'probe'`. If the client then falls back to a legacy `initialize`,
the probe is discarded and instance #2 (`era: 'legacy'`) is constructed from the SAME
factory.

If the client instead continues on the modern path (any non-discover modern request or
notification), the probe instance is PROMOTED to the pinned instance - `state = { phase:
'pinned', era: 'modern', instance: state.instance }` - and the factory is not called
again.

### 2.3 What happens to the discarded instance

`server/dist/stdio.mjs`:

```js
const discardProbeInstance = async (instance) => {
    discarding = instance.channel;
    try {
        if (!await instance.channel.whenRequestsAnswered(DISCARD_ANSWER_TIMEOUT_MS))
            reportError(new Error(`Discarded the probe instance with requests still unanswered after ${DISCARD_ANSWER_TIMEOUT_MS}ms; continuing with the fallback`));
        await instance.product.close();
    } catch (error) { reportError(toError(error)); }
    finally { discarding = void 0; }
};
```

`const DISCARD_ANSWER_TIMEOUT_MS = 3e3;` (3000 ms) in the same file.

So the discarded probe IS closed, by `instance.product.close()` - that is
`McpServer.close()` (or `Server.close()` for a low-level product). It is awaited, after a
bounded wait for the requests already delivered to it to be answered. The `discarding`
guard makes the channel's close not tear the connection down
(`onInstanceClosed`: `if (closing || channel === discarding) return;`).

A factory instance that resolves only after the connection is torn down is closed by
`disposeLateInstance` -> `instance.product.close()`.

### 2.4 Runtime probe evidence

Probe (run from `/home/kubas/Vex`) constructed a fake in-process `Transport`, wrapped
`McpServer.close` to log, sent a modern `server/discover`, then a legacy `initialize`.
Verbatim output:

```
transport.start
FACTORY call#1 era=modern
OUT {"result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{"listChanged":true}},"instructions":"PROBE-INSTRUCTIONS","resultType":"complete","ttlMs":0,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"probe","version":"1.0.0"}}},"jsonrpc":"2.0","id":1}
--- after discover, factoryCalls=1
INSTANCE#1 .close() called
FACTORY call#2 era=legacy
OUT {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"probe","version":"1.0.0"},"instructions":"PROBE-INSTRUCTIONS"},"jsonrpc":"2.0","id":2}
--- after initialize, factoryCalls=2 closedInstances=[1]
```

The `server/discover` request in that probe carried
`_meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28",
"io.modelcontextprotocol/clientInfo": {...}, "io.modelcontextprotocol/clientCapabilities": {} }`.

### 2.5 Consequence for the builder

The factory MUST be side-effect-free and cheap:

- it may be called twice per connection;
- both calls receive the same connection, one of the two products is thrown away;
- registration (tools, prompts, resources) must be idempotent per instance, and must not
  mutate shared process state, acquire exclusive handles, open sockets, write files,
  increment counters, or emit telemetry keyed to "a connection started";
- any per-connection resource must be owned OUTSIDE the factory (created once by the
  caller of `serveStdio` and closed by the caller after `handle.close()`), or acquired
  lazily inside a tool handler where the instance is known to be the pinned one.

---

## 3. Clean EOF -> transport `onclose`, and what `onclose` aborts

### 3.1 What `serveStdio` does on `wire.onclose()`

`server/dist/stdio.mjs`:

```js
wire.onclose = () => {
    if (closing || state.phase === "closed") return;
    closing = true;
    const current = state;
    state = { phase: "closed" };
    if (current.phase === "probe" || current.phase === "pinned")
        current.instance.product.close().catch((error) => reportError(toError(error)));
};
```

Notes that matter:
- it is idempotent (guarded by `closing` / `phase === 'closed'`);
- it does NOT call `wire.close()` back (unlike `closeAll()`), so a transport reporting EOF
  is not re-closed by the entry;
- it does NOT run `listenRouter.teardownAll()` (that only happens in `closeAll()`);
- `product.close()` is fired and NOT awaited here.

For the default `StdioServerTransport` (`server/dist/stdio.mjs`), clean EOF on the read
side reaches this through the transport's own `close()`/stdin `end` wiring; for a custom
socket transport, YOU must call `this.onclose?.()` on socket `end`/`close`.

### 3.2 What `product.close()` tears down

`McpServer.close()` delegates to the underlying `Server`, which is a `Protocol`. The
teardown is `Protocol._onclose`, verbatim from `server/dist/src-CX2iR2pK.mjs`:

```js
_onclose() {
    const responseHandlers = this._responseHandlers;
    this._responseHandlers = new Map();
    this._progressHandlers.clear();
    this._pendingDebouncedNotifications.clear();
    for (const info of this._timeoutInfo.values()) clearTimeout(info.timeoutId);
    this._timeoutInfo.clear();
    const requestHandlerAbortControllers = this._requestHandlerAbortControllers;
    this._requestHandlerAbortControllers = new Map();
    const error = new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed");
    this._transport = void 0;
    try {
        this.onclose?.();
    } finally {
        for (const handler of responseHandlers.values()) handler(error);
        for (const controller of requestHandlerAbortControllers.values()) controller.abort(error);
    }
}
```

The `.d.mts` states the contract for subclasses, verbatim
(`server/dist/createMcpHandler-CLhGwQTn.d.mts`): "Transport-close hook. Subclass overrides
MUST call `super._onclose()` after their own cleanup - base teardown (response-handler
settlement, timeout clearing, in-flight request abort) does not run otherwise."

So on close:
1. outstanding outbound requests (server-to-client) are rejected with
   `SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed')`;
2. progress handlers and debounced notifications are dropped;
3. all pending request timeouts are cleared;
4. **every in-flight inbound request handler's AbortSignal is aborted** with that same
   `SdkError` as the abort reason.

### 3.3 The signal, and where a handler sees it

The aborted controllers are the ones registered in `Protocol._onrequest`:

```js
const abortController = new AbortController();
this._requestHandlerAbortControllers.set(request.id, abortController);
```

and exposed to the handler as `ctx.mcpReq.signal` (`baseCtx.mcpReq.signal: abortController.signal`).
That is the signal a tool handler must observe. Its abort `reason` on EOF is the
`SdkError` instance described above.

Also relevant: after abort, the handler's eventual result is discarded and nothing is
written to the wire - `Promise.resolve().then(() => handler(request, ctx)).then(async (result) => { if (abortController.signal.aborted) return; ... }`
(same for the rejection branch).

### 3.4 Runtime probe evidence

The probe from section 2.4 continued with a `tools/call` whose handler slept 5 s, then
fired the transport's `onclose()`. Verbatim tail:

```
--- now simulating clean EOF (transport.onclose)
INSTANCE#2 .close() called
HANDLER SIGNAL ABORTED reason=SdkError: Connection closed
```

---

## 4. Progress and cancellation: the tool-handler context object

### 4.1 Exact type of the second handler argument

The second argument of a `registerTool` handler is `ServerContext`
(`server/dist/createMcpHandler-CLhGwQTn.d.mts`):

```ts
type ToolCallback<Args extends StandardSchemaWithJSON | undefined = undefined> =
  BaseToolCallback<CallToolResult | InputRequiredResult, ServerContext, Args>;

type BaseToolCallback<SendResultT extends Result$1, Ctx extends ServerContext, Args extends StandardSchemaWithJSON | undefined> =
  Args extends StandardSchemaWithJSON
    ? (args: StandardSchemaWithJSON.InferOutput<Args>, ctx: Ctx) => SendResultT | Promise<SendResultT>
    : (ctx: Ctx) => SendResultT | Promise<SendResultT>;
```

Note the arity flip: **with** an `inputSchema` the handler is `(args, ctx)`; **without**
one it is `(ctx)` - the context is the FIRST argument.

`ServerContext = BaseContext & { ... }`. Verbatim:

```ts
type BaseContext = {
  sessionId?: string;
  mcpReq: {
    id: RequestId;
    method: string;
    _meta?: RequestMeta;
    envelope?: Partial<RequestMetaEnvelope>;
    inputResponses?: Record<string, unknown>;
    droppedInputResponseKeys?: string[];
    requestState: RequestStateAccessor;
    signal: AbortSignal;
    send: {
      <M$1 extends RequestMethod>(request: { method: M$1; params?: Record<string, unknown> }, options?: RequestOptions): Promise<ResultTypeMap[M$1]>;
      <T$1 extends StandardSchemaV1>(request: Request$1, resultSchema: T$1, options?: RequestOptions): Promise<StandardSchemaV1.InferOutput<T$1>>;
    };
    notify: (notification: Notification) => Promise<void>;
  };
  http?: { authInfo?: AuthInfo };
};

type ServerContext = BaseContext & {
  mcpReq: {
    log: (level: LoggingLevel, data: unknown, logger?: string) => Promise<void>;
    elicitInput: (params: ElicitRequestFormParams | ElicitRequestURLParams, options?: RequestOptions) => Promise<ElicitResult>;
    requestSampling: (params: CreateMessageRequest['params'], options?: RequestOptions) => Promise<CreateMessageResult | CreateMessageResultWithTools>;
  };
  http?: {
    req?: globalThis.Request;
    closeSSE?: () => void;
    closeStandaloneSSE?: () => void;
  };
};
```

`log`, `elicitInput` and `requestSampling` all carry `@deprecated` tags in the `.d.mts`;
`elicitInput` and `requestSampling` "Throws on a 2026-07-28-era request".

`RequestStateAccessor` is `<T$1 = unknown>() => T$1 | undefined` - a call, not a value.

`http` is populated only when the transport supplied `extra.authInfo`
(`server/dist/src-CX2iR2pK.mjs`: `http: extra?.authInfo ? { authInfo: extra.authInfo } : void 0`).
Under `serveStdio` no `authInfo` is ever passed, so `ctx.http` is `undefined`.

Runtime probe (verbatim), enumerating the real keys of the object handed to a
`registerTool` handler on a legacy-pinned `serveStdio` connection:

```
handler ctx keys=sessionId,mcpReq,http mcpReq=id,method,_meta,requestState,signal,send,notify,log,elicitInput,requestSampling
```

(`envelope`, `inputResponses` and `droppedInputResponseKeys` are conditional spreads and
were absent on that legacy request.)

### 4.2 Sending a progress notification

**There is no dedicated progress method on the context.** Grepping
`server/dist/*.d.mts` and `server/dist/*.mjs` for `sendProgress` / `notifyProgress`
returns nothing. A handler sends progress through `ctx.mcpReq.notify`:

```ts
await ctx.mcpReq.notify({
  method: 'notifications/progress',
  params: { progressToken, progress, total, message }
});
```

`notify: (notification: Notification) => Promise<void>`
(`server/dist/createMcpHandler-CLhGwQTn.d.mts`). Implementation evidence
(`server/dist/src-CX2iR2pK.mjs`, `_onrequest`): `notify` is
`sendNotification`, which is
`(notification, options) => this._notificationViaCodec(this._resolveOutboundCodec(notification.method), notification, { ...options, relatedRequestId: request.id })`.
The `relatedRequestId` is stamped for you.

The wire params shape (`server/dist/src-CX2iR2pK.mjs`):

```js
const ProgressSchema$1 = z.object({
    progress: z.number(),
    total: z.optional(z.number()),
    message: z.optional(z.string())
});
const ProgressNotificationParamsSchema$1 = z.object({
    ...NotificationsParamsSchema$1.shape,
    ...ProgressSchema$1.shape,
    progressToken: ProgressTokenSchema$1
});
```

`progressToken` is REQUIRED by that schema.

**The client's progress token** is at `ctx.mcpReq._meta?.progressToken`. Evidence:
`RequestMetaSchema` includes `progressToken: ProgressTokenSchema.optional()`
(`server/dist/src-CX2iR2pK.mjs` line 675 region), and the dispatch-time post-lift meta is
`z.looseObject({ progressToken: ProgressTokenSchema$1.optional() })`.
Runtime probe on a `tools/call` sent with `_meta: { progressToken: 'PT1' }`, verbatim:

```
handler _meta={"progressToken":"PT1"}
OUT {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"PT1","progress":1,"total":2}}
```

**What happens when the client sent no `progressToken`:** `ctx.mcpReq._meta` is
`undefined`, and the SDK does NOT suppress or validate an outbound progress notification
you send anyway - it writes it to the wire with no token, producing a spec-invalid frame.
Runtime probe, verbatim (`tools/call` sent with no `_meta`, handler called `notify` with
`params: { progress: 1 }`):

```
meta=undefined
OUT {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}
notify-without-token RESOLVED
```

Consequence for the builder: the handler MUST itself guard on
`const token = ctx.mcpReq._meta?.progressToken; if (token === undefined) return;` before
emitting progress. The SDK will not do it.

### 4.3 How `notifications/cancelled` reaches the handler

`server/dist/src-CX2iR2pK.mjs`:

```js
async _oncancel(notification) {
    if (!notification.params.requestId) return;
    this._requestHandlerAbortControllers.get(notification.params.requestId)?.abort(notification.params.reason);
}
```

The member is `ctx.mcpReq.signal` (the same `AbortSignal` as in section 3.3). The abort
`reason` is the raw `params.reason` string sent by the client.

Runtime probe, verbatim (client sent
`{"method":"notifications/cancelled","params":{"requestId":2,"reason":"user cancelled"}}`):

```
ABORT reason=user cancelled
```

Contrast with EOF, where the reason is an `SdkError` instance ("SdkError: Connection closed").
A handler that stringifies the reason must handle both.

#### 4.3.1 `reason` is OPTIONAL, so "is it a string" is NOT the discriminator

`notification.params.reason` is optional in the spec and the SDK passes it through
UNCHANGED. A client that sends `{"method":"notifications/cancelled","params":{"requestId":2}}`
therefore reaches `abort(undefined)`, and Node's `AbortController` substitutes its own
`AbortError` DOMException as `signal.reason`. That value is not a string and is not an
`SdkError`.

Consequence for the builder: classify on the SDK error, never on the reason's string-ness.
The identifying values, read off the installed `@modelcontextprotocol/server@2.0.0`:

```ts
declare class SdkError extends Error {
  readonly code: SdkErrorCode;
  readonly data?: unknown | undefined;
  static [Symbol.hasInstance](value: unknown): boolean;
  static isInstance<T>(this: T, value: unknown): value is InstanceType<T>;
}
declare enum SdkErrorCode { /* ... */ ConnectionClosed = "CONNECTION_CLOSED" /* ... */ }
```

Both `SdkError` and `SdkErrorCode` are VALUE exports of the package root
(`dist/index.d.mts`), so the guard needs no structural re-declaration:

```ts
SdkError.isInstance(signal.reason) && signal.reason.code === SdkErrorCode.ConnectionClosed
```

`isInstance` is brand-based and must be invoked ON THE CLASS; a detached
`.filter(SdkError.isInstance)` throws. The code is checked as well as the brand so a
future SDK error class arriving on this signal is not read as a disconnect.

Vex's rule, in `mcp/server.ts`: ConnectionClosed -> the owner's typed teardown cause;
EVERY other abort of `ctx.mcpReq.signal` -> `cancelled`. A reasonless cancellation is a
cancellation.

Note also `StdioConnectionChannel.deliver` in `server/dist/stdio.mjs` treats a delivered
`notifications/cancelled` as settling that request id for the probe-discard drain
accounting.

---

## 5. The `fromJsonSchema` adapter

### 5.1 Export path and signature

Exported from the package root, `@modelcontextprotocol/server`
(`server/dist/index.d.mts`):

```ts
declare function fromJsonSchema<T = unknown>(schema: JsonSchemaType, validator?: jsonSchemaValidator): StandardSchemaWithJSON<T, T>;
```

`JsonSchemaType` (`server/dist/types-DUs7mGBv.d.mts`) is
`type JsonSchemaType = JSONSchema.Interface;` - "This uses the object form of JSON Schema
(excluding boolean schemas)", re-exported from `json-schema-typed` draft 2020-12.

### 5.2 What it returns

Implementation evidence, `server/dist/src-CX2iR2pK.mjs`:

```js
function fromJsonSchema(schema, validator) {
	const check = validator.getValidator(schema);
	return { "~standard": {
		version: 1,
		vendor: "mcp",
		jsonSchema: { input: () => schema, output: () => schema },
		validate: (data) => {
			const result = check(data);
			return result.valid ? { value: result.data } : { issues: [{ message: result.errorMessage }] };
		}
	} };
}
```

Runtime probe, verbatim:

```
fromJsonSchema keys [ 'version', 'vendor', 'jsonSchema', 'validate' ]
vendor/version mcp 1
validate ok {"value":{"a":"x"}}
validate bad {"issues":[{"message":"data must have required property 'a'"}]}
jsonSchema.input {"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}
```

`jsonSchema.input(options)` and `.output(options)` return the SAME object you passed in
(identity, not a copy or a normalization).

### 5.3 What `registerTool` expects for `inputSchema`

`StandardSchemaWithJSON` (`server/dist/createMcpHandler-CLhGwQTn.d.mts`):

```ts
interface StandardSchemaWithJSON<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output> & StandardJSONSchemaV1.Props<Input, Output>;
}
```

Doc comment, verbatim: "This is the type accepted by `registerTool` / `registerPrompt`.
The SDK needs `~standard.jsonSchema` to advertise the tool's argument shape in
`tools/list`, and `~standard.validate` to check incoming arguments when a `tools/call`
arrives. Zod v4, ArkType, and Valibot (via `@valibot/to-json-schema`'s
`toStandardJsonSchema`) all implement both interfaces."

So `fromJsonSchema(jsonSchema)` is exactly the adapter for handing a hand-written JSON
Schema to `registerTool`. A plain Zod object also works directly (zod ^4.2.0 is a runtime
dependency of the server package). The legacy `ZodRawShape` overload
(`Record<string, z.ZodType>`) is marked `@deprecated`: "Wrap with `z.object({...})` instead."

### 5.4 Does the JSON Schema draft / dialect matter?

Yes, when the default validator is in play. `server/dist/dialects-DoSzNhcb.mjs`:

```js
const DRAFT_2020_12_URIS = new Set(["https://json-schema.org/draft/2020-12/schema", "http://json-schema.org/draft/2020-12/schema"]);
const DRAFT_2019_09_URIS = new Set([... "draft/2019-09/schema" ...]);
const DRAFT_07_URIS = new Set([... "draft-07/schema" ...]);
const DRAFT_06_URIS = new Set([... "draft-06/schema" ...]);

function declaredDialect(schema, remedy) {
	if (!("$schema" in schema) || typeof schema.$schema !== "string") return "2020-12";
	...
	throw new Error(`JSON Schema declares an unsupported dialect ("$schema": "...")). The default validator supports JSON Schema 2020-12, 2019-09, draft-07, and draft-06; ${remedy}`);
}
```

- No `$schema` (or a non-string one) -> treated as 2020-12.
- 2020-12 -> `Ajv2020`; 2019-09 -> `Ajv2019`; draft-07 / draft-06 -> classic `Ajv`.
- Anything else -> a plain `Error` is thrown at `getValidator` time.

`AjvJsonSchemaValidator._engineFor` doc comment, verbatim
(`server/dist/ajvProvider-CgI-5L6O.d.mts`): "A caller-supplied engine is used for every
schema - do not second-guess by `$schema` (bring-your-own-validator means
bring-your-own-dialect). Otherwise: no `$schema` or 2020-12 -> `Ajv2020`; 2019-09 ->
`Ajv2019`; draft-07 or draft-06 -> classic `Ajv`; anything else -> `Error`."

Recommendation for the builder: emit 2020-12 schemas (or omit `$schema` entirely) so the
default `Ajv2020` engine is used and no dialect dispatch is needed.

### 5.5 Does a validator provider have to be installed?

**No.** A default validator is always available on Node, and ajv is vendored into the
package - it is not a runtime dependency you must install.

Evidence chain:

- `server/dist/index.mjs`: `import { DefaultJsonSchemaValidator } from "@modelcontextprotocol/server/_shims";`
  and `function fromJsonSchema(schema, validator) { return fromJsonSchema$1(schema, validator ?? (_defaultValidator ??= new DefaultJsonSchemaValidator())); }`
- `server/package.json` export map `"./_shims"` resolves `node` -> `./dist/shimsNode.mjs`.
- `server/dist/shimsNode.mjs` (whole file):
  ```js
  import { n as AjvJsonSchemaValidator } from "./ajvProvider-CEoC__sr.mjs";
  import process from "node:process";
  export { AjvJsonSchemaValidator as DefaultJsonSchemaValidator, process };
  ```
- `server/dist/ajvProvider-CEoC__sr.mjs` is 273 KB and its header shows ajv bundled inline:
  `//#region ../../node_modules/.pnpm/ajv@8.18.0/node_modules/ajv/dist/compile/codegen/code.js`.
  `ajv` and `ajv-formats` are listed only under `devDependencies` in `server/package.json`,
  confirming they are vendored, not resolved at runtime.
- `browser` / `workerd` conditions resolve to `shimsBrowser.mjs` / `shimsWorkerd.mjs`,
  which export `CfWorkerJsonSchemaValidator` as `DefaultJsonSchemaValidator`
  (`@cfworker/json-schema`, also bundled).

So: **if no validator is configured, `fromJsonSchema` lazily constructs an
`AjvJsonSchemaValidator` on Node and validation works.** The runtime probe in section 5.2
called `fromJsonSchema(...)` with no second argument and got real ajv error text
("data must have required property 'a'"), proving the default path is live.

The default engine is constructed with, verbatim from the `.d.mts`:
"`strict: false`, `validateFormats: true`, `validateSchema: false`, `allErrors: true`, and
`ajv-formats` registered - lazily, on the first `getValidator` call needing each".

Also note `ServerOptions.jsonSchemaValidator` (`server/dist/createMcpHandler-CLhGwQTn.d.mts`),
`@default Runtime-selected validator (AJV-backed on Node.js, `@cfworker/json-schema`-backed
on browser/workerd runtimes)` - that option is documented as being for elicitation
response validation.

The `./validators/ajv` and `./validators/cf-worker` entry points exist only to let you
construct a customized provider:

- `server/dist/validators/ajv.d.mts`: `export { Ajv, AjvJsonSchemaValidator, addFormats };`
- `server/dist/validators/cfWorker.d.mts`: `export { CfWorkerJsonSchemaValidator, type CfWorkerSchemaDraft };`

`Ajv` there is the draft-07 class; the `.d.mts` notes: "The SDK bundles ajv internally but
does not re-export `Ajv2020` (its type graph tips downstream declaration bundling - see
#2339). To construct a custom 2020-12 instance, add `ajv` to your own dependencies
(matching the SDK's pinned version) and `import { Ajv2020 } from 'ajv/dist/2020.js'`."

The provider interface you would implement (`server/dist/types-DUs7mGBv.d.mts`):

```ts
type JsonSchemaValidatorResult<T> =
  | { valid: true; data: T; errorMessage: undefined }
  | { valid: false; data: undefined; errorMessage: string };

type JsonSchemaValidator<T> = (input: unknown) => JsonSchemaValidatorResult<T>;

interface jsonSchemaValidator {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T>;
}
```

---

## 6. `instructions` delivery on both paths

### 6.1 Where it is declared

`ServerOptions` (`server/dist/createMcpHandler-CLhGwQTn.d.mts`), verbatim:

```ts
type ServerOptions = ProtocolOptions & {
  capabilities?: ServerCapabilities;
  /**
   * Optional instructions describing how to use the server and its features.
   */
  instructions?: string;
  jsonSchemaValidator?: jsonSchemaValidator;
  ...
};
```

That is the SECOND argument of `new McpServer(serverInfo, options)` / `new Server(...)`.
Stored at `server/dist/mcp-DXXb3Vv3.mjs`: `this._instructions = options?.instructions;`

### 6.2 Legacy `initialize` result

`server/dist/mcp-DXXb3Vv3.mjs`, `_oninitialize`:

```js
return {
    protocolVersion,
    capabilities: this.getCapabilities(),
    serverInfo: this._serverInfo,
    ...this._instructions && { instructions: this._instructions }
};
```

Runtime probe, verbatim wire frame:

```
OUT {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"probe","version":"1.0.0"},"instructions":"PROBE-INSTRUCTIONS"},"jsonrpc":"2.0","id":2}
```

### 6.3 Modern `server/discover` result

`server/dist/mcp-DXXb3Vv3.mjs`, `_ondiscover`:

```js
return {
    supportedVersions: modernProtocolVersions(this._supportedProtocolVersions),
    capabilities: discoverAdvertisedCapabilities(this.getCapabilities()),
    ...this._instructions && { instructions: this._instructions }
};
```

Result schema (`server/dist/src-CX2iR2pK.mjs`):

```js
"server/discover": liftedResult({
    ttlMs: z.number().int().min(0).catch(0),
    cacheScope: z.enum(["public", "private"]).catch("private"),
    supportedVersions: z.array(z.string()),
    capabilities: ServerCapabilities2026Schema,
    instructions: z.string().optional()
}),
```

Runtime probe, verbatim wire frame:

```
OUT {"result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{"listChanged":true}},"instructions":"PROBE-INSTRUCTIONS","resultType":"complete","ttlMs":0,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"probe","version":"1.0.0"}}},"jsonrpc":"2.0","id":1}
```

Both paths deliver it, from one `ServerOptions.instructions` on the factory-built instance.
Note the falsy check `...this._instructions && {...}`: an empty string is dropped.

---

## 7. `registerTool` and the tool contract

### 7.1 Exact signature

`server/dist/createMcpHandler-CLhGwQTn.d.mts`, `class McpServer` (current overload):

```ts
registerTool<OutputArgs extends StandardSchemaWithJSON, InputArgs extends StandardSchemaWithJSON | undefined = undefined>(name: string, config: {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  icons?: Icon[];
  _meta?: Record<string, unknown>;
}, cb: ToolCallback<InputArgs>): RegisteredTool;
```

Deprecated raw-shape overload (same file), tagged "@deprecated Wrap with `z.object({...})`
instead. Raw-shape form: `inputSchema`/`outputSchema` may be a plain `{ field: z.string() }`
record; it is auto-wrapped with `z.object()`":

```ts
registerTool<InputArgs extends ZodRawShape, OutputArgs extends ZodRawShape | StandardSchemaWithJSON | undefined = undefined>(name: string, config: {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  icons?: Icon[];
  _meta?: Record<string, unknown>;
}, cb: LegacyToolCallback<InputArgs>): RegisteredTool;
```

The full tool-config field set is therefore exactly: `title`, `description`,
`inputSchema`, `outputSchema`, `annotations`, `icons`, `_meta`. There is no
`execution`/`taskSupport` field on the config object even though `ToolExecutionSchema`
exists in the wire vocabulary.

### 7.2 `ToolAnnotations`

`server/dist/createMcpHandler-CLhGwQTn.d.mts`: `type ToolAnnotations = Infer<typeof ToolAnnotationsSchema>;`
The schema, verbatim from `server/dist/src-CX2iR2pK.mjs`:

```js
const ToolAnnotationsSchema$1 = z.object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional()
});
```

Exactly five optional fields: `title`, `readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`. Per repo rule 09 these are hints, not enforcement.

### 7.3 `CallToolResult`

`server/dist/createMcpHandler-CLhGwQTn.d.mts`:
`type CallToolResult = StripWireOnly<Infer<typeof CallToolResultSchema>>;`

Schema, verbatim from `server/dist/src-CX2iR2pK.mjs`:

```js
const CallToolResultSchema$1 = ResultSchema$1.extend({
    content: z.array(ContentBlockSchema$1),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
    isError: z.boolean().optional()
});
```

`content` is REQUIRED (an array; may be empty). The content block union, verbatim from the
same file:

```js
const ContentBlockSchema$1 = z.union([
    TextContentSchema$1,
    ImageContentSchema$1,
    AudioContentSchema$1,
    ResourceLinkSchema$1,
    EmbeddedResourceSchema$1
]);
```

so five block kinds: `text`, `image`, `audio`, `resource_link`, `resource` (embedded).
`ResultSchema` contributes the optional `_meta` slot.

A handler may also return `InputRequiredResult` instead of a `CallToolResult`
(`ToolCallback` returns `CallToolResult | InputRequiredResult`); the `inputRequired(...)`
helper is exported from the package root.

`isCallToolResult` is exported: `declare const isCallToolResult: (value: unknown) => value is CallToolResult;`

`RegisteredTool` (returned by `registerTool`) carries `title`, `description`,
`inputSchema`, `outputSchema` and an internal memoised output JSON Schema, plus an
`update({...})` path referenced in the same declaration region.

---

## 8. Package facts

### 8.1 Versions installed

Exact, from the installed manifests:

- `@modelcontextprotocol/server` version `2.0.0` (`server/package.json`)
- `@modelcontextprotocol/core` version `2.0.0` (`core/package.json`)

Both declare `"type": "module"` and `"engines": { "node": ">=20" }`.

### 8.2 Export map entry points

`@modelcontextprotocol/server` (`server/package.json` `exports`):

- `.` -> `./dist/index.mjs` (types `./dist/index.d.mts`); CJS `./dist/index.cjs`
- `./stdio` -> `./dist/stdio.mjs` (types `./dist/stdio.d.mts`)
- `./validators/ajv` -> `./dist/validators/ajv.mjs`
- `./validators/cf-worker` -> `./dist/validators/cfWorker.mjs`
- `./_shims` -> conditional: `workerd` -> `shimsWorkerd`, `browser` -> `shimsBrowser`,
  `node` and `default` -> `shimsNode`

`@modelcontextprotocol/core` (`core/package.json` `exports`):

- `.` -> `./dist/index.mjs` (types `./dist/index.d.mts`)
- `./internal` -> `./dist/internal.mjs` (types `./dist/internal.d.mts`)

`core`'s root export is the public Zod schema set (`ToolSchema`, `CallToolResultSchema`,
`ProgressNotificationSchema`, the OAuth/OpenID schemas, etc.); `./internal` additionally
exports the protocol constants (`LATEST_PROTOCOL_VERSION`,
`DEFAULT_NEGOTIATED_PROTOCOL_VERSION`, `SUPPORTED_PROTOCOL_VERSIONS`, and the
`io.modelcontextprotocol/*` `_meta` key constants).

### 8.3 `SUPPORTED_PROTOCOL_VERSIONS` and the modern list

Runtime probe from `/home/kubas/Vex`, verbatim output:

```
SUPPORTED_PROTOCOL_VERSIONS ["2025-11-25","2025-06-18","2025-03-26","2024-11-05","2024-10-07"]
LATEST_PROTOCOL_VERSION 2025-11-25
DEFAULT_NEGOTIATED_PROTOCOL_VERSION 2025-03-26
STDIO_DEFAULT_MAX_BUFFER_SIZE 10485760
```

`SUPPORTED_PROTOCOL_VERSIONS` is the LEGACY `initialize` list only. The modern list is a
separate, deliberately non-public constant (`server/dist/src-CX2iR2pK.mjs`):

```js
const FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28";
/**
* Modern-era protocol revisions this SDK can negotiate via `server/discover`.
* Deliberately separate from SUPPORTED_PROTOCOL_VERSIONS (the legacy
* `initialize` list), so adding a revision here can never leak a modern version
* string into a 2025-era handshake. Internal - not part of the public API surface.
*/
const SUPPORTED_MODERN_PROTOCOL_VERSIONS = [FIRST_MODERN_PROTOCOL_VERSION];
```

`SUPPORTED_MODERN_PROTOCOL_VERSIONS` is NOT exported from
`@modelcontextprotocol/server`. Do not depend on importing it; the observed
`server/discover` result advertises `supportedVersions: ["2026-07-28"]`.

The `_meta` envelope key constants, probed verbatim from the package root export:

```
PROTOCOL_VERSION_META_KEY = io.modelcontextprotocol/protocolVersion
CLIENT_INFO_META_KEY = io.modelcontextprotocol/clientInfo
CLIENT_CAPABILITIES_META_KEY = io.modelcontextprotocol/clientCapabilities
SERVER_INFO_META_KEY = io.modelcontextprotocol/serverInfo
LOG_LEVEL_META_KEY = io.modelcontextprotocol/logLevel
SUBSCRIPTION_ID_META_KEY = io.modelcontextprotocol/subscriptionId
RELATED_TASK_META_KEY = io.modelcontextprotocol/related-task
TRACEPARENT_META_KEY = traceparent
TRACESTATE_META_KEY = tracestate
BAGGAGE_META_KEY = baggage
```

`hasEnvelopeClaim` keys off `PROTOCOL_VERSION_META_KEY` only
(`server/dist/src-CX2iR2pK.mjs`): `return meta !== void 0 && PROTOCOL_VERSION_META_KEY in meta;`

### 8.4 Runtime dependency lists

`@modelcontextprotocol/server` `dependencies`:

```json
{ "zod": "^4.2.0", "@modelcontextprotocol/core": "2.0.0" }
```

`@modelcontextprotocol/core` `dependencies`:

```json
{ "zod": "^4.2.0" }
```

That is the entire runtime dependency closure: `zod` plus `core`. `ajv`, `ajv-formats`
and `@cfworker/json-schema` appear only under `devDependencies` and are bundled into the
published `dist/` chunks (see section 5.5).

---

## UNDETERMINED

1. **Whether the default `StdioServerTransport` fires `onclose` on a clean stdin EOF
   without an explicit `close()` call.** The declaration
   (`server/dist/stdio.d.mts`) shows `onclose?: () => void` and `close(): Promise<void>`,
   and the `Transport` doc says "This should be invoked when `close()` is called as well",
   but the socket-backed server will supply its own transport, so this path was not
   exercised. What would settle it: spawn a child process running `serveStdio()` with the
   default transport, close its stdin, and observe whether the process's instance
   `close()` runs. Not needed for the socket build: a custom transport must call
   `this.onclose?.()` itself on socket `end`/`close`, which is the contract section 1.4
   records.

2. **Whether `serveStdio` tolerates a probe promotion after a `subscriptions/listen`
   arrives before any other modern message.** `tryServeListen` is consulted on the
   promotion path (`if (await tryServeListen(message)) return;` after the state flip), but
   the interaction between `listenRouter.setServerCapabilities` (called in
   `connectInstance` for the modern era) and a listen delivered while still in `phase:
   'probe'` was not exercised by a probe. What would settle it: a probe that sends
   `server/discover`, then `subscriptions/listen`, and inspects the emitted frames plus
   `factoryCalls`.

3. **The exact behavior of `maxSubscriptions` rejection wording on the wire.** The
   `.d.mts` states `-32603` 'Subscription limit reached', but this was not exercised.
   What would settle it: open `maxSubscriptions + 1` listens on a modern connection and
   record the frames.
