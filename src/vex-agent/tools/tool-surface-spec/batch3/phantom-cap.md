# The phantom output cap: audit, fixes, and the lint

Completed 2026-08-21 at `ea5dea2af71414cba6a492e4eba7c4565266d00f`.

## 1. Ground truth: no cap exists

The runtime once externalised any tool result over `TOOL_OUTPUT_OVERFLOW_BYTES`
(16,384) into a blob with a stub in the transcript. **That mechanism was
removed, not relaxed.** Four independent pieces of evidence:

1. `src/vex-agent/engine/core/tool-output-policy.ts` **does not exist**. A
   repo-wide search for `TOOL_OUTPUT_OVERFLOW_BYTES` returns two lines, both
   comments in `db/migrations/013_tool_output_blobs.sql`. No producer, no
   consumer.
2. `engine/core/turn-loop-tool-batch/results.ts:167-172` states the inverse
   contract outright: every tool output is persisted verbatim and inline,
   "because the model could not tell what to look for inside a blob, so full
   output in context beats blobbing." That file contains no truncation logic.
3. `__tests__/vex-agent/engine/core/turn-loop-tool-batch-results-inline.test.ts`
   pins the removal, asserting a >16 KiB output persists verbatim with no
   overflow or blob markers.
4. No byte enforcement exists anywhere in the tool path. Every `byteLength` in
   `src/vex-agent/` is request sizing, database parameter sizing, compaction
   corpus measurement, launch-image bytes, or an unrelated on-chain image cap.

The bound the strings claimed was therefore not merely stale. It was **fiction
the model was budgeting real calls against**: specific, quantitative, and false.

## 2. What replaced it: real producer-level bounds

Every model-facing site had a real bound available, which is why no fix required
inventing one.

| Producer | Real bound today | Where |
| --- | --- | --- |
| WebResearch | `maxResults` 1-10 (default 6), `fetchTop` 0-10 (default 3), `maxChunksPerSource` | `tools/internal/web-research/search-options.ts:30-34` |
| WebResearch `url=` | **none** - the whole document | - |
| TwitterAccount | `count` max 20 (search/timelines) / 100 (lists), `cursor`, plus a field projection | `tools/registry/twitter-account.ts:91`, `tools/internal/twitter-projection.ts` |
| solana.tokens.* | Vex-side `limit` window + projection | `solana-jupiter/manifests/core.ts`, `projectors.ts` |
| dexscreener lists | `limit` 1-200 over a <=30-row provider window, `offset` paging, lean projection | `dexscreener/manifests/pair-list-params.ts`, `list-core/row-window.ts` |
| MemorySearch | entry and character caps, **signaled** to the model | `long-memory/search/format.ts:10-11` |

The one honest "no bound" is `WebResearch(url=...)`, and its description now
says so rather than substituting a comforting number.

## 3. Classification and disposition

Verified independently against the review's count of 14 files. **Model-facing
matched exactly at 6 files; comment-only did not** - the review said 7, the real
figure is 10 files / 13 sites.

### (a) Model-facing - 6 files, 8 sites. All fixed.

| # | Site | Was | Now |
| --- | --- | --- | --- |
| 1 | `engine/prompts/research.ts:177` | "~21 KB of page text, over the output cap" | "~21 KB of page text in one result, and `fetchTop` is the only thing that bounds it" |
| 2 | `tools/internal/twitter-account.ts:36` | "measured 1.6-1.9x the tool-output cap" | "measured 26,082 B and 30,321 B on ordinary 20-row searches, against a far smaller projected payload" |
| 3 | `tools/registry/web.ts:38` (`url`) | "well past the 16,384 B tool-output cap" | "and no parameter bounds it" |
| 4 | `tools/registry/web.ts:40` (`fetchTop`) | "will exceed the 16,384 B output cap" | clause deleted; the ~21 KB and ~12 KB measurements stay |
| 5 | `tools/registry/twitter-account.ts:91` (`count`) | "~12 KB of the 16 KB tool-output cap" | "~12 KB in one response. `count` and `cursor` are what bound it." |
| 6 | `solana-jupiter/manifests/core.ts:48` | "27,970 B against the 16,384 B tool-output cap" | "measured 27,970 B, so limit is applied Vex-side and never silently" |
| 7 | `dexscreener/manifests/pair-list-params.ts:145` | "24,139 B against the 16,384 B tool-output cap. The widest queries genuinely overflow" | keeps 24,139 B; "The widest queries are genuinely large, and `limit` is what bounds them" |
| 8 | `dexscreener/manifests/pair-list-params.ts:178` | "22,378 B against the 16,384 B tool-output cap ... about 23 rows fit one response" | see below |

Sites 1 and 2 are the two the spec's own inventory had missed, and they were the
worst two. Site 1 is the **system prompt** - the most-read string in the
product. Site 2 is a runtime `fail()` returned to the model, and the only site
that asserted the cap as a **ratio** with no number at all; a ratio to a
nonexistent quantity is less falsifiable than a wrong number, not more.

Site 8 needed more than a clause deletion. "About 23 rows fit one response" was
**derived** from 16,384 / 640, so deleting the cap while keeping the conclusion
would have left the fiction in place with its evidence removed. It is restated
from the measurement alone: 22,378 B for 35 rows is ~640 B per row, so a
60-address batch is ~38 KB and offset paging is what bounds it.

**Generated mirrors regenerated** in the same change, as reviewed contract
artifacts: `__toolsnaps__/` `WebResearch`, `TwitterAccount`,
`solana__tokens_discover`, `dexscreener__pairs_search`,
`dexscreener__tokens_get`. Five files changed, no orphans.

### (b) Comment-only - 10 files, 13 sites. All fixed.

`web-research/search-options.ts:13`; `twitter-projection.ts:6` and `:14`;
`solana-jupiter/projectors.ts:7` and `:26`;
`solana-jupiter/handlers/core/token-handlers.ts:153` and `:158`;
`dexscreener/feed-list/feed-fields.ts:9`;
`dexscreener/feed-list/feed-row.ts:51`; `dexscreener/handlers/feeds.ts:18` and
`:120`; `dexscreener/manifests/pair-list-params.ts:107`.

Measured byte figures were preserved throughout; only the cap clause was
removed. The last four are additions to the review's list.

**`token-handlers.ts:153` deserves its own note.** It read "so default-limit
trending stays under the overflow threshold" - a cap claim carrying **no
magnitude at all**. It survived a repo-wide grep for `16384`, `16 KiB` and
`16 KB` that had already come back clean, and was caught only when the lint was
tightened to fire on cap-shaped prose alone. It is the concrete argument for
shipping a rule rather than doing a one-time sweep.

### (c) Unrelated - 1 site cluster, clarified not deleted.

`engine/core/explorer-refs.ts:129,139,142` said "output cap" but means
`MAX_REFS = 8`, a reference-count bound that genuinely exists. The bound stays;
the comments now name `MAX_REFS` so the phrase cannot be misread, and so the new
lint is not fighting a legitimate use.

Also unrelated and untouched: scrypt `N = 16384`, `maxOutputTokens: 16_384`,
`REASONING_PAYLOAD_CAP = 16_384`, `context_length: 163840`.

### (d) Deliberately out of scope

- **`db/migrations/013_tool_output_blobs.sql:5,35`** references
  `TOOL_OUTPUT_OVERFLOW_BYTES` and the deleted module path. An applied migration
  is history; editing it to tidy a comment risks a checksum for no behavioural
  gain. Recorded here instead.
- **`__tests__/dexscreener/_byte-budget.ts`** keeps
  `DEXSCREENER_BYTE_BUDGET_BYTES = 16_384`. This is legitimate and stays: a
  budget the repository chooses for its own authoring discipline is not a claim
  to the model that the runtime enforces one. Only
  `persona-gate-follow-ups.test.ts` changed - it asserted the cap clause had to
  be **present** in a model-visible description, so it was pinning the false
  claim in place. It now requires the measurement and the naming of `limit`, and
  asserts the cap magnitude is **absent**. The contract change is stated in the
  test.
- Spec markdown copies are corrected in `output-envelope.md` section 5, which
  also records what its own inventory had wrong.

## 4. The lint

`stale-output-cap-claim`, in `protocols/_manifest-lint/source-rules.ts`
alongside `generic-error-literal`, driven from
`__tests__/vex-agent/tools/protocols/manifest-lint.test.ts`.

**It lands at ZERO with an empty allowlist.** No legitimate occurrence survived,
so none is recorded, and the suite asserts
`MANIFEST_LINT_ALLOWLIST.filter(e => e.rule === "stale-output-cap-claim")` is
empty. This is modelled on the `slippage-default-home` test rather than on the
debt tables, deliberately: recording an occurrence as debt is exactly how the
claim would come back.

**Scan roots are wider than the rest of the linter**, and this is the part most
likely to be undone by accident. The existing source rules scan
`src/vex-agent/tools/protocols` alone. That directory holds only 3 of the 8
model-facing sites; the other 5 live in `engine/prompts`, `tools/registry` and
`tools/internal`. A rule scoped to the protocol tree would have missed the
system prompt and the runtime error - the two worst sites - and would have been
a guard in name only. All four roots are declared in the test with that
rationale.

**Two ways to fire**, because the claim has two spellings:

1. an unambiguous global-cap phrase, magnitude or not (`tool-output cap`,
   `output cap`, `overflow cap`, `overflow threshold`);
2. a 16 KB-shaped magnitude **and** weaker cap-shaped prose ("response limit",
   "context budget", "truncat") on the same line.

The first draft required a magnitude and consequently missed both the
"1.6-1.9x the tool-output cap" error string and `token-handlers.ts:153`.

**Verified to fire.** A lint that cannot fail proves nothing, so the rule was
probed against eleven cases before being accepted: six positives (all four
magnitude spellings, the magnitude-free ratio form, the "response limit"
paraphrase) and five negatives (a bare measured byte figure, scrypt `N`,
`maxOutputTokens`, cap prose with no magnitude, a `16 KB` magnitude with no cap
prose). All eleven behaved as intended, and the tightening pass then found the
real thirteenth site in the tree.

The failure message names the fix rather than the fault: keep the measured
figure, drop the cap clause, name the real producer-level bound, and **do not
invent a ceiling to replace the removed one**.
