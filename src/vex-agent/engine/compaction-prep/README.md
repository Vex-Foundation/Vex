# compaction-prep

Everything between "context pressure reached the warning band" and "a
`compaction_preparations` row exists carrying an immutable, deterministic,
provider-safe corpus".

This is NOT the legacy archive pipeline. `engine/compact-jobs/` stays isolated
and unchanged — it survives only as the deterministic LLM-free fallback
chunker.

## Public API (`index.ts`)

Corpus (`corpus.ts`) — the frozen preparation input:

- `buildPreparationCorpus` — build from the locked row set.
- `serializePreparationCorpus` — the canonical bytes that get stored as TEXT.
- `fingerprintPreparationCorpus` — sha256 over those bytes.
- `parsePreparationCorpus` — validated read-back of a stored corpus.
- `CORPUS_FORMAT_VERSION`, `PreparationCorpus` and its entry types.

Watermark + supersession (`supersession.ts`):

- `computeWatermarkMessageId` — the MAX id of the locked row set.
- `decideSupersession` + `SUPERSEDE_MIN_NEW_MESSAGES` / `SUPERSEDE_MIN_NEW_BYTES`.

Capture + trigger:

- `capturePreparation` (`capture.ts`) — the ONE writer that creates a
  preparation row, in one transaction under the `sessions` row lock.
- `createPreparationTriggerAction` (`trigger.ts`) — the iteration-boundary
  action that calls capture once pressure reaches the warning band.

## Locking

Capture takes the `sessions` row lock and NOTHING else — never an advisory
lock. The apply path locks `session advisory lock → queued-stop/control rows →
sessions row → preparation row → money rows`; a capture that took the control
lock after the row lock would close a cycle with it.

The TypeScript supersession decision is ADVISORY. `supersedeAndReplace`
re-checks status inside its guarded `UPDATE`, so a concurrent apply request
landing between the decision and the CAS is refused by Postgres, not by an
if-statement.

## Contracts that must not be re-derived

- **The corpus shape has one owner: this module.** Storage keeps the string
  opaque; the branch workers parse it through `parsePreparationCorpus` and
  render an already-parsed corpus. Nobody reconstructs the shape, and nobody
  re-reads the message set from the DB for a preparation that already has a
  corpus — that is what makes every retry deterministic.
- **Stored as TEXT + sha256 + `corpus_format_version`, never JSONB.** JSONB
  re-orders object keys on read and would change the bytes under the
  fingerprint without failing anything.
- **The watermark is `MAX(id)` of the locked rows, not the last sorted row.**
  Rows sort by `created_at, id` and `created_at` is caller-supplied, so those
  two are not the same row.

## Frozen decisions recorded ahead of their build stage

- **No auto-re-preparation on the same base generation.** Once Branch A
  exhausts its 3 attempts, the runtime never automatically prepares that
  session again on the same base `checkpoint_generation`. Eligibility returns
  only after the deterministic fallback bumps the generation.
- **Supersession constants are absolute** (20 messages / 200_000 bytes),
  justified as "a material fraction of a typical prefix" — not derived from a
  token estimate.

## Do not

- Never widen `executeTurn`'s discarded in-memory tape into a corpus source —
  the corpus is built from ID-bearing DB rows.
- Never take the session control advisory lock in the capture path.
- Never add anything from this folder to `compact-jobs/`.
