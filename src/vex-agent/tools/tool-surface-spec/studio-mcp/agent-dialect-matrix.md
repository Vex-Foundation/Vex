# Agent dialect matrix (reviewed artifact, A5a)

REVIEWED, HAND-MAINTAINED. This is the formalized form of
`agent-dialect-research-2026-08-24.md` INCLUDING its "Addendum 2026-08-25",
which supersedes the original rows wherever the two disagree. Every per-client
fact the installer emits appears here, and
`src/__tests__/vex-agent/studio/agent-dialect-matrix.test.ts` enumerates every
config path, owned path, entry key, `type` value, timeout field and
never-written field that `src/vex-agent/studio/agents.ts` carries against the
tables below. Code and this document therefore cannot drift: a registry edit
that is not reflected here fails a test, and so does the reverse.

It is not generated. A generated mirror of the registry would prove only that
the registry equals itself; the point of this file is that a HUMAN read the
vendor evidence and wrote down what it says, so a wrong transcription is
visible as a diff in review.

## The finding that governs the timeout column

A Vex approval can hold a tool call for the full `APPROVAL_TTL_MS`
(`src/vex-agent/engine/core/approval-runtime/enqueue.ts`, one hour). What kills
such a wait in practice is an IDLE timer, not a wall clock: claude-code aborts a
silent stdio call at 30 minutes, and qwen-code's `mcp.toolIdleTimeoutMs` is HARD
CAPPED at 60 minutes. Neither can be configured past the problem from a project
file. The load-bearing mechanism is MCP PROGRESS NOTIFICATIONS, which the Vex
host emits about every 2 seconds during an approval wait, guarded on the client
having sent a progress token. Stage A-test must verify per client that a token
is actually sent; a client that sends none is subject to its idle timer no
matter what this file's wall-clock column says.

## Column meanings

- **config path**: the repo-relative file Vex writes. One per agent.
- **also reads**: other repo paths the client reads. Vex NEVER writes these;
  they are listed because they are the accepted residual (owner decision
  2026-08-24: Copilot and Grok also reading Claude's `.mcp.json` means a project
  with Claude selected is discoverable by unselected Copilot/Grok; this is
  described in the trust copy, not prevented).
- **owned path**: the JSON path, or TOML section, that belongs to Vex inside
  that file. Everything else in the file is the user's and is preserved.
- **entry keys**: the CLOSED allowlist of keys Vex may emit in its entry. No
  code path can emit a key outside it.
- **timeout mechanism**: how a long tool call survives, with the unit and the
  value Vex writes. Server-entry field, client-process environment variable and
  user-scope config are DISTINCT mechanisms; a client env var is NEVER written
  into the bridge child's environment.
- **never written**: fields this format accepts that would grant tool authority,
  pre-approve calls, or assert trust. A FOREIGN occurrence beside our entry is
  preserved verbatim and reported as a security warning distinct from Vex-owned
  drift.
- **client basis**: the client version the row was established against, pinned
  or detected at install. Never silently guessed.
- **inert until**: a gate outside Vex's reach that makes a correct write do
  nothing until the user acts. Non-null means a write is NOT a working
  integration and the DTO says so.

`UNVERIFIED` cells name the probe that would resolve them. Absence of vendor
documentation is not absence of a timer.

## Config mode

| id | display name | config mode |
| --- | --- | --- |
| claude-code | Claude Code | project |
| codex | Codex CLI | project |
| gemini-cli | Gemini CLI | project |
| opencode | opencode | project |
| grok-build | Grok Build | project |
| kimi | Kimi CLI | launch |
| qwen-code | Qwen Code | project |
| copilot-cli | GitHub Copilot CLI | project |
| cursor | Cursor | project |
| amp | Amp | project |
| kiro | Kiro | project |
| mistral-vibe | Mistral Vibe | project |
| cline | Cline | unsupported |
| droid | Factory Droid | project |
| warp | Warp | unsupported |

Every id stays SELECTABLE and is STORED even when unsupported: a selection is
the user's durable intent, and support arriving in a later version must not
require a migration of stored scopes. An unsupported id produces NO artifact and
an explicit `unsupported` outcome - never silence, never a fake success.

## Paths and dialect

| id | config path | also reads | format | dialect | owned path |
| --- | --- | --- | --- | --- | --- |
| claude-code | `.mcp.json` | - | jsonc | mcp-servers-json | `mcpServers.vex` |
| codex | `.codex/config.toml` | - | toml | mcp-servers-toml-table | `[mcp_servers.vex]` |
| gemini-cli | `.gemini/settings.json` | - | jsonc | mcp-servers-json | `mcpServers.vex`, `context.fileName` |
| opencode | `opencode.json` | `opencode.jsonc` | jsonc | opencode-json | `mcp.vex` |
| grok-build | `.grok/config.toml` | `.mcp.json`, `.cursor/mcp.json` | toml | mcp-servers-toml-table | `[mcp_servers.vex]` |
| kimi | `.vex/mcp/kimi.json` | - | jsonc | mcp-servers-json | `mcpServers.vex` |
| qwen-code | `.qwen/settings.json` | - | jsonc | mcp-servers-json | `mcpServers.vex` |
| copilot-cli | `.github/mcp.json` | `.mcp.json` | jsonc | mcp-servers-json | `mcpServers.vex` |
| cursor | `.cursor/mcp.json` | - | jsonc | mcp-servers-json | `mcpServers.vex` |
| amp | `.amp/settings.json` | `.amp/settings.jsonc` | jsonc | mcp-servers-json | `amp.mcpServers.vex` |
| kiro | `.kiro/settings/mcp.json` | - | jsonc | mcp-servers-json | `mcpServers.vex` |
| mistral-vibe | `.vibe/config.toml` | - | toml | mcp-servers-toml-array | `[[mcp_servers]]` where `name = "vex"` |
| droid | `.factory/mcp.json` | - | jsonc | mcp-servers-json | `mcpServers.vex` |

`amp.mcpServers` is ONE literal key containing a dot, not two path segments.

Cline and Warp have no row here: they have no writer at all.

## Entry shape

| id | `type` value | entry keys allowed |
| --- | --- | --- |
| claude-code | omitted | `type`, `command`, `args`, `timeout` |
| codex | omitted | `command`, `args`, `tool_timeout_sec` |
| gemini-cli | omitted | `type`, `command`, `args`, `timeout` |
| opencode | `local` | `type`, `command`, `timeout` |
| grok-build | omitted | `command`, `args`, `tool_timeout_sec` |
| kimi | omitted | `type`, `command`, `args`, `timeout` |
| qwen-code | omitted | `type`, `command`, `args`, `timeout` |
| copilot-cli | `local` | `type`, `command`, `args`, `timeout` |
| cursor | `stdio` | `type`, `command`, `args`, `timeout` |
| amp | omitted | `type`, `command`, `args`, `timeout` |
| kiro | omitted | `type`, `command`, `args`, `timeout` |
| mistral-vibe | omitted | `name`, `command`, `args`, `tool_timeout_sec` |
| droid | omitted | `type`, `command`, `args`, `timeout` |

The allowlist is per DIALECT, so a key listed above is permitted, not
necessarily emitted: `type` appears only where the row names a value, and
`timeout` / `tool_timeout_sec` only where the timeout mechanism is a
server-entry field.

NO `env` KEY EXISTS IN ANY ALLOWLIST. The bridge locates the Vex socket itself
from the platform config directory, so a Vex entry needs no environment map at
all. That is what makes "a client's own timeout environment variable is never
written into the bridge child's environment" a structural property rather than
a rule to remember.

`opencode` is the outlier: its schema is `additionalProperties: false`,
`type: "local"` is REQUIRED, `command` is an ARRAY carrying binary and arguments
together, and its environment key would be `environment`, not `env` (Vex writes
neither). Re-confirmed against the live `https://opencode.ai/config.json`
(`$defs.McpLocalConfig`) and npm `opencode-ai` 1.18.23; the "V2" line is REFUTED
and does not exist.

`mistral-vibe` is the other outlier: `[[mcp_servers]]` is an ARRAY OF TABLES
whose `name` is a hard required field (`vibe/core/config/models.py`,
`name: str = Field(...)`), so the entry carries its own identity instead of
being keyed by a table name.

## Timeout mechanism

| id | mechanism | field or variable | unit | value Vex writes | seconds |
| --- | --- | --- | --- | --- | --- |
| claude-code | client-env | `MCP_TOOL_TIMEOUT` | ms | nothing | 100800 (default ~28 h) |
| codex | server-entry-field | `tool_timeout_sec` | s | 3900 | 3900 |
| gemini-cli | server-entry-field | `timeout` | ms | 3900000 | 3900 |
| opencode | server-entry-field | `timeout` | ms | 3900000 | 3900 |
| grok-build | vendor-default-sufficient | `tool_timeout_sec` | s | nothing (default 6000) | 6000 |
| kimi | user-global-config | `[mcp.client] tool_call_timeout_ms` | ms | nothing (user action) | 60 (default, INSUFFICIENT) |
| qwen-code | server-entry-field | `timeout` | ms | 3900000 | 3900 |
| copilot-cli | server-entry-field | `timeout` | ms | 3900000 | 3900 |
| cursor | UNVERIFIED | - | - | nothing | - |
| amp | UNVERIFIED | - | - | nothing | - |
| kiro | UNVERIFIED | - | - | nothing | - |
| mistral-vibe | server-entry-field | `tool_timeout_sec` | s | 3900 (emitted as `3900.0`) | 3900 |
| droid | server-entry-field | `timeout` | ms | 3900000 | 3900 |

Every value Vex writes is 3900 s, 65 minutes, which exceeds the one-hour
`APPROVAL_TTL_MS` with five minutes of margin. `agent-registry.test.ts` asserts
this against the constant itself, not against a copy of the number.

Row notes:

- **claude-code**: `MCP_TOOL_TIMEOUT` is a HARD wall clock that progress
  notifications do NOT extend; progress resets only the separate 30-minute stdio
  IDLE timer (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` overrides it in ms, 0 disables,
  v2.1.187+; stdio was exempt before v2.1.203; a per-server `timeout` of at least
  1000 ms floors the idle window on v2.1.203+). Both variables belong to the
  CLIENT's process. Vex writes neither, and neither is ever placed in the bridge
  child's environment.
- **grok-build**: the vendor default of 6000 s is already 100 minutes, so Vex
  writes no timeout rather than restate a sufficient default.
  `startup_timeout_sec` (30) is a separate field Vex does not touch.
- **kimi**: the ONLY mechanism is the global `[mcp.client] tool_call_timeout_ms`
  in the user's `~/.kimi/config.toml`, default 60000 ms. A project cannot set it,
  so it is surfaced as a USER ACTION: set it to 3900000 or a Studio approval
  times out before the user can answer.
- **qwen-code**: the written `timeout` is a wall clock. The separate
  `mcp.toolIdleTimeoutMs` is hard-capped at 3600000 ms, so a 65-minute approval
  survives ONLY because the host emits progress notifications. Vex does not write
  the idle key.
- **copilot-cli**: the vendor DEFAULT is version-dependent - the current CLI
  reference states 30000 ms, and vendor issue copilot-cli#1378 measured 180000 ms
  at v0.0.406. Either is far below an approval wait, so THE EXPLICIT WRITE
  GOVERNS AND THE DEFAULT NEVER DOES. That same closed issue reports a per-server
  timeout being lost after a `notifications/tools/list_changed`; re-verify at the
  installed version if the Vex host ever emits that notification.
- **cursor**, **amp**, **kiro**: UNVERIFIED after two primary-source passes. No
  documented tool-call timeout exists. Owed probe (stage A-test): expose a
  deliberately slow stdio tool and measure where the client aborts.
- **mistral-vibe**: `tool_timeout_sec` is declared FLOAT (default 60.0), so the
  renderer emits `3900.0` rather than `3900`.

## Never-written fields

| id | never written (bare field or section token) |
| --- | --- |
| claude-code | `enableAllProjectMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `hasTrustDialogAccepted` |
| codex | `default_tools_approval_mode`, `approval_mode`, `approval_policy`, `trust_level` |
| gemini-cli | `trust`, `folderTrust` |
| opencode | `permission` |
| grok-build | `permission`, `permission_mode` |
| kimi | - |
| qwen-code | `trust`, `folderTrust`, `allowed`, `excluded` |
| copilot-cli | `tools` |
| cursor | - |
| amp | `mcpPermissions`, `disable` |
| kiro | `autoApprove` |
| mistral-vibe | - |
| cline | `type` |
| droid | - |
| warp | - |

Bare TOKENS, not full paths, because they are asserted as ABSENT SUBSTRINGS of
every byte Vex authors. The full spellings they stand for:
`tools.<tool>.approval_mode` and `projects.<path>.trust_level` (codex),
`security.folderTrust.enabled` (gemini, qwen), `permission.<tool> = "allow"`
(opencode), `[permission]` with any allow rule and `[ui] permission_mode`
(grok), `mcp.allowed` / `mcp.excluded` (qwen), `tools: ["*"]` (copilot),
`amp.mcpPermissions` with `action: "allow"` and `amp.tools.disable` (amp).

THE ABSENCE IS ASSERTED OVER VEX-AUTHORED BYTES ONLY. A foreign occurrence in
the user's file is PRESERVED, never removed - `agent-registry.test.ts` audits
the fresh render, which is entirely ours, and the golden fixtures prove a
foreign `[permission]` survives a merge and a remove untouched.

Notes:

- **grok-build** is the sharpest case: a project `.grok/config.toml` contributes
  `[mcp_servers]`, `[plugins]` AND `[permission]`, so a project file CAN grant
  tool authority. Vex never emits `[permission]` or any allow rule. A foreign
  `[permission]` beside our entry is PRESERVED verbatim - it is the user's or
  another tool's statement, never ours to remove - and reported as a security
  warning distinct from Vex-owned drift. The golden fixtures include exactly that
  case.
- **qwen-code**: `mcp.allowed` / `mcp.excluded` are listed because they are
  commonly mistaken for security controls. They are not, and Vex writes neither.
- **kiro**: `autoApprove` also has open vendor bugs on its semantics, which is a
  second reason never to emit it.
- **cline** carries a never-written field although it has no writer: in Cline's
  dialect an OMITTED `type` means legacy SSE rather than stdio, the inverse of
  Claude's default. If that id ever becomes writable the field is a correctness
  trap, so the fact is recorded now.

## Client version basis and inertness

| id | basis | inert until |
| --- | --- | --- |
| claude-code | pinned 2.1.x | - |
| codex | detected at install | the user trusts the project in Codex |
| gemini-cli | detected at install | - |
| opencode | pinned 1.18.x | - |
| grok-build | detected at install | - |
| kimi | detected at install | the user passes `--mcp-config-file` |
| qwen-code | detected at install | - |
| copilot-cli | detected at install | the folder is trusted in Copilot |
| cursor | detected at install | - |
| amp | detected at install | - |
| kiro | detected at install | - |
| mistral-vibe | detected at install | the working directory is trusted in Vibe |
| droid | detected at install | - |

A write is not success. Codex is trust-gated, Copilot silently skips project
servers in untrusted directories, Vibe silently does not load an untrusted
directory's config, and Kimi needs a launch flag. The per-agent outcome reports
each of these honestly rather than reporting a successful file write as a
working integration.

## Launch mode

Kimi is the only launch-scoped agent. It has NO project config path (user
`~/.kimi/mcp.json` only), but it accepts `--mcp-config-file <path>`, so Vex
generates `.vex/mcp/kimi.json` and documents:

```
kimi --mcp-config-file .vex/mcp/kimi.json
```

Sources disagree on the rebranded "Kimi Code" user path (`~/.kimi-code/`) and on
per-server overrides. That disagreement is irrelevant to the writer, which never
reads or writes a user-scope path, and would only need resolving if Vex ever
read one.

## Unsupported ids

| id | why | support returns when |
| --- | --- | --- |
| cline | the CLI reads `~/.cline/mcp.json` only; writing a user-global file from a project would configure every repository at once | the Cline CLI gains a project-scoped or launch-flag MCP mechanism |
| warp | the CLI reads its global config only ("project-scoped MCP config files in repositories are not detected") and has NO `--mcp` flag; MCP is managed in-session via `/mcp` | the `warp` CLI gains a project or launch MCP mechanism |

Warp's earlier LAUNCH classification (2026-08-24) is SUPERSEDED. Its premise -
an `oz`-style mcp flag - does not exist on the current `warp` binary. OWNER
DECISION 2026-08-25: Warp ships unsupported. The still-functioning deprecated
`oz --mcp` launch was EXPLICITLY DECLINED rather than build a bridge on a binary
the vendor is removing, and the Warp APP's project `.warp/.mcp.json`, readable
only behind explicit in-app manual approval, is NOT built in A5.

## Owed live probes (stage A-test)

1. Tool-call timeouts for **cursor**, **amp**, **kiro** and (if it ever becomes
   supported) **warp**: expose a deliberately slow stdio tool and measure where
   the client aborts.
2. Per-client PROGRESS TOKEN emission: does the client send `progressToken` on a
   tool call? A client that does not is subject to its idle timer regardless of
   every wall-clock value in this file, and that is the single most load-bearing
   unverified fact in the matrix.
3. Copilot's per-server timeout after a `notifications/tools/list_changed`
   (vendor issue copilot-cli#1378), at the installed version.
