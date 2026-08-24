# Identity And Migration

Spec S4, Batch 1. Docs only. No renames, no live `publicName` fields, and no
code changes in this batch. This document specifies the design that Batch 2
implements and that guardrail G3 proves the mechanism for.

Companion documents: [style-guide.md](./style-guide.md),
[parameter-vocabulary.md](./parameter-vocabulary.md),
[output-envelope.md](./output-envelope.md).

Reference checkout cited: `agents-colab/github-mcp-server` at `8ec6249`
(v1.9.0-14, 2026-08-18). Line citations rot if that checkout moves.

## 1. Two identities

**`toolId`** (dotted, e.g. `kyberswap.swap.quote`) is the immutable internal and
audit identity. It never changes. Every durable row, matrix key, embedding row,
and classifier map keeps its meaning without migration.

**`publicName`** is a new projection field on the manifest: the model-visible
and MCP-visible callable name, grammar `namespace__resource_action`, lowercase
snake_case, exactly one double underscore at the namespace boundary, namespace
contains no underscore, the action part contains no double underscore.

The seam this projects through **already exists**. `injected-protocol-tools.ts`
projects a callable name from the stable id today, mechanically:

```
injected-protocol-tools.ts:43-45   toInjectedToolName:  "kyberswap.swap.quote" -> "kyberswap__swap__quote"
injected-protocol-tools.ts:48-50   fromInjectedToolName: the inverse
injected-protocol-tools.ts:29      const NAME_SEPARATOR = "__"
injected-protocol-tools.ts:26      OPENAI_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
```

Batch 2 makes that projection **table-driven** rather than mechanical. The
grammar constraint, the 64-character bound, and the charset are not new
requirements invented by this spec; they are the constraint already asserted
catalog-wide by `injected-protocol-tools.test.ts`
(`injected-protocol-tools.ts:15-17`: "Both facts are asserted over the WHOLE
catalog [...] which is the guard that keeps a future manifest from breaking the
reverse map").

**The gating invariant that must survive every change**, stated at the same
seam:

> `injected-protocol-tools.ts:19-23`: "Injection is a VISIBILITY decision only.
> Which manifests may be shown is decided here [...]; whether a call may RUN is
> decided, unchanged, by `executeProtocolTool` off the RESOLVED MANIFEST —
> never off the function name."

Resolution direction is therefore fixed: a public name or a deprecated alias
resolves to a `toolId`, and **policy, approval, capture, and audit operate on
`toolId` only**.

## 2. Resolver placement

There is ONE authoritative resolver (old model-visible name or `publicName` to
canonical identity), owned by one module, invoked at every name-bearing
boundary. A single call at dispatch entry is not sufficient.

The evidence, copied from plan v3 section 5.5 and verified against the tree: the
turn loop hands dispatch a **temporary request object** but later passes the
**original model `toolCall`** to approval enqueue and preview construction.

```
turn-loop-tool-batch.ts:204   dispatchTool({ name: toolCall.name, args: toolCall.arguments, toolCallId: toolCall.id }, toolContext)
turn-loop-tool-batch.ts:272   enqueueApprovalIntent({ context, toolCall, result: resultForTranscript, ... })
approval-stop.ts:127          buildIntentPreview(toolCall.name, toolCall.arguments, ...)
approval-stop.ts:189          buildApprovalToolCall(toolCall.name, toolCall.arguments)
```

`toolCall` at `:272` is the same object the model produced, not the resolved
request built at `:204`. A resolver called only at `:204` would leave the
approval envelope and the preview holding an unresolved name.

The resolver is invoked at:

- dispatch entry, before all gates (pressure, plan-acceptance, mutation/retry
  classification, action-kind fallback);
- approval envelope construction;
- approval preview construction;
- cold approval resume;
- protocol catalog selection;
- future ToolSearch select (when ToolSearch exists; in Batch 1, G3 proves the
  shared catalog resolver that ToolSearch will later consume, and the
  integrated ToolSearch test lands with ToolSearch).

Approval fingerprints and stored envelopes bind to the **resolved** identity.
Fixture-alias tests prove equivalence through every boundary listed above.

The reference checkout's placement is explicitly **not** adoptable here. There,
alias resolution is a local CLI and config concern that logs a warning to stderr
(`pkg/inventory/registry.go:279`) and never crosses an approval boundary. Vex
resolves before authority is evaluated, not alongside it.

One adoptable detail from the reference: alias lookup is consulted **only after**
a direct canonical lookup returns nothing (`pkg/inventory/filters.go:237-247`),
so an alias can never shadow a live tool. Vex adopts that ordering.

## 3. Deprecation alias table

This table is about tool NAMES. A retired PARAMETER spelling is a separate
mechanism with a separate owner: `ProtocolParamDef.aliases`, rewritten at the
runtime boundary, never advertised in a schema, and carrying its own
`removeAfter` condition per entry. Its contract is section 7 of
[parameter-vocabulary.md](./parameter-vocabulary.md). The two do not compose: a
tool-name alias cannot map arguments (`registry/name-resolution.ts`), so a change
that retires both a name and a param key needs both mechanisms.

### 3.1 Shape

The reference's table is `map[string]string`
(`pkg/github/deprecated_tool_aliases.go:12`) with no per-entry metadata: no
`since`, no removal condition, no owner. Its documented process is three steps
ending at "That's it." (`docs/tool-renaming.md:14-23`).

**Vex does not copy that.** Rule 03 requires a compatibility shim to have "a
named consumer, owner, test, and removal condition", and a metadata-free
permanent map satisfies none of them. The reference is cited here as the
observed baseline to improve on, not as the pattern adopted.

Vex shape, one readonly array of frozen entries in one module:

| Field | Meaning |
| --- | --- |
| `deprecatedName` | the retired model-visible name, exactly as a model may still emit it |
| `canonicalId` | the `toolId` for a protocol tool, or the current name for an internal tool (section 5) |
| `kind` | `"internal"` or `"protocol"`; decides the removal condition |
| `since` | the release the rename landed |
| `removeAfter` | the concrete condition, not a date alone (section 3.3) |
| `reason` | why the name changed, for the generated docs row |

Because `canonicalId` lives in two identity spaces (a callable NAME for an
internal tool, an immutable dotted TOOLID for a protocol tool), the one
authored table projects into two typed lookups owned by the same module
(`registry/name-resolution.ts`): a name-space resolve consumed at dispatch
entry and the internal lanes, and an id-space resolve consumed at the catalog
boundary that every protocol gate already consults. "One authoritative
resolver" means one table, one owner module, one resolution semantics - not
one function signature. A retired protocol name is therefore never rewritten
into the request; it resolves to its manifest, and the id in durable state
comes from what the table states, never from string inversion of the name.

### 3.2 Invariants

- **Single hop.** An alias resolves to a canonical identity, never to another
  alias. Asserted by test over the whole table. A chain of aliases makes the
  removal condition of the middle entry unanalyzable.
- **No shadowing.** An entry whose `deprecatedName` collides with any live
  `publicName` or internal tool name fails the test. This is the
  `filters.go:237-247` ordering made structural rather than incidental.
- **Many-to-one is permitted, and is therefore not invertible.** The reference
  collapses three old names onto one new tool
  (`deprecated_tool_aliases.go:39-41`). Vex allows the same, which means no code
  may derive "what was this renamed from" by inverting the table. Anything
  needing that reads the table forward.
- **Uniqueness and charset.** Every `deprecatedName` and every `publicName` is
  unique catalog-wide, matches `OPENAI_TOOL_NAME_PATTERN`
  (`injected-protocol-tools.ts:26`), and is at most 64 characters. G2 validates
  this against the S2/S3 mapping artifacts.

### 3.3 Removal condition, per alias

**The governing rule, for every `kind`: an alias may be removed only when no
durable model-visible artifact can still cause the old spelling to be emitted.**

A release count is **not** a sufficient condition and must not be used as one.
The reason is section 4.6: an active `session_plans.plan_md` retains whatever
names it was authored with, has no expiry, and is never rewritten, so a model
reading its own accepted plan can emit a name that was retired arbitrarily long
ago. Long-term memory entries and re-read transcripts have the same property.
Removing the alias while any such artifact is live turns a previously working
call into an unknown-tool failure, mid-plan.

`removeAfter` therefore states a **checkable condition**, never a date or a
version count. Establishing it means one of:

- **Evidence of quiescence.** No `session_plans` row with `enabled = true`
  predating the rename, no unresolved `approval_queue` row referencing the name,
  and no resolution of that alias observed in the structured record (section
  3.4) for a stated window. The structured log is what makes this measurable
  rather than assumed; that is its purpose.
- **Explicit owner acceptance** of the residual breakage, recorded in the
  `reason` field, when quiescence cannot be established. This is the honest
  path for a single-user desktop product where old sessions can persist
  indefinitely, and it keeps the decision visible instead of implied by a
  version bump.

The two `kind` values differ only in **which** artifacts can hold the name, not
in the standard applied:

- **`kind: "protocol"`.** Stored approvals are not an exposure: protocol calls
  are already canonicalized to `execute_tool {toolId, params}` before storage
  (section 4.1), so no `approval_queue` row holds the deprecated name. The
  exposure is model re-emission from plans, memory, and transcripts, per the
  governing rule.
- **`kind: "internal"`.** Everything above, **plus** stored approvals. Internal
  calls are stored as `{command, args}` with the name as the identity, so a
  pending approval created before the rename still names the old tool. Its
  removal condition additionally requires that the approval expiry window has
  elapsed and no unresolved `approval_queue` row references the name.

`CHANGED MEANING OF removeAfter (for G3).` An earlier draft of this section
allowed `kind: "protocol"` aliases to be removed after one full release. That
was wrong and is withdrawn. `removeAfter` now carries a **condition to
evaluate**, not a deadline that elapses, and no alias of either `kind` has a
purely time-based removal. The field's type and name are unchanged, so the typed
entry shape G3 is implementing (`deprecatedName`, `canonicalId`, `kind`,
`since`, `removeAfter`, `reason`) needs no change; only the values written into
`removeAfter` are affected. If G3 modelled `removeAfter` as a date or version
rather than free text describing a check, that is the one adjustment required.

An entry is deleted only when its condition is met. A deletion is a reviewed
change like any other; the table only shrinks by deliberate edit, the same
contract `_manifest-lint/allowlist.ts:9-18` already uses for convention debt.

### 3.4 Surfacing

Three layers, mirroring the reference but with the CLI-specific one dropped:

1. **Resolution is silent to the model.** No warning text is injected into a
   tool result. A deprecation notice inside `output` competes with the money-path
   prose in [output-envelope.md](./output-envelope.md#22-failure-refusal-cancellation-and-ambiguous-commit-are-prose)
   and would be the one place a refusal sentence could be pushed down.
2. **Structured record.** Resolution emits a structured log field naming the
   deprecated name and the resolved identity, so the rate of old-name use is
   measurable and the removal condition is evidence-backed.
3. **Generated docs table.** A generated section in this repository's tool
   documentation, sorted for determinism, with an explicit empty state. The
   reference does exactly this (`cmd/github-mcp-server/generate_docs.go:503,512,519`)
   and it is worth copying: a hand-maintained alias table drifts from the code
   table on the first rename.

The reference's stderr warning (`registry.go:279`) has no Vex analogue and is not
ported. Note also its own doc comment overstates reach
(`deprecated_tool_aliases.go:6` claims the user "will receive the new tool with a
deprecation warning" when the warning is stderr-only); do not repeat that claim.

## 4. Durable inventory

Every surface keyed on a tool name or id, with its handling under this identity
model. `publicName` is a projection; unless a row is stated to hold a
model-visible name, it is unaffected.

### 4.1 `approval_queue.tool_call` - CORRECTION TO THE PLAN

`001_initial.sql:263` (`tool_call JSONB NOT NULL`).

Plan v3 section 3 states this column "stores resumable calls by tool NAME". That
is **true only for internal tools**. Protocol calls are already canonicalized to
the durable id before storage:

> `approval-stop.ts:192-198`: "An injected direct call
> (`kyberswap__swap__execute`) is CANONICALIZED here into the
> `execute_tool {toolId, params}` envelope so the approval survives a process
> restart: the injected lane resolves its name from the process-local discovered
> set, which is empty in a fresh process, and the human's Approve click would
> fail 'not discovered'. Every other lane keeps today's `{command, args}` shape
> — see `approval-runtime/tool-call-envelope.ts`."

The call site is `buildApprovalToolCall(toolCall.name, toolCall.arguments)`
(`approval-stop.ts:199`).

**Consequences, and they are favorable:**

- Renaming a **protocol** tool creates no cold-resume exposure at all. The
  stored envelope already holds `toolId`, which does not change.
- Cold-resume alias exposure is confined to **internal** tool names, which is
  exactly the set plan 5.1 identifies as having no separate durable id ("the
  NAME is the identity in `approval_queue.tool_call` and prompts").
- G3's risk surface is smaller than the plan implies, and the `kind`-dependent
  removal condition in section 3.3 follows directly from this.

The resolver still runs at cold resume, because a row written before a rename
under the `{command, args}` shape must still resolve. The correction narrows
which rows can be affected; it does not remove the boundary.

### 4.2 `tool_embeddings` - unchanged by naming; embedding text policy below

`010_tool_embeddings.sql:21-35`. `tool_id TEXT PRIMARY KEY`, keyed on the
durable id, so a `publicName` change touches nothing. See section 6 for the
embedded-text decision.

### 4.3 `protocol_executions.tool_id` - unchanged

`001_initial.sql:424` (`tool_id TEXT NOT NULL`), with three indexes on it
(`:436-438`). Audit rows keep their meaning because the id does not move. This
is the single strongest argument for the projection model over renaming durable
ids: no migration, no backfill, no rollback plan needed for the audit log.

### 4.4 `protocol_sync_jobs.read_tool_id` - unchanged

Durable, keyed on the id. No action.

### 4.5 `messages.tool_calls` / `messages_archive.tool_calls` - tolerant reads, never rewritten

`001_initial.sql:253` (`tool_calls JSONB`); the archive is
`CREATE TABLE messages_archive (LIKE messages INCLUDING INDEXES)`
(`001_initial.sql:259`), so it inherits the column and the same policy.

These rows are **history**. They record what the model actually emitted at the
time, which is the point of a transcript. They are read tolerantly (an unknown
name renders as itself) and are **never rewritten**. Rewriting them would make
the transcript disagree with the audit log and would destroy the only evidence
of what name the model used before a rename.

This is also a rule 09 obligation: model-visible if and only if logged. A rename
changes a model-visible input, so the history that records the old input must
survive intact for the request it describes to remain reconstructable.

### 4.6 `session_plans.plan_md` - never parsed, never rewritten; protection is runtime alias retention

`031_session_plans.sql:31` (`plan_md TEXT NOT NULL DEFAULT ''`). Free prose
authored before a rename can name old tools, and it can do so **indefinitely**:
an active plan has no expiry.

**There is no plan-markdown alias resolution, and this spec does not propose
adding any.** The plan-acceptance gate never parses plan text. It reads two
boolean facts and then classifies the **incoming call name**:

```
dispatcher.ts:146                       checkPlanAcceptanceDeny(call, context)
dispatcher/plan-acceptance-gate.ts:62   const plan = await getActivePlan(context.sessionId)
dispatcher/plan-acceptance-gate.ts:63   if (!plan || !plan.enabled || plan.accepted) return null
dispatcher/plan-acceptance-gate.ts:65-76 classify call.name: PLAN_GATE_SAFE_CONTROL,
                                         isMutatingProtocolAlias(call.name),
                                         resolveInjectedProtocolTool(call.name),
                                         getActionKind(call.name)
```

The omission is deliberate, not an oversight: `planMd` **is** present on the
object the gate holds (`db/repos/session-plans.ts:34`), and the gate reads
`enabled` and `accepted` from it and nothing else.

`plan_md` is treated as an **opaque blob** everywhere else too. It is only ever
compared whole-string, never tokenized: `session-plans.ts:113`
(`WHEN session_plans.plan_md IS DISTINCT FROM EXCLUDED.plan_md THEN NULL`) and
`:200` (`WHERE session_id = $1 AND plan_md = $2`).

That comparison also rules out the tempting repair. **Rewriting old names inside
`plan_md` would silently revoke the user's acceptance**, because acceptance is
bound to the exact stored text: `session-plans.ts:9` states the contract
("`accepted_at` means 'the CURRENT `plan_md` is accepted'") and `:113` nulls
`accepted_at` the moment the text differs. A cosmetic rename would turn an
accepted plan into an unaccepted one and park a mission run in
`paused_plan_acceptance`. So the text is not rewritten, for a stronger reason
than the historical-record reason in section 4.5.

**The accurate policy.** A durable model-visible artifact - an active `plan_md`,
a memory entry, or a transcript the model is re-reading - can cause the model to
re-emit an **old spelling** long after a rename. That spelling is caught at
**runtime**, by the dispatch-entry resolver (section 2), which resolves the name
before any gate runs, including this one. Note that the plan-acceptance gate is
itself a name-bearing consumer (`plan-acceptance-gate.ts:65-76` reads
`call.name` four times), which is exactly why plan v3 section 5.5 orders
resolution at dispatch entry *before* the pressure and plan-acceptance gates.

The protection is therefore **runtime alias retention, not plan parsing**. Its
direct consequence is the removal condition in section 3.3.

### 4.7 `transactions-failure-tools.ts` maps - unchanged, plus alias awareness

`db/repos/transactions-failure-tools.ts`. `LEGACY_TOOL_PRODUCTS`
(`:94`) is keyed on dotted `toolId`s (`"pendle.pt.buy"`, `"pendle.pt.sell"`,
`:102-110`), so it is unaffected by a `publicName` change.

Its existing contract must not be disturbed:

> `transactions-failure-tools.ts:88-92`: "Never edit the live `MUTATION_MATRIX`
> to 'keep a tool visible' — add it here instead; this map is the ONLY place
> deleted-tool product history lives."

Alias awareness is a read-path concern only: a lookup arriving with a public
name resolves first, then hits the map with the id.

### 4.8 Approval preview JSON: built from resolved identity

`buildIntentPreview(toolCall.name, ...)` at `approval-stop.ts:127`, stored as
`previewJson` on the approval intent (`approval-stop.ts:212`). The preview is
what a human reads before authorizing a fund-moving action, so it is built from
the **resolved** identity and never from the raw model-supplied name.

The surrounding code already establishes that preview inputs are typed and not
raw args:

> `approval-stop.ts:122-124`: "carry the gate-matched swap safety verdict
> (typed, off the ToolResult — NOT raw args) into the preview so restricted-mode
> approval surfaces `pass` / `unknown` ('UNVERIFIED') before the human approves."

The same discipline extends to the name: a model-chosen string must not be what
a human sees identifying the action they are approving.

### 4.9 `MUTATION_MATRIX` keys - unchanged

`protocols/mutation-matrix.ts:270`, consumed at
`transactions-failure-tools.ts:188` and `capture-validator.ts:9`, and named the
canonical source of truth at `protocols/catalog.ts:189`. Keyed by `toolId`. No
action.

### 4.10 Lint allowlist subjects: mixed, and a rename touches them

`_manifest-lint/allowlist.ts:25`: "Tool id, tool name, or repo-relative source
path." The 650 live entries mix all three forms: `"solana.predict.buy"` (a
dotted id) and `"swap_execute"` / `"bridge_quote_relay"` (flat internal or alias
names) both appear (`allowlist.ts:41-47`).

**Consequence:** renaming an internal tool invalidates its allowlist entries by
subject. The allowlist contract forbids adding entries in a wave
(`allowlist.ts:12-13`: "a migration wave DELETES the entries it fixes - entries
are never added by a wave, only removed") and a stale entry also fails
(`:14-15`). So a rename wave must **rewrite the subject in place** for entries it
carries forward. That is neither an add nor a delete, and it is not covered by
the current contract wording.

`OPEN ITEM for the rename wave:` the allowlist contract needs one sentence
permitting a subject rewrite that changes no rule and no detail, or the first
internal rename turns the suite red with no legal action available.

### 4.11 `bug_reports.tool_name` - historical, tolerant

`019_bug_reports.sql:59` (`tool_name TEXT`). A user-submitted report naming a
tool at the time of the report. Historical, read tolerantly, never rewritten,
same policy as 4.5.

## 5. Internal (core) tool renames

Tier 1 internal tools get PascalCase model-visible names. They have **no
separate durable id**: the name is the identity in `approval_queue.tool_call`
(for the `{command, args}` lane, section 4.1) and in prompts.

They therefore ride the same alias layer rather than gaining a second identity.
`canonicalId` for an internal entry is the current name.

Rejected alternative: minting a durable internal id (`vex.wallet.balances` or
similar) so internal tools mirror the protocol model. It would be symmetric, and
it is rejected because it creates a new durable identity for 34 tools purely to
serve a rename, with its own migration for every stored `{command, args}` row.
The alias layer solves the same problem with a table that is designed to shrink.

The narrowing in section 4.1 makes this affordable: internal names are the only
cold-resume exposure, they are a bounded set of 34, and their aliases have a
checkable removal condition.

## 6. Embedding text policy: DECISION

**`publicName` does NOT join the embedded source text, and does NOT join
`content_hash`.**

### 6.1 What the pipeline does today

```
embeddings/reembed.ts:185-192   pickSourceText: discovery.embeddingText ?? discovery.canonicalSummary ?? description ?? ""
embeddings/reembed.ts:201-215   computeContentHash: sha256 of [FORMATTER_VERSION, toolId, namespace, sourceText, aliases, exampleIntents, chains]
010_tool_embeddings.sql:24      the same component list, documented on the column
010_tool_embeddings.sql:39      CREATE UNIQUE INDEX idx_te_content_hash
```

Note the asymmetry, which is deliberate: `toolId` and `namespace` are in the
**hash** but not in the **embedded vector**. The hash's job is stated at
`reembed.ts:194-200`: invalidate every row when the formatter changes, and make
"the same `sourceText` shared by two tools (rare but possible) hash
differently". The vector's job is semantic recall over prose.

### 6.2 Why `publicName` stays out of the vector

Adding a machine identifier to a semantic vector dilutes it, and this tree has a
**measured** instance of exactly that failure:

> `morpho/manifests/markets-discover.ts:26-31`: "It does NOT enumerate the nine
> chain slugs. [...] Repeating it in the description as well made this tool
> outrank `relay.quote.get` on the eval query 'Move USDC from Base to Arbitrum
> using Relay' by two points, purely on two duplicated chain tokens."

Two duplicated tokens flipped a ranking. Injecting `namespace` and
`resource_action` tokens into all 137 embedded texts is the same class of change
at fleet scale, with no evidence of benefit and a known mechanism of harm. It
would also require a full re-embed of every row to find out.

### 6.3 Why `publicName` stays out of the hash

Adding it to the hash alone, without changing `sourceText`, would invalidate all
137 rows (`content_hash` mismatch at `reembed.ts:119`) and force a full re-embed
that produces **byte-identical vectors**. Pure cost, zero information. The
hash's contract is "did the embedded input change", and `publicName` does not
change it.

### 6.4 Where name-shaped recall belongs instead

`discovery.aliases` already exists, is already a hash component
(`reembed.ts:203,211`), and is the ratified seam for name-shaped recall.

**The rule:** when a rename makes an old name unrecoverable by search, the old
name is added to that tool's `discovery.aliases`. That correctly re-embeds
**only that tool** (the hash changes for one row), and it puts the string in the
field whose job it is, rather than in the semantic prose.

This also stays clear of the unique `content_hash` index (`010:39`): a per-tool
alias keeps hashes distinct, whereas a fleet-wide constant would be waste even
though `toolId` in the hash would prevent an actual collision.

### 6.5 Rename-wave consequence

A `publicName`-only change triggers **no re-embed**. A description change
triggers a re-embed for the tools whose descriptions changed, which is the
existing generation-diff behavior (`reembed.ts:12-19`) and is already planned for
the description waves.

The orphan purge (`reembed.ts:21-24`) deletes rows "for tool ids no longer
active (removed/renamed tools)". Since `toolId` never changes under this model,
a `publicName` rename produces no orphans, which is one more migration the
projection model avoids.

## 7. Prompt cache

Changing a model-visible name or description changes the prompt prefix and
therefore flushes the cache once, fleet-wide. The injected block is appended
last specifically to protect that prefix (`registry/openai-tools.ts:21-37`).

**Batch 1 changes nothing model-visible, so it flushes nothing.** Batch 2 and
the later description waves each cause one flush. Batching the renames and the
description rewrites into as few model-visible waves as possible is worth doing
for that reason alone: the cost is per wave, not per tool.

## 8. Snapshot interaction

The contract-snapshot harness (G1) captures the final model-visible contract, so
a rename changes a snapshot's identity, not only its contents.

Two gaps in the reference implementation must be closed rather than inherited:

- **Orphan detection.** `internal/toolsnaps/toolsnaps.go` is entirely
  path-driven (`:27`, `fmt.Sprintf("__toolsnaps__/%s.snap", toolName)`) and never
  enumerates the snapshot directory. A snapshot for a renamed or deleted tool
  lingers undetected, and `docs/tool-renaming.md:14` mentions toolsnaps only
  parenthetically. Vex fails on orphaned snapshots, per plan section 6 (G1).
- **Array order.** The reference compares with `jd.SET`
  (`toolsnaps.go:58-60`), deliberately order-insensitive. Vex does **not** copy
  this: approval fingerprints are order-sensitive
  (`engine/core/approval-runtime/tool-call-envelope.ts:157`), so Vex key-sorts
  only and preserves array order.

The adoptable half is the missing-snapshot stance: in CI a missing snapshot is a
hard error, not a silent creation (`toolsnaps.go:37-45`), because "it's important
that snapshots are committed alongside the tests, rather than just being
constructed and not committed during a CI run" (`:38-39`). The failure message
teaches the fix inline (`:63`).

## 9. Open items

1. **Allowlist subject rewrite** (section 4.10). The rename wave has no legal
   operation for carrying an entry forward under a new subject. Needs one
   sentence added to the allowlist contract before the first internal rename.
2. **`wallet_balances` response_format default** - see
   [output-envelope.md](./output-envelope.md#73-the-wallet_balances-divergence-resolution-requires-an-owner-decision).
3. **`query` / `cursor` ratification** - see
   [parameter-vocabulary.md](./parameter-vocabulary.md#2-conflict-with-plan-section-53-unresolved-escalated).
4. **`input_examples` provider support** - see
   [style-guide.md](./style-guide.md#7-worked-examples-and-the-input_examples-verification-item).
