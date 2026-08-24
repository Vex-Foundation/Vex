# Tool Description Style Guide

Spec S4, Batch 1. Vex policy. This batch rewrites no descriptions. Batch 1
DOES ship one basic guardrail: the ActionKind-aware description rule
(`_manifest-lint/internal-description-rules.ts`) over all 34 internal tools,
with a 40-entry shrink-only allowlist recording today's debt. Full
enforcement of THIS style guide (template structure, budget, canonical
sentences) lands with the description rewrite wave, not now.

Companion documents: [parameter-vocabulary.md](./parameter-vocabulary.md)
(param keys and the pagination classes named below),
[output-envelope.md](./output-envelope.md) (what RETURNS must match),
[identity-and-migration.md](./identity-and-migration.md) (names).

Reference checkout cited: `agents-colab/github-mcp-server` at `8ec6249`
(v1.9.0-14, 2026-08-18).

## 1. What already enforces description quality

A tool-description rule is live today (`_manifest-lint/rules.ts:185-218`,
`lintToolDescription`). It checks four things:

| Check | Constant / anchor | Line |
| --- | --- | --- |
| minimum length 120 chars | `MIN_TOOL_DESCRIPTION = 120` | `rules.ts:49` |
| a WHEN TO USE anchor | `/Use (this )?when\|Call this\|before\|after/i` | `rules.ts:61` |
| a RETURNS anchor | `/returns\|answers with/i` | `rules.ts:62` |
| a SPENDS anchor, **when `mutating`** | `/spend\|broadcast\|real funds\|on-chain transaction\|signs/i` | `rules.ts:63` |

180 tools currently carry `tool-description` allowlist debt against it (measured
tally in `_manifest-lint/allowlist.ts`). This style guide is the target the
allowlist shrinks toward. It is an extension of that rule, not a replacement:
the four checks above stay.

## 2. The template

Every description, in this order:

1. **Sentence 1: verb + object + scope.** Never repeats the tool name.
2. **What the thing is**, when the domain noun is ambiguous.
3. **When to use** and **when NOT to use**, each naming the concrete
   alternative tool.
4. **Behavior that changes the outcome**: what is applied server-side, what is
   rejected by name, what defaults, what is advisory.
5. **ActionKind-specific obligations** (section 4).
6. **Pagination protocol**, named by class (section 6).
7. **RETURNS**: the actual result keys.

### 2.1 Sentence 1

Verb first, then the object, then the scope. The name is not restated, because
the model already has it; restating it spends the most valuable sentence saying
nothing.

Live examples that follow the rule:

> "Screen Morpho Blue VARIABLE-RATE lending markets across the nine EVM chains
> Vex reads Morpho on" (`morpho/manifests/markets-discover.ts:40-41`)

> "Price a pools.fun token launch on Robinhood Chain (4663) before committing to
> it, and record the preview." (`pools/manifests/launch.ts:17`)

> "Launch a token on pools.fun (Robinhood Chain 4663) FOR REAL - signs and
> broadcasts the on-chain launch with the user's wallet."
> (`pools/manifests/launch.ts:44-45`)

Each opens with a verb, names the object, and bounds the scope in the same
sentence. The third also front-loads the fact that decides everything else about
the call.

The reference states the same rule and Vex adopts it as policy.

## 3. Length

**Length scales with decision ambiguity, not with importance.** A tool whose
misuse is obvious can be short. A tool where two plausible readings of the same
request lead to different tools, different units, or different money, is long,
and the length is doing work.

The clearest statement of this is already in the tree:

> `morpho/manifests/markets-discover.ts:22-24`: "The description is long on
> purpose (owner decree): the claims in it are grounded in the live 2026-08-14
> capture, not in documentation prose. The 297,995% figure is a real row from
> that capture."

Length earned by a measurement is not bloat. Length spent restating the schema
is.

### 3.1 The 2048-byte budget, and a measured tension

Plan v3 section 5.2 sets a budget of 2048 bytes, for forward compatibility with
Claude Code's MCP description truncation and as a discipline bound, with
justified exceptions requiring an allowlist entry and a reason.

**Both descriptions designated as the quality floor exceed that budget today:**

| Tool | Measured description length |
| --- | --- |
| `morpho.markets.discover` | ~2,567 chars, and larger after `${...}` expansion (`markets-discover.ts:39-` , sort-key list and page limit are interpolated) |
| `pools.launch_execute` | 2,599 chars (`pools/manifests/launch.ts:44-67`) |

This is not an argument to shorten them. `pools.launch_execute` spends its
length enumerating the 13 pre-signing proofs, the three authority modes, the
image requirement, and the pending-outcome rule, and every one of those is a
fact that changes whether a real launch should happen. Cutting it to fit a
budget would remove safety copy from a `user_wallet_broadcast` tool.

**The honest reading of the budget is therefore:**

- 2048 bytes is the default and the discipline bound. Most tools fit it easily,
  and a tool that exceeds it should be asked what it is spending the bytes on.
- The exception mechanism is not a formality. The two highest-quality
  descriptions in the tree are exceptions on day one, which means the exception
  list will be legitimately non-empty and the reason field is the real control.
- An exception's reason names the decision the extra length prevents getting
  wrong. "It is an important tool" is not a reason. "It enumerates the 13
  on-chain proofs a signer refuses on" is.
- The truncation risk is real but is a **consumer** property, not a Vex one:
  Claude Code truncates MCP descriptions at ~2KB. A tool that must exceed the
  budget puts its critical facts **first**, so that a truncating consumer keeps
  them. `pools.launch_execute` already does this: "SPENDS REAL FUNDS AND IS
  IRREVERSIBLE" lands in the second sentence (`launch.ts:45`).

`OPEN ITEM:` whether the budget counts bytes or characters, and whether it is
measured before or after the injection-time augmentation that appends
cross-parameter constraint text (`injected-protocol-tools.ts:66-77`, appended
never substituted). It must be measured on the **final** string the provider
receives, because that is the string a consumer truncates. Lint measuring the
manifest literal would under-count every tool with param groups.

## 4. ActionKind-specific requirements

`ACTION_KINDS` is a closed, durable set of seven (`tools/taxonomy.ts:54-62`):
`read`, `local_write`, `schedule`, `approval_prepare`, `user_wallet_broadcast`,
`external_post`, `destructive`.

**"mutating" alone does not imply "spends funds", and the lint must not pretend
it does.** The current rule keys the SPENDS demand off the loose `mutating`
boolean (`rules.ts:211-215`), and the tree already contains the case that breaks
it: `pools.launch_preview` is `mutating: true` with
`actionKind: "local_write"` (`pools/manifests/launch.ts:18-22`) and its
description correctly says "**it spends nothing**, signs nothing, takes no image
lock" (`launch.ts:17`). It satisfies the SPENDS anchor only because the regex
matches the substring "spend" inside a sentence that says the opposite.

The manifest comment states why the classification is what it is:

> `pools/manifests/launch.ts:19-21`: "`local_write`, not `read`: this writes a
> durable preview row. It carries no authorization and no transaction hash, so
> it never reaches an approval card - which is exactly what `local_write`
> means."

So the requirements are per ActionKind:

### `user_wallet_broadcast`

Required, all five:

- **SPENDS statement.** That real funds move and the action is irreversible.
  Front-loaded.
- **Approval statement.** Under which authority it runs and what happens under
  each. `pools.launch_execute` is the model: FULL-permission chat executes
  directly, RESTRICTED "refuses BY NAME and you must call
  pools.launch_request_form instead", a MISSION run is bounded by
  "the contract's HOST-authored launch ceilings, which you cannot write"
  (`launch.ts:58-63`).
- **Preconditions.** What must be true or the tool refuses, and it refuses **by
  name**. The image requirement is the exemplar: "without an imageId this tool
  REFUSES and launches nothing" (`launch.ts:58`).
- **Units warning.** Which amounts are raw, which are human, where decimals come
  from. Params carry `CANONICAL_RAW_AMOUNT_SENTENCE` and
  `CANONICAL_HUMAN_AMOUNT_SENTENCE` (`conventions.ts:304,308`); the description
  states the consequence at call level.
- **RETURNS**, including the **ambiguous outcome**. "a status of confirmed,
  reverted or pending. A launch that confirmed but whose token could not be
  PROVEN from the receipt says so and stays pending - it never guesses an
  address, and you must not launch again." (`launch.ts:66-67`). See
  [output-envelope.md](./output-envelope.md#22-failure-refusal-cancellation-and-ambiguous-commit-are-prose).

### `approval_prepare`

Required: the **approval flow** (what this creates, what the human sees, what
submitting authorizes, what expires) and **RETURNS**. It must also state that it
does not itself move funds, when that is true.

`pools.launch_request_form` shows the shape: "THE FORM ITSELF IS THE APPROVAL:
submitting it is what authorizes the launch, so this tool creates a request and
never a transaction. It spends nothing on its own." (`launch.ts:32`).

### `local_write` and `schedule`

Required: **what is written, and where it surfaces.** A durable local row the
user can later see is a side effect, and an agent that does not know a preview
row was written cannot reason about the run's history.

Not required: a SPENDS statement. Required instead, when there is any ambiguity:
an explicit statement that it spends nothing, as `pools.launch_preview` does.

### `read`

Required: **RETURNS** and the pagination protocol. Not required: SPENDS or
approval copy.

A `read` description carries one obligation the others do not: stating what it
does **not** prove. `pools.launch_preview` is `local_write` but demonstrates the
discipline: "ADVISORY, and it says so: the final token ADDRESS cannot be known
here" and "Read the numbers as an estimate of a launch, not as a launch that is
about to happen." (`launch.ts:17`).

### `external_post` and `destructive`

Required: what leaves the machine or what is destroyed, whether it is
reversible, and the approval statement. Neither appears in the worked examples
below; their requirements follow `user_wallet_broadcast`'s shape minus the units
clause.

## 5. When-to-use and when-NOT

Both, and the when-NOT **names the alternative tool**. A when-NOT without a
named alternative tells the agent to stop without telling it where to go, which
costs a call.

Live exemplar, three alternatives in one sentence:

> `morpho/manifests/markets-discover.ts:43-46`: "Use this when the user asks
> where to lend or deposit an asset, what a deposit would earn, where the
> cheapest borrow rate is, which markets accept a given collateral, or how deep a
> lending market is; use `pendle.yields` instead when they want a FIXED rate
> locked to an expiry date, and `solana.lend.*` for Solana."

Note what makes it work: the boundary is drawn on the **user's intent**
(variable rate versus fixed rate locked to an expiry, EVM versus Solana), not on
the tool's implementation. A model matches on intent.

Named alternatives use the model-visible name of the moment. After Batch 2 that
is the `publicName`; a description naming a retired name is stale copy, and the
rename wave updates descriptions and names together for that reason.

## 6. Pagination protocol, named

A description states its pagination class in prose and matches the class the
manifest declares. The five classes and their required params and output fields
are in
[parameter-vocabulary.md](./parameter-vocabulary.md#4-pagination-classification-vocabulary).

The prose form for each:

- `none`: say the result is complete.
- `offset`: name `offset`/`limit`, the maximum, and that the reply names the
  next offset. Exemplar: "page with offset/limit (max
  `${MORPHO_MAX_PAGE_LIMIT}`)" (`markets-discover.ts:50-51`).
- `cursor`: name the cursor key and that it is passed back verbatim.
- `page_window`: name `page`/`pageSize`, and that `limit` filters after the
  window is fetched.
- `bounded_non_pageable`: say that rows beyond the cap are **not** reachable and
  what narrowing would help. Exemplar: "the response says so and asks you to
  refine - there is no overflow fetch." (`registry/long-memory.ts:145`).

A description must also state when a filter is applied server-side and echoed,
because the alternative failure is silent:

> `markets-discover.ts:17-20`: "a screening tool that silently ignores a floor
> is worse than one that errors, because the agent then believes it filtered and
> every later decision inherits the mistake."

## 7. Worked examples and the `input_examples` verification item

Money-path tools get worked input examples.

**Provider support is unverified.** Anthropic's `input_examples` field moved
complex-parameter accuracy from 72% to 90%, but support on the
OpenAI-compatible provider path Vex dispatches through is not confirmed. Vex
serves one flat OpenAI tools array (`registry/openai-tools.ts:39-41`), so an
Anthropic-shaped field is not obviously carried.

`VERIFICATION ITEM (not completed in Batch 1):` determine whether
`input_examples` survives the Vex dispatch path to each configured provider.
The check is behavioral, not documentary: send a tool definition carrying the
field and confirm it appears in the request the provider receives, and that the
provider does not reject the definition. Until that evidence exists, **the
fallback is in-description worked examples**, which are carried verbatim by
every provider.

The fallback is already the established Vex reasoning for cross-parameter rules:

> `injected-protocol-tools.ts:70-73`: "The description is the channel every
> provider carries verbatim — and it is the same sentence `discover_tools` puts
> on the `constraints` row and the runtime rejects with, so the model never sees
> the rule stated two ways."

Note also that a separate, already-live mechanism exists and is not the same
thing: `ProtocolToolManifest.exampleParams` (used at
`pools/manifests/launch.ts:24,36,71`) with its own lint rule
`lintExampleParamsRequired` (`rules.ts:222-235`). A worked example in a
description does not replace `exampleParams`; they serve different consumers and
both should agree.

## 8. Doctrine placement

**Schema-reading rules and global approval doctrine live in the system prompt
stack, not in per-tool descriptions.**

Two facts make this a defect today rather than a preference:

- The global approval doctrine is stated only inside `execute_tool`'s
  description, and `execute_tool` is withheld from the model
  (`registry/visibility.ts:161`). Doctrine that no model reads is doctrine that
  does not exist.
- `discover_tools` (~4KB) and `loop_defer` (~4.5KB) carry doctrine that applies
  to every tool. Repeated per tool it would be unaffordable; stated once in the
  prompt stack it is free. Vex already has the second model-visible surface for
  it: the system prompt Tool Map (`engine/prompts/tool-catalog.ts:29-45`).

The reference draws the same seam and its rationale is the sharpest available
argument: toolset instructions are computed from the enabled inventory, so they
can express things a static per-tool description cannot.

> `pkg/github/toolset_instructions.go:9`: "Always call 'get_me' first to
> understand current user permissions and context."

A cross-tool precondition no single tool owns. And conditional guidance gated on
another capability being present:

> `toolset_instructions.go:23-27`: `if inv.HasToolset("repos") { instructions +=
> "Before creating a pull request, search for pull request templates..." }`

That is the strongest case: guidance emitted only when the capability it depends
on is available. Emitting it unconditionally would instruct the model to use
tools it does not have.

**The boundary, both ways.** The reference also shows where the seam erodes:
`generateProjectsToolsetInstructions` (`toolset_instructions.go:37-114`) mixes
toolset workflow with what is effectively per-parameter documentation for one
tool's `query` field (`:77-109`). That half belongs in the input schema, where
it would be snapshot-tested. Vex takes the lesson: **a fact about one param
belongs to that param; a fact about the call belongs to the description; a fact
about every call belongs to the prompt stack.** Note that in the reference,
instruction strings are not covered by the snapshot mechanism at all, so
instruction drift has no regression guard; Vex should not inherit that gap when
moving doctrine into the prompt stack.

## 9. Worked example descriptions

**These are illustrative renderings of the template, not authoritative copy.**
The claims in a real description must be grounded in measurement, per section 3.
The rewrite wave grounds each one; these show shape only. Names are the
Batch 2 `publicName` form.

### 9.1 A read tool: `morpho__markets_discover`

The live description (`markets-discover.ts:39-`) is already at or above the
quality floor and is not rewritten here. Its structure, annotated against the
template:

| Template element | Where |
| --- | --- |
| verb + object + scope | "Screen Morpho Blue VARIABLE-RATE lending markets across the nine EVM chains..." (`:40-41`) |
| what the thing is | "A Morpho market is ONE loan asset borrowed against ONE collateral asset at a fixed liquidation threshold; rates float with utilization and there is no maturity." (`:42-43`) |
| when-to-use / when-NOT + alternatives | `:43-46` (quoted in section 5) |
| outcome-changing behavior | "Every filter is applied SERVER-SIDE and echoed back in `filtersApplied`; an off-enum or out-of-range value is REJECTED BY NAME, never clamped or dropped." (`:51-52`) |
| pagination named | "page with offset/limit (max `${MORPHO_MAX_PAGE_LIMIT}`)" (`:50-51`) |
| RETURNS keys | "RETURNS one row per market: marketId (a 64-hex id, not an address) plus chain, loan and collateral asset each with address, symbol and decimals, lltvPercent..." (`:53-56`) |
| unit discipline | "APY LABELLING IS THE CONTRACT: `supplyApyPercent` and `borrowApyPercent` EXCLUDE incentives, `netSupplyApyPercent` and `netBorrowApyPercent` INCLUDE them [...] never compare across those three bases." (`:56-58`) |
| a measured default | "`listedOnly` defaults to TRUE [...] ranking UNLISTED markets by net supply APY returned 297,995% on a market holding 0.04 USD and flagged `oracle_unusable`." (`:59-60`) |

One negative rule this exemplar establishes, worth applying fleet-wide: **do not
enumerate a list in the description when a structured discovery field already
owns it.** The chain slugs are omitted deliberately (`:26-33`), because
duplicating them into the embedded text cost a ranking position on an unrelated
query. The description points at the metadata instead: "the exact slugs ship on
this tool's `chains` metadata" (`:41`).

### 9.2 A `user_wallet_broadcast` tool: `pools__launch_execute`

Also live (`pools/manifests/launch.ts:44-67`), also at the floor, also not
rewritten. Annotated against section 4's five required elements:

| Requirement | Where |
| --- | --- |
| SPENDS, front-loaded | "FOR REAL - signs and broadcasts the on-chain launch with the user's wallet. SPENDS REAL FUNDS AND IS IRREVERSIBLE" (`:44-45`) |
| approval statement, all three authorities | "in a FULL-permission chat session the user's permission is the authority and this executes directly; in a RESTRICTED session it refuses BY NAME and you must call pools.launch_request_form instead [...] in a MISSION run the authority is the contract's HOST-authored launch ceilings, which you cannot write" (`:58-63`) |
| preconditions, refused by name | "Vex DECODES the launchpad's transaction and proves 13 things about it against the chain [...] and REFUSES BY NAME if any of them disagrees" (`:51-54`); "without an imageId this tool REFUSES and launches nothing" (`:58`) |
| units | "as raw amounts with their decimals" (`:65-66`) |
| RETURNS incl. ambiguous outcome | `:63-67`, ending "it never guesses an address, and you must not launch again." |

Two further properties worth generalizing:

- **A fee is stated with its timing.** "Vex also charges 25 bps of the ETH the
  launch sends (deployment fee + any ETH prebuy) as a SEPARATE transfer that
  runs only after the launch confirms" (`:49-51`). Rule 90 requires a fee to be
  taken only after the operation it charges for succeeds; the description says
  so, which is what lets the agent reason about a partial outcome.
- **A value that cannot be redirected says so.** "The creator fee stream always
  goes to the user's own session wallet on this path; there is no recipient
  parameter." (`:54-56`). Stating the absence of a parameter is what stops a
  model inventing one.

### 9.3 A discovery tool: `ToolSearch`

`ToolSearch` does not exist yet; S1 owns its design and the copy below is a
template rendering, not a specification of its behavior. It is included because
a discovery tool is the one case where the template's "RETURNS" element carries
the most weight: the result is what the model navigates by.

Shape a discovery description must have:

- **Sentence 1**: verb + object + scope, naming that it searches the *available*
  tool surface, not the whole catalog.
- **The three modes** and which one a bare query gets.
- **The injection visibility fact**, which is the single most misunderstandable
  property: a hit makes a tool callable on the **next** provider request, not
  the current one. A model that does not know this calls a just-discovered tool
  immediately and burns a turn.
- **What the result contains and what it does not**: slim rows, no params dump,
  the full schema arriving via injection instead.
- **The default limit** and that it is a ranked shortlist, not an exhaustive
  list, so an absent tool is not proof of absence.
- **when-NOT**: naming the namespace-listing mode for browsing and the direct
  call for a tool already injected.
- **RETURNS**: the exact row keys.
- Pagination class: `bounded_non_pageable` (a ranked shortlist with no
  continuation) unless S1 designs otherwise, and the description says so rather
  than letting an agent assume there is a page two.

Doctrine that must **not** be in it, per section 8: how to read a JSON schema,
and the global approval rules. Those belong to the prompt stack. The ~4KB
`discover_tools` description shrinks by exactly that much.

## 10. Checklist

For each tool, in the rewrite wave:

- [ ] Sentence 1 is verb + object + scope and does not repeat the name.
- [ ] Ambiguous domain nouns are defined.
- [ ] when-to-use and when-NOT both present; when-NOT names a real, current tool.
- [ ] ActionKind obligations met (section 4) for the tool's declared
      `actionKind`, not for its `mutating` boolean.
- [ ] Pagination class named in prose and matching the manifest field.
- [ ] RETURNS lists the actual keys, and matches
      [output-envelope.md](./output-envelope.md).
- [ ] Units, decimals, and their source stated wherever an amount appears.
- [ ] Server-side filtering and reject-by-name behavior stated.
- [ ] No list duplicated from a structured discovery field (section 9.1).
- [ ] No schema-reading or global approval doctrine (section 8).
- [ ] Within 2048 bytes, or an allowlist entry whose reason names the decision
      the extra length prevents getting wrong, with critical facts first.
- [ ] Measured claims are grounded in a capture with its date, not in provider
      documentation prose.
