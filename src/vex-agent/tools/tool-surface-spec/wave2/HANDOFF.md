# Wave 2 - state and continuation

Read this first when picking Wave 2 up cold. The standing program goal and
the order of work (D14) are at the top of ../batch3/HANDOFF.md.

## Where the work is

- Branch feat/prompt-wave2 in the worktree /home/kubas/Vex-wave2, cut from
  feat/tool-surface-3 at 4ef0cfda (Batch 3 closure, PR #108 against main,
  CI green, CLEAN, awaiting the owner's merge word). Rebase onto main after
  #108 merges; the branch is a descendant, so it is trivial.
- Plan: plan-v2-codex-reviewed.md in this directory (section 15 overrides
  the earlier sections it conflicts with). Codex GREEN LIGHT 2026-08-22 on
  thread harness-wave2 after two turns.
- Evidence: recon.md in this directory (measured 2026-08-22).
- Implementation mode chosen by the owner: Codex build on the thread
  harness-wave2 (workspace-write in this worktree, never main; Codex's own
  subagents do the eleven per-namespace analyses; the coordinator reviews
  every deliverable and runs the gates).

## What the wave does, in one paragraph

The 69.5 KB protocols layer (68 percent of the static prefix, an inventory
organized by namespace with doctrine that the injected tool descriptions
already carry) is replaced, inside the SAME static layer and behind the same
four-symbol facade, by eleven typed protocol declarations (a new readonly
`declaration` object on each existing navigation entry: identity, offers,
when it applies, characteristic and limits, chain coverage rendered from
runtime-owned constants, model-visible retrieval terms that must exist in
the frozen embeddingText) and a task-shapes section carrying the
cross-namespace judgment no description carries (research three-layer,
swap and bridge routing with D4 stated once, the yield arbiter, positions
and risk, launches). Every PRESERVE-VERBATIM section stays byte-identical;
every D9-frozen retrieval field stays byte-identical; every removed
doctrine sentence is accounted for in a migration ledger; every wording
test that changes is listed in a migration inventory with its new contract.

## WP0, done by the coordinator (2026-08-22)

- src/__tests__/vex-agent/engine/prompts/promptsnaps.test.ts and
  src/vex-agent/engine/prompts/__promptsnaps__/: the static prefix of all six
  modes under both env fingerprints (JUPITER_API_KEY absent and present;
  TAVILY and RETTIWT removed for the run, the Wave 0 posture), byte-exact,
  14/14 green, determinism asserted by rendering twice. Regenerate once,
  centrally, with UPDATE_PROMPTSNAPS=true when the rebuild lands; the diff
  of these files is the review artifact.
- __promptsnaps__/navigation-retrieval-fields.json: the D9-frozen retrieval
  surface (navigation aliases, facets, discoveryHints, exampleQueries; a
  digest per tool of embeddingText, canonicalSummary, aliases,
  exampleIntents), captured from the PRE-WAVE revision. Its test fails on
  any byte change. It is regenerated only with
  UPDATE_RETRIEVAL_FIELDS_FIXTURE=true and only on an owner ruling that
  unfreezes D9; never from the completed rebuild.
- scripts/check-no-em-dash.mjs excludes __promptsnaps__ as generated
  output.

## Codex build, the gates in order

1. Analysis deliverables first, no prompt source edits: eleven analyst
   reports under wave2/analysis/<namespace>.md, the doctrine migration
   ledger (wave2/doctrine-migration-ledger.md: every sentence of the six
   doctrine sections and of the capsule prose assigned exactly once, with
   the carrying description named for every deletion), and the test
   migration inventory (wave2/test-migration-inventory.md: every prompt-text
   test and assertion in the 26 files with its category, old contract, new
   contract, destination). The coordinator reviews all three before step 2.
2. Rendering: the declaration type and the eleven declarations, the
   task-shapes section, the chain-coverage projection from
   TRENCH_CHAIN_ID, POOLS_CHAIN_ID, SOLANA_SYNTHETIC_CHAIN_ID,
   getKyberChains(), the Khalani pinned projection and Relay's
   BRIDGE_FAMILY; the facade split inside protocols.ts; deletion of the
   capsule renderer, the Examples line, the dotted globs and the ledgered
   doctrine; the two ledger DELETE blocks in tool-model and research; the
   static coupling test (every retrieval term present in an embeddingText
   of its namespace), the facet coverage test, the missing
   response-format test, the ceiling ratchet.
3. Wording pins aligned per the inventory; no edit to any test classified
   invariant (stop condition).
4. Coordinator: regenerate the prompt snapshots once, measure the budget
   per mode (same posture), run every gate, read the whole diff, Codex final
   review on harness-wave2, PR on the owner's word.

## The owner's personality setup (vex-app Personalize)

Asked by the owner on 2026-08-22. The Personalize screen
(vex-app/src/renderer/features/appShell/SidebarProfile.tsx) writes a
UserProfile (vex-app/src/shared/schemas/user-profile.ts, IPC
vex:settings:setUserProfile); the engine renders it in identity.ts:97-151 as
"## User profile (style preferences)": address-as name, work description,
tone preset, style traits, risk appetite (tone only, never authority), the
user's free-form instructions through sanitizeUntrustedBlock, and the
subordination clause last. Wave 2 keeps this block byte-identical and in
place; declarations and task shapes never restate or reference it (plan
section 15 item 13).

## Open items carried into this wave

- O12 (pre-existing em dashes in untouched model-visible prompt copy) is
  naturally resolved for every line the rebuild rewrites; untouched lines
  stay as they are.
- The replay gate (old versus new prompt on the owner's sessions) is
  reinstated the moment sessions are provided.
- Codex's analysts run on Codex's model; the owner's "Opus 5 low" rule
  applies to Claude's subagents.
