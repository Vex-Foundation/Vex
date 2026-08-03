# Retrieval eval baselines

Stored metrics for `discover_tools` retrieval quality. A baseline is an anchor:
`--check` proves the numbers have not moved, `--update` records that they did
and why.

## Files

| File | Mode | Dataset | Needs |
|---|---|---|---|
| `lexical.json` | lexical | `datasets/tool-discovery-seed.json` (canonical, 116 queries) | nothing |
| `lexical-supplemental.json` | lexical | `datasets/tool-discovery-supplemental.json` (Pendle/Relay/Virtuals, 12 queries) | nothing |
| `dense.json` | dense | canonical seed dataset | Postgres/pgvector + populated `tool_embeddings` + embedding endpoint |
| `dense-latency.json` | dense | canonical seed dataset | same as `dense.json` (captured by `pnpm test:eval:latency`, outside this tooling) |

The lexical lane is not a legacy curiosity: `dense-score.ts` falls back to
`lexicalScore` whenever embeddings, the DB, or `tool_embeddings` are
unavailable, so `lexical.json` gates the behavior agents get on a bad day —
and it runs with no stack at all.

## Commands

```sh
pnpm test:eval:lexical                            # --check (default), read-only
pnpm test:eval:lexical --update                   # recapture both lexical baselines
pnpm test:eval:lexical --update --target seed     # canonical baseline only
pnpm test:eval:lexical --update --target supplemental

pnpm test:eval:dense                              # --check against dense.json
pnpm test:eval:dense:update                       # recapture dense.json
```

`--check` is the default everywhere. `--check` and `--update` are mutually
exclusive; the dense runner is a vitest test, so it reads the mode from
`VEX_EVAL_BASELINE_MODE` (`check` | `update`) which the scripts above set.

## Guarantees

- **`--check` never writes.** Not the metrics, not `capturedAt`, not a note.
  A failing check leaves the file byte-identical.
- **`--update` is the only writer**, and it records the measured delta against
  the previous baseline plus the dataset id and version in the file's metadata.
- **Comparison has no tolerance.** Both sides are rounded to three decimals by
  the same function; anything that moves is drift.
- **`capturedAt`, `notes` and `reconciliation` are outside the compared
  surface** — provenance, not measurements. That is what makes a check stable.
- **A run that evaluates zero cases FAILS by name.** A dense eval with no
  embedding endpoint used to aggregate to all-zero metrics and report green;
  `assertEvaluatedCaseCount` now refuses both zero and partial runs.
- **A dataset-version mismatch is reported as identity drift**, separately from
  metric drift, because comparing 116 measured cases against a 200-case
  baseline produces noise, not a regression signal.

## Reconciliation status (2026-08-03)

Both `lexical.json` and `dense.json` are **stale**, not regressed. Evidence:

- Both were captured at commit `5afb3674` ("Make discover tools dense-primary",
  2026-04-30) against dataset `v3-agent-200`.
- The dataset shrank to `v3-agent-116` at commit `9e45b086` (2026-07-23), when
  Polymarket, KyberSwap zaps and limit orders were removed. `5afb3674` is an
  ancestor of `9e45b086`.
- Neither baseline was recaptured afterwards, because until now no `--update`
  path existed for lexical at all and the dense runner rewrote its file
  unconditionally rather than reconciling it.

The dataset contract (116 queries, 55/61 awareness split) and the dense quality
floors are unchanged by this reconciliation.

### Reconciling `dense.json`

Requires the embedding endpoint (the app Compose stack). With it up:

```sh
pnpm test:eval:dense:update
```

That single command re-anchors `dense.json` against the current canonical
dataset and writes a `reconciliation` block naming the previous version, the
previous case count, and why the numbers moved. Verify with:

```sh
pnpm test:eval:dense
```

The floors are asserted on the measured metrics in BOTH modes, so an `--update`
cannot record a broken capture as the new truth.

### Reconciling `lexical.json`

Deliberately **not** done here: the description-rename wave (F7) owns the
lexical recapture, and re-anchoring now would be immediately superseded. Run
`pnpm test:eval:lexical --update --target seed` as part of that wave and report
the measured delta the command prints.
