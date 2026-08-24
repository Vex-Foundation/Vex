# Agent MCP dialect research (2026-08-24, primary sources)

Source: deep-research pass over current official documentation, verified
2026-08-24. This file is the INPUT to the reviewed
`agent-dialect-matrix.md` the A5a builder formalizes. Citations live in
the research transcript; every UNVERIFIED cell below must either be
resolved by an empirical probe (stage A-test) or ship as a named
limitation.

## The finding that shapes everything: idle timers dominate

A 65-minute approval wait is killed by IDLE timers, not wall-clock
timeouts: claude-code aborts a silent stdio call at 30 minutes
(v2.1.203+), qwen-code's `mcp.toolIdleTimeoutMs` is HARD-CAPPED at 60
minutes. The ONLY mechanism that works across both is MCP PROGRESS
NOTIFICATIONS, which the Vex host already emits every ~2 s during an
approval wait (A4a, guarded on the client's progressToken). Stage
A-test must verify each client actually SENDS a progress token on tool
calls; a client that does not is subject to its idle timer regardless
of wall-clock config.

## Per-agent rows (config mode / path / wrapper / entry / timeout / forbidden)

- claude-code (PROJECT): `.mcp.json`, `mcpServers` JSON; stdio =
  `command/args/env`, `type` optional ("stdio"); per-server `timeout`
  ms (values <1000 ignored), wall-clock env `MCP_TOOL_TIMEOUT` default
  ~28 h, IDLE 30 min unless progress or
  `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (client env, not ours to write).
  Forbidden: `enableAllProjectMcpServers`, `enabledMcpjsonServers`,
  `disabledMcpjsonServers`, `hasTrustDialogAccepted`. Schema shifts
  within v2.1.x - re-verify against installed version.
- codex (PROJECT, trust-gated): `.codex/config.toml`,
  `[mcp_servers.<id>]` TOML; `tool_timeout_sec` per server, default
  60 s -> SET 3900. Config is INERT until the user trusts the project:
  a write is not a working integration. Forbidden:
  `default_tools_approval_mode`, `tools.<t>.approval_mode`,
  `approval_policy`, `projects.<p>.trust_level`.
- gemini-cli (PROJECT): `.gemini/settings.json`, `mcpServers`;
  per-server `timeout` ms default 600000 -> SET 3900000; needs
  `context.fileName: ["AGENTS.md"]` (default is GEMINI.md). Forbidden:
  `trust`, `security.folderTrust.enabled`.
- opencode (PROJECT): `opencode.json[c]`, key `mcp`, schema
  `additionalProperties: false` - `type: "local"` REQUIRED, `command`
  is an ARRAY, `environment` not `env`; `timeout` ms default 5000 ->
  SET 3900000. No V2 on npm (refuted); current 1.18.x. Forbidden:
  `permission.*: "allow"`.
- grok (PROJECT): `.grok/config.toml`, `[mcp_servers.<name>]` TOML;
  `tool_timeout_sec` default 6000 s (already > 65 min). Also reads
  `.mcp.json` and `.cursor/mcp.json` as vendor compat (the accepted
  residual). Forbidden fields UNVERIFIED (project "permission rules"
  undocumented) - probe.
- kimi (LAUNCH): NO project file; `~/.kimi/mcp.json` user-scope or
  `--mcp-config-file <path>` flag. Timeout is GLOBAL
  `[mcp.client] tool_call_timeout_ms` default 60000 in the USER's
  config.toml - a project cannot set it. => launch-scoped: generate
  `.vex/mcp/kimi.json` + document the flag; timeout documented as a
  user action.
- qwen-code (PROJECT): `.qwen/settings.json` like gemini; `timeout` ms
  PLUS `mcp.toolIdleTimeoutMs` clamped to max 3600000 - 65 min
  REQUIRES our progress notifications. Forbidden: `trust`,
  `security.folderTrust.enabled`, `mcp.allowed/excluded` are not
  security.
- copilot (PROJECT): `.github/mcp.json` (chosen; it also reads
  `.mcp.json` upward - residual accepted by owner); wrapper
  `mcpServers` or bare map; `type: "local"|"stdio"`, `tools` field
  (forbidden value `["*"]` = pre-approval). Tool-call timeout
  UNVERIFIED - probe.
- cursor (PROJECT): `.cursor/mcp.json`, `mcpServers`;
  `type: "stdio"`, `envFile` exists. Timeout UNVERIFIED - probe.
  No config pre-approval field documented.
- amp (PROJECT): `.amp/settings.json[c]`, DOTTED key
  `amp.mcpServers`; timeout UNVERIFIED - probe. Forbidden:
  `amp.mcpPermissions` with `action: "allow"`, `amp.tools.disable`.
- kiro (PROJECT): `.kiro/settings/mcp.json`, `mcpServers`; `disabled`,
  `autoApprove` (forbidden; note open bugs on its semantics). Timeout
  UNVERIFIED - probe.
- factory/droid (PROJECT): `.factory/mcp.json`, `mcpServers`;
  per-server `timeout` ms, no documented default -> SET 3900000;
  `connectTimeout` separate. No pre-approval config field exists
  (out-of-band fingerprint approvals).
- cline (UNSUPPORTED in A5): CLI reads ONLY `~/.cline/mcp.json`
  (user-global; writing it from a project is invasive). CAUTION:
  omitting `type` defaults to legacy SSE, NOT stdio - inverse of
  claude. Timeout field undocumented. => unsupported until a
  project/launch mechanism exists; shown as such in the picker copy.
- vibe (PROJECT, path UNVERIFIED): `[[mcp_servers]]` ARRAY-OF-TABLES
  with `name` field (outlier dialect); `tool_timeout_sec` per server
  -> SET 3900; config.toml path needs a probe before the writer ships.
- warp (LAUNCH, owner decision): CLI reads GLOBAL config only; `oz`
  binary deprecated in favor of `warp`. => generate `.vex/mcp/
  warp.json` + document `warp agent run --mcp <file>` (verify the
  current binary/flag at build time). Timeout UNVERIFIED.

## Cross-cutting rules for the writers

- NEVER assume `mcpServers`+`command`/`args`/`env` is universal
  (opencode, codex, grok, vibe, amp, warp-inline all differ).
- NEVER emit `type` for cline-dialect files; ALWAYS emit
  `type: "local"` for opencode; optional elsewhere.
- A write is not success: codex is trust-gated, warp/kimi are
  launch-scoped - the DTO reports per-agent integration state
  honestly.
- Empirical probes owed (stage A-test): cursor/amp/kiro/copilot/warp
  timeouts, vibe path, grok forbidden fields, per-client progressToken
  emission.
