# Parameter Vocabulary

Spec S4, Batch 1, revised in Batch 4 (owner decisions D1 and D15). The key table
and the alias contract are ENFORCED: `param-key` and `param-alias` in the
manifest linter, and the boundary rewrite in `protocols/runtime/param-aliases.ts`.

Companion documents: [style-guide.md](./style-guide.md) (description template),
[output-envelope.md](./output-envelope.md) (what a paged tool returns),
[identity-and-migration.md](./identity-and-migration.md) (names, not params).

## 1. Where the vocabulary already lives

`src/vex-agent/tools/protocols/conventions.ts` is the existing owner of the
param vocabulary and it is **live**, not aspirational. Its header used to claim
otherwise ("NOTHING consumes it yet"); Batch 4 corrected it, because the table
has three live readers: `lintParamKey` and the chain-parity rule in the manifest
linter, the untrusted boundary in `runtime/params.ts` (which answers a
`BANNED_PARAM_KEYS` spelling with its replacement), and the `param-alias` rule,
which admits an input alias only for a key banned there. The canonical sentences
are imported across the manifest tree.

**Consequence for this spec: this document does not restate the key table. It
extends it.** `conventions.ts` stays the single home for which keys exist; this
document adds only the per-key canonical *description sentence* and the
pagination classification, neither of which lives there today.

## 2. Free text and continuation: resolved by owner decision D1/D15

Batch 1 recorded a conflict here and refused to resolve it: plan 5.3 named
`query` and `cursor` as canonical, while `conventions.ts` ratified `search` and
deliberately withheld both, because "canonicalizing one of them would silently
retire a fleet-wide rename this task has no mandate to decide".

**The owner gave that mandate.** D1 chose `query`; D15 ratified the 141
allowlisted keys that had no canonical target, `query` and `cursor` among them,
and retired `search`. The resolution, as it stands in code today:

| Key | State | Where |
| --- | --- | --- |
| `query` | canonical, the free-text key | `CANONICAL_PARAM_KEYS` |
| `cursor` | canonical, the cursor-class continuation key | `CANONICAL_PARAM_KEYS` |
| `search` | BANNED, replacement `query` | `BANNED_PARAM_KEYS` |

The choice went to `query` on the count that already existed: seven tools spelled
it `query`, two spelled it `search`. The two `search` params (Morpho markets and
vaults discover, both reads) were renamed, each carrying an input alias under the
contract in section 7. Morpho's own provider predicate is still spelled `search`;
that translation lives inside `morpho/read-params/*.ts`, which is the same rule
`conventions.ts` already states for every other provider spelling.

`sort`, `order`, `limit`, `offset`, `chain` and `walletFamily` were never in
dispute and are unchanged.

## 3. Canonical description sentences

`conventions.ts:289-320` already owns four shared sentences:
`CANONICAL_CHAIN_SENTENCE` (`:296`), `CANONICAL_RAW_AMOUNT_SENTENCE` (`:304`),
`CANONICAL_HUMAN_AMOUNT_SENTENCE` (`:308`), `CANONICAL_SLIPPAGE_PARAGRAPH`
(`:318`). Those are not restated here and must not be retyped in a manifest;
`chain-doc-parity` already fails a chain param that does not carry the chain
sentence (`rules.ts:237-247`).

This spec adds the sentences the screening family lacks. Each is a proposed
export for `conventions.ts` in Batch 2, in the same style as the existing four:
one sentence, stating the contract the runtime actually enforces.

**`query`** (ratified by D1; `search` is its banned spelling)

> Free-text substring match over a row's name and symbol identifiers. It is a
> filter, not a ranker: it narrows the set, and `sort` decides the order.

The second clause exists because a model that reads a free-text key as "search
ranking" stops passing `sort` and then reports the first row as the best row.

**`sort`** (`conventions.ts:115`)

> Ranking key. The accepted set ships as a JSON Schema `enum`, and a value
> outside it is REJECTED BY NAME, never ignored.

**`order`** (`conventions.ts:116`)

> Ranking direction, `asc` or `desc`. Declared as an `enum`; defaults are
> resolved server-side, so state the default in the tool description.

The "resolved server-side" half is load-bearing:
`internal/types.ts:203-207` documents why handlers resolve their own defaults
("LLMs frequently omit defaults even when the schema declares one"). A schema
default is therefore documentation, not a mechanism.

**`limit`** (`conventions.ts:94`)

> Caps what is RETURNED after filtering. State the default and the maximum in
> the description; an over-max value is rejected by name, never clamped.

`limit` is explicitly not `pageSize` (`conventions.ts:96`).

**`offset`** (`conventions.ts:117`)

> Row offset for paging. Pairs with the reply's `nextOffset`: pass back exactly
> what the last reply returned, never a number you computed yourself.

The "never computed yourself" half matters when a producer applies a
post-filter, because then rows returned and rows consumed differ and an
agent-computed offset silently skips rows.

**`page` / `pageSize`** (`conventions.ts:95-96`)

> `page` is the 1-based FIRST provider page of a windowed read and the reply
> names the next page to continue from. `pageSize` is rows fetched per provider
> page, distinct from `limit`, which caps what is returned after filtering.

**`chain`** (`conventions.ts:60`) carries `CANONICAL_CHAIN_SENTENCE`
unchanged. It is one of three keys in `CHAIN_VALUE_PARAM_KEYS`
(`conventions.ts:287`) that get case-insensitive matching and numeric-to-string
normalization; that tolerance is a chain-value exception and does not
generalize (`protocols/types.ts:124-131`).

**`walletFamily`** (`conventions.ts:64`)

> The wallet FAMILY (`eip155` | `solana` | `all`). Never a chain. `network` and
> `wallet` are banned spellings of this key (`conventions.ts:275-276`).

**`cursor`** (ratified by D1/D15)

> The provider's own opaque continuation value. Send back exactly what the
> previous reply returned; never compute one, never parse it. A reply that
> carries no cursor is the end of the list.

Opaque to the agent AND to Vex. A provider that needs a different wire shape
converts inside its own adapter, which is the rule `conventions.ts` already
states for provider spellings.

## 4. Pagination classification vocabulary

A machine-readable field, one value per tool, from a closed set. It is the
prerequisite for the continuation lint, which is Batch 2 work and deliberately
out of Batch 1.

**Where it lives.** A new optional field on `ProtocolToolManifest`
(`protocols/types.ts:138`), alongside `lifecycle` and `discovery`, added in
Batch 2 with the `publicName` field. It is manifest-level, not param-level,
because it is a fact about the whole call, not about one property. That is the
same reasoning `injected-protocol-tools.ts:66-77` gives for putting
cross-parameter group rules in the description rather than in the schema.

**Why closed.** Same convention as `ToolLifecycle` (`protocols/types.ts:42`)
and `ProtocolParamDef.unit` (`:87-89`): a single-member or small closed union
whose growth is a deliberate edit with its own enforcement, not an accident in
a manifest.

### 4.1 The five values

**`none`**

The tool returns a complete, structurally bounded result. There is nothing to
continue because there is no more.

- Required params: none.
- Required output fields: none.
- Fails the class if: the producer ever drops rows. A tool that drops rows is
  `bounded_non_pageable`, not `none`. This is the distinction the class exists
  to force, because both look identical to an agent that only sees the reply.

**`offset`**

Row-offset paging, the shape `conventions.ts:117` already describes.

- Required params: `offset`, `limit`.
- Required output fields: `hasMore`, `nextOffset`, `filtersApplied`.
- `nextOffset` is present if and only if `hasMore` is true. An always-present
  `nextOffset` invites one more empty call per query.
- Exemplar: `morpho.markets.discover` documents "page with offset/limit (max
  ${MORPHO_MAX_PAGE_LIMIT})" and echoes `filtersApplied`
  (`morpho/manifests/markets-discover.ts:50-52`).

**`cursor`**

Opaque provider continuation token.

- Required params: `cursor` (ratified; see section 2).
- Required output fields: `hasMore`, `nextCursor`, `filtersApplied`.
- The cursor is **opaque to both the agent and Vex**. It is round-tripped
  verbatim and never parsed, inspected, or synthesized. A Vex-side adapter that
  needs a different provider shape converts inside its own adapter, which is
  the rule `conventions.ts:15-17` already states for provider spellings.
- Fails the class if: the tool accepts BOTH a cursor and an offset. Two
  continuation lanes on one tool is the drift this vocabulary exists to catch.

**`page_window`**

Provider-side page windows, the `page` / `pageSize` shape
(`conventions.ts:95-96`). Distinct from `offset` because the unit is a provider
page, not a row, and because `limit` filters *after* the window is fetched, so
"rows returned" and "rows consumed from the provider" are different numbers.

- Required params: `page`, `pageSize` (and usually `limit`).
- Required output fields: `hasMore`, `nextPage`, `filtersApplied`.
- The reply names the next page rather than the agent incrementing, for the
  same reason `offset` does: a post-filter makes agent arithmetic wrong.

**`bounded_non_pageable`**

The producer caps the result and **no continuation exists**. The rows beyond
the cap are unreachable through this tool at all.

- Required params: usually `limit`; the cap may also be unconditional.
- Required output fields: `truncated` (boolean), and when `truncated` is true,
  a stated reason and the narrowing action that would help.
- This is the class that must never be silent. Rule 05's boundedness
  requirement is that dropped data is signaled to consumers, and this is the
  only class where data is dropped with no way to ask for the rest.
- Live exemplar of the honest shape: `long_memory_search` states "If results
  were truncated to the inline cap, the response says so and asks you to refine
  - there is no overflow fetch." (`registry/long-memory.ts:145`). The last
  clause is the part that makes it `bounded_non_pageable` rather than a paged
  class.
- Live exemplar of the *contrast*: `solana.tokens.*` returns
  "returned/totalMatched/hasMore" and states the limit "is applied Vex-side and
  never silently" (`solana-jupiter/manifests/core.ts:45`).

### 4.2 What the classification is not

It does not describe **projection**. A tool that returns every matching row but
narrows the fields per row is not truncating and not paging. Projection is a
separate, already-solved concern with its own key (`fields`,
`conventions.ts:118`) and its own module-level owners
(`solana-jupiter/projectors.ts`, `internal/twitter-projection.ts`). Conflating
the two would make every projected tool look truncated.

It also does not describe **output size**. There is no global output cap; see
[output-envelope.md](./output-envelope.md#4-no-global-truncation).

## 5. Schema authoring rules

**No root-level `anyOf` or `oneOf`.** The root of a tool's `parameters` schema
is a plain `object`. Root combinators are rejected by the Claude API and
flattened to prose by Claude Code, so a root combinator is a rule the model
never reliably receives.

The rule is **root-level only**. Property-level `anyOf` is legitimate and
already in use: `ProtocolParamDef.acceptsStringArray` compiles to an `anyOf`
union on that one property (`protocols/types.ts:105-108`), and it earns its
place with a measurement:

> `protocols/types.ts:96-99`: "`dexscreener.profiles {chainIds: ["solana"]}`
> was rejected in 78 bytes while `chainIds: "solana"` answered in 5,215 — a
> whole call spent on a spelling a JSON tool call makes natural."

Cross-parameter rules (mutual exclusion, at-most-one, at-least-one) do **not**
become root combinators. They are declared as manifest group fields, checked by
`lintExclusiveParamGroups` (`rules.ts:252-274`), and rendered into the
description by `describeParamGroupConstraints`, so the model sees the rule in
the one channel every provider carries verbatim
(`injected-protocol-tools.ts:66-77`).

**`additionalProperties: false` is authored at the source.** The field is
already settable on the schema shape (`tools/types.ts:198-199`, "When false on
an object, rejects extra keys (OpenAI strict requirement)"). Authoring it at
the manifest rather than patching it in a normalizer keeps one home for the
fact and means the snapshot artifact shows what the author declared.

**Unit declarations are carried, never dropped.** `ProtocolParamDef.unit`
(`protocols/types.ts:90`) is currently the single member `"bps"`, and its
rationale is a silent-failure class, not tidiness:

> `protocols/types.ts:80-84`: "`z.number()` happily accepts `0.5`, and a
> fractional bps is not a smaller tolerance — Jupiter answers a non-integer
> `slippageBps` with `otherAmountThreshold = 0`, i.e. a swap that accepts ANY
> output including near-zero. The failure is silent: the quote looks normal."

Consequences for every later wave: a bps param declares `type: "number"` and
`unit: "bps"` together; a schema normalizer, a projection, a snapshot, or an
MCP export that drops `unit` drops an enforcement, not an annotation. Seven
manifests currently carry `amount-bps-shape` allowlist debt against this rule
(`_manifest-lint/allowlist.ts:41-47`), which is exactly the set a later wave
deletes.

**A closed value set is an `enum`, never prose.** `ProtocolParamDef.enum`
(`protocols/types.ts:135`) is read in three places and nowhere else: the
boundary rejects an off-list value naming the allowed values,
`paramsToJsonSchema` compiles it into the schema, and `discovery.ts` ships it on
the param row (`protocols/types.ts:118-121`). The live counter-example is
recorded in the same comment: `virtuals.list.chain` had an UPPERCASE value list
"written in a description, unenforced at the boundary, and absent from the
compiled JSON schema - so a model that followed every other chain param in the
tree sent `base` and burnt the call" (`protocols/types.ts:113-116`). 27
`enum-declaration` allowlist entries remain.

## 6. Adding a key

Adding a param key is a deliberate edit to `CANONICAL_PARAM_KEYS` in
`conventions.ts`, with the reason on the entry, exactly as the table does today
(`conventions.ts:54-58`). It is never an accident in a manifest: the linter
reports any other key against the tool that introduced it.

Before adding, check `BANNED_PARAM_KEYS` (`conventions.ts:268-277`). Each
banned spelling names its replacement, because "a rejection that does not say
what to write instead costs the agent another call"
(`conventions.ts`). The nine banned spellings are `amount`, `inputToken`,
`outputToken`, `chainId`, `chains`, `address`, `network`, `wallet` and `search`.
Nothing in this spec proposes unbanning any of them.

## 7. Aliases: accepting a retired spelling for one migration

A rename costs every in-flight session one burnt call: the model holds a schema
it read before the change and sends the spelling that schema declared.
`ProtocolParamDef.aliases` buys that back for a bounded period, under a contract
narrow enough that it cannot become a second vocabulary.

**The contract.**

1. An alias is INPUT ONLY. `paramsToJsonSchema`, the discovery row and every
   description advertise the canonical key alone, so nothing the model reads
   today teaches it the retired spelling.
2. The rewrite runs at the EARLIEST runtime boundary: first thing in
   `executeProtocolTool`, before the string-array and numeric-string coercers,
   before the preview reader, before `validateProtocolParams` and before the
   approval enqueue. It mutates the ORIGINAL arguments object, because the
   enqueue persists that object into `approval_queue.tool_call`. Owner:
   `protocols/runtime/param-aliases.ts`.
3. Both spellings in one call is a REFUSAL naming both keys, never a precedence
   rule. A caller that sent both has not said what it wants.
4. An alias key must be a key of `BANNED_PARAM_KEYS`, must not be canonical,
   and must collide with no declared key or other alias of the same tool.
   Enforced by the `param-alias` lint rule.
5. Every alias carries `removeAfter`, the condition under which it is deleted.
   For the six Batch 4 renames that condition is owner decision D5: the alias
   goes when the owner accepts that a stale call should instead receive the
   unknown-parameter answer naming the new key. A shim with no named removal
   condition never gets removed (rule 03).
6. Declared aliases enter the approval fingerprint as their sorted KEYS, and
   only when a param declares any, so a manifest with no alias hashes exactly as
   it did before the field existed. An alias widens what the boundary admits
   under a queued approval, which is call shape; `removeAfter` prose is not.

**The internal lane.** `BridgeStatus` is a `ToolDef` with its own Zod parse, not
a protocol manifest, so it carries the same contract in a helper of its own
(`tools/internal/action-aliases.ts`) that runs BEFORE `safeParse`. It has to run
before the parse: the schema strips undeclared keys, so a retired spelling would
otherwise vanish silently and the call would run as if nothing had been filtered.

**The six renames, all on READ tools.**

| Tool | Retired | Canonical |
| --- | --- | --- |
| `BridgeStatus` | `address` | `walletAddress` |
| `BridgeStatus` | `wallet` | `walletFamily` |
| `khalani__orders_list` | `wallet` | `walletFamily` |
| `khalani__token_balances_get` | `wallet` | `walletFamily` |
| `morpho__markets_discover` | `search` | `query` |
| `morpho__vaults_discover` | `search` | `query` |

Output field names are NOT renamed by any of these: `khalani__token_balances_get`
still returns `wallet` as the family it scanned. The one output that follows the
input is `filtersApplied.query` on the two Morpho discover tools, because that
field exists to echo the agent-facing key back.
