# Core Tool Naming Map (Tier 1)

Status: specification, Batch 1. No code changes accompany this document.
Authority: harness plan v3 section 5.1 (Tier 1 core). This document finalizes
what that section marked "spec S1 finalizes".

Scope: the 34 internal `ToolDef` entries registered in
`src/vex-agent/tools/registry/`. Protocol `publicName` mapping (137 manifests)
is owned by S2 and S3 and is out of scope here.

All file references are to the `feat/tool-surface` worktree
(`/home/kubas/Vex-tool-surface`), paths relative to `src/vex-agent/`.

## 1. Identity model for internal tools

Protocol tools have two identities: the immutable dotted `toolId` and the new
`publicName` projection (plan 5.1). Internal tools do not. For an internal
tool the NAME is the identity: it is what the dispatcher routes on
(`tools/dispatcher/protocol-route.ts:265-279`), what the registry keys
(`tools/registry/lookup.ts:56`), what `approval_queue.tool_call` stores, and
what the system prompt names in prose.

Consequence: every rename in this document is a durable-identity change and
MUST go through the deprecation alias resolver (plan 5.5, builder G3). Old
name resolves to new at every name-bearing boundary, including cold approval
resume. Nothing in this document is safe to apply without that resolver in
place.

## 2. Grammar

- PascalCase, no separators, ASCII letters and digits only.
- Shape is `Resource` + `Verb` (`WalletBalances`, `PlanWrite`,
  `MemorySearch`), matching the Claude Code core form the owner selected.
  Where a tool is a pure action with an implicit resource, the verb leads
  (`ToolSearch`, `AgentScan`).
- No underscores, no dots. Safe in the OpenAI function-name charset
  (`OPENAI_TOOL_NAME_PATTERN`, `tools/registry/injected-protocol-tools.ts:38`)
  and safe against Claude Code name normalization for the later MCP export
  (plan section 3, external fact 2).
- No `__`. The double underscore is reserved as the protocol-namespace
  separator (`NAME_SEPARATOR`,
  `tools/registry/injected-protocol-tools.ts:41`); `isInjectedToolNameShape`
  (same file, line 88) uses its presence to separate "the model aimed at a
  protocol tool" from "unknown internal tool". A PascalCase core name can
  never collide with that shape.
- Maximum length observed in this map: 24 characters
  (`SessionMemoryResolve`, `BridgeExecuteRelay` are shorter; the longest is
  `SessionMemorySearch` at 19 and `MissionDraftUpdate` at 18). Well inside the
  64-character provider limit.

## 3. The map

Columns: current registered name, new PascalCase name, classification as
declared on the `ToolDef`, visibility gates, and the modules that name the
tool in prose or in a name-keyed set (all of which must change with the
rename).

Classification is written `mutating / pressureSafety / actionKind`.

### 3.1 Discovery and protocol meta-tools (`registry/protocol.ts`)

| Current | New | Class | Gates | Named by |
| --- | --- | --- | --- | --- |
| `discover_tools` | `ToolSearch` | false / read_only / read | none (always visible) | `protocol.ts` x9, `engine/prompts/tool-model.ts` x8, `injected-protocol-tools.ts` x3, `engine/prompts/research.ts` x3, `tool-map.ts`, `khalani.ts`, `discovered-tools.ts`, `describe-tools-reveal.ts` |
| `describe_tools` | merged into `ToolSearch` | false / read_only / read | `visibility.requiresDescribeToolsReveal` (`protocol.ts:66`, enforced `visibility.ts:285`) | `discovered-tools.ts` x4, `describe-tools-reveal.ts` x4, `tool-map.ts` x2, `visibility.ts`, `protocol.ts` |
| `execute_tool` | retired from the model surface (see section 5) | false / read_only / read | `MODEL_WITHHELD_TOOL_NAMES` (`visibility.ts:161`) | `visibility.ts` x4, `protocol.ts` x2, `action-aliases.ts` x2, `tool-map.ts`, `khalani.ts`, `injected-protocol-tools.ts` |

Rationale.

- `ToolSearch`: one tool, three modes, one name. Four spellings of discovery
  in the current surface (`discover_tools`, `describe_tools`, `execute_tool`,
  plus `list:true` as a hidden fourth behavior) collapse to one. The design is
  `toolsearch-design.md`.
- The merge deletes a registered `ToolDef`, so the internal count moves
  34 -> 33. The `execute_tool` retirement moves it 33 -> 32. Neither is a
  Batch 1 change.

### 3.2 Swap and bridge action aliases (`registry/action-aliases.ts`)

| Current | New | Class | Gates | Named by |
| --- | --- | --- | --- | --- |
| `swap_quote` | `SwapQuote` | false / read_only / read | none | `action-aliases.ts` x7, `engine/prompts/protocols.ts` x2, `uniswap-reveal.ts`, `tool-map.ts`, `engine/prompts/tool-model.ts` |
| `swap_execute` | `SwapExecute` | true / mutating / user_wallet_broadcast | none | `action-aliases.ts` x6, `engine/prompts/safety-contract.ts` x2, `engine/prompts/protocols.ts` x2, `tool-map.ts`, `engine/prompts/tool-model.ts` |
| `swap_quote_uniswap` | `SwapQuoteUniswap` | false / read_only / read | `visibility.requiresUniswapReveal` (`action-aliases.ts:165`, enforced `visibility.ts:280`) plus a dispatch-side refusal in the alias handlers (`uniswap-reveal.ts` header) | `action-aliases.ts` x5, `uniswap-reveal.ts` x3, `uniswap-reveal-eligibility.ts` x2, `tool-map.ts` x2, `visibility.ts` |
| `swap_execute_uniswap` | `SwapExecuteUniswap` | true / mutating / user_wallet_broadcast | same reveal pair as above (`action-aliases.ts:180`) | `action-aliases.ts` x5, `uniswap-reveal.ts` x3, `tool-map.ts` x2, `visibility.ts`, `uniswap-reveal-eligibility.ts` |
| `bridge` | `BridgeExecute` | true / mutating / user_wallet_broadcast | none | `action-aliases.ts` (36 hits, mostly substring), `engine/prompts/protocols.ts`, `engine/prompts/chain-coverage.ts`, `relay-reveal.ts`, `autonomy.ts`, `engine/prompts/index.ts`, `portfolio.ts`, `engine/prompts/safety-contract.ts` |
| `bridge_quote` | `BridgeQuote` | false / read_only / read | none | `action-aliases.ts` x6, `engine/prompts/protocols.ts` x3, `tool-map.ts`, `engine/prompts/tool-model.ts` |
| `bridge_status` | `BridgeStatus` | false / read_only / read | none | `autonomy.ts` x3, `action-aliases.ts` x2, `tool-map.ts`, `engine/prompts/tool-model.ts`, `engine/prompts/execution-policy.ts` |
| `bridge_quote_relay` | `BridgeQuoteRelay` | false / read_only / read | `RELAY_REVEAL_GATED_ALIAS_NAMES` name set (`relay-reveal.ts:82-85`, filtered `visibility.ts:174`) plus exact-route enforcement at dispatch | `action-aliases.ts` x3, `tool-map.ts` x2, `relay-reveal.ts` x2, `relay-reveal-eligibility.ts` |
| `bridge_execute_relay` | `BridgeExecuteRelay` | true / mutating / user_wallet_broadcast | same relay reveal set | `tool-map.ts` x2, `relay-reveal.ts` x2, `action-aliases.ts` x2, `relay-reveal-eligibility.ts` |
| `token_check` | `TokenCheck` | false / read_only / read | none | `engine/prompts/safety-contract.ts` x3, `action-aliases.ts` x2, `tool-map.ts`, `engine/prompts/tool-model.ts` |

Rationale.

- `bridge` -> `BridgeExecute` is the only rename in this group that changes
  meaning as well as spelling. Today the bare `bridge` is the mutating
  fund-moving router while its read-only sibling carries the explicit
  `_quote` suffix, so the SHORTER name is the DANGEROUS one. Making the verb
  explicit puts `BridgeQuote` and `BridgeExecute` in the same grammar as
  `SwapQuote` and `SwapExecute`, and removes an asymmetry that a model
  scanning a tool list has to know about rather than read.
- `token_check` -> `TokenCheck` keeps the current word. `TokenSafetyCheck`
  was considered and rejected: the description (`action-aliases.ts:243-244`)
  is where honeypot and fee-on-transfer detection belongs, and a longer name
  buys nothing that sentence 1 of the description does not already carry.
- `bridge_status` -> `BridgeStatus` and not `BridgeOrders`, even though it
  lists orders when `orderId` is omitted (`action-aliases.ts:260-261`). The
  single-order lookup is the primary path in the prompt stack
  (`engine/prompts/execution-policy.ts`), and the list is the fallback.
- The four venue-suffixed names are the recommendation of section 6, not a
  mechanical carry-over.

### 3.3 Token resolution (`registry/khalani.ts`)

| Current | New | Class | Gates | Named by |
| --- | --- | --- | --- | --- |
| `token_find` | `TokenFind` | false / read_only / read | none | `action-aliases.ts` x18, `khalani.ts` x3, `evm.ts` x3, `units.ts` x2, `engine/prompts/tool-model.ts` x2, `engine/prompts/safety-contract.ts` x2, `tool-map.ts`, `protocol.ts` |

Rationale. This is the single most cross-referenced internal tool name in the
repository (33 mentions across registry and prompts) and it sits on the money
path: `khalani.ts:16-18` records that it is kept precisely because the swap
chain-param docs, `chain_read`'s description, and the safety doctrine all name
it. The rename is mechanical, but its blast radius is the largest in this map
and the alias must cover it before any prose is touched.

Note: this tool is a projection of the protocol manifest
`khalani.tokens.search` (`KHALANI_INTERNAL_TO_PROTOCOL`, `khalani.ts:20-22`).
Its internal name is Tier 1; the underlying `toolId` is untouched and remains
S3's concern.

### 3.4 Reads, research, and wallet (`registry/web.ts`, `twitter-account.ts`, `portfolio.ts`, `evm.ts`, `wallet.ts`, `units.ts`)

| Current | New | Class | Gates | Named by |
| --- | --- | --- | --- | --- |
| `web_research` | `WebResearch` | false / read_only / read, `requiresEnv: TAVILY_API_KEY` (`web.ts:24`) | env gate only (`visibility.ts:166`) | `engine/prompts/research.ts` x12, `web.ts`, `tool-map.ts`, `plan.ts`, `engine/prompts/plan.ts`, `engine/prompts/mission-setup.ts`, `engine/prompts/index.ts` |
| `twitter_account` | `TwitterAccount` | false / read_only / read, `requiresEnv: RETTIWT_API_KEY` (`twitter-account.ts:57`) | env gate only | `engine/prompts/research.ts` x4, `twitter-account.ts` x2, `web.ts`, `tool-map.ts`, `plan.ts`, `engine/prompts/plan.ts`, `engine/prompts/mission-setup.ts` |
| `agent_scan` | `AgentScan` | false / read_only / read | none | `engine/prompts/research.ts` x3, `engine/prompts/mission-capital-banner.ts` x3, `engine/prompts/tool-model.ts` x2, `engine/prompts/identity.ts` x2, `tool-map.ts`, `portfolio.ts`, `autonomy.ts`, `engine/prompts/mission-setup.ts` |
| `chain_read` | `ChainRead` | false / read_only / read | none | `tool-map.ts`, `khalani.ts`, `evm.ts`, `engine/prompts/tool-model.ts`, `engine/prompts/protocols.ts` |
| `wallet_balances` | `WalletBalances` | false / read_only / read | none | `engine/prompts/tool-model.ts` x5, `evm.ts` x3, `engine/prompts/research.ts` x3, `wallet.ts` x2, `autonomy.ts` x2, `engine/prompts/mission-capital-banner.ts` x2, `tool-map.ts`, `portfolio.ts` |
| `wallet_track_token` | `WalletTrackToken` | false / read_only / local_write | none | `wallet.ts`, `tool-map.ts`, `khalani.ts`, `engine/prompts/identity.ts` |
| `wallet_send_prepare` | `WalletSendPrepare` | false / mutating / approval_prepare | none | `wallet.ts` x2, `prepared-action-follow-ups.ts` x2, `tool-map.ts` |
| `wallet_send_confirm` | `WalletSendConfirm` | true / mutating / user_wallet_broadcast | none | `prepared-action-follow-ups.ts` x7, `wallet.ts` x2, `tool-map.ts` |
| `units_convert` | `UnitsConvert` | false / read_only / read | none | `units.ts` x2, `tool-map.ts` |

Rationale.

- `AgentScan` is a product surface name, not a generic verb phrase: the same
  words name the AgentScan views and the egress path (plan section 3, wallet
  capture gap). Preserving it keeps one home for the term.
- `ChainRead` keeps the current word even though the tool is an
  action-enum reader (`tx_receipt`, `erc721_mint`, `erc20_balance`,
  `evm.ts:18`). The enum is the consolidation the plan endorses for reads
  (5.1, "reads MAY consolidate behind method enums"); the name should stay at
  the resource level so a future fourth action does not force a rename.
- `WalletTrackToken` classification is worth stating in the map because it is
  counter-intuitive and is preserved exactly: `mutating: false` with
  `actionKind: "local_write"` (`wallet.ts:37`). It writes a local DB bookmark
  and broadcasts nothing. The description lint (builder G2) must apply the
  `local_write` requirements to it and not the fund-moving ones.
- The `wallet_send_*` pair keeps `Prepare` / `Confirm` verbs. These two carry
  the shortest descriptions in the whole surface (58 characters for a
  fund-moving confirm, plan section 3), which is a description defect, not a
  naming defect. The rename does not fix it and must not be mistaken for
  fixing it.

### 3.5 Session and durable memory (`registry/session-memory.ts`, `long-memory.ts`)

| Current | New | Class | Gates | Named by |
| --- | --- | --- | --- | --- |
| `session_memory_search` | `SessionMemorySearch` | false / read_only / read | `visibility.requiresSessionMemory` (`session-memory.ts:31`, enforced `visibility.ts:269`) | `session-memory.ts` x5, `engine/prompts/memory-section.ts` x2, `engine/prompts/memory-policy.ts` x2, `visibility.ts`, `tool-map.ts`, `engine/prompts/tool-model.ts` |
| `session_memory_resolve_item` | `SessionMemoryResolve` | false / read_only / local_write | `requiresSessionMemory` (`session-memory.ts:66`) | `session-memory.ts` x2, `visibility.ts`, `tool-map.ts` |
| `long_memory_search` | `MemorySearch` | false / read_only / read | `visibility: {}` (always visible, `long-memory.ts:136`) | `long-memory.ts` x6, `engine/prompts/memory-section.ts` x4, `engine/prompts/memory-policy.ts` x2, `tool-map.ts`, `session-memory.ts` |
| `long_memory_get` | `MemoryGet` | false / read_only / read | always visible (`long-memory.ts:189`) | `long-memory.ts` x5, `engine/prompts/index.ts` x2, `tool-map.ts`, `engine/prompts/memory-section.ts`, `engine/prompts/memory-policy.ts` |
| `long_memory_history` | `MemoryHistory` | false / read_only / read | always visible (`long-memory.ts:215`) | `long-memory.ts` x3, `tool-map.ts`, `engine/prompts/memory-section.ts`, `engine/prompts/memory-policy.ts` |
| `long_memory_suggest` | `MemorySuggest` | false / mutating / local_write | always visible (`long-memory.ts:40`) | `engine/prompts/memory-policy.ts` x4, `long-memory.ts` x2, `tool-map.ts`, `engine/prompts/memory-section.ts` |

Rationale and the one live risk in this group.

The plan's baseline drops the `long_` qualifier and keeps `session_`. That
produces an asymmetric pair: `MemorySearch` (durable, cross-session) beside
`SessionMemorySearch` (this conversation only). The alternative,
`LongMemorySearch`, is symmetric.

Recommendation: keep the plan's baseline (`MemorySearch`), because the
asymmetry encodes the correct default. The durable store is always visible in
every session (`long-memory.ts:19`, `visibility: {}`) while the session store
only appears once Track-2 chunks exist (`visibility.ts:269`), so the unmarked
name belongs to the tool that is always there, and the qualified name belongs
to the narrower one.

Cost accepted: two tools whose names differ only by a prefix, both of which
"search memory". This must be paid for in the descriptions, not left to the
name. Requirement for the description wave: sentence 1 of `MemorySearch` and
of `SessionMemorySearch` must each state the scope boundary and name the other
tool as the when-NOT alternative. `engine/prompts/memory-policy.ts` already
teaches this routing and is the second home to keep in sync.

`long_memory_suggest` -> `MemorySuggest` keeps the current verb. `MemoryPropose`
was considered; "suggest" is what the prompt stack and the candidate-staging
model already say (`long-memory.ts:12-18`: a local candidate write, not an
approval-gated mutation), and renaming the concept as well as the tool would
put two vocabularies in the repository at once.

Classification note: `MemorySuggest` is the one tool in this map declared
`mutating: false` with `pressureSafety: "mutating"` (`long-memory.ts:37-39`).
That is deliberate and documented in place: `mutating: true` would wrongly
trigger the dispatcher's internal approval gate
(`protocol-route.ts:280-290`), while the pressure classification still blocks
it at barrier. The rename must not disturb either field.

### 3.6 Session control (`registry/compact.ts`, `autonomy.ts`, `mission.ts`, `plan.ts`)

| Current | New | Class | Gates | Named by |
| --- | --- | --- | --- | --- |
| `compact_apply` | `CompactApply` | false / safe_at_barrier / local_write | `visibility.requiresSummaryReady` (`compact.ts:37`, enforced `visibility.ts:291`) | `visibility.ts` x3, `tool-map.ts` x2, `compact.ts` x2, `engine/prompts/context-pressure.ts` x2, `autonomy.ts`, `engine/prompts/tool-model.ts`, `engine/prompts/safety-contract.ts` |
| `loop_defer` | `LoopDefer` | false / safe_at_barrier / schedule | `visibility.requiresAutonomousLoop` (`autonomy.ts:44`, enforced `visibility.ts:244`) | `engine/prompts/execution-policy.ts` x6, `engine/prompts/mission-run.ts` x4, `visibility.ts` x3, `autonomy.ts` x3, `engine/prompts/index.ts` x2, `tool-map.ts`, `engine/prompts/identity.ts` |
| `mission_draft_update` | `MissionDraftUpdate` | false / mutating / local_write | `visibility.requiresMissionSetup` (`mission.ts:8`, enforced `visibility.ts:255`) | `engine/prompts/mission-setup.ts` x8, `engine/prompts/execution-policy.ts` x2, `tool-map.ts`, `plan.ts`, `mission.ts` |
| `mission_stop` | `MissionStop` | false / safe_at_barrier / local_write | `visibility.requiresMissionRun` (`mission.ts:41`, enforced `visibility.ts:250`) | `engine/prompts/mission-run.ts` x3, `autonomy.ts` x2, `tool-map.ts`, `mission.ts`, `engine/prompts/identity.ts` |
| `plan_write` | `PlanWrite` | false / safe_at_barrier / local_write | `visibility.requiresPlanMode` plus `hiddenInMissionSetup: false` (`plan.ts:21`, enforced `visibility.ts:275`) | `visibility.ts` x2, `plan.ts` x2, `engine/prompts/mission-setup.ts` x2, `tool-map.ts`, `engine/prompts/plan.ts` |

Rationale. All five preserve the resource-plus-verb shape. `LoopDefer` keeps
the current word order deliberately: `engine/prompts/execution-policy.ts`
teaches "park the loop" as a named pattern in six places, and `DeferLoop`
would invert a phrase the prompt stack already owns.

### 3.7 Deviation from the plan's baseline

One entry differs from plan 5.1:

- `mission_draft_update` -> `MissionDraftUpdate`, not `MissionDraft`. The verb
  is load-bearing. The tool mutates a draft; `MissionDraft` reads as a
  resource accessor and would be the only name in the whole Tier 1 map with no
  verb while still performing a write (`actionKind: "local_write"`,
  `mission.ts:7`). Cost: 18 characters instead of 12.

Everything else in this document either matches the plan's representative
mapping or fills a slot the plan left to this spec (the four venue-suffixed
names, section 6).

## 4. Inventory verification

Registered internal `ToolDef` entries, counted by aggregation source
(`registry/lookup.ts:34-50`):

| Source array | File | Count |
| --- | --- | --- |
| `PROTOCOL_TOOLS` | `protocol.ts:37` | 3 |
| `KHALANI_INTERNAL_TOOLS` | `khalani.ts:28`, one entry in `KHALANI_INTERNAL_TO_PROTOCOL` (`khalani.ts:20-22`) | 1 |
| `ACTION_ALIAS_TOOLS` | `action-aliases.ts:118` | 10 |
| `WEB_TOOLS` | `web.ts:22` | 1 |
| `TWITTER_ACCOUNT_TOOLS` | `twitter-account.ts:50` | 1 |
| `PORTFOLIO_TOOLS` | `portfolio.ts:14` | 1 |
| `MISSION_TOOLS` | `mission.ts:5` | 2 |
| `AUTONOMY_TOOLS` | `autonomy.ts:37` | 1 |
| `EVM_TOOLS` | `evm.ts:13` | 1 |
| `WALLET_TOOLS` | `wallet.ts:18` | 4 |
| `UNITS_TOOLS` | `units.ts:38` | 1 |
| `COMPACT_TOOLS` | `compact.ts:30` | 1 |
| `SESSION_MEMORY_TOOLS` | `session-memory.ts:24` | 2 |
| `LONG_MEMORY_TOOLS` | `long-memory.ts:33` | 4 |
| `PLAN_TOOLS` | `plan.ts:18` | 1 |
| Total | | 34 |

This matches the plan's figure of 34 exactly. No discrepancy.

Uniqueness: the 32 distinct new names in sections 3.1 to 3.6 (34 current names
minus `describe_tools`, which merges, and `execute_tool`, which retires) are
pairwise distinct, contain no `__`, and collide with no protocol `publicName`
grammar (which is lowercase snake_case with exactly one `__`, plan 5.1). No
rename collides with an existing registered name.

`KHALANI_INTERNAL_TO_PROTOCOL` holds exactly one alias today; three former
Khalani aliases were removed on 2026-07-30 (`khalani.ts:8-13`) and are NOT
part of this map. They are reachable only as protocol tools and belong to S3.

## 5. `execute_tool` retirement

Current state. `execute_tool` is registered (`protocol.ts:87`) but withheld
from every model-facing surface by `MODEL_WITHHELD_TOOL_NAMES`
(`visibility.ts:161`, filtered at `visibility.ts:165`). The comment above that
set (`visibility.ts:144-160`) records the reason it was withheld rather than
deleted: an approved intent is re-dispatched by its STORED tool name
(`approval-runtime/post-tx/dispatch-approved.ts`), so every approval queued as
`execute_tool` must still run.

Target state.

1. The model-facing `ToolDef` is DELETED from `PROTOCOL_TOOLS`. This is the
   "physical deletion after the prompt sweep" that `visibility.ts:158-159`
   already anticipates.
2. The dispatch route at `protocol-route.ts:177-197` is KEPT verbatim,
   including `resolveExecuteToolParams` flat-argument recovery. It is the
   approval-resume envelope and nothing else.
3. `execute_tool` is registered with the G3 resolver as an internal identity
   that is never a `publicName` and is never advertised. It must resolve for
   cold approval resume and for `approval_queue.tool_call` rows written before
   the retirement, and must be rejected as an unknown tool when a model emits
   it.
4. `MODEL_WITHHELD_TOOL_NAMES` becomes empty once the `ToolDef` is gone. Keep
   the mechanism, empty, rather than deleting it: it is the seam a future
   staged retirement uses, and an empty named set is cheaper than
   reconstructing the filter later. This is a judgement call, not an
   invariant.

Blocking prerequisite. `EXECUTE_TOOL_DESCRIPTION` (`protocol.ts:25-35`) is
currently the ONLY place in the repository that states the global approval
doctrine to the model, and no model can read it because the tool is withheld
(plan section 3). Deleting the `ToolDef` without first relocating that
doctrine loses it permanently. The relocation target is
`engine/prompts/safety-contract.ts`; see `toolsearch-design.md` section 6.
Sequencing requirement: doctrine moves first, deletion second, in that order,
even if both land in the same batch.

## 6. Venue aliases: recommendation

The question. Four tools are venue-specific fallbacks:
`swap_quote_uniswap`, `swap_execute_uniswap` (`action-aliases.ts:155,175`),
`bridge_quote_relay`, `bridge_execute_relay` (`action-aliases.ts:320,354`).
Option A folds them into their routers as a `venue` parameter. Option B gives
them venue-suffixed PascalCase names of their own.

### 6.1 Evidence that constrains the answer

- Both pairs are HIDDEN by default and revealed per session. Uniswap uses a
  `ToolVisibility` flag (`requiresUniswapReveal`, `visibility.ts:280`); Relay
  uses a name-keyed set filtered before the flag chain
  (`RELAY_REVEAL_GATED_ALIAS_NAMES`, `relay-reveal.ts:82-85`, applied at
  `visibility.ts:174`).
- The reveal is enforced twice. Visibility is the soft half; the alias
  handlers re-check `isUniswapPairRevealed` and refuse to dispatch even if the
  model names the tool without having seen it (`uniswap-reveal.ts:11-19`).
  Relay adds exact-route enforcement at dispatch on top of the session-level
  predicate (`action-aliases.ts:313-319`).
- The hidden state leaks nothing. `uniswap-reveal.ts:20-24` states the
  invariant explicitly: a session that never revealed, an unknown session, and
  an expired reveal are all the SAME fail-closed hidden state, and there is no
  separate "denied" signal.
- Prequote identity is provider-bound. A KyberSwap quote can never authorize a
  Uniswap execute and vice versa (`action-aliases.ts:44-46`), and the same
  same-venue requirement holds for Relay (`action-aliases.ts:363`).
- The reveal is mirrored a third time at injection for the underlying protocol
  manifests: `REVEAL_GATED_UNISWAP_TOOL_IDS`
  (`injected-protocol-tools.ts:56-59`) is re-checked at
  `injected-protocol-tools.ts:105` because a reveal can expire AFTER the ids
  were recorded.
- The internal tool block is positionally first and deliberately stable across
  turns, so that the volatile injected block can sit last and preserve the
  longest prompt-prefix cache (`openai-tools.ts:21-37`).

### 6.2 Option A: `venue` parameter on the router

`SwapQuote(venue?: "kyberswap" | "uniswap")`, `BridgeQuote(venue?: "khalani" |
"relay")`, and the matching executes.

For:

- Two fewer names in each family; the visible core reads as a pure action
  menu.
- Venue selection becomes an explicit, inspectable argument that appears in
  the approval preview rather than being implied by which of four tools was
  called.
- One schema and one description per operation instead of two near-duplicates.
  Today `UNISWAP_SWAP_SCHEMA_PROPERTIES` exists solely because the shared text
  wrongly claimed KyberSwap routing and Solana support on a Uniswap-only pair
  (`action-aliases.ts:88-94`); a single schema removes that class of drift.

Against:

- It cannot express the reveal. Both gates are keyed on the tool NAME
  (`visibility.ts:174`, `visibility.ts:280`) and the Tool Map hides names
  (`tool-map.ts` categories). A JSON Schema `enum` value is static: either
  `"uniswap"` is advertised in every session, which destroys the reveal
  (the fallback venue exists to be offered after a specific failure, not
  browsed), or the schema is rebuilt per session, which makes the internal
  block volatile and breaks the cache design at `openai-tools.ts:21-37`.
- Rejecting an unrevealed `venue` value leaks. The rejection would have to
  name the parameter and its accepted values, which discloses that a hidden
  fallback venue exists. That directly contradicts the stated no-denied-signal
  invariant at `uniswap-reveal.ts:20-24`.
- It puts venue selection for a fund-moving call into model-supplied
  parameters. Venue is not a fee receiver or a destination, so `rules/90` does
  not forbid it outright, but it does select which signer path and which
  prequote binding apply. Under Option B that selection is a consequence of an
  authority decision the runtime already made (the reveal); under Option A it
  becomes an argument the model chooses.
- The rename becomes a contract change, not a rename. Four names collapse into
  two plus an enum, which the deprecation alias layer cannot express: an alias
  maps name to name, not name to name-plus-argument. Cold approval resume of a
  stored `swap_execute_uniswap` row would need a synthetic argument injection.

### 6.3 Option B: venue-suffixed PascalCase (recommended)

`SwapQuoteUniswap`, `SwapExecuteUniswap`, `BridgeQuoteRelay`,
`BridgeExecuteRelay`.

For:

- Reveal semantics are preserved byte for byte. Both gates keep working on
  names; `RELAY_REVEAL_GATED_ALIAS_NAMES` needs a two-string edit and nothing
  else.
- The alias mapping stays 1:1, so cold approval resume of a stored old name is
  a pure lookup.
- Prequote venue binding stays implicit in the name that was called, which is
  what `executeProtocolTool` already keys on.
- The internal tool block stays static across turns; the cache design at
  `openai-tools.ts:21-37` is untouched.
- No new leak surface: an unrevealed tool is simply absent, exactly as today.

Against:

- Four extra names in the Tier 1 map, and the core stops reading as a minimal
  verb menu.
- The two near-duplicate schemas at `action-aliases.ts:64-116` survive, with
  their drift risk.

### 6.4 Recommendation

Adopt Option B. The reveal mechanism is a security-relevant, fail-closed,
name-keyed gate with three independent enforcement points, and the naming
redesign is not authorized to change approval or reveal semantics
(plan 5.1, plan section 9 hard stops). Option A cannot be implemented without
either weakening the reveal or making the stable tool block session-variable,
and both are worse outcomes than four extra names.

The schema-duplication cost of Option B is real and should be paid separately:
S4's canonical parameter vocabulary can make the two swap schemas share their
param KEYS and slippage sentence while keeping their venue-specific chain and
token prose, which is what `action-aliases.ts:88-94` says the difference
actually is. That is a description-wave item, not a naming item.

Revisit condition. If the reveal mechanism is ever replaced by an explicit
capability contract that the model can see (so that hiding is no longer the
enforcement), Option A becomes viable and should be reconsidered.

## 7. Quality reference adopted

From `agents-colab/github-mcp-server`:

- `docs/tool-renaming.md`: rename plus alias, one map, silent resolution of old
  names, documentation updated to the canonical name in the same change. Vex
  amendment: the alias table is not optional and not only for configuration
  strings. Vex stores tool names in `approval_queue.tool_call`, so an
  unresolved old name is a stuck fund-moving approval, not a config error.
- `pkg/github/toolset_instructions.go`: workflow doctrine lives in server
  instructions, not in tool descriptions. Adopted as the justification for
  moving the schema-reading rules and the approval doctrine out of
  `protocol.ts` and into the prompt stack (`toolsearch-design.md` section 6).
- `docs/tool-renaming.md` consolidation examples (`get_workflow_run` and six
  siblings to `actions_get`): read consolidation behind one name is normal and
  safe. Vex applies it to reads only; mutations stay atomic (plan 5.1).

## 8. Open items for other builders

- G3 owns the resolver and must cover every name in section 3, plus
  `execute_tool` as a resume-only identity (section 5).
- G2's internal-description lint consumes the classification column of
  section 3. The `local_write` versus `user_wallet_broadcast` distinction on
  `WalletTrackToken` and `MemorySuggest` is the case most likely to be linted
  wrongly.
- S4 owns whether `publicName` joins the embedded text. Internal tools have no
  `tool_embeddings` row today, so this map does not affect re-embedding.
- The description defects named in passing here (the 58-character
  `wallet_send_confirm` description, the two near-duplicate swap schemas, the
  stranded approval doctrine) are recorded, not fixed. They belong to the
  description wave.
