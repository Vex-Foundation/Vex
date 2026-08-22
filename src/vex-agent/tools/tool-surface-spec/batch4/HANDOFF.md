# Batch 4 - state and continuation

Read this first when picking Batch 4 up cold. The program goal and the
order of work (D14) are at the top of ../batch3/HANDOFF.md; Wave 2 closed
on feat/prompt-wave2 (PR #109, ../wave2/HANDOFF.md).

## Where the work is

- Branch feat/tool-surface-4 in the worktree /home/kubas/Vex-batch4, cut
  from feat/prompt-wave2 at 76f6306d. Rebase onto main after #109 merges.
- Rulings: owner-decisions.md D15 (O3), D16 (O4), D17 (response_format),
  recorded 2026-08-22 from the owner's answers to the Batch 4 brief.
  OPEN-DECISIONS.md: O3 removed, O4 narrowed (summary sweep and the five
  extra-fetch handlers), O5 deferred to the Studio MCP design.
- Evidence: recon.md in this directory (three Explore reports, measured
  2026-08-22, static evidence only).
- Plan: /tmp/harness-batch4-plan.md during the arc (archived here as
  plan-v1-codex-reviewed.md once Codex approves), Codex thread
  harness-batch4.
- Implementation mode chosen by the owner: builder subagents (Opus 5,
  effort low) in parallel, three lanes on disjoint files; the coordinator
  reads every diff, regenerates toolsnaps and the lexical baseline once,
  runs the gates, then the Codex final review.

## The three lanes (disjoint files)

1. Vocabulary (O3): conventions.ts, allowlist.ts, protocols/types.ts,
   runtime/params.ts (alias rewrite at step 0), registry/khalani.ts
   (schema never emits an alias), tool-call-envelope.ts (fingerprint
   includes aliases), _manifest-lint rule, khalani/manifest.ts (two
   `wallet` -> `walletFamily`), morpho markets-discover and
   vaults-discover manifests (`search` -> `query`), registry/action-aliases.ts
   BridgeStatus (`address` -> `walletAddress`, `wallet` -> `walletFamily`)
   and its args mapper, parameter-vocabulary.md, tests; plus the Group A
   descriptions of the three tools in those files.
2. Envelope (O4): trench/handlers/images.ts, virtuals/handlers.ts (genesis
   arm), solana-jupiter/handlers/predict.ts (events search arm) and their
   manifests; the twelve remaining Group A descriptions; tests.
3. response_format: new internal/response-format.ts, its nine sites,
   WalletBalances `truncated` in internal/wallet/read.ts and its
   description in registry/wallet.ts, output-envelope.md 7.3, tests.

## Task 0b

Closed until the AgentScan server change (BerzanTas/vex-agentscan
feat/transfer-kind, 1a1397f) is merged into `dev` and deployed. Measured
2026-08-22: no pull request exists, the branch is not in `dev`. The
Vex-side switch is recorded in recon.md (two SQL lists plus a readiness
arm and its row-predicate mirror). Nothing to implement in this batch.

## Progress log

- 2026-08-22: recon written; rulings D15-D17 recorded; plan v1 sent to
  Codex for plan review (thread harness-batch4).
- Plan review turn 1: BLOCKED, six blockers, all accepted on evidence
  (the "aha": approval enqueue reads the ORIGINAL ParsedToolCall.arguments,
  turn-loop-tool-batch.ts:260 and approval-stop.ts:125; the Morpho
  read-params and khalani resolveWalletFamily still read the retired
  keys; default Genesis pagination slices 80 of 100 fetched rows). Plan
  v2 (section 10): alias seam at the earliest runtime boundary on the
  original arguments object; lane 1 owns the reader files, the
  BridgeStatus pre-safeParse helper and bridge-status-mode.ts;
  fingerprint includes aliases only when present (sorted keys,
  removeAfter not hashed); Genesis emits `returned`, `fetched`,
  `truncated` and only emits `hasMore`/`nextPage` with provider metadata;
  lexical recapture only after a check-and-explain pass; WalletBalances
  `truncated` = trimmed < projected, present as false otherwise; aliases
  must be BANNED_PARAM_KEYS members.
- Plan review turn 2: DISCUSS, two precision points accepted (plan
  section 11): sufficient Genesis metadata = total, page, pageSize all
  finite non-null, with null, all-null and partial cases omitting
  hasMore/nextPage and emitting continuationNote; the shared
  response_format module lives at src/vex-agent/response-format.ts (no
  `check:boundaries` script exists; evidence is import inspection, tsc,
  build, tests). Turn 3 dispatched for the verdict (convergence cap).
- D18 recorded the same day: github-mcp-server is the reference for the
  Studio MCP server's code and architecture; a deep-research pass on the
  2026 MCP landscape and an Explore map of github-mcp-server are running
  and land under tool-surface-spec/studio-mcp/.
