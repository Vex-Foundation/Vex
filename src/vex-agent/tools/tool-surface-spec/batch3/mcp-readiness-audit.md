# MCP-readiness audit of the agent tool surface

Measured 2026-08-22 on branch feat/tool-surface-3 (worktree
/home/kubas/Vex-batch3), statically over the 167 committed contract
snapshots in src/vex-agent/tools/__toolsnaps__/ and the live catalog import
(PROTOCOL_TOOLS, 134 manifests). Nothing was executed at runtime. Every gap
is classified as METADATA (naming, descriptions, schemas, projection; allowed
under the frozen-behavior constraint) or BEHAVIOR (handler logic, parameter
semantics, approvals, persisted writes; named here, not changed by this
program).

## The exported set

Per mcp-export-scope.md: 155 exported tools = 21 internal + 134 protocol.
Excluded as session-bound (11): SessionMemorySearch, SessionMemoryResolve,
MemorySuggest, MemorySearch, MemoryGet, MemoryHistory, MissionDraftUpdate,
MissionStop, LoopDefer, CompactApply, PlanWrite.

Exported internal (21): AgentScan, BridgeExecute, BridgeExecuteRelay,
BridgeQuote, BridgeQuoteRelay, BridgeStatus, ChainRead, SwapExecute,
SwapExecuteUniswap, SwapQuote, SwapQuoteUniswap, TokenCheck, TokenFind,
ToolSearch, TwitterAccount, UnitsConvert, WalletBalances, WalletSendConfirm,
WalletSendPrepare, WalletTrackToken, WebResearch.

Doc drift: mcp-export-scope.md:18 says "137 toolIds today"; the catalog holds
134 (three retired in Batch 2). Corrected in the Batch 3 closure.

## Readiness by criterion

1. Name validity: DONE for protocol, PARTIAL for internal. 155/155 match
   ^[A-Za-z0-9_-]{1,64}$, zero collisions after Claude Code's mangling, max
   length 37 (dexscreener__community_takeovers_list,
   solana__predict_suggested_events_list), 47 with an mcp__vex__ prefix.
   Pinned for protocol names by registry/injected-protocol-tools.ts:61
   (OPENAI_TOOL_NAME_PATTERN) asserted in
   __tests__/vex-agent/tools/registry/injected-protocol-tools.test.ts:60-68,
   and by protocols/public-name-gate.ts:100-102,184,190. No test pins the 21
   internal names. METADATA, XS: one test (Batch 3 closure WP1 item 8).

2. Title: MISSING on all 155. ToolDef (tools/types.ts:115-152) and
   ProtocolToolManifest (protocols/types.ts:138-279) have no title field.
   github-mcp carries one as an annotation (pkg/github/repositories.go:33,
   snapshotted at pkg/github/__toolsnaps__/get_file_contents.snap:4).
   discovery.canonicalSummary exists on only 20/134 manifests (all
   solana-jupiter); navigation label and summary are per facet and per
   namespace, not per tool. METADATA, M: 155 titles to author, one new
   optional manifest and ToolDef field, snapshot and lint update.

3. Description: PARTIAL. Exported descriptions: min 507 B
   (solana__predict_order_status_get), max 6114 B (morpho__vaults_discover),
   mean 1531 B, median 1264 B. Over 2048 B: 32 of 167 (31 exported; morpho
   18, dexscreener 3, internal 4 including the excluded LoopDefer, trench 2,
   pendle 2, pools 1, khalani 1, kyberswap 1). D12 ratified seven
   fund-moving ones; the other 24 are an open owner decision (D12 corrected).
   Session-only concepts in exported descriptions: "mission" in 4 (AgentScan,
   pools__launch_execute, trench__images_list, trench__launch_execute),
   "compact" in 2 (AgentScan, ToolSearch), "session wallet" or "selected
   wallet" in 17 (WalletSendConfirm, khalani__bridge_execute,
   khalani__orders_list, khalani__token_balances_get,
   kyberswap__swap_execute, morpho__market_quote, pendle__lp_quote,
   pendle__merkle_rewards_list, pendle__positions_get, pendle__pt_quote,
   pendle__py_quote, pendle__yt_quote, pools__launch_execute,
   pools__my_launches_list, solana__predict_profile_get,
   solana__predict_vault_get, trench__launch_preview). Zero references to
   session memory, plan mode, long memory, loop or defer, or the approval
   queue UI. The 17 wallet references describe real wallet-scoping
   behavior (criterion 9d); rewording them without a Studio-side scope
   equivalent would make the description lie. METADATA for the 6
   mission/compaction mentions once the Studio design says what an external
   client sees; BEHAVIOR underneath the 17.

4. Input schema: DONE. Compiler registry/khalani.ts:60-89
   (paramsToJsonSchema), called from registry/injected-protocol-tools.ts:172,
   then inference/schema-normalizer.ts:44. Output is plain JSON Schema
   (type, properties, description, required, enum, anyOf, items,
   additionalProperties). additionalProperties false on 155/155; required on
   115; enum on 48; anyOf on 26 (the acceptsStringArray union,
   khalani.ts:70-79). Param types across 134 manifests: string 475, number
   209, boolean 94, object 0 (only the internal TwitterAccount has an object
   param). exampleParams (123/134) and unit "bps" (41 params) stay on the
   manifest and are already absent from the projected schema. Nothing
   provider-specific to strip. METADATA, XS.

5. Output: MISSING. No outputSchema or structuredContent anywhere under
   src/vex-agent/ (grep: 0 hits). Output is one string, ToolResult.output
   (tools/types.ts:222-224); data is dropped before the model
   (output-envelope.md:13-24). output-envelope.md:30-38 requires a JSON
   success body led by summary; measured: of 68 protocol handler files that
   return ok(...), 28 carry a summary key (about 41 percent). Failure,
   refusal, cancellation and ambiguous-commit arms are deliberately PROSE
   (output-envelope.md:40-79, live citation
   kyberswap/handlers/swap/execute-broadcast.ts:122-126), a money-path
   invariant. github-mcp emits StructuredContent (pkg/utils/result.go:79).
   BEHAVIOR to add a second channel; METADATA only if Studio declares an
   outputSchema for the already-JSON success arm and leaves the four prose
   arms alone. L.

6. Annotations: PARTIAL, derivable except three cells. actionKind x mutating
   over the 155: read/false 103; user_wallet_broadcast/true 47;
   local_write/true 3 (pools__launch_preview, pools__launch_request_form,
   trench__launch_request_form); local_write/false 1 (WalletTrackToken);
   approval_prepare/false 1 (WalletSendPrepare). No idempotency field exists
   on ToolDef or ProtocolToolManifest (only prose and a runtime
   idempotencyKey at internal/wallet/send/prepare.ts:71). Contestable
   derivations: pools__launch_preview is mutating true but a preview (the
   runtime overrides to read when isPreviewExecution,
   protocols/types.ts:206-207); the two *_request_form tools park a human
   form rather than write data; WalletSendPrepare is mutating false yet
   writes a durable intent row (internal/wallet/send/prepare.ts:45-71), so
   readOnlyHint true would be false. schedule and destructive have zero
   exported inhabitants. openWorldHint has no backing field. METADATA: a
   declared derivation table and, if idempotentHint is wanted, one new
   manifest field. BEHAVIOR only if an actionKind is reclassified.

7. Read-only mode: PARTIAL. The natural filter is actionKind === "read",
   103 tools, mirroring github-mcp pkg/inventory/server_tool.go:107-108 and
   pkg/inventory/filters.go:98. The classification is compiler-enforced
   (tools/types.ts:139, protocols/types.ts:209) and snapshotted, but no
   lint asserts that a read handler performs no write. The four cells above
   are where a read-only verdict is contestable. METADATA for the filter;
   BEHAVIOR to reclassify.

8. Determinism of tools/list: PARTIAL, one real source of variance. Measured:
   0 exported-internal withheld under the baseline scenario, 0 declared
   visibility gates, 0 non-advertised protocol manifests, lifecycle is the
   single-inhabitant union "active" (protocols/types.ts:42). Venue reveal
   gone (D4; toolsnaps/build-contracts.ts:40-48). Discovery barrier gone
   (D2; build-contracts.ts:50-53). Remaining variance: requiresEnv, one
   variable, JUPITER_API_KEY, gating 34 of 155 (all solana__*), derived at
   build-contracts.ts:172-194. Separately, contextUsageBand at barrier or
   critical drops pressureSafety "mutating" tools from the in-app catalog
   and hard-denies at dispatcher/pressure-gate.ts:31-51, and
   registry/discovered-tools.ts caps a session's injected protocol set at 40
   (MAX_DISCOVERED_TOOLS_PER_SESSION). requiresEnv: METADATA (list
   statically, return a typed unsupported outcome at call time, rule 04).
   Pressure gate and the 40-cap: in-app behavior the export must simply not
   apply; state it, do not change it.

9. Session dependencies: five classes.
   a. ToolSearch select writes a session working set
      (dispatcher/tool-search-select.ts:58-60,157 recordDiscoveredTools;
      store registry/discovered-tools.ts:1-20, process-local, fail-closed on
      unknown session). Projection can omit: D2 exports ToolSearch read-only.
   b. Prequote gating of mutating tools: protocols/prequote/gate.ts:66-76
      returns block("no_session") without a sessionId (gate-errors.ts:13);
      about 22 execute tools are gated (prequote/registry.ts
      EXECUTE_GATE_TOOLS: 3 swap executes, khalani and relay bridge, 8
      pendle, 8 morpho) against 14 recording quote tools (registry.ts:53-80).
      A Studio caller with no session can never satisfy it. BEHAVIOR; needs
      a project-scope equivalent.
   c. Approval envelope: protocols/runtime.ts:251-261 evaluateApprovalGate,
      runtime/gates.ts:236 pendingApproval; caller-facing carry is
      PreparedActionFollowUp (tools/types.ts:350-360: toolName, args,
      expiresAt, approvalPreview.criticalArgs) plus ToolResult.prequote
      (types.ts:277 onward). BEHAVIOR.
   d. Wallet scoping: ProtocolExecutionContext.walletResolution and
      walletPolicy (protocols/types.ts:296-302), defaulted at
      runtime.ts:132-133; 17 descriptions promise it. BEHAVIOR.
   e. Durable session writes: internal/portfolio-inspect.ts:73 passes
      sessionId to inspectTransactions; internal/wallet/send/prepare.ts:59-71
      writes the intent row under withSessionControlLock(sessionId) with a
      TTL. BEHAVIOR.
   mcp-export-scope.md:50-53 already names project scope as the intended
   owner of b to e. Not designed here.

10. Approval path inventory: 47 user_wallet_broadcast exported tools
    (BridgeExecute, BridgeExecuteRelay, SwapExecute, SwapExecuteUniswap,
    WalletSendConfirm, khalani__bridge_execute, kyberswap__swap_execute,
    every morpho market and vault mutation, every pendle mutation,
    solana__swap_execute, solana__predict_buy, sell, claim, close_all,
    solana__lend_*, pools__launch_execute, trench__launch_execute), 1
    approval_prepare (WalletSendPrepare), 3 local_write mutating, 0
    destructive, 0 schedule. The caller must carry today: intentId and
    expiresAt (wallet/send/prepare.ts:45-46,96-97), approvalPreview.
    criticalArgs (trusted, never model-sourced, types.ts:337-343), the typed
    prequote.verdict and fotTax (types.ts:277 onward), and host-side
    provenance missionId, missionRunId, approvalId, toolCallId
    (protocols/types.ts:305-341). The input_required plus sealed
    requestState shape at mcp-export-scope.md:46-49 is a design note, not
    code. BEHAVIOR.

11. Pagination and output envelope: MISSING for most. Continuation-field
    mentions in the 155 descriptions: hasMore 18, filtersApplied 14,
    truncated 6, nextCursor 4, nextOffset 2, nextPage 0; 28/155 mention any.
    44 tools carry an offset, cursor, page or limit param; 24 of those
    promise no continuation field: ToolSearch, TwitterAccount,
    WalletBalances, dexscreener__narratives_list, khalani__orders_list,
    khalani__tokens_autocomplete, morpho__markets_discover,
    morpho__positions_get, morpho__vaults_discover, pools__my_launches_list,
    pools__token_candles_list, solana__predict_events_discover,
    solana__predict_events_search, solana__predict_leaderboard_list,
    solana__predict_orders_list, solana__predict_positions_list,
    solana__predict_trade_history_list, solana__predict_trades_list,
    trench__images_list, trench__my_launches_list, trench__tokens_search,
    virtuals__agents_discover, virtuals__genesis_launches_list,
    virtuals__graduations_list. Contract at output-envelope.md:107-135.
    Describing existing fields is METADATA; emitting new fields is BEHAVIOR
    (handler return shape). Batch 4, owner decision.

12. Parameter vocabulary: MISSING, Batch 4. _manifest-lint/allowlist.ts holds
    329 param-key rows: dexscreener 117, solana 72, pendle 50, trench 24,
    pools 20, khalani 19, virtuals 3, relay 2, plus internal subjects
    (BridgeStatus 6, BridgeQuote 4, BridgeExecute 4, BridgeQuoteRelay 2,
    BridgeExecuteRelay 2, WalletTrackToken, WalletSendPrepare,
    WalletSendConfirm, WalletBalances 1 each). Other rule debt:
    chain-doc-parity 55, enum-declaration 27, param-description 26,
    amount-bps-shape 7, exclusive-param-groups 5, generic-error-literal 4.
    A param RENAME changes what a stored approval or durable plan can replay;
    D5 governs. Owner decision under the frozen-behavior constraint.

## What remains, ordered

### Metadata and projection, allowed now

1. Internal-name charset test (criterion 1). Batch 3 closure.
2. mcp-export-scope.md count 137 to 134. Batch 3 closure.
3. Annotation derivation table: readOnlyHint = actionKind read;
   destructiveHint from user_wallet_broadcast and destructive;
   idempotentHint omitted or backed by a new field; openWorldHint omitted;
   the four contestable tools resolved by the declared rule, never by
   reclassifying actionKind. Studio phase.
4. Titles for 155 tools: new optional field, authored per tool. Studio
   phase or Batch 4.
5. requiresEnv projection: list the 34 solana tools statically, typed
   unsupported outcome without JUPITER_API_KEY. Studio phase.
6. inputSchema: the existing normalized schema, unchanged.
7. Description-side continuation promises where a handler already emits the
   fields (28 tools). Batch 4, with the handler inventory.
8. The 24 over-2048 descriptions beyond the ratified seven: owner decision
   (D12).

### Behavior, named only

9. Prequote gating without a session (about 22 execute tools).
10. Approval round trip for 47 broadcast tools plus WalletSendPrepare.
11. Wallet scoping promised by 17 descriptions.
12. Durable session writes (WalletSendPrepare intents, AgentScan reads
    keyed on sessionId).
13. ToolSearch select-mode working-set write: the read-only export must not
    reach it (a projection decision about a behavior; state it).
14. Pressure gate and the 40-tool session cap: do not apply to the export.
15. Output envelope: 40 of 68 handler files emit no summary; 24 paginated
    tools emit no continuation field.
16. structuredContent and outputSchema: zero support; a second model-visible
    channel output-envelope.md deliberately does not have.
17. Param-key vocabulary: 329 non-canonical keys.

## Do not assume

- 137 protocol tools: it is 134.
- D12's seven covers the over-2048 set: measured 32 of 167.
- actionKind read is a proven read-only filter: it is classification, not
  a verified property.
- tools/list is already deterministic: JUPITER_API_KEY gates 34/155.
- The venue reveal or the discovery barrier still exist: both deleted.
- An idempotency field exists: it does not.
- The four prose failure arms are drift: they are a ratified money-path
  invariant.
- The 17 "session wallet" descriptions are a wording problem: they
  describe real behavior.
- Anything here was verified at runtime: every count is static.

## Addendum 2026-08-22: two corrections from the github-mcp-server architecture map

Measured against the reference at 8ec6249 (`studio-mcp/github-mcp-architecture-map.md`):

1. Criterion 5 cites `pkg/utils/result.go:79` as "github-mcp emits
   StructuredContent". That site is the MCP Apps `awaiting_user_submission`
   sentinel (an `IsError: true` result meaning a form is open and the
   operation has NOT happened); `csv_output.go:104` nils the field. The
   reference has no structured output channel; its output is text content.
   The "L" behavior item at line 95 is not supported by the reference and
   O5 stays deferred.
2. The dynamic-toolsets meta-tool mode (`enable_toolset`,
   `list_available_toolsets`) does not exist in the reference at this
   commit. The surface is fixed per connection by flags or headers, and
   `pkg/inventory/tool_availability.go` filters `tools/list` by the client's
   protocol version and declared capabilities. Any design citing the
   meta-tool mode as prior art cites something that no longer exists.
