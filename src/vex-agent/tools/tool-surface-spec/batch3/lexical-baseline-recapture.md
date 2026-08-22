# Lexical baseline recapture

Recaptured 2026-08-21 at `ea5dea2af71414cba6a492e4eba7c4565266d00f`, before any
Wave 1 change. **This artifact exists so that a future Batch 3 lexical delta is
attributable.** Without it, the next person to run the gate inherits a red
check, cannot tell which program caused which movement, and has no honest
option but to accept whatever it prints.

## 1. The check was invalid, and had been for a month

Two baselines back this gate, and both were stale, for different reasons.

**Canonical seed - identity drift.** The stored baseline declared
`datasetVersion: "v3-agent-200"` with `count: 200`, while the dataset it was
compared against is `v3-agent-116` with 116 queries. The CLI detects this and
says so:

```
Identity drift (the baseline was captured against a different contract):
  datasetVersion: baseline "v3-agent-200" vs measured "v3-agent-116"

The stored baseline does not describe the dataset that was just evaluated;
metric comparison below is NOT a regression signal until this is reconciled
with an explicit --update.
```

The cause is pinned to one commit: **`9e45b086`, 2026-07-23, "feat(agent-scan):
etherscan-like activity log, staged swap pipeline, remove polymarket/zaps/
limit-orders"**. It rewrote the schema in the same change
(`retrieval-eval-harness.ts`: `z.literal("v3-agent-200")` -> `"v3-agent-116"`,
`.length(200)` -> `.length(116)`, with the in-file note "Agent Scan phase 1
(2026-07-22): shrunk from v3-agent-200 to v3-agent-116") and deleted the queries
for the retired surfaces, but never recaptured the baseline. The stored file was
last written on **2026-04-29**, three months earlier.

So the 105 moved metrics on this target are the arithmetic of dropping 84
queries - overwhelmingly the ones the teardown removed - and nothing else. They
are **not** a retrieval regression, and they belong to that teardown.

**Supplemental - catalog drift, no identity drift.** Case count is 12 both
sides and the dataset version is unchanged at `supplemental-v1`, so this one is
a genuine measurement of a moved catalog. It was captured 2026-08-03; since
then **22 commits touched the protocol tree**, including Batch 1 (`0316e2af`)
and Batch 2 (`951f1a4d`, which renamed the fleet to `publicName` and merged
tools), plus the morpho, pools and dexscreener work. 24 metrics moved, and the
movement is mixed rather than uniformly down - overall recall@5 0.667 -> 0.75
and market_research recall@1 0.5 -> 0.75 improved, while bridge regressed
(recall@1 0.667 -> 0.333, coverage@5 1 -> 0.667). That is what a rename-and-merge
wave does to lexical scoring, and it is **already merged into main**.

**Neither delta belongs to Batch 3.** Batch 3 had made no change to any
description, embedding text or navigation entry at the moment of recapture.

## 2. Commands, verbatim, and their results

```
$ git rev-parse HEAD
ea5dea2af71414cba6a492e4eba7c4565266d00f

$ pnpm test:eval:lexical
  -> exit 1. Canonical: identity drift + 105 metrics moved.
     Supplemental: 24 metrics moved.
     "Lexical baseline gate FAILED. No file was written."

$ pnpm test:eval:lexical:update
  -> exit 0. Both baselines UPDATED.

$ pnpm test:eval:lexical
  -> exit 0.
     "lexical / canonical seed dataset
      Baseline check PASSED - measured metrics are identical to
      src/__tests__/eval/baselines/lexical.json."
     "lexical / supplemental Pendle+Relay+Virtuals coverage
      Baseline check PASSED - measured metrics are identical to
      src/__tests__/eval/baselines/lexical-supplemental.json."
```

The update writes its own reconciliation note into the baseline metadata, so
the file explains itself to the next reader without this document:

> Previous baseline was captured against dataset v3-agent-200 (200 cases) on
> 2026-04-29T20:54:25.325Z; the canonical dataset is now v3-agent-116 (116
> cases). The baseline was STALE - it was never recaptured after the dataset
> changed - so this update re-anchors it against the current dataset. The
> dataset contract and its quality floors were NOT changed.

## 3. The frozen numbers

| Target | Cases | recall@1 | recall@5 | coverage@5 | mrr@5 | groupMrr@5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| canonical seed `v3-agent-116` | 116 | 0.319 | 0.440 | 0.362 | 0.361 | 0.319 |
| supplemental `supplemental-v1` | 12 | 0.417 | 0.750 | 0.750 | 0.510 | 0.524 |

Previous, for the record: canonical 200 cases at recall@5 0.76 / mrr@5 0.557;
supplemental 12 cases at recall@5 0.667 / mrr@5 0.5.

**Do not read the canonical row as a regression against 0.76.** Those two
numbers were computed over different query sets and are not comparable. What
the new row is FOR is comparison against the run Wave 1 produces on the same
116 queries.

## 4. What the frozen numbers say about Batch 3's target

Recall@5 of 0.44 on the canonical set means the right tool is absent from the
top five for more than half of the seed queries. Two scenario rows are worth
naming because they are the batch's own thesis:

- `market_research` is the weakest scenario in the set.
- blind queries (0.382 recall@5) trail protocol-aware ones (0.492), which is
  the measurable form of "the model has to already know the namespace".

This is the lexical lane only. Dense retrieval reads `embeddingText`, not
descriptions, and has its own baseline; a description rewrite that does not also
move embedding text will show up here and nowhere else.

## 5. Second recapture, same session

Wave 0 subsequently corrected the phantom output-cap claims, which touched two
protocol manifest param descriptions (`dexscreener` `limit`, `solana` tool
description). Those strings feed `protocols/lexical-score.ts`, so the gate was
re-run afterwards. **It stayed green with no metric movement** - the edited
words carry no query-matching weight. Recorded so that a later reader does not
have to wonder whether the cap fix moved retrieval: it did not.

## 6. Standing obligation

The gate is only worth having while it is honest. When Wave 1 moves these
numbers:

1. run `pnpm test:eval:lexical` and read the delta as a **signal**, not a
   failure;
2. decide per metric whether the movement is intended;
3. recapture with `--update` and state, in the commit, which change caused it.

Leaving it red is the one unacceptable option, because that is how it reached
this state.
