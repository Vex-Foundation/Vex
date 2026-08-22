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

## Progress log

- 2026-08-22, build turn 1 (Codex, analysis only): eleven reports under
  wave2/analysis/, doctrine-migration-ledger.md (485 rows: DUPLICATED with
  the carrying description named, JUDGMENT with one destination, 69
  PRESERVE EXACT rows), test-migration-inventory.md (774 assertion rows,
  609 invariant, 165 wording). Committed as 7d4e94dc after the rebase onto
  main 45b0e2d7 (PR #108 merged).
- Coordinator review of turn 1: declarations rich and neutral; corrections
  sent with turn 2: the inventory omitted
  engine/core/turn-envelope-system-boundaries.test.ts (to be added as
  invariant rows first); the renderer owns layout (plain-string fields, no
  markup, no backticks, no meta "use these words" sentences, the fee only
  in Identity, chain coverage rendered from runtime sources, never typed);
  PRESERVE EXACT rows land verbatim at their ledger destinations even when
  their current section is replaced. The declaration contract (identity,
  read, quote, act, whenItApplies, characteristicAndLimits, retrievalTerms,
  facets, optional coverageNote) is the ProtocolNamespaceDeclaration type
  in src/vex-agent/tools/protocols/navigation/types.ts and is recorded in
  the Codex thread harness-wave2 (the /tmp build prompts were deleted at
  closeout).
- Build turn 2 (Codex, 2026-08-22): 36 files. ProtocolNamespaceDeclaration
  added to navigation/types.ts and all eleven entries; new modules
  protocol-capabilities.ts (renders "## What Vex can reach"),
  task-shapes.ts ("## How Vex works a task": research, swap, bridge, yield,
  positions and risk, launches), chain-coverage.ts rebuilt as a projection
  from runtime sources, bridge-capability.ts split out; protocols.ts keeps
  its four exports; the capsule renderer, Examples, Try, facets, dotted
  globs, the standalone chain table and the ledgered doctrine are gone; the
  two ledger DELETE blocks applied in tool-model.ts and research.ts. The
  layer H1 is now "# Protocols". Two relocations into preserved sections,
  both byte-identical to HEAD text and disclosed: the pools.fun fee-basis
  sentences into identity.ts Vex Fee (plus the list item now naming
  pools.fun launches), and the mission-run bullet's cross-reference to the
  Research task shape. The em-dash gate gained a narrow exemption: an added
  line whose full quoted string exists verbatim in the base revision passes
  (moved PRESERVE EXACT sentences keep their punctuation). Measured:
  protocols layer 69,568 to 26,480 B; static prefix 53.9 to 60.4 KB per mode
  (was 102 to 110). Inventory 847 rows, 672 invariant, 175 wording, no
  invariant edited. Coordinator confirmation: engine 2138 passed with only
  the 12 stale prompt snapshots red, lint and scripts 24/24, toolsnaps
  174/174, lexical 13/13, tsc clean, em-dash green.
- Coordinator review of the rendered layer: accepted in shape; six text
  corrections sent as build turn 3 (the research procedure must not allow
  stopping at discovery in an agent session; Khalani coverage with chain
  names, not bare ids; virtuals and dexscreener coverage without renderer
  talk; thin uniswap and relay read lines; the bridge shape's dangling
  "listed below"; the yield shape's Solana sentence must be env-aware).
- Build turn 3 (Codex, 2026-08-22): 12 files. Research shape: agent
  sessions and active mission runs answer through all three layers
  (identity and discovery, depth and price sanity, narrative and safety),
  only mission setup stops at orientation. Khalani coverage renders names
  with ids from CURATED_BRIDGE_CHAIN_NAMES ("and others" only if a pinned
  id has no curated name). Virtuals coverage renders the manifest's closed
  chain enum; DexScreener renders its coverageNote. Uniswap and Relay read
  lines name the route details. Bridge shape points at "each namespace's
  coverage line above". Yield shape is env-aware (both fingerprints
  snapshotted). Wording rows T290, T321, T732 re-pinned; no invariant row
  touched. Layer 26,278 B; static prefix 53.7 to 60.2 KB per mode; the
  ceilings were lowered to the new measurements.
- Coordinator review of turn 3: accepted. Verified the ledger's carrying
  descriptions for the launch-form pins the trench test dropped (L288-L291
  in trench/manifests/launch.ts: DRAFTS AND ASKS ONLY, turn PARKS, runtime
  resumes, never improvise; pools/manifests/launch.ts: parks the turn).
  One coordinator edit: the stale "HONESTY GATE, FLIPPED" comment in
  trench-launch-prompt-package.test.ts described pins that no longer
  exist; replaced with a comment naming the carrying description and the
  ledger rows. Judgment recorded: the research shape no longer carries an
  explicit "resolve a name or symbol to an exact chain and contract
  address before treating it as a token" sentence; the rule is carried by
  the dexscreener, solana, uniswap, trench and pools declarations, the
  swap shape and the research Report line, so it was not re-added (adding
  it would also raise every ceiling). Snapshots regenerated once,
  centrally (12 files, 2002 insertions, 3634 deletions); the diff outside
  the Protocols layer is exactly the disclosed set: identity fee item and
  the two relocated fee sentences, the tool-model heading reference and
  the schema-reading DELETE block, the bridge shortcut row without dotted
  globs, the research Token Research Map DELETE block, the mission-run
  cross-reference.
- Full gate run after turn 3 (coordinator): the whole vitest suite found
  four files OUTSIDE the 26-file inventory scan still pinning the old
  layer text, and two navigation fixtures without the new required
  `declaration` field (ratchet red). Classified and repaired by the
  coordinator, recorded as inventory rows T848-T865 (3 invariant, 15
  wording): openrouter-cache-e2e marker `# Protocols`;
  chain-read-erc20-balance-surface kept its invariant and the PROMPT was
  fixed instead (the Bridge shape again names `WalletBalances` and
  `ChainRead` with action `erc20_balance` for Robinhood reads, ledger
  L015, +66 B per mode, ceilings raised to the new measurements:
  53,795 / 54,496 / 60,218 / 60,237 / 58,834 / 58,649 B);
  dexscreener-source-policy test 1 re-pinned on the dexscreener
  declaration and the research shape, with a new negative pin that the
  declaration teaches no dotted id and no publicName; the Morpho
  capability-consistency guard now scans the typed declaration and the
  `### morpho`, `### Yield` and `### Positions and risk` surfaces instead
  of the retired doctrine slice; fixtures in metadata-compile and
  manifest-lint gained a declaration. Snapshots regenerated again.
- Committed as d5312b4d on feat/prompt-wave2 (pushed). Codex final review
  turn 1 (harness-wave2): BLOCKED on one item, everything else clean (layer
  neutral, D4 only in Swap and Bridge, research requires all three layers
  outside mission setup, coverage lines trace to runtime sources, Morpho
  guard surfaces sufficient, DexScreener negative tool-name pin
  appropriate, no invariant row edited including the addendum, D9
  unchanged, no research sentence to restore). The blocker: the em-dash
  exemption `movedVerbatimContent()` accepted any quoted string with an em
  dash that occurs anywhere in the base tree. Fixed by the coordinator: a
  closed allowlist `RELOCATED_VERBATIM_SENTENCES` keyed by destination path
  and exact sentence (bridge-capability.ts L024, L025; task-shapes.ts L039,
  L368, L294), exempt only when the base still carries the sentence
  verbatim and no other em dash shares the line; the gate's test gained
  four cases (fails before the base carries it, passes at the destination,
  fails in any other file, fails with a second em dash on the line). The
  list only ever shrinks (O12).
- Fix-up committed as b4e251f2 (pushed). Codex final review turn 2:
  GREEN LIGHT, no remaining blockers or discussion points; the five
  allowlist entries verified against their destination files, the base
  sentences and ledger rows L024, L025, L039, L368, L294. Final gate set on
  b4e251f2: tsc, vitest 1063 files / 14130 tests, build, unsafe-escapes,
  ratchet, diff --check, em-dash, all green. Wave 2 is complete on the
  branch; the PR waits for the owner's word, then D14 continues with
  Batch 4 (O3-O5), the Studio MCP server, and the live-test phase last.
- Owner follow-up on the rendered Research shape (2026-08-22, recorded as
  D19 on the Batch 4 branch): DexScreener is the primary research surface
  on every chain; WebResearch and TwitterAccount add news and social
  evidence (each named only when its key is configured; RETTIWT_API_KEY
  joined the protocols-layer availability fingerprint); on Solana,
  Jupiter's `solana__tokens_discover` feeds add fresh discovery (with
  JUPITER_API_KEY); Trench, pools.fun and Virtuals are launchpad-native
  reads of lower general value, reached for only when the token lives
  there or the user names it. Implemented in task-shapes.ts and
  protocol-capabilities.ts; snapshots regenerated (24 lines across the 12
  files); ceilings raised by 340 B per mode (54,135 / 54,836 / 60,558 /
  60,577 / 59,174 / 58,989 B). Committed as 913b9405.
- WITHDRAWN the same day by the owner ("niech widzi protokoły i sam sobie
  wybierze"): no ranking of research tools in the prompt; the model sees
  the protocol declarations and chooses. task-shapes.ts,
  protocol-capabilities.ts, the ceiling test and the 12 snapshots are
  restored to their 76f6306d content (the Codex-approved Research shape:
  the three-layer procedure, the mission-setup exception and the neutral
  freshness-lag note stay). D19 on the Batch 4 branch records the
  withdrawal. RETTIWT_API_KEY therefore left the availability fingerprint
  again.

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
