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
- Plan: plan-v3-codex-reviewed.md in this directory (sections 10 and 11,
  the v2 and v3 revisions, win over sections 3, 5, 7 and 8 where they
  conflict), Codex thread harness-batch4.
- Implementation mode chosen by the owner: builder subagents (Opus 5,
  effort low) in parallel, three lanes on disjoint files; the coordinator
  reads every diff, regenerates toolsnaps and the lexical baseline once,
  runs the gates, then the Codex final review.

## The three lanes (disjoint files)

1. Vocabulary (O3): conventions.ts, allowlist.ts, protocols/types.ts,
   runtime/param-aliases.ts (the rewrite, called first in
   executeProtocolTool), tool-call-envelope.ts (fingerprint hashes alias
   keys only when declared), _manifest-lint `param-alias` rule,
   khalani/manifest.ts (two `wallet` -> `walletFamily`), morpho
   markets-discover and vaults-discover manifests (`search` -> `query`),
   registry/action-aliases.ts and tools/internal/action-aliases.ts
   (BridgeStatus `address` -> `walletAddress`, `wallet` -> `walletFamily`,
   rewritten before the Zod parse), khalani/bridge-status-mode.ts, the
   readers khalani/handlers/read.ts and morpho/read-params/*,
   parameter-vocabulary.md, tests; plus the Group A descriptions of the
   three tools in those files.
2. Envelope (O4): trench/handlers/images.ts, virtuals/handlers.ts (genesis
   arm), solana-jupiter/handlers/predict.ts (events search arm) and their
   manifests; the twelve remaining Group A descriptions; tests.
3. response_format: src/vex-agent/response-format.ts (repository-neutral
   seam), its nine sites, WalletBalances `truncated` in
   internal/wallet/read.ts and its description in registry/wallet.ts,
   output-envelope.md section 7, tests.

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
  Studio MCP server's code and architecture; the deep-research pass
  (studio-mcp/mcp-landscape-2026.md) and the Explore map
  (studio-mcp/github-mcp-architecture-map.md) landed, with two audit
  corrections and the new open decisions O20-O24 for the MCP phase.
- Plan review turn 3: GREEN LIGHT. Docs baseline committed as d0d44c8a;
  three builders launched in parallel (mode b).
- Lane 3 (response_format, WalletBalances truncated): DONE_WITH_CONCERNS,
  reviewed and accepted. Module at src/vex-agent/response-format.ts (zod
  only); six sites consume it with no default change; twitter retirement
  still before the schema parse (message re-punctuated, facts verbatim);
  WalletBalances `truncated` = trimmed < projected, present as false
  otherwise, `truncationNote` when true; tests 271 in the touched suites.
  Coordinator fixed output-envelope.md line 290 (the preamble said
  "default concise"). Flagged, not acted on: MemoryHistory declares a
  `response_format` its handler never reads (description now says it adds
  nothing; removal needs its own ruling); the prompt layer has a
  same-named file engine/prompts/response-format.ts (unrelated).
- Lane 2 (envelope): DONE_WITH_CONCERNS, reviewed and accepted. Three
  handlers additive only (trench images `truncated`; virtuals genesis
  `returned`/`fetched`/`truncated` plus `hasMore`/`nextPage` only with
  total, page and pageSize all finite from the provider, else
  `continuationNote`; predict events search `returned`/`totalMatched`/
  `truncated`); fifteen descriptions name the emitted fields; the
  dexscreener narratives `offset` param text "No pagination exists." was
  reconciled with the emitted envelope. Coordinator added `filtersApplied:
  {}` to the genesis reply (page_window class requirement R4 had dropped),
  its description clause and a test assertion (40/40 in the two virtuals
  files). Lane 2 exported `SEARCH_MAX_LIMIT` from
  solana-jupiter/predict-params.ts (outside its list, trivial, accepted)
  and replaced three pre-existing em dashes on lines it touched.
- Lane 1 (vocabulary): DONE, reviewed and accepted. 141 keys ratified
  (329 allowlist rows deleted: 325 ratified, 4 renamed), `search` banned
  with replacement `query`; `ProtocolParamAlias` and `aliases` on
  ProtocolParamDef; the rewrite lives in runtime/param-aliases.ts and is
  called first thing in executeProtocolTool on the caller's own object
  (before both coercers, the preview reader, validation, capture and the
  approval enqueue); both spellings refused by name; fingerprint hashes
  sorted alias keys only when declared (alias-free pin
  4e1100eabcbaf452be7826f62a9ad4a6 derived independently); lint rule
  `param-alias`; BridgeStatus rewrites `address`/`wallet` before its Zod
  parse and bridge-status-mode lists the canonical keys; readers follow
  (resolveWalletFamily reads walletFamily; Morpho read-params read
  `query`, translate to the provider's `search`, echo
  `filtersApplied.query`). Side effect worth knowing: BridgeStatus list
  mode used to forward `address`, which khalani.orders.list never
  declared, so list-by-address was rejected; it now forwards
  `walletAddress` and works. Flagged by lane 1 and recorded as O25: the
  Morpho discover handlers emit `nextOffset: null` at the end, while
  parameter-vocabulary 4.1 says present iff hasMore; descriptions state
  the live shape, nothing changed.
- Coordinator: toolsnaps regenerated once (26 contracts: the five
  schema-changing ones read line by line, renamed keys and continuation
  prose correct; the rest description-only). Lexical check BEFORE update:
  seed, dexscreener, virtuals improved (virtuals recall@5 0.647 to 0.765);
  supplemental, kyberswap, morpho, pendle, pools, relay, trench, uniswap
  identical; khalani mrr@5 0.100 to 0.094 (protocol-aware 0.278 to 0.259)
  from the longer orders_list description; solana recall@1 0.441 to 0.426
  (prediction_discovery 0.571 to 0.500, mrr@5 0.571 to 0.536) because the
  five predict descriptions now share continuation vocabulary, recall@5
  unchanged. Both degradations are explained by the description changes
  D16 ordered; dense retrieval (the primary lane, embeddingText frozen by
  D9) is unaffected. The five drifted baselines were updated one target
  at a time; the other eight were left untouched.
- Full gate set on the combined tree: tsc, vitest 1067 files / 14192
  tests, build, diff --check, em-dash and lexical 13/13 green on the
  first run; two red gates fixed by the coordinator and re-run green:
  five non-null assertions in lane 2 and lane 3 test files replaced by
  explicit guards (test:unsafe-escapes), and the GenesisReply test type
  gained `filtersApplied` (typecheck:test:ratchet). Implementation
  committed on feat/tool-surface-4 for the Codex final review.
- Codex final review turn 1 (b427f0b7): BLOCKED on four contract defects,
  all accepted and fixed by the coordinator: the WalletBalances
  truncationNote and description now define truncation against the full
  projected scan, name `detailed` as the only complete recovery and
  promise `limit` only the priced rows it cut (tests assert the text);
  the genesis recovery is phrased from `fetched` and the current page
  (same page, same pageSize, larger limit) and, when the page exceeds
  what `limit` can return, restarts from page 1 with a smaller pageSize
  because page boundaries move with pageSize (page > 1 regression tests);
  the trench images description is conditional (raise `limit` below 50;
  at 50 the rest is unreachable, ask the user); the BridgeStatus schema
  descriptions no longer mention the retired spellings (regression test
  on ACTION_ALIAS_TOOLS). Missing validation added: the approval
  envelope test passes the normalized object through
  buildApprovalToolCall (identity, canonical keys, fingerprint), plus
  pins for `address` with `walletAddress` and for `orderId` with a
  retired list key. Scope note from Codex: the studio-mcp research docs,
  O20-O25, the audit addendum and D19 travel in the same commit; they
  are owner-directed (D18) and no history is rewritten without the
  owner's word, so they stay and are named in the PR body.
