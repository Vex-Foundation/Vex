# vex-app docs

Practical references for contributors and QA. Keep these scoped to the desktop
app; release-engineering and release-flow content lives elsewhere (deferred to
the release hardening track).

## Inventory

- [`LOCAL_RUNTIME.md`](./LOCAL_RUNTIME.md) — Supported platforms, per-OS config
  paths, the WSL2 dev gotcha, and the clean-slate reset procedure.
- [`QA_MATRIX.md`](./QA_MATRIX.md) — Manual QA test matrix per OS × feature for
  release-candidate verification.
- [`SCALING.md`](./SCALING.md) — pgvector ANN (HNSW) migration plan for when
  the knowledge-entries table outgrows the brute-force scan budget.

## Related

- vex-app dependency audit + license posture: [`../dependency-audit.md`](../dependency-audit.md).
- Third-party attribution (UI patterns and icon glyphs adapted from
  deepseek-harness, MIT): [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
- Renderer motion / accessibility policy: [`../MOTION-POLICY.md`](../MOTION-POLICY.md).
- Local-only agent guidance (NOT committed — gitignored by repo policy):
  `/AGENTS.md` (repo root) and `.claude/skills/vex-*`. These exist on
  contributor machines as Claude / Codex memory; check with the team or
  re-create from upstream templates if absent.

If a doc here ever drifts from the code, prefer fixing the doc in the same PR
as the underlying change. Stale docs are worse than missing ones.
