# ToolSearch Design

Status: specification, Batch 1. No code changes accompany this document.
Authority: harness plan v3 sections 5.1, 5.4, and revision-log items 9 and 14.

ToolSearch is the single core tool that replaces `discover_tools`
(`registry/protocol.ts:39`) and `describe_tools` (`registry/protocol.ts:65`).
Its name is fixed by `core-naming.md` section 3.1.

Paths are relative to `src/vex-agent/` in the `feat/tool-surface` worktree.

## 1. What exists today

- `discover_tools` is always visible, read-only, and does two unrelated jobs
  behind one boolean: ranked semantic search when `list` is absent, and an
  unranked whole-namespace listing when `list: true` with a `namespace`
  (`protocol.ts:43,54`).
- `describe_tools` fetches full manifests for up to
  `MAX_DESCRIBE_TOOL_IDS` (40) dotted toolIds the model already knows
  (`protocol.ts:68,73`). It is hidden until the session produces a successful
  non-empty discovery (`requiresDescribeToolsReveal`, `protocol.ts:66`,
  enforced `visibility.ts:285`, flipped at `protocol-route.ts:165-167`).
- Limits: `DEFAULT_DISCOVERY_LIMIT = 5`, `MAX_DISCOVERY_LIMIT = 20`
  (`protocols/discovery.ts:39,57`), `MAX_DESCRIBE_TOOL_IDS = 40`.
- A ranked row is recorded into the session working set
  (`recordDiscoveredTools`, `protocol-route.ts:146-149`), which is capped at
  `MAX_DISCOVERED_TOOLS_PER_SESSION = 40` (`discovered-tools.ts`) with FIFO
  displacement; displaced ids are named back to the model
  (`buildDisplacementWarning`, `protocol-route.ts:155-158`).
- Everything in the working set is rebuilt into real function schemas on the
  next request by `buildInjectedProtocolTools`
  (`injected-protocol-tools.ts:100-127`), appended last by `getOpenAITools`
  (`openai-tools.ts:39-41`).

The defect this design addresses: the full parameter schema is stated TWICE.
Once as prose inside the discovery result (`protocol.ts:47` describes how to
read the `params` block the result carries), and once as the real injected
function schema. The prose copy is the larger of the two, is not enforceable,
and is the reason `discover_tools`' own description is roughly 4 KB.

## 2. The tool

One tool, three modes, one always-visible registration.

```
name:          ToolSearch
kind:          internal
mutating:      false
pressureSafety: read_only
actionKind:    read
visibility:    none (always visible, inherited from discover_tools)
```

Mode is derived from the arguments, not from a separate discriminator field:

| Arguments | Mode |
| --- | --- |
| `query` free text, optional `namespace`, optional `limit` | query |
| `query` matching `select:<publicName>[,<publicName>...]` | select |
| `namespace` present, no `query` | namespace |

Rationale for deriving rather than declaring: the owner selected the Claude
Code core form, in which `select:` is a reserved prefix on the same string
field the free-text query uses. Keeping one string field preserves that form.
The cost is a small grammar at a model-facing boundary, which is paid for by
requiring exactly one parser module owning it, with by-name rejection and
`additionalProperties: false` (section 4).

### 2.1 Query mode

Default mode. Ranked retrieval over the advertised protocol catalog, unchanged
from today: embedding score plus lexical score, with exact-toolId pinning
(`protocols/discovery.ts` imports `denseScore` and `pinExactToolIdMatch`).

- `limit` default 5, maximum 20. A higher value is REJECTED by name, never
  clamped (`discover-tools-args.ts`, referenced `protocols/discovery.ts:52-55`).
  Both numbers stay interpolated from the constants, never retyped in prose.
- `namespace` narrows the ranked search to one advertised namespace. This is
  today's behavior (`protocol.ts:45`) and is preserved.
- Every returned row is recorded into the session working set and injected on
  the next request.

### 2.2 Select mode

`query: "select:kyberswap__swap_quote,dexscreener__search"`.

- Accepts 1 to `MAX_DESCRIBE_TOOL_IDS` (40) public names. Above that the call
  is rejected by name and NOTHING runs, exactly as today (`protocol.ts:73`).
- Names are resolved to `toolId` through the ONE authoritative catalog resolver
  (plan 5.5, builder G3). Old model-visible names and deprecated aliases
  resolve; unresolvable names are rejected by name.
- The result contains acknowledgement rows ONLY. It never contains a manifest
  dump. The full schema arrives exclusively through injection on the next
  provider request.
- This is the mode a model uses to pull a whole namespace after reading a
  namespace listing, and to recover a schema lost to compaction, which are the
  two use cases `describe_tools` was created for (`protocol.ts:69-70`).

### 2.3 Namespace mode

`namespace: "solana"` with no `query`.

- Returns EVERY tool of that namespace as slim one-line rows, unranked and
  unpaginated, replacing today's `list: true` flag (`protocol.ts:54`). The
  boolean is retired: a namespace with no query IS the listing.
- Namespace mode performs NO injection and records NOTHING into the working
  set. This is a deliberate change from a naive reading of "list a namespace":
  today's list rows are already excluded from recording because they carry no
  param schema (`isRankedDiscoveryItem`, `protocol-route.ts:144-148`), and the
  merge preserves that. The listing is a menu; select is the order.
- The result carries a `nextStep` field at the top stating how to select from
  the listing, preserving today's contract (`protocol.ts:54`).

## 3. Result payloads

All three modes return compact JSON, not pretty-printed, for the reason
already recorded at `protocol-route.ts:170-172`.

### 3.1 Query-mode row

```
publicName         string   the callable name
summary            string   one line, sentence 1 of the manifest description
whyMatched         string   unchanged from today's discovery row
mutating           boolean
actionKind         string
unavailableAtPressure boolean  present only when true
```

Removed relative to today: `params`, `required`, `exampleParams`,
`constraints`, and `toolId`.

- `params`, `required`, and `constraints` are removed because they now travel
  in the injected function schema, which is the channel a provider can
  actually enforce. `constraints` in particular is already appended to the
  injected description by `injectedDescription`
  (`injected-protocol-tools.ts:129-141`), so today the same sentence reaches
  the model twice.
- `exampleParams` is removed from the RESULT, not from the surface. If
  `input_examples` provider support is confirmed (S4's verification item) the
  example belongs on the injected definition; if not, it belongs inside the
  injected description. Either way it is a property of the tool, not of a
  search hit.
- `toolId` is removed from the model-visible row. The dotted id is the durable
  internal identity (plan 5.1) and the model has no legitimate use for it once
  `publicName` is what it calls. Removing it also removes the third naming
  lane the plan identifies as the core defect (plan section 3).

Result-level fields kept unchanged: `success`, `count`, `totalCount`,
`hasMore`, `warnings`, and `retrieval.method` (`dense` | `lexical` |
`catalog`). The telemetry-only `embeddingModel` and `embeddingDim` stay
stripped from the model copy (`toModelDiscoveryResult`,
`protocol-route.ts:51-61`).

### 3.2 Select-mode row

```
publicName   string
status       "callable_next_request" | "rejected"
reason       string, present only when rejected
```

Plus the result-level fields today's `describe_tools` already reports:
`sessionCapacity` (how many tools stay callable) and the names of any earlier
tool this call displaced (`protocol.ts:73`).

### 3.3 Namespace-mode row

```
publicName     string
summary        string   one line
mutating       boolean
actionKind     string
requiredParams string[] required param KEY NAMES only, no types, no descriptions
```

`requiredParams` is retained from today's list rows (`protocol.ts:54`). It is
one short array and it is what makes a listing decidable: the model can tell a
`chain` plus `address` read from a `chain` plus `tokenIn` plus `tokenOut` plus
`amountIn` swap without selecting either. It is a key list, not a schema, so
it does not reintroduce the duplication of section 3.1.

## 4. Input schema sketch

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Either a short English intent phrase, or the reserved form select:Name1,Name2 to make tools you already know callable."
    },
    "namespace": {
      "type": "string",
      "description": "<generated from buildDiscoverNamespaceDescription()>"
    },
    "limit": {
      "type": "number",
      "description": "Query mode only. Ranked results to return (default 5, max 20). Above the max is rejected, not clamped."
    }
  },
  "additionalProperties": false
}
```

Notes.

- No `required` array: a bare `namespace` is the listing, a bare `query` is
  the search. A call with neither is rejected by name with a message that
  states all three modes.
- `additionalProperties: false` is authored at the source, mirroring the
  handler's strict boundary. `describe_tools` already does this and states why
  (`protocol.ts:77-80`); `discover_tools` does not, and gains it here.
- `list` is retired (section 2.3). `toolIds` is retired, replaced by the
  `select:` form on `query`.
- The namespace enumeration stays generated by
  `buildDiscoverNamespaceDescription()` (`protocol.ts:52`) rather than typed
  into prose.

## 5. The `describe_tools` reveal gate under the merge

Today the gate hides a tool: `requiresDescribeToolsReveal` keeps
`describe_tools` out of the catalog and the Tool Map until the session
produces a successful non-empty discovery (`visibility.ts:285`,
`describe-tools-reveal.ts`). After the merge there is no separate tool to
hide, and ToolSearch itself must always be visible because it is the only
entry point to the protocol surface.

Recommendation: RETIRE the gate. `describe-tools-reveal.ts` and the
`requiresDescribeToolsReveal` flag are deleted, along with the
`revealDescribeTools` call at `protocol-route.ts:166`.

Justification. The module's own header states its purpose: it exists so a
fresh session is not shown a manifest-fetch tool with nothing to fetch. That
is a menu-affordance heuristic, not a security control, and it has no TTL for
exactly that reason (`describe-tools-reveal.ts:12-17`). Under the merge the
affordance problem disappears: select mode is a mode of a tool the model is
already using, not a second tool that appears from nowhere.

This is a model-visible behavior change and is called out as such. It must be
an explicit owner decision at the point the merge lands, not a silent
consequence of it.

What does NOT change, and must be preserved verbatim:

- The Uniswap reveal. `REVEAL_GATED_UNISWAP_TOOL_IDS`
  (`injected-protocol-tools.ts:56-59`) is re-checked at injection time
  (`injected-protocol-tools.ts:105`) precisely because a reveal can expire
  after the ids were recorded, and discovery hides those manifests from an
  unrevealed session (`protocols/discovery.ts` imports `isUniswapPairRevealed`).
  Select mode MUST run the same availability chain as injection: advertised
  namespace, `isProtocolToolAvailable`, reveal gate, pressure barrier
  (`injected-protocol-tools.ts:102-107`).
- The no-leak rule. A reveal-gated toolId named in select mode by an
  unrevealed session is answered as UNKNOWN, with the same wording an
  unresolvable name gets. It is NOT answered with the real reason. This is a
  deliberate, narrow exception to the by-name rejection contract, and its
  authority is the invariant stated at `uniswap-reveal.ts:20-24`: a session
  that never revealed, an unknown session, and an expired reveal are all the
  same fail-closed hidden state, with no separate denied signal to leak.
  Everywhere else in ToolSearch, rejection names the real cause.
- Gating decides off the RESOLVED MANIFEST, never off the name
  (`injected-protocol-tools.ts:19-23`). Select mode resolves a name to a
  manifest and then gates; it never gates on the string.

## 6. Doctrine relocation

Today's `discover_tools` description is roughly 4 KB across seven joined
sentences (`protocol.ts:40-49`). Most of it is not about searching. The
target budget is 2048 bytes (plan 5.2) and ToolSearch should land far below
it.

| Content | Current location | Target |
| --- | --- | --- |
| How to read a `params` schema: `required: true` semantics, optional-by-absence, `unit` and bps, raw versus human amounts, literal types, never invent a param | `protocol.ts:47` (roughly 1.6 KB, the single largest block) | `engine/prompts/tool-model.ts` | 
| The dot-to-double-underscore name mapping and "call it directly by name in the same session" | `protocol.ts:46` | already stated in `engine/prompts/tool-model.ts`; delete the duplicate |
| "Do not invent dotted toolIds; execute only ids this response returned" | `protocol.ts:42` | `engine/prompts/tool-model.ts` |
| Pressure advisory: what `unavailable_at_pressure` means and what to do at barrier or critical | `protocol.ts:48` | `engine/prompts/context-pressure.ts` |
| Global approval doctrine: mutating requires approval in restricted and off, preview and dryRun are reads, there is no approval-free mutation | `protocol.ts:33`, inside withheld `execute_tool` where no model can read it | `engine/prompts/safety-contract.ts` |
| Do not retry the same failing call in a tight loop | `protocol.ts:34`, same withheld description | `engine/prompts/execution-policy.ts` |

`engine/prompts/tool-model.ts` is the correct owner for the first four rows:
its header already declares that it holds "the routing model: internal versus
protocol tools, the discover-then-call mechanics", already owns the
`.` to `__` mapping, and already interpolates `DEFAULT_DISCOVERY_LIMIT` and
`MAX_DISCOVERY_LIMIT` from the constants for the stated reason that a number a
human retypes is a number that drifts.

The doctrine currently stranded in `EXECUTE_TOOL_DESCRIPTION` is the highest
priority of the six rows, because `core-naming.md` section 5 deletes that
`ToolDef`. Moving it is a prerequisite for the deletion, not a follow-up.

Adopted from `agents-colab/github-mcp-server/pkg/github/toolset_instructions.go`:
multi-step workflow guidance, pagination protocol, and ordering rules live in
toolset instructions, and the tool description states what one tool does.
`generateProjectsToolsetInstructions` carries the whole "Pagination
(mandatory)" and "Field usage" protocol; the individual project tools do not
repeat it.

### 6.1 What stays in ToolSearch's own description

- Sentence 1: verb, object, scope. What is searched and over what.
- The three modes and how to invoke each.
- `limit` default and maximum, interpolated.
- The next-request injection fact (section 7).
- When-NOT, naming the alternative: for a curated internal tool, read the Tool
  Map instead; for a name already callable this session, call it directly
  rather than selecting it again.

## 7. Injection becomes visible on the NEXT provider request

This is a mechanical property of the Vex serving path and must be stated in
the result text, not assumed.

`buildInjectedProtocolTools` runs inside `getOpenAITools`
(`openai-tools.ts:39-41`), which builds the tools array for a request. The
working set it reads is written during dispatch of the previous tool call
(`recordDiscoveredTools`, `protocol-route.ts:146`). A tool selected or
discovered during turn N therefore first appears in the tools array assembled
for turn N+1.

This is NOT Anthropic's Tool Search Tool, which expands deferred tool
definitions inline within the same response while preserving the cached
prefix (plan section 3, external fact 1). Vex injects into the tools array of
a subsequent request. The model must not attempt to call a newly selected tool
in the same assistant turn.

Required wording in every query-mode and select-mode result: the returned
tools are callable from your next message, not from this one.

Accepted cost, already recorded at `openai-tools.ts:21-37`: every call that
returns a new toolId changes the tools array and invalidates the provider's
tool-definition prefix cache for the following turn. The comment there also
records the rule that must survive this redesign: do not fix the churn by
caching a stale tools array, because a schema the model can see but the
dispatcher would reject is worse than a cache miss.

## 8. Working set, cap, and displacement: unchanged

Nothing in this design changes the retention model.

- `MAX_DISCOVERED_TOOLS_PER_SESSION` stays 40 (`discovered-tools.ts`).
- FIFO displacement stays; re-selecting a tool refreshes its position.
- Displaced ids stay NAMED to the model. Today `describe_tools` names them and
  `discover_tools` names them through `buildDisplacementWarning`
  (`protocol-route.ts:150-158`); under the merge one code path names them for
  both modes, which removes the divergence that comment describes.
- The invariant that a single round is never partially evicted is preserved:
  the cap must remain greater than or equal to BOTH `MAX_DISCOVERY_LIMIT` (20)
  and the select-mode maximum (40). Select mode inherits
  `MAX_DESCRIBE_TOOL_IDS` unchanged, so the invariant holds at equality, which
  is what `injected-protocol-tools.test.ts` already asserts against both
  constants.
- Namespace mode records nothing, so it cannot displace anything. A model can
  browse a large namespace without disturbing its working set, which today it
  cannot do without knowing that `list: true` rows are silently non-recording.

Any change to the cap requires a visibility-context test plus eval evidence
(plan 5.4). This design proposes no change.

## 9. Consequences for the visible tool count

Merging two registrations into one removes one `ToolDef`; retiring
`execute_tool` removes another (`core-naming.md` section 5). Registered
internal tools move 34 to 32.

The worst-case visible function count is NOT derived here. The plan's figure
of 72 (32 internal plus a full 40-tool working set) is explicitly pending a
visibility-context test owned by builder G1 (plan sections 3 and 10). This
design neither confirms nor revises it.

## 10. Verification this design implies

Not Batch 1 work; recorded so the later wave has a target.

- Mode-selection contract tests: query, select, namespace, and the four
  rejection paths (no arguments, `limit` above maximum, more than 40 selected
  names, unresolvable name).
- A select-mode test proving a reveal-gated Uniswap toolId in an unrevealed
  session returns the UNKNOWN wording and injects nothing, and that the same
  id in a revealed session injects normally.
- A golden test proving no query-mode or select-mode result contains a `params`
  block, so the duplication of section 3.1 cannot come back.
- A test proving the next-request visibility statement: the tools array for
  request N does not contain the tool selected during request N, and the array
  for N+1 does.
- Displacement parity: query mode and select mode name displaced tools with
  the identical sentence.
- Re-embedding is required when manifest descriptions change, but not for this
  design on its own: ToolSearch changes the result payload and the tool's own
  description, not the embedded manifest text.

## 11. Open questions

1. Retiring the `describe_tools` reveal (section 5) is a model-visible
   behavior change that needs an explicit owner decision.
2. Whether select mode should accept a namespace shorthand
   (`select:solana__*`) as a shorter path to a whole namespace than 34 comma
   separated names. Not recommended without evidence: a wildcard is a second
   grammar at the same boundary, and 34 explicit names cost fewer tokens than
   the manifests they will pull.
3. `input_examples` provider support is unverified (S4). It determines whether
   the worked example lives on the injected definition or inside the injected
   description; it does not affect this design's result payloads.
