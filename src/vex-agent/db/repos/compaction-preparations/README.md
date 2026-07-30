# `compaction-preparations`

Durable state for compaction v2: the `compaction_preparations` outbox FSM
(migration `058_compaction_preparations.sql`), its two independent branch leases,
and the Branch-B frozen-output snapshot.

## Purpose

At the context-pressure warning band the runtime forks two background branches
off one frozen conversation prefix, then offers a single **apply** action that
performs the context cutover. This module owns everything durable about that:
the row, the leases, every state transition, crash recovery and retention. It
owns **no** behaviour — no inference, no prompts, no corpus construction, no
`session_memories` writes, no engine wiring, no IPC. Those belong to the engine
packages that call in here.

## Row FSM

```
preparing ──► summary_ready ──► apply_requested ──► applying ──► applied
    │               │                   ▲              │
    │               │                   └──────────────┘   (defer / pre-commit crash)
    ├──► failed ◄───┤                   │
    │               │                   └──► failed        (generation conflict)
    └──► superseded ┘
```

Two independent branch machines run alongside it:

- **Branch A — summary** (`summary_*`): `pending → running → succeeded | failed →
  permanently_failed`. Success is what makes the preparation *ready*.
- **Branch B — chunks** (`chunks_*`): `pending → running → frozen → succeeded`,
  with `failed`/`permanently_failed` on the LLM phase only. Never blocking.

## Public API

Import from `index.ts`; nothing else in the folder is public.

| Area | Functions |
| --- | --- |
| Fork | `createPreparation`, `supersedeAndReplace` |
| Branch leases | `claimBranch`, `claimFrozenChunksTail`, `branchHeartbeat`, `casBranchFailed`, `casFrozenTailFailed`, `recoverStaleBranch` |
| Branch outcomes | `casSummaryReady`, `casFreezeChunksOutput`, `casChunksApplied`, `casMarkFailed` |
| Apply | `casRequestApply`, `casBeginApply`, `applyHeartbeat`, `casMarkApplied`, `casDeferApply`, `casFailApply`, `recordMoneyGateBypassReasons` |
| Recovery | `recoverStuckApplying` |
| Pressure | `getLivePreparationPressureState` — the storage side of the per-turn read, mapped onto the engine's four-variant `PreparationPressureState` |
| Reads | `getPreparationById`, `getLivePreparationForSession`, `listPreparationsForSession`, `getFrozenChunksOutput` |
| Determinism | `assertCorpusFingerprint` |
| Constants | `policy.ts` — lease/attempt/stale/backoff/length bounds |

## Key contracts

**The corpus is write-once.** `corpus_text` + `corpus_sha256` +
`corpus_format_version` are written at fork time and never touched again. It is
`TEXT`, not `JSONB`, because JSONB reorders object keys on read and would break
the fingerprint that proves every branch and every retry read the same bytes.

**Two independent leases, never one.** Branch A and branch B share a row and
nothing else. Branch A stops when the row terminalizes; branch B does not — a
late chunk landing on a `superseded` or `applied` preparation is valid active
memory, and `chunks_landed_after_supersession` records when that happened.

**The frozen tail is insert-only.** `casFreezeChunksOutput` persists the complete
insert-ready snapshot — including the server-generated outstanding-item ids and
timestamps, the pinned `body_md` schema version, and `themeSource` — before a
single memory row is written. `themeSource` is carried rather than re-derived
because a fallback theme validates by construction: asking "did this theme
validate?" at insert time answers `chunker` for every fallback ever built, so
the label is recorded at the only point where the choice is actually made. From then on branch B is claimed through `claimFrozenChunksTail`,
which preserves `frozen`, cannot be stolen from a live lease, and never
increments the attempt counter. "Attempt 3 → freeze → crash" stays retryable.

**Apply is two-phase and durable.** Tx A commits `applying` (so a crash is
detectable); Tx B commits `applied` together with the generation bump, under the
caller's client. A pre-cutover exit returns to `apply_requested`, never to
`summary_ready`. `recoverStuckApplying` decides which side of the COMMIT a crash
fell on by comparing `sessions.checkpoint_generation` to
`target_checkpoint_generation` — and by nothing else.

**Chunk accounting spans the freeze barrier**, and each counter names its phase.
`chunks_rejected_by_exclusion_at_freeze` / `..._by_redaction_at_freeze` count what
Branch B discarded while *building* the snapshot (the successor of
`compact_jobs.chunks_rejected_by_*`, and the answer to "why did this compaction
produce so few memories?"); `chunks_inserted` / `chunks_deduped` are the *insert*
outcome. Nothing is rejected at insert — the snapshot was already validated and
redacted — so a chunk that does not become a new row was collapsed by the
`(session_id, content_hash)` active-row upsert. Reading one phase's counter as
the other's misattributes where the memories went.

**Retention prunes at whichever crossing comes second** (`retention.ts`, private
— it is only ever called from inside a terminal transition's own transaction). The corpus is dropped
once the row *and* branch B are both terminal, atomically with the transition
that completed the pair.

## Operational notes for the workers

**A claim collision between the two branches is a SKIP, not a conflict.**
`SELECT ... FOR UPDATE SKIP LOCKED` takes a ROW lock, not a column-set lock, so
two claims for *different* branches of the same row landing in the same instant
do not both succeed — the loser skips and returns `null`. The claim transaction
is two statements of pure DB work, so the window is tiny and the skipped branch
takes the row on its next poll while the other branch is still running. Nothing
is lost and nothing is double-claimed. Worth knowing when choosing poll
intervals: identical, perfectly-synchronised intervals for the two branch
workers maximise collisions, so give them different periods or a small jitter.

**A frozen row that can never insert holds its corpus indefinitely.** Retention
requires branch B to be terminal, and the frozen tail retries forever by design
(that is what makes a post-freeze crash safe). So a snapshot whose insert fails
permanently — a persistently unreachable embedding endpoint, say — keeps both its
snapshot and the preparation's corpus. This is a monitoring concern, not a schema
change: alert on rows sitting in `chunks_status = 'frozen'` with a rising
`chunks_last_error`, rather than adding a retry budget that would discard work
already paid for.

**The recovery discriminator is a TWO-SIDED invariant.**
`recoverStuckApplying` decides whether a crashed cutover committed by asking
whether `sessions.checkpoint_generation` equals the preparation's frozen
`target_checkpoint_generation`. That is sound only if the cutover bumps the
session to *exactly* that value. If the apply path ever recomputes the next
generation from a re-read, a crashed apply is silently mislabelled as `applied`
and the session loses a compaction it never got. This module asserts its half;
the apply path owes the matching assertion on its side.

## Do not

- Do not add engine imports. `pressure-state.ts` carries the single sanctioned
  one (a type-only import of the pure `PreparationPressureState` seam); nothing
  else in this folder may reach into the engine.
- Do not emit bus events from here. The engine callers emit **after** commit; a
  DB repo importing an engine bus inverts the dependency direction.
- Do not take a session lock inside `createPreparation`/`supersedeAndReplace` —
  the caller already holds `sessions ... FOR UPDATE`, and grabbing the
  preparation row first deadlocks against the apply path's lock order.
- Do not re-declare the lease/attempt/stale/backoff constants in a worker. Import
  them from `policy.ts`; the DB CAS predicates and the column DEFAULTs are
  written against these exact numbers.
- Do not add a renderer-facing projection here. The desktop app reads
  preparations through its own app-scoped query in the main process; an engine
  repo cannot enforce that scoping, so a projection living here would be a
  second, unenforceable read path.
- Do not add a `session_memories` column for any of this. Progress and audit live
  here.
