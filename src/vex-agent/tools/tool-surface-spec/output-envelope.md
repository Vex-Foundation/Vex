# Output Envelope

Spec S4, Batch 1. Docs only. No code changes in this batch.

Companion documents: [style-guide.md](./style-guide.md) (what a description must
promise about the return), [parameter-vocabulary.md](./parameter-vocabulary.md)
(the pagination classes referenced below),
[identity-and-migration.md](./identity-and-migration.md).

Reference checkout cited in this document:
`agents-colab/github-mcp-server` at `8ec6249` (v1.9.0-14, 2026-08-18).

## 1. What the model actually sees

One field. `ToolResult.output` is a string and it is the only model-visible
half of a tool result. The `data` object is dropped before the model:

> `tools/internal/twitter-projection.ts:8-9`: "the only lever, since the
> internal-tool `data` is dropped at the batch loop and only the `output`
> string reaches the model."

Every rule below is therefore a rule about a **string**. `data` is for the
renderer, the transcript, and downstream Vex code; it is not a second channel to
the model and must never be where a fact the model needs to act on lives.

## 2. The envelope

### 2.1 Success is JSON

A successful call returns `output` = a JSON document carrying:

- a `summary` field: one sentence a model can act on without parsing the rest;
- typed fields: the domain payload;
- the continuation fields its pagination class requires (section 3).

`summary` is not decoration. The model reads the whole string either way, but a
lead sentence is what makes a 6 KB result usable in a batch of four tool
results, and it is the only part that survives a human skimming the transcript.

### 2.2 Failure, refusal, cancellation, and ambiguous commit are PROSE

**This is a deliberate money-path invariant and this spec preserves it
unchanged.** It is not drift to be tidied into a uniform JSON envelope.

The reason is visible in the live ambiguous arm of a real broadcast path:

> `protocols/kyberswap/handlers/swap/execute-broadcast.ts:126`:
> "`${toolId}`: broadcast of the `${plan.eventRole}` transaction
> (`${outcome.txHash}`) could not be confirmed yet — it may still settle
> on-chain. Do not retry; this attempt is recorded as pending and will resolve
> automatically. You can verify it now yourself with chain_read (action
> tx_receipt, chain=`${chainId}`, txHash=`${outcome.txHash}`)."

The authoring comment above it states the contract
(`execute-broadcast.ts:122-125`): "'Do not retry' is the safety-critical half
and never moves. The second half gives the agent a READ it can perform itself
instead of waiting on the sweep - the alternative to waiting must never be a
re-broadcast."

A JSON field named `retryable: false` does not carry that. Prose does, and a
model that skims one field of a JSON error can skip a field; it cannot skip the
first clause of a sentence. The four prose states are:

| State | What the prose must state |
| --- | --- |
| Failure | what could not be completed, the real sanitized cause, whether retry is appropriate, the next action |
| Refusal | that the tool refused, **by name** which precondition failed, and what would satisfy it |
| Cancellation | that the work was cancelled, and whether any side effect committed before cancellation |
| Ambiguous commit | that the outcome is UNKNOWN and still pending, that this attempt is recorded, that retry is forbidden, and the read the agent can perform itself |

Refusal-by-name is already the fleet convention, not a new rule:
`pools.launch_execute` "REFUSES BY NAME if any of them disagrees"
(`pools/manifests/launch.ts:54`), and the same tool "refuses BY NAME and you
must call pools.launch_request_form instead" (`launch.ts:60-61`).

The four states must stay distinguishable from each other and from success.
Collapsing any of them into "unexpected error" is forbidden by rule 90; the
ambiguous state in particular is a distinct state requiring reconciliation, not
an ordinary failure.

### 2.3 Errors are already scrubbed by an owner

Do not hand-write scrubbing at a handler. `src/utils/error-summary/` owns
turning a thrown value into "the bounded, scrubbed summary the agent, the logs
and the renderer are allowed to see" (`error-summary/render.ts:2-4`). Its
`SafeErrorSummary` carries a machine-stable `code`, a `category`, an optional
`httpStatus` ("Never scrubbed: a bounded integer", `render.ts:25`), a
`message`, and a `remediation` (`render.ts:17-29`).

The `code` field exists precisely to prevent collapse:

> `error-summary/render.ts:20-22`: "This is what a mission log keys on — a
> category alone cannot distinguish `KYBER_PRICE_FLOOR_VIOLATED` from
> `PENDLE_UNSAFE_TX`."

The github-mcp reference draws the same seam differently and the difference is
worth stating. It splits by *audience*: user-actionable failures come back as a
failed tool call, developer failures bubble as real errors
(`docs/error-handling.md:77-78`). Vex has no equivalent second channel, because
`output` is the only model-visible field (section 1). Vex therefore keeps the
distinction inside `SafeErrorSummary`'s `code` and `category` rather than in
two return paths. The adoptable half is the privacy stance, which Vex already
implements: detailed structure retained for logs and middleware, redacted
message to the model (`error-handling.md:91-93`).

## 3. Continuation contract

For every tool whose pagination class is `offset`, `cursor`, or `page_window`
(see [parameter-vocabulary.md](./parameter-vocabulary.md#4-pagination-classification-vocabulary)),
the success JSON carries:

- **`hasMore`** - boolean. Whether rows exist beyond this reply.
- **`nextOffset` | `nextCursor` | `nextPage`** - exactly one, matching the
  class, present if and only if `hasMore` is true. The agent passes back what
  the reply returned; it never computes a continuation itself, because a
  post-filter makes agent arithmetic silently skip rows.
- **`truncated`** - boolean. Whether the producer dropped rows *within this
  reply* for a reason other than paging. Distinct from `hasMore`: `hasMore`
  means "ask again and you get more", `truncated` means "these are gone unless
  you narrow".
- **`filtersApplied`** - which filters actually ran.

`filtersApplied` is the one with a measured rationale already in the tree:

> `morpho/manifests/markets-discover.ts:17-20`: "every filter that ran is echoed
> in `filtersApplied` - a screening tool that silently ignores a floor is worse
> than one that errors, because the agent then believes it filtered and every
> later decision inherits the mistake."

`bounded_non_pageable` tools carry `truncated` and, when it is true, the reason
and the narrowing action. They carry no `hasMore` and no `next*`, because
offering a continuation field that cannot be continued is worse than offering
none. The honest live shape is `long_memory_search`: "If results were truncated
to the inline cap, the response says so and asks you to refine - there is no
overflow fetch." (`registry/long-memory.ts:145`).

Five distinct continuation vocabularies exist in the tree today. This spec
defines the target; the migration that converges them is a later wave.

## 4. No global truncation

**There is no global output cap, by design, and this spec does not add one.**
The owner rule in `.claude/CLAUDE.md` forbids truncate/slice-style context
cutting: agent features need the whole context.

The code agrees:

> `engine/core/turn-loop-tool-batch/results.ts:168-172`: "Every tool output is
> persisted VERBATIM and inline: the externalisation mechanism (tool output
> blobs + a stub in the transcript) was removed — the model could not tell what
> to look for inside a blob, so full output in context beats blobbing."

The same stance is stated at a projector:

> `tools/internal/twitter-projection.ts:19-20`: "NOTHING HERE IS TRUNCATED.
> `fullText` is 43 % of a concise payload and it still ships whole."

Boundedness is therefore a **producer-level** obligation, satisfied by:

1. **Declared limits** with a stated default and maximum, rejected by name when
   exceeded rather than clamped.
2. **Pagination** with the continuation contract above.
3. **Projection**: returning every matching row with fewer fields per row. This
   is not truncation and must not be reported as such. Two live owners:
   `solana-jupiter/projectors.ts` strips a ~40-field payload to
   "identity, price/market-cap/liquidity, holder + organic-trading signals, the
   safety audit flags the agent uses, tags/launchpad, age" (`projectors.ts:10-13`),
   and `internal/twitter-projection.ts` does the same for Twitter payloads.
4. **Signaled truncation** when rows genuinely are dropped, per `truncated`
   above.

What is forbidden is a blanket cap applied at the batch loop that slices any
tool's output without the producer knowing. What is required is that a producer
which drops anything says so.

## 5. Stale copy inventory - CLEARED 2026-08-21 (Batch 3 Wave 0)

**Status: every claim below is fixed and a lint now prevents its return. This
section is retained as the record of what was wrong, not as a worklist.**

The rule is `stale-output-cap-claim`
(`protocols/_manifest-lint/source-rules.ts`), driven from
`__tests__/vex-agent/tools/protocols/manifest-lint.test.ts`. It scans four roots
- `engine/prompts`, `tools/protocols`, `tools/registry`, `tools/internal` -
because the claim had four different owners and a protocol-tree-only scan would
have caught three of the eight model-facing sites. It lands at ZERO with an
empty allowlist, and the suite asserts the allowlist stays empty, so a future
occurrence cannot be admitted as recorded debt.

### What this section previously got wrong

It claimed "five to seven manifests and modules" and presented its own list as
the complete correction to the plan. Both were understatements. The measured
figures are **6 model-facing source files / 8 sites**, **10 comment-only source
files / 13 sites**, 1 unrelated cap, plus 6 generated toolsnap mirrors and 2
immutable migration comments. Two of the model-facing sites - the ones with the
widest blast radius - were missing from the table below entirely.

**Model-visible (inside a string the model receives) - 8 sites, all fixed:**

| Location | Was | Now |
| --- | --- | --- |
| `engine/prompts/research.ts:177` | "~21 KB of page text, over the output cap" | names `fetchTop` as the bound. **Was missing from this inventory**: it is the system prompt, the single most-read string in the product. |
| `tools/internal/twitter-account.ts:36` | "measured 1.6-1.9x the tool-output cap" | states 26,082 B and 30,321 B. **Was missing from this inventory**: a runtime `fail()` returned to the model, and the only site that asserted the cap as a RATIO with no number - less falsifiable, not more. |
| `tools/registry/web.ts:38` | "well past the 16,384 B tool-output cap" | "and no parameter bounds it" |
| `tools/registry/web.ts:40` | "will exceed the 16,384 B output cap" | clause deleted; the ~21 KB measurement stays |
| `tools/registry/twitter-account.ts:91` | "~12 KB of the 16 KB tool-output cap" | "~12 KB in one response. `count` and `cursor` are what bound it." |
| `tools/protocols/solana-jupiter/manifests/core.ts:48` (this inventory said `:45`) | "27,970 B against the 16,384 B tool-output cap" | "measured 27,970 B, so limit is applied Vex-side" |
| `tools/protocols/dexscreener/manifests/pair-list-params.ts:145` | "24,139 B against the 16,384 B tool-output cap" | keeps 24,139 B; "`limit` is what bounds them" |
| `tools/protocols/dexscreener/manifests/pair-list-params.ts:178` | "22,378 B against the 16,384 B tool-output cap ... about 23 rows fit one response" | keeps 22,378 B; the row count was DERIVED from the phantom cap, so it is restated as ~640 B/row and ~38 KB for 60 addresses, bounded by offset paging |

The 6 mirrors in `tools/__toolsnaps__/` (`WebResearch`, `TwitterAccount`,
`solana__tokens_discover`, `dexscreener__pairs_search`,
`dexscreener__tokens_get`) are regenerated in the same change, as reviewed
contract artifacts.

**Internal comments only - 13 sites across 10 files, all fixed.** The previous
list held 7 of them. It missed `dexscreener/feed-list/feed-row.ts:51`,
`dexscreener/handlers/feeds.ts:18` and `:120`,
`solana-jupiter/projectors.ts:26`, and
`solana-jupiter/handlers/core/token-handlers.ts:153` - the last of which
contained no magnitude at all ("under the overflow threshold") and was found by
the lint after a repo-wide grep for `16384` had already come back clean. That is
the case for having the rule rather than a one-time sweep.

**Out of scope, deliberately:**

- `engine/core/explorer-refs.ts` - says "output cap" but means `MAX_REFS = 8`, a
  real bound. The comments now name `MAX_REFS` so the phrase is unambiguous.
- `db/migrations/013_tool_output_blobs.sql:5,:35` - reference
  `TOOL_OUTPUT_OVERFLOW_BYTES` and the deleted `tool-output-policy.ts`. Applied
  migrations are history; not edited.
- Unrelated `16384` matches: scrypt `N`, `maxOutputTokens`,
  `REASONING_PAYLOAD_CAP`, `context_length: 163840`.
- `src/__tests__/dexscreener/_byte-budget.ts` keeps
  `DEXSCREENER_BYTE_BUDGET_BYTES = 16_384` as a self-imposed authoring budget.
  That is legitimate: a budget the repository chooses for itself is not a claim
  to the model that the runtime enforces one. Only
  `persona-gate-follow-ups.test.ts` changed, because it asserted the cap clause
  had to be PRESENT in a model-visible description.

### The remediation rule (unchanged, and now enforced)

The measured byte figures in these strings were always true and are still
useful. Only the clause naming a cap that enforces them was false. The
correction keeps the measurement and restates the consequence as a
producer-level bound (`limit`, `offset`, `fetchTop`, `count`/`cursor`, or the
projection). Where a surface genuinely has no bound - `WebResearch(url=...)` -
the honest statement is that none exists. **Never invent a ceiling to replace
the removed one**, and never delete a measurement to avoid the question.

## 6. One shared `ok` / `fail` helper

Two byte-identical copies exist today:

```
tools/internal/types.ts:221-228          tools/protocols/handler-helpers.ts:47-55
export function ok(data: unknown)        export function ok(data: unknown)
export function fail(msg: string)        export function fail(msg: string)
```

Both bodies are the same: `{ success: true, output: JSON.stringify(data), data }`
and `{ success: false, output: msg }`.

**The convergence is already precedented in the same file.** `handler-helpers.ts`
does not redefine `enumField`; it re-exports it:

> `tools/protocols/handler-helpers.ts:17`: `export { enumField } from "../internal/types.js";`
>
> `handler-helpers.ts:7-8`: "`enumField` is re-exported from
> `tools/internal/types.ts` where it already exists — same helper, one source of
> truth."

**Design: apply the identical treatment to `ok` and `fail`.** The definitions
stay in `tools/internal/types.ts`; `handler-helpers.ts` re-exports them. Every
existing import path keeps working, no call site changes, and the resulting
shape matches a pattern this file already documents and defends.

Rejected alternative: a new neutral third module owning `ok`/`fail`. It would
leave `enumField` in `internal/types.ts` and split two halves of the same
helper set across three files, creating the ownership question the current
re-export already answered.

This is a Batch 2 edit. It is recorded here because the envelope contract and
its helper cannot have two owners, and because a snapshot harness that captures
result shapes should capture one helper's shape, not two.

## 7. `response_format`

`concise` | `detailed`, one shared module (`src/vex-agent/response-format.ts`, D17). The default is `concise` everywhere except `wallet_balances`, whose `detailed` default is the ratified exception recorded in section 7.3.

### 7.1 Current state: four sites, three behaviors

| Site | Default | Evidence |
| --- | --- | --- |
| `long_memory_*` | `concise` | `internal/long-memory/get.ts:36` `?? "concise"`; declared at `registry/long-memory.ts:120,164,199,225` |
| `mission_draft_update` | `concise` | `internal/mission.ts:79` `?? "concise"` |
| `wallet_balances` | **`detailed`** | `internal/wallet/read.ts:72` `.default("detailed")`; `registry/wallet.ts:32` |
| `twitter_account` | **retired, rejected by name** | `internal/twitter-account.ts:26-34` |

### 7.2 The shared module

One module exports the enum, the canonical param schema fragment, and the
canonical description sentence. Manifests reference it; none of the four
re-declares the enum inline. The `long_memory` sites already carry per-tool
prose describing what `detailed` adds (`registry/long-memory.ts:51,145,193`),
which is correct and stays per-tool: the *shape* is shared, the *contents* are
the tool's own.

The module must model **four** states, not two, because a fourth already exists
in production:

- offers both formats, default `concise`;
- offers both, default `detailed` (the divergence, section 7.3);
- does not offer the param at all;
- **retired the param and rejects it by name**.

The last is `twitter_account` and its reasoning must survive any consolidation:

> `internal/twitter-account.ts:21-25`: "`response_format: "detailed"` would then
> sail through the union, get dropped [...] Retirement is enforced by
> NAME-REJECTION in the handler, never by silent deletion."

A shared module that treats "retired" as merely "absent" would reintroduce the
silent-drop this rejection exists to prevent.

### 7.3 The `wallet_balances` divergence: RESOLVED 2026-08-22 as R2 (D17)

`wallet_balances` defaults to `detailed`, and the code says why:

> `internal/wallet/read.ts:70-71`: "'detailed' (DEFAULT, compatibility-first)
> returns every projected token. 'concise' enables the `limit` trim to the
> top-N tokens by held USD value."
>
> `read.ts:457-458`: "Compatibility-first: a trim only happens when
> `response_format` is 'concise' AND a positive `limit` was supplied."

This is not drift. It is a deliberate compatibility choice, and on this tool the
default also gates whether `limit` does anything at all
(`registry/wallet.ts:33`: "Only applied when response_format='concise'; ignored
under the default 'detailed'").

**Therefore the spec does not silently flip it.** Flipping the default changes
what an existing caller receives from a wallet-reading tool: fewer token rows,
and a previously-inert `limit` suddenly trimming. That is a behavior change on a
money-adjacent read, which rule 00 makes an explicit-direction item.

**The owner chose R2 on 2026-08-22 (D17): `wallet_balances` keeps `detailed`,
recorded as a ratified exception.**

The two candidates were R1 (flip to `concise`, keeping the trim opt-in, for a
uniform default) and R2 (keep `detailed` and document why). R1 was rejected on
this reason: on this tool the default does not only label the reply, it gates
the trim. Under a `concise` default a caller who sent `{limit: N}` and nothing
else would start receiving a trimmed and RE-RANKED row set from a
money-adjacent read, having asked for neither. The uniformity R1 buys is not
worth a wallet read quietly dropping holdings.

So the divergence is now documented policy rather than debt:

- The reason lives in the shared module's header
  (`src/vex-agent/response-format.ts`, state 2), not in a handler comment, so
  it is found before the code is changed rather than after.
- The behavior is pinned by test, not by prose: `{limit: N}` with no
  `response_format` returns every row, unmarked and untruncated
  (`__tests__/vex-agent/tools/internal/wallet/read-concise-unpriced.test.ts`,
  "the detailed default (D17 R2) and `truncated` (D16)"). The same suite
  asserts field-for-field equality between a bare call and
  `response_format: "concise"` without a limit, which is the equivalence R1
  would have needed and which now guards the exception instead.

Related, from D16: each wallet snapshot now carries `truncated` (always
present, `false` on the `detailed` path and on a `{limit}` call with no
format) plus a `truncationNote` when true. `wallet_balances` is
bounded_non_pageable: there is no continuation to fetch, so the note names the
narrowing action (raise `limit`, or ask for `detailed`) instead.

### 7.4 What `concise` must never drop

`concise` narrows fields. It never drops a fact the model needs to decide
safety or authority: units, decimals, chain, destination, fee, approval state,
refusal reason, `truncated`, or any continuation field. Those are the fields
rule 90 binds consent to. A concise projection that omits decimals turns a
display change into a money-path hazard.

The live precedent for getting this right is the unpriced-row handling in
`wallet_balances`: unpriced tokens are appended "outside this limit, marked
`priceUnavailable` so 'no price feed' never reads as 'not held'"
(`registry/wallet.ts:33`). A trim that had simply dropped them would have made
an absent price look like an absent balance.
