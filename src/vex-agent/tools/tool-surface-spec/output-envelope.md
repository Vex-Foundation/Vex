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

## 5. Stale copy inventory

Five to seven manifests and modules still describe a "16,384 B tool-output cap"
that no longer exists. Plan v3 section 5.3 lists five references; **the measured
count is higher and the plan's list is both slightly off and incomplete**. Full
inventory from a repo-wide scan of non-test sources:

**Model-visible (inside a description the model receives), the priority half:**

| Location | Text |
| --- | --- |
| `tools/registry/web.ts:38` | "well past the 16,384 B tool-output cap" |
| `tools/registry/web.ts:40` | "will exceed the 16,384 B output cap" |
| `tools/registry/twitter-account.ts:91` | "~12 KB of the 16 KB tool-output cap" |
| `tools/protocols/solana-jupiter/manifests/core.ts:45` | "27,970 B against the 16,384 B tool-output cap" |
| `tools/protocols/dexscreener/manifests/pair-list-params.ts:145` | "24,139 B against the 16,384 B" |
| `tools/protocols/dexscreener/manifests/pair-list-params.ts:178` | "16,384 B tool-output cap (live batch, 2026-08-17...)" |

**Internal comments only (no model impact, correct for accuracy):**

`tools/internal/web-research/search-options.ts:13`;
`tools/internal/twitter-projection.ts:6` and `:14`;
`tools/protocols/solana-jupiter/projectors.ts:7` (plan said `:8`);
`tools/protocols/solana-jupiter/handlers/core/token-handlers.ts:158`;
`tools/protocols/dexscreener/feed-list/feed-fields.ts:9`;
`tools/protocols/dexscreener/manifests/pair-list-params.ts:107`.

Correction to the plan: it named `registry/web.ts:38,40`,
`internal/web-research/search-options.ts:13`, `internal/twitter-projection.ts:6,14`
and `projectors.ts:8`, which is four of the seven files and misses **every
model-visible reference except `web.ts`**. `twitter-account.ts:91`,
`solana-jupiter/manifests/core.ts:45` and `pair-list-params.ts:145,178` are the
ones a model actually reads and the ones worth correcting first.

Note the measured byte figures in these strings are still true and still useful.
Only the clause naming a cap that enforces them is false. The correction is to
keep the measurement and restate the consequence as a producer-level bound ("so
pass a `limit`"), not to delete the numbers. Test files and unrelated
`16 KB` matches (keystore, inference config, secret vault) are out of scope.

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

`concise` | `detailed`, one shared module, **default `concise`**.

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

### 7.3 The `wallet_balances` divergence: resolution requires an owner decision

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

Two candidate resolutions, for the owner:

- **R1: flip to `concise`, keep the trim opt-in.** Uniform default across all
  tools; `limit` still requires an explicit value, so a bare call returns every
  row exactly as today and only the *label* changes. This is the smallest change
  that removes the divergence, and it appears to preserve observable behavior for
  bare calls, but that equivalence must be proven by a test before the flip, not
  assumed from reading `trimTokens` (`read.ts:481-483`).
- **R2: keep `detailed` and record it as a ratified exception.** The divergence
  becomes documented policy with a reason, not debt. Costs uniformity; costs
  nothing else.

R1 is recommended if and only if the bare-call equivalence test passes. Absent
that evidence, R2 is the honest state. Either way the decision is recorded in
the shared module, not discovered by reading a handler.

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
