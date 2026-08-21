# Parameter Vocabulary

Spec S4, Batch 1. Docs only. Nothing here is enforced yet; the lint rules that
will enforce it land in Batch 2.

Companion documents: [style-guide.md](./style-guide.md) (description template),
[output-envelope.md](./output-envelope.md) (what a paged tool returns),
[identity-and-migration.md](./identity-and-migration.md) (names, not params).

## 1. Where the vocabulary already lives

`src/vex-agent/tools/protocols/conventions.ts` is the existing owner of the
param vocabulary and it is **live**, not aspirational. Its own header claims
otherwise:

> `conventions.ts:10-12`: "NOTHING consumes it yet."

That sentence is false today. `CANONICAL_PARAM_KEYS` and `BANNED_PARAM_KEYS`
are read by the manifest linter (`_manifest-lint/rules.ts:84-103`, function
`lintParamKey`), the chain-parity rule (`rules.ts:237-247`), and the canonical
sentences are imported across the manifest tree. The header is stale copy and
is listed for correction alongside the other stale copy in
[output-envelope.md](./output-envelope.md#5-stale-copy-inventory).

**Consequence for this spec: this document does not restate the key table. It
extends it.** `conventions.ts` stays the single home for which keys exist; this
document adds only the per-key canonical *description sentence* and the
pagination classification, neither of which lives there today.

## 2. Conflict with plan section 5.3 (unresolved, escalated)

Plan v3 section 5.3 names the canonical keys as
"query, sort + order, limit, offset (offset APIs) or cursor (cursor APIs),
chain, walletFamily".

Two of those contradict the live ratified table:

| Plan 5.3 says | `conventions.ts` says | Evidence |
| --- | --- | --- |
| `query` | `search` is the ratified free-text key; `query` is **not** in `CANONICAL_PARAM_KEYS` | `conventions.ts:114` ratifies `search`; `conventions.ts:216-219` names `query` as one of the screening family's older spellings deliberately **not** ratified |
| `cursor` | not ratified; explicitly withheld | `conventions.ts:216-221` |

The withholding is reasoned, not accidental:

> `conventions.ts:216-220`: "The screening family's older spellings (`sortBy`,
> `cursor`, `query`, `minMarketCapUsd`, `maxMarketCapUsd`) are NOT added here,
> because a dozen existing tools carry allowlist debt against them and
> canonicalizing one of them would silently retire a fleet-wide rename this
> task has no mandate to decide."

`sort` and `order` are already ratified (`conventions.ts:115-116`), so the plan
and the code agree there. `limit` (`:94`), `chain` (`:60`), `offset` (`:117`)
and `walletFamily` (`:64`) also agree.

**This spec does not resolve the conflict, because resolving it is exactly the
fleet-wide rename decision `conventions.ts:216-220` says nobody has a mandate
for.** It records the two options and their costs:

- **Option A (adopt the live table).** Free text stays `search`; the cursor
  lane keeps whatever each provider adapter spells today until a separate
  decision ratifies one. Cost: plan 5.3's wording is wrong and should be
  amended; the `pagination: "cursor"` class below has no canonical key to
  point at, so its param requirement stays "the tool's declared cursor key"
  rather than a fixed spelling.
- **Option B (ratify `query` and `cursor`).** `conventions.ts` gains both keys
  and the fleet-wide `search` to `query` rename becomes a migration wave with
  its own allowlist churn across the 340 existing `param-key` entries
  (`_manifest-lint/allowlist.ts`, measured tally: `param-key` 340,
  `tool-description` 180, `chain-doc-parity` 61, `enum-declaration` 27,
  `param-description` 26). Cost: a rename the current mandate does not cover,
  touching every screening tool.

Until an owner decides, **the rest of this document is written against Option
A**, because Option A is the one that does not contradict code that is live and
tested today. Every place the choice matters is marked `RATIFICATION PENDING`.

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

**`search`** (`conventions.ts:114`)

> Free-text substring match over a row's name and symbol identifiers. It is a
> filter, not a ranker: it narrows the set, and `sort` decides the order.

The second clause exists because a model that reads `search` as "search
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

**`cursor`** - `RATIFICATION PENDING` (section 2). No canonical sentence is
proposed until the key itself is ratified. Proposing prose for an unratified
key would create the second source of truth this document exists to prevent.

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

- Required params: the tool's declared cursor key (`RATIFICATION PENDING`, see
  section 2).
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
(`conventions.ts:264-266`). The eight banned spellings are `amount`,
`inputToken`, `outputToken`, `chainId`, `chains`, `address`, `network`,
`wallet`. Nothing in this spec proposes unbanning any of them.
