# MCP servers in 2026: what the Studio MCP design rests on

Deep-research report, read 2026-08-22 against primary sources (URLs at the
end), condensed by the coordinator. Every "verified" claim carries a
source; items marked REQUIRES_FRESH_VERIFICATION or LOW_CONFIDENCE are not
to be built on without a probe. The local reference
(`agents-colab/github-mcp-server` at 8ec6249) corroborates the protocol
claims independently: it declares `MinimumProtocolVersion = "2026-07-28"`,
implements MRTR with a sealed `requestState`, and depends on
`github.com/modelcontextprotocol/go-sdk v1.7.0`.

## 1. Protocol revision: 2026-07-28, stateless

- Current revision 2026-07-28 (format YYYY-MM-DD, bumped only on
  incompatible change). Versus 2025-11-25: sessions removed (no
  `Mcp-Session-Id`; `tools/list` MUST NOT vary per connection, MAY vary by
  the authorization presented on the request); `initialize` and
  `notifications/initialized` removed, every request carries
  `_meta["io.modelcontextprotocol/protocolVersion"]`, `clientCapabilities`,
  `clientInfo`, results carry `serverInfo`; `server/discover` is mandatory
  (supported versions, capabilities, identity); `subscriptions/listen`
  replaces the HTTP GET stream and `resources/subscribe`; `ping`,
  `logging/setLevel`, roots list_changed removed; log level per request via
  `_meta`; tasks moved to the extension `io.modelcontextprotocol/tasks`;
  MRTR (multi round-trip requests) replaces server-initiated
  `elicitation/create`, `sampling/createMessage`, `roots/list`; every
  result carries `resultType: "complete" | "input_required"`; SSE
  resumability removed.
- Deprecated in 2026-07-28: Roots, Sampling, Logging (SEP-2577; migrate to
  tool params or resource URIs, direct LLM APIs, stderr or OpenTelemetry);
  HTTP+SSE transport; OAuth dynamic client registration in favour of
  Client ID Metadata Documents.
- 2025-11-25 versus 2025-06-18: icons on tools, resources, prompts;
  URL-mode elicitation; tool-name guidance (SEP-986); tasks (experimental);
  JSON Schema 2020-12 default.
- Client negotiation: Claude Code runs two client runtimes, v1 on MCP TS
  SDK 1.x and v2 on SDK 2.0 (adds 2026-07-28). `MCP_PROTOCOL_NEGOTIATION`
  unset or `legacy` keeps STDIO servers on the earlier handshake; `auto`
  negotiates 2026-07-28. Codex CLI's negotiated revision:
  REQUIRES_FRESH_VERIFICATION (its docs describe config, not the wire).
- So what: the Studio server must speak both eras (`initialize` fallback
  and `server/discover`); let the SDK own that; never keep
  connection-scoped state; `tools/list` varies only by request
  authorization, never by which terminal connected.

## 2. Transport: stdio

- Standard bindings: stdio (newline-delimited JSON-RPC over a subprocess
  the client launches) and Streamable HTTP; HTTP+SSE deprecated (12-month
  window). Custom byte-stream transports (Unix domain socket, TCP) SHOULD
  reuse stdio framing.
- Spec guidance for locally-run servers, verbatim intent: use stdio to
  limit access to the MCP client; if HTTP, require an authorization token
  or use Unix domain sockets or other restricted IPC. DNS rebinding against
  a local HTTP server is a named attack; invalid Origin MUST get HTTP 403.
- So what: use stdio, launched by Studio. No loopback HTTP port for a
  wallet-bearing server. If one engine must serve several terminals, a
  Unix domain socket with filesystem permissions and stdio framing, not
  loopback HTTP. (The reference's HTTP default binds all interfaces; the
  Vex loopback rule wins regardless.)

## 3. Authorization

- OAuth 2.1 machinery (protected resource metadata RFC 9728, resource
  indicators, CIMD, RFC 9207 `iss` validation, step-up scopes) is defined
  for HTTP servers. A stdio server has no HTTP request to authorize; the
  spec's local mitigation is process isolation.
- Rules that bind even on stdio: token passthrough forbidden (a server
  MUST NOT accept tokens not issued for it); state handles MUST NOT count
  as authentication (possession of a handle proves nothing; bind
  server-side to the principal, secure random).
- Credential passing: Claude Code stdio `--env KEY=value`; it STRIPS
  inherited environment variables whose underscore-separated parts include
  TOKEN, SECRET, PASSWORD, KEY, AUTH, COOKIE, PAT, CREDENTIAL and similar;
  `headersHelper` runs only after workspace trust. Codex CLI
  `[mcp_servers.<name>]` in `~/.codex/config.toml` (stdio: command, args,
  env, cwd; HTTP: url, bearer_token_env_var, auth defaults oauth,
  http_headers).
- So what: no OAuth for the local server. Signing authority never derives
  from "an MCP client connected". Secrets do not travel through env (the
  stripper eats them anyway; rule 07 forbids it); the server reaches the
  running Studio instance through an IPC handshake.

## 4. Tool definition fields and client limits

- Fields (2026-07-28): `name`, `title`, `description`, `icons`,
  `inputSchema` (MUST be a JSON Schema object, 2020-12 default),
  `outputSchema`, `annotations` (clients MUST treat annotations as
  untrusted unless the server is trusted), `_meta`. The exact hint names
  `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`
  are not enumerated on the tools page: LOW_CONFIDENCE on their current
  status; check the 2026-07-28 schema. They remain behaviourally
  load-bearing: Codex CLI's `default_tools_approval_mode = "writes"`
  prompts for non-read-only tools.
- `structuredContent`: any JSON value conforming to `outputSchema`; a
  tool returning it SHOULD also return the serialized JSON as a
  TextContent block (SEP-2106 loosened the shape).
- `isError`: protocol errors (JSON-RPC error) for unknown tool or
  malformed request; tool execution errors (`isError: true` in the result)
  for API failures, input validation and business logic, fed back to the
  model for self-correction.
- Name charset: SHOULD be 1-128 chars, case-sensitive, `A-Za-z0-9_-.`, no
  spaces or commas, unique per server. `WalletBalances` and
  `namespace__resource_action` comply.
- `tools/list`: cursor pagination plus required `ttlMs` and `cacheScope`
  ("public" | "private") on list results; servers SHOULD return tools in
  DETERMINISTIC order (client caching, prompt-cache hits);
  `notifications/tools/list_changed` over the opted-in
  `subscriptions/listen` stream.
- CONFIRMED VERBATIM from the Claude Code MCP reference: "Claude Code
  truncates tool descriptions and server instructions at 2KB each. Keep
  them concise to avoid truncation, and put critical details near the
  start." Other Claude Code limits: MCP tool output warns above 10,000
  tokens and is limited to 25,000 tokens by default
  (`MAX_MCP_OUTPUT_TOKENS`); a server can raise its own per-tool ceiling
  with `_meta["anthropic/maxResultSizeChars"]` up to 500,000 characters
  (text only).
- So what: the 2 KB cut is a client-side silent truncation Vex cannot
  prevent; every description front-loads its risk facts (destructive,
  chain, approval-gated) inside the first 2 KB, and the budget is named in
  the lane doc as the consumer's property (O2 resolves against this
  number). Results paginate with `hasMore` / `nextCursor` rather than
  approach the 25k-token cut; set `anthropic/maxResultSizeChars` where a
  result is genuinely large.

## 5. Large tool surfaces: the crux for 155 tools

- Claude Code has tool search ON BY DEFAULT for MCP tools: only tool
  names and server instructions load at session start; definitions are
  deferred until needed; no fixed per-server cap. `ENABLE_TOOL_SEARCH`:
  unset = all MCP tools deferred; `true` forced; `auto` defers once tool
  definitions reach 10 percent of the context window; `auto:N`; `false`
  loads everything. Requires Sonnet 4.5 / Haiku 4.5 / Opus 4.5 or later;
  disabled on some non-first-party base URLs. Per-server opt-out
  `"alwaysLoad": true`; per-tool opt-out `_meta["anthropic/alwaysLoad"]`.
- Anthropic's API Tool Search Tool (`tool_search_tool_regex_20251119`,
  `..._bm25_20251119`): selection accuracy degrades past 30-50 tools; a
  typical 5-server setup costs about 55k tokens, tool search cuts that by
  more than 85 percent, loading the 3-5 tools needed; search covers names,
  descriptions, argument names and argument descriptions; default 5
  results; explicit advice to namespace tool names by prefix so one search
  matches a whole group.
- Codex CLI: static `enabled_tools` allowlist and `disabled_tools`
  blocklist per server; no dynamic search; loads all tools upfront.
- Spec level: no tool filtering primitive; the only lever is varying
  `tools/list` by request authorization.
- So what (the most important finding): a custom ToolSearch facade for
  Claude Code is a SECOND search layer inside a client that already
  searches, a second source of truth for tool metadata, and a name clash
  with Claude Code's own `ToolSearch`. The evidence favours exposing every
  exported tool as a real MCP tool with strong namespacing (the existing
  `namespace__resource_action` convention is exactly what Anthropic
  recommends), `anthropic/alwaysLoad` on the handful needed every turn, and
  generated instructions telling the client when to search. Codex CLI is
  the asymmetry: it loads all 155 upfront, past the accuracy cliff, so a
  facade or a documented `enabled_tools` subset stays necessary there.
  This is an OWNER decision (O20), because vex-studio.plan.md specifies
  "protocol tools via ToolSearch".

## 6. Elicitation, sampling, roots, progress, cancellation, logging, tasks

- Elicitation flows through MRTR: the server returns `resultType:
  "input_required"` with keyed `inputRequests` (`elicitation/create`,
  `mode: "form" | "url"`, `requestedSchema`) and an opaque `requestState`;
  the client retries the ORIGINAL request with a new id, passing
  `inputResponses` and `requestState`. Claude Code supports both modes
  with zero config (form dialog; URL opens a browser); an `Elicitation`
  hook can auto-answer. Codex CLI as a client: REQUIRES_FRESH_VERIFICATION;
  the reference's own test "form-only client receives actionable
  instructions" shows the fallback: plain-text instructions in the result.
- Sampling: deprecated; absent from the Claude Code reference. Roots:
  deprecated in the spec, still implemented by Claude Code (launch
  directory plus added working directories). Progress notifications do not
  extend the per-server wall-clock timeout but reset the idle timeout (30
  min stdio). Cancellation: `notifications/cancelled` on stdio. Logging:
  deprecated; stdio servers log to stderr (stdout is the protocol
  channel) or OpenTelemetry (`traceparent` / `tracestate` / `baggage`
  `_meta` conventions). Tasks: extension, disabled by default, client
  support unverified; Claude Code can background long MCP calls into
  `/tasks` itself.
- So what: form elicitation is the natural shape for non-authoritative
  input, but per rules 09 and 90 a signing operation proposed by the model
  is NOT approved by a dialog rendered inside an external coding agent:
  approval lives in Studio's privileged main process with revalidation
  before commit; every interactive tool degrades to an instructional text
  result. Log to stderr only. Skip sampling and roots.

## 7. Resources and prompts

- Claude Code surfaces resources through `@server:protocol://path`
  mentions and prompts as `/mcp__server__prompt` slash commands whose
  results are injected into the conversation.
- So what: a tool-centric server may skip both; prompts are cheap and
  cost no context (a few `/mcp__vex__...` commands such as "audit this
  wallet"); resources are a poor fit for live parameterized data; private
  documents and wallet data must never become `@`-mentionable (rule 07).

## 8. Instructions and capability declaration

- Capabilities come back from `server/discover`. With tool search on,
  the `instructions` string plus tool names is the ENTIRE upfront context;
  Claude Code's docs say instructions "help Claude understand when to
  search for your tools, similar to how skills work"; same 2 KB cut.
- So what: generate the instructions from the enabled toolset set (the
  reference pattern), at most 2 KB, front-loading: Vex handles wallets,
  DeFi and on-chain actions; search the `vex` namespaces for them; every
  value-moving action requires approval in the Vex Studio window (a
  safety control, not marketing). Codex CLI's use of instructions:
  REQUIRES_FRESH_VERIFICATION.

## 9. Security guidance and client enforcement

- Servers MUST validate inputs, implement access controls, rate limit,
  sanitize outputs; clients SHOULD confirm sensitive operations, show
  inputs before calling, validate results, time out, audit; "there SHOULD
  always be a human in the loop with the ability to deny tool
  invocations"; annotations untrusted unless the server is trusted; local
  install consent shows the exact command without truncation.
- Claude Code permission rules address tools as `mcp__<server>__<tool>`;
  `_meta["anthropic/requiresUserInteraction"]: true` (v2.1.199+) forces the
  permission prompt on every call even in acceptEdits, auto and
  bypassPermissions, with no "don't ask again"; in `dontAsk` mode the call
  is denied; under `--permission-prompt-tool` an allow becomes a deny.
  Codex CLI: `default_tools_approval_mode` auto | prompt | writes |
  approve, per-tool `tools.<tool>.approval_mode`.
- What a server can never rely on: all of the above is client-side;
  bypass modes exist; a user can allowlist everything.
- So what: set `anthropic/requiresUserInteraction` on every value-moving
  tool as defense in depth, documented as Claude-Code-only, version-gated
  and bypassable; the authorization boundary is Studio's privileged main
  process revalidating chain, asset, amount and recipient immediately
  before signing. Every tool argument arriving over MCP is hostile: the
  coding agent's context is full of untrusted repo content.

## 10. SDK state (npm, 2026-08-22)

- `@modelcontextprotocol/sdk` 1.30.0 (the 1.x maintenance line);
  `@modelcontextprotocol/core`, `server`, `client` 2.0.0 (published
  2026-07-27): v2 is a package SPLIT, adds 2026-07-28, ships dual ESM and
  CJS, moves schemas into `core`, runtime-neutral `requireBearerAuth`, Zod
  for form-elicitation schemas, lazy schema construction. Zod major:
  REQUIRES_FRESH_VERIFICATION. Go SDK v1.7.0 is what the reference uses.
- So what: `@modelcontextprotocol/server@2.0.0`, pinned exactly (four
  weeks old; rule 07), after verifying its Zod major against the
  repository's validation stack. Vex is ESM on Node 22.

## 11. Registry, 12. MCP Apps, 13. Testing

- The MCP Registry stores public `server.json` metadata and does not
  support private servers; a Studio-spawned local server registers
  nothing.
- MCP Apps (`io.modelcontextprotocol/ui`, HTML inline in conversations) is
  an opt-in extension; terminal clients' support is unverified and Vex
  already owns a privileged, CSP-controlled UI, so server-returned HTML is
  a boundary not to open (rules 07 and 90).
- MCP Inspector (`@modelcontextprotocol/inspector`, browser plus CLI with
  CI exit codes; 0.22.0 per a secondary source, LOW_CONFIDENCE) is not the
  conformance suite; the identity of the official conformance runner is
  an open question. The reference's toolsnaps (117 snapshots) map onto
  rules 04 and 06; a lint asserting each description's first 2000 bytes
  carry its risk classification is the natural addition.

## Risks named by the research

The 2 KB cut is silent; `tools/list` must not vary per connection; stdout
is the protocol channel (a stray `console.log` corrupts it, the logger
must pin to stderr in that process); the `ToolSearch` name clash; Codex
loads all tools upfront and Claude Code's deferral hides that during
development; roots, sampling, logging, HTTP+SSE and OAuth DCR are on
removal timers; prompt injection into a wallet through the coding agent's
context; the v2 SDK is four weeks old.

## Open verifications before design

Codex CLI negotiated revision, elicitation, progress and instructions
support; the exact annotation hint names in the 2026-07-28 schema; the
Zod major of `@modelcontextprotocol/server@2`; the official conformance
runner; client support for the tasks extension. Recommended probe: a
throwaway stdio server that logs inbound `_meta`, `initialize` or
`server/discover`, and declared client capabilities from both clients.

## The ten decisions the design must make (research ranking)

1. Transport: stdio launched by Studio (Unix socket with stdio framing if
   multiplexing is needed); never loopback HTTP for a wallet-bearing server.
2. Authority: the server holds no signing authority; value-moving calls
   return a pending proposal; Studio's main process approves and
   revalidates before commit; client permission systems are defense in
   depth.
3. Exposure model: all exported tools as real MCP tools with namespacing
   for Claude Code; a facade or documented `enabled_tools` subset for
   Codex CLI (owner decision O20 against vex-studio.plan.md).
4. Description budget: 2000 bytes per description with the risk
   classification first, enforced by a test (O2 resolves here).
5. Instructions: generated from the enabled toolset set, at most 2 KB,
   front-loading the approval rule.
6. SDK: `@modelcontextprotocol/server@2.0.0` pinned, Zod verified.
7. Dual-era compatibility owned by the SDK, never hand-rolled.
8. Result contract: `outputSchema` and `structuredContent` on money-path
   tools (an owner decision, O5, because output-envelope.md deliberately
   has one model-visible channel), `isError` for actionable failures,
   explicit pagination.
9. Safety annotations: `anthropic/requiresUserInteraction` on value-moving
   tools plus read-only and destructive hints for Codex's writes mode.
10. Contract testing: one reviewed snapshot per exported tool, Inspector
    CLI in CI, the 2 KB lint.

## Sources (all read 2026-08-22)

https://modelcontextprotocol.io/specification/versioning ;
https://modelcontextprotocol.io/specification/2026-07-28/changelog ;
https://modelcontextprotocol.io/specification/2025-11-25/changelog ;
https://modelcontextprotocol.io/specification/2026-07-28/server/tools ;
https://modelcontextprotocol.io/specification/2026-07-28/basic/transports ;
https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices ;
https://modelcontextprotocol.io/docs/extensions/overview ;
https://blog.modelcontextprotocol.io/posts/2026-07-28/ ;
https://code.claude.com/docs/en/mcp ;
https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool ;
https://learn.chatgpt.com/docs/extend/mcp?surface=cli ;
https://registry.npmjs.org/@modelcontextprotocol/{sdk,server,client,core} ;
https://modelcontextprotocol.io/registry/about (secondary) ;
https://github.com/modelcontextprotocol/inspector (secondary) ;
local: agents-colab/github-mcp-server go.mod, pkg/github/__toolsnaps__/,
internal/toolsnaps/, internal/requeststate/.
