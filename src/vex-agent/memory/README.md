# Vex Memory

Long-term memory for the Vex autonomous crypto agent: it decides what the agent
durably **remembers** (promotes, supersedes, or rejects the lessons it proposes)
and what it **retrieves** at decision time. Memory is **advisory only** — it never
controls execution, sizing, approvals, or signing.

## Pipeline (write → curate → recall)

1. **Write door** (`tools/internal/long-memory/`) — the agent proposes a memory via
   `long_memory_suggest`. Untrusted input is validated, **secrets / live-state are
   redacted**, English-by-contract + content-hash dedup; survivors land as pending
   candidates with a consolidation job.
2. **Deterministic stage** (`manager/deterministic-stage.ts`, D1–D11) — cheap,
   fail-closed rules (live-state / exact-dup / near-dup / mundane / low-confidence /
   TTL terminals + a recurrence gate). Only survivors **escalate** to the judge.
3. **LLM judge** (`manager/judge.ts` + `judge-prompt.ts`) — scores a five-axis rubric
   (grounding, durability, novelty, generalizability, processNotOutcome) and returns
   ONE verdict: `promote | supersede | retain | reject | expire`. **Fail-closed** — a
   broken/invalid verdict promotes nothing.
4. **Promote / supersede** (`manager/consolidate.ts`, `manager/promote.ts`) — atomic
   insert into `knowledge_entries`; the source tier is hard-capped by the deterministic
   evidence ceiling; a supersede retires its predecessor in the same transaction.
5. **Dual-trace retrieval** (`knowledge/recall.ts`, `long-memory-retrieval-policy.ts`)
   — confirmed knowledge + inferred candidates are embedded (Gemma) and blended; a
   confirmed lesson always outranks an unconfirmed candidate at equal similarity.
6. **Maturity / decay / regime** (`manager/maturity*.ts`,
   `engine/memory-manager/decay-sweep.ts`) — activation decays over time with
   regime-aware half-lives; stale lessons fade out of hot context (never deleted).
7. **Reconcile — RETIRED** (Agent Scan Phase 1): `engine/memory-manager/reconcile.ts`,
   `memory/ledger-wake.ts`, and `manager/{outcome-resolver,reconcile-policy,reconcile-judge}.ts`
   are deleted along with the profit-computation system they graded lessons against. A
   trade-family candidate no longer gets a later closing-trade re-resolution; it carries a
   neutral placeholder outcome (`status:"open", lessonSignal:"neutral", pnlSource:"none"`)
   from consolidation onward — never a believed-win/real-loss flip. A later phase will inject
   the session's own transaction list into the judge directly instead of re-deriving PnL
   facts from a ledger. Historical reconcile decisions and maturity events remain readable.
8. **Knowledge graph** (`manager/entity-extraction.ts`, `db/repos/memory-edges`) —
   bi-temporal entities/edges; superseding a lesson retracts its edges
   (invalidate ≠ delete, audit history preserved).

## Boundaries

- The untrusted renderer **never** imports this subsystem.
- Secrets are redacted at the door (defense-in-depth: again at promote).
- Every decision is fail-closed and audited; no judge claim or fresh candidate can
  outrank human-confirmed knowledge.

## Tests

Two live integration suites (real judge + real Gemma embeddings + Postgres) under
`src/__tests__/integration/eval/`:

- **Correctness eval** (`e2e-memory-correctness.int.test.ts`) — 122 realistic
  Solana/perp memories over a simulated 90 days; structural invariants (decay, supersede,
  redaction, retrieval) as hard gates vs an independent oracle. The "reconcile" invariant
  this suite used to gate on is retired doctrine (see pipeline step 7 above): the K
  category (4 items) and the S7 PF03/PF04/LQ03/LQ04 reconcile-flip mirrors are REMOVED
  from the corpus (not replaced, per owner ruling — outcome-driven reconciliation no
  longer exists), along with their dedicated ledger instruments, closing TradeEvents,
  and oracle/scorer references (`ExpectedReconcile`, `scoreReconcile`,
  `reconcileCauseCode`). The private fixtures `_sim-runner.ts`/`_world-corpus.ts`/
  `_oracle.ts`/`_sim-scorer.ts` now drive + score a pure consolidate/graph/decay/
  retrieval pipeline and compile cleanly.
- **Judge benchmark** (`judge-benchmark.int.test.ts`) — decision quality of the judge
  on 134 always-escalating memories vs an independent oracle (false-promote rate,
  supersede recall, tier/grounding calibration, rubric-axis localization).

Design + hardening notes live in `memory-system/`.
