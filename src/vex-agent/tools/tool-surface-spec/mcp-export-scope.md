# Studio MCP Export Scope

Owner decision, 2026-08-21. Records which parts of the agent tool surface the
future local MCP server (vex-studio.plan.md) exports to external coding
agents (Claude Code, Codex CLI) running in Studio terminals. This is a scope
record for the Studio phase; nothing here is implemented in Batch 1.

## Decision

The MCP server exports the tool surface EXCEPT the session-bound groups:

| Group | Export | Tools (current names) |
| --- | --- | --- |
| Trading aliases | YES | token_find, token_check, swap_quote, swap_execute, swap_quote_uniswap, swap_execute_uniswap, bridge, bridge_quote, bridge_status, bridge_quote_relay, bridge_execute_relay |
| Wallet / on-chain | YES | wallet_balances, wallet_track_token, wallet_send_prepare, wallet_send_confirm, chain_read, agent_scan |
| Research | YES | web_research, twitter_account |
| Math | YES | units_convert |
| Protocol tools | YES, all namespaces | the full catalog (137 toolIds today), under their publicName |
| Memory | NO | session_memory_search, session_memory_resolve_item, long_memory_suggest, long_memory_search, long_memory_get, long_memory_history |
| Engine / runtime | NO | mission_draft_update, mission_stop, loop_defer, compact_apply, plan_write |
| Knowledge | NO | already retired from the agent surface; stays retired in the export |
| Meta / discovery | ToolSearch YES (read-only catalog search); execute_tool NO | see below and owner-decisions.md D2 |

## Rationale

- Memory and engine/runtime tools are agent-session concerns bound to the
  in-app session lifecycle (missions, plan mode, context compaction, session
  memory stores). An external coding agent brings its own planning and
  memory; exposing Vex's would cross two session models with no owner.
- MCP 2026-07-28 requires tools/list not to vary by connection state.
  Session-bound tools cannot satisfy that contract; the excluded groups are
  exactly the session-bound ones.
- Knowledge tools were removed from the agent surface before this program
  and do not return through the export.

## Design notes for the Studio phase (not Batch 1 work)

- The MCP tools/list is a STABLE, deterministic catalog of every exported
  tool (spec 2026-07-28: no per-connection variance, deterministic order,
  CacheableResult hints); the CLIENT's own deferred loading handles context
  scale. ON TOP of that static list, ToolSearch exports as a read-only
  catalog-search tool (owner decision D2): it answers with ranked matches
  from the same embedding+lexical index the in-app agent uses, and never
  mutates the list. execute_tool remains an internal approval-resume
  envelope and never exports.
- Every exported mutating tool keeps its approval path: the MCP call returns
  input_required with sealed requestState (multi round trip) and the
  approval decision stays in the Vex privileged executor. Client-side hints
  (readOnlyHint, destructiveHint) are set but are never the enforcement.
- Project scope from vex-studio.plan.md (restricted/full permission plus
  selected wallets per project) gates the export the way session scope gates
  the in-app surface today; the gating decision is made off the resolved
  manifest, never the tool name.
- Exported names are the publicName projections from the mapping artifacts
  in this directory; the tier-1 PascalCase names export as-is (charset-safe
  for the mcp__vex__ prefix).
