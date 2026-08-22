# Batch 3 closure plan (v3, delta over the v2 plan at /tmp/harness-batch3-plan.md)

Written 2026-08-22. Repository: /home/kubas/Vex-batch3, branch feat/tool-surface-3
cut from origin/main ea5dea2a (Task 0, Batch 1, Batch 2 merged). About 350
files uncommitted. Nothing committed, nothing pushed.

## 0. Status delta since the v2 GREEN LIGHT

Measured from the tree today, not quoted from the plan:

- Wave 0: DONE. Seven artifacts under
  src/vex-agent/tools/tool-surface-spec/batch3/ (inventory, lexical baseline
  recapture, prompt ledger, prompt budget baseline, phantom-cap fix and lint).
- Wave 1 descriptions: DONE. 166 surfaces reviewed, 127 edited under D8.
  manifest-lint allowlist 616 to 454 with tool-description emptied; internal
  description allowlist 33 to 0. manifest-lint suite 17/17 green.
- Wave 1 dotted-toolId sweep: the earlier "317 remaining" (and the handoff's
  "343") were WRONG measurements. Those greps counted bare dotted literals
  that are durable identity (pointer(...) args, navigation toolPrefixes,
  mutation-matrix rows, prequote registry keys: 879 such literals, all
  correct as dotted) plus code comments. A prose-aware scan (string literals
  containing whitespace and a live-namespace dotted token, excluding
  embeddings/**, _manifest-lint/**, tests, the pools.fun and dexscreener.com
  brands) finds FOUR model-facing items plus ONE advisory. Listed in WP1.
- The dotted-toolid lint (_manifest-lint/dotted-toolid-rules.ts) landed and
  is green at zero with no allowlist, but it reads ONLY manifest description
  and param descriptions (lines 130-133). Navigation prose and src/tools/**
  runtime strings are outside its reach, which is exactly where the four
  items live.
- Contract snapshots: RED, 81 of 174 failing when run without
  UPDATE_TOOLSNAPS. Sampled diffs are all Wave 1 text (dotted to publicName,
  description edits). The set is half-regenerated because builders ran the
  global regen mid-wave. One central regen is owed (WP4).
- tsc --noEmit: clean. All 161 protocol test files: green.
- Owner rulings recorded today in owner-decisions.md: D11 (overlap pairs
  ranking together is the desired outcome; default ToolSearch path is dense
  over the frozen embeddingText, lexical is the fallback only, so the lexical
  eval is a fallback regression guard not a ranking target) and D12
  (solana.predict.pnlHistory stays; the seven descriptions above 2048 bytes
  are ratified; AgentScan feat/transfer-kind pushed, transfer egress stays
  closed until that server change is deployed).
- AgentScan: feat/transfer-kind committed (1a1397f) and pushed after lint,
  1234 unit tests and the 34-test integration file passed locally.

## 1. Task and latest user constraints (2026-08-22)

- Finish Batch 3 in /harness with Codex.
- github-mcp-server (agents-colab/github-mcp-server) stays the quality model
  for the future Studio MCP server AND for how the current runtime presents
  tools. Builders read github-mcp code; Explore agents do reconnaissance.
- After most of the work lands: Opus 5 low test agents (always Opus 5 low),
  one per protocol, test retrieval: read the protocol's tools, write the
  queries a model would write, check whether the intended tool appears in
  ToolSearch results / top 5.
- Rulings: pnlHistory stays; the 7 over-2KB descriptions stand; AgentScan
  push approved (done); the mission-contract sanitization gap: owner asked
  for my assessment ("if not worth it, fine"); the Morpho bug: owner asked
  what it is.
- Standing constraints: D1 to D13; no em dashes in authored content; no AI
  attribution anywhere; no commit, push, merge without an explicit ask; tool
  behavior, parameters and agentscan writes unchanged ("nie zmieniaj logiki
  dzialania tooli"); embeddingText, aliases, example intents frozen (D9);
  no truncate/slice of prompt content.
- OWNER REFRAME (2026-08-22, later the same day): the goal of this whole
  program is tool READINESS for the Studio local MCP server described in
  /home/kubas/Vex/vex-studio.plan.md (naming, descriptions, schemas,
  metadata, presentation) plus the runtime prompt. The tools worked and were
  tested before this program; NOTHING in this plan may change how a tool
  behaves (handler logic, parameter semantics, approvals, agentscan writes).
  Consequences: WP1 is text and lint only; WP2 is limited to the rendered
  nextStep SENTENCE (two table rows plus a type; the quote's computation,
  gating and persistence are untouched, and the test asserts the sentence
  only); WP3 touches the prompt stack, not tools; WP5 is read-only
  measurement. When unsure, the coordinator dispatches Explore or asks Codex
  rather than deciding without context. An MCP-readiness audit (Explore) is
  running in parallel to turn "fit for MCP" into a measured checklist.

## 2. Rules loaded and their consequences here

.claude/CLAUDE.md and all ten .claude/rules/*.md (00 priority, 01 senior
method, 02 git, 03 architecture, 04 types/errors, 05 async/observability,
06 testing, 07 security, 08 frontend, 09 AI/tools/approvals, 90 product
delta).

- 00 hard stops: WP3 changes security posture (a sanitization boundary) and
  therefore needs explicit owner direction. It is asked in the user brief;
  the builder is not dispatched on it without a yes.
- 04 contract artifacts: toolsnaps are reviewed contract artifacts. One
  central regeneration, the diff read as a contract diff (text only, no
  schema shape or enum order change).
- 06 test selection by risk: the Morpho map is a lookup table, so a table
  test over all six directions that goes red when the fix is reverted; the
  sanitization change gets a byte-stability parity test (cache invariant)
  plus forgery tests through the real prompt builder.
- 07 secrets: the dense lane needs no credential (loopback llama.cpp sidecar,
  no Authorization header). The Postgres password is read from
  ~/.config/vex/local-infra/secrets/pg_password into VEX_DB_URL in the
  shell only, never written to a file or a report.
- 90 money path: the two Morpho validation errors in src/tools/morpho/
  request/shared.ts fan out to every Morpho tool error including mutations;
  the edit is text only and the text stays a sanitized domain outcome.
- CLAUDE.md: subagents are Opus 5 effort low. Builders get github-mcp
  reference paths in their briefs.

## 3. Repo context inspected (evidence)

Three Explore reports plus my own verification:

Sweep and lint:
- _manifest-lint/dotted-toolid-rules.ts:76-86 (regex built from live
  namespaces), :68 (NON_TOOL_TOKENS pools.fun, dexscreener.com), :130-133
  (only description and param descriptions), :147-155 (two message modes:
  live tool gives the publicName; unknown token refuses to invent one).
  Wired in src/__tests__/vex-agent/tools/protocols/manifest-lint.test.ts:113-122,
  asserted at :181-187 (zero issues, empty allowlist).
- Remaining prose items resolved against the live catalog by me:
  - protocols/navigation/entries-market/morpho.ts:49 preferInstead says
    "Use `solana.lend` for lending on Solana". Live Solana lend publicNames:
    solana__lend_earn_rates_list, solana__lend_earn_deposit,
    solana__lend_earn_withdraw, solana__lend_earn_positions_list,
    solana__lend_borrow_vaults_list, solana__lend_borrow_operate,
    solana__lend_borrow_positions_list.
  - src/tools/morpho/request/shared.ts:36 "read one from
    `morpho.vaults.discover`" and :95 "`morpho.markets.discover`". Live:
    morpho__vaults_discover, morpho__markets_discover.
  - src/tools/pendle/read/errors.ts:67 "Re-check it with `pendle.yields`".
    pendle.yields IS live (handlers/read.ts:19) and its publicName is
    pendle__markets_discover.
  - Advisory: protocols/trench/handlers/launch/execute-user-submit.ts:76
    ENTRY_ID = "trench.launch (user submit)" is prefixed onto model-visible
    failure strings (lines 129-190, 316, 324). trench.launch is not a live
    toolId shape; it reads as provenance but the model cannot tell.
- navigation/types.ts:23 preferInstead?: string (free-text nav prose,
  unguarded by the lint).
- src/__tests__/eval/lexical-retrieval.ts:38-42 claims the uniswap namespace
  is not advertised. FALSE on this branch: every namespace entry under
  navigation/entries-market/*.ts has advertised: true, uniswap at
  uniswap.ts:19, and catalog.ts:65-66 derives the advertised allowlist from
  that flag. The comment predates the Batch 2 reveal teardown (D4).
- src/vex-agent/engine/prompts/**: zero model-facing dotted hits (the one
  match, tool-model.ts:17, is an architectural comment about the projection
  and is correct).

Snapshots:
- Owner test src/__tests__/vex-agent/tools/toolsnaps.test.ts; env
  UPDATE_TOOLSNAPS === "true" (line 54); dir src/vex-agent/tools/__toolsnaps__
  (168 files). Regen command (from the test header):
  UPDATE_TOOLSNAPS=true pnpm exec vitest run src/__tests__/vex-agent/tools/toolsnaps.test.ts
- Without the env var: 81 failed / 93 passed of 174. By namespace: pendle 26,
  morpho 19, dexscreener 11, solana 10, pools 6, trench 4, kyberswap 2,
  uniswap 2, relay 1. Sampled failures are text only.

Morpho market-quote (item A, CONFIRMED):
- Six-value union MorphoMarketDirection at morpho/read-params/
  market-operations.ts:61-76; manifest enum matches at manifests/
  market-quote.ts:67; parser accepts all six (:339-352).
- handlers/market-quote.ts:50-56 EXECUTE_FOR typed Readonly<Record<string,
  string>> with four rows (supplyCollateral, withdrawCollateral, borrow,
  repay). supply and withdraw absent.
- Render site :174-179, the nextStep field, interpolates
  EXECUTE_FOR[q.direction] twice: "This quote AUTHORIZES undefined ...".
- Flow: nextStep is inside output and data (handler-helpers.ts:48-50);
  result.output is persisted verbatim to the transcript
  (turn-loop-tool-batch/prepared-follow-up.ts:247-266, approval-stop.ts:200)
  and replayed every turn. NOT authority-bearing: prequote identity reads
  resultData.direction (prequote/record/morpho-borrow.ts:42-69, safety/
  extract/morpho-borrow.ts:35,95), all six executes are registered
  (prequote/registry.ts:192-206), and the sibling map in
  handlers/market-execute.ts:96-103 is complete and typed over
  MorphoMarketDirection.
- Vex's own routing prose sends the model into the hole:
  handlers/vaults-discover.ts:294 and manifests/vaults-discover.ts:97
  recommend "morpho__market_quote then morpho__market_supply".
- tsc cannot catch it as written (strict on, noUncheckedIndexedAccess off);
  Record<MorphoMarketDirection, string> or satisfies would (TS2739).
- Existing test src/__tests__/vex-agent/tools/protocols/morpho/
  market-quote-handler.test.ts asserts nextStep only for borrow and
  supplyCollateral (:270-291). The sibling gate test
  swap-prequote/morpho-market-gate.test.ts:1-22 states the table-row
  discipline the quote test did not adopt.

Mission contract sanitization (item B, CONFIRMED):
- engine/prompts/mission-run.ts:94-99 pushes runContext.missionPromptContext
  raw, no sanitizer import. It is a STATIC cached layer (prompts/index.ts:
  210-214; the file's own comment at mission-run.ts:100-104) and the static
  prefix is wrapped in the system-block sentinels at
  engine/core/turn-envelope.ts:111. So untrusted text sits inside the
  operator block.
- Origin: engine/mission/run-contract.ts:26 stores draftToPromptContext(
  mission) ASSEMBLED into the persisted contract snapshot (z.string(), no
  content constraint) and :36/:49 read it back verbatim. mapper.ts:176-229
  interpolates title, goal, capitalSource, riskProfile, successCriteria[],
  stopConditions[], allowed lists, deadline, all verbatim. Those fields are
  written by the model's own tool (tools/internal/mission.ts:32-53
  MissionDraftUpdateArgs, bounded by .max(MAX_STRING_LENGTH) only) and are
  user-editable in the UI.
- Every other untrusted string in the stack is sanitized: turn-envelope.ts:
  122, prompts/index.ts:331, identity.ts:144, plan.ts:18,
  memory-section.ts:191-192, resume-packet.ts:95-126, virtuals/projectors.ts:
  72,81. mission-run.ts:97 is the single outlier.
- Sanitizer prompts/sanitize.ts: sanitizeForSystemPrompt (:47) fractures
  the sentinel pattern (:45), fences, pseudo role tags, [INST], im_start
  tokens by inserting U+200B; benign input returns byte-identical.
  sanitizeUntrustedBlock (:93) adds heading demotion ^(#{1,6})(?=\s) and
  thematic-break fracture. The docstring at :70-92 names exactly this class
  of input ("authored OUTSIDE the prompt stack and rendered inside it").
- mapper.ts:180 emits "# Mission: <title>" as an H1 even though the block is
  rendered under "## Mission Contract" (mission-run.ts:96), so the untrusted
  variant would demote the engine's own line unless that line changes.

Missing test (item C, REFUTED as a coverage gap):
- sanitize.ts:39-45 says "system-boundary.test.ts pins that this matches both
  exported constants". No such file exists anywhere, never did (git log
  --diff-filter=D empty; deleted-test-allowlist has no entry). The coverage
  DOES exist under src/__tests__/vex-agent/engine/core/
  turn-envelope-system-boundaries.test.ts:142-148 ("keeps the sanitizer
  pattern and the exported sentinels in sync"), importing the real constants
  and feeding them through the real sanitizer. The fix is one word in the
  comment. Writing a new file would create a duplicate test.

Retrieval (the user's verification ask):
- Dense path: protocols/dense-score.ts needs embedQuery (embeddings/client.ts)
  and searchByVector (db/repos/tool-embeddings.ts); k = full catalog; exact
  cosine scan, no ANN index, deterministic for a fixed generation; NO tiebreak
  column in ORDER BY (tool-embeddings.ts:164, advisory).
- Fallback to lexical on zero hits (:48-60) or any throw (:72-82), logged at
  warn as discovery.dense.failed, never surfaced. Discriminator:
  result.retrieval.method ("catalog" | "dense" | "lexical" | "list") and
  denseFailed. The dispatcher strips embeddingModel/embeddingDim before the
  model sees them (dispatcher/tool-search.ts:117-127), so a test runner must
  call discoverProtocolCapabilities (protocols/discovery.ts:340, re-exported
  at protocols/runtime.ts:44) directly, not handleToolSearch.
- An EXISTING dense eval runner does what the user asked, globally:
  src/__tests__/eval/discovery-dense-baseline.int.ts (calls
  assertToolEmbeddingsReady in beforeAll :73, evaluateDiscoverTools(queries,
  5) :86, asserts every row has method === "dense" and !denseFailed OUTSIDE
  the check/update branch :89-96/:114-120, floors recall5 >= 0.95 overall,
  0.94 blind, 0.98 protocol-aware, mrr5 >= 0.88). Script: pnpm test:eval:dense
  (VEX_REAL_DENSE_EVAL=1, VEX_EVAL_BASELINE_MODE=check, vitest/
  dense-eval.config.ts, fileParallelism false, maxWorkers 1).
- Shared harness src/__tests__/eval/retrieval-eval-harness.ts: row shape
  {query, awareness: blind|protocol-aware, scenario (13-value enum),
  intentShape: single|cross|compare|workflow, expectedToolIds[],
  expectedCoverageGroups[][]}; metrics recall1, recall5, coverage5, mrr5,
  groupMrr5 broken down by awareness/intentShape/scenario; prefix-tolerant
  match; exact-equality baseline compare at 3 decimals; dataset validators
  (blind queries must not leak protocol names; expected ids must be live).
- Datasets: datasets/tool-discovery-seed.json frozen at v3-agent-116 with
  .length(116) (retrieval-eval-harness.ts:44-47, deliberate lockstep) and
  datasets/tool-discovery-supplemental.json (supplemental-v1, 12 rows,
  tolerant schema via supplemental-dataset.ts:38). Targets registered in
  lexical-baseline-cli.ts (supplementalTarget() at :73-86) and in the dense
  runner.
- Coverage by expected-toolId namespace: seed covers khalani 32, solana 39,
  dexscreener 32, kyberswap 22; supplemental covers pendle 6, relay 3,
  virtuals 3. ZERO rows for morpho (19 tools), trench (10), pools (9),
  uniswap (2). 40 of 134 tools unmeasured. (The Explore claim that uniswap is
  unreachable was the stale comment above; it is advertised.)
- baselines/dense.json is STALE: datasetVersion v3-agent-200, count 200,
  against a 116-row dataset. pnpm test:eval:dense will fail on identity
  drift first (baseline/compare.ts:39, :69-80). Pre-existing since commit
  9e45b086 (the same staleness Wave 0 found and recaptured for the lexical
  lane). The schema has a reconciliation field (baseline/schema.ts:54-60)
  for exactly this.
- Orphans: reembed.ts:158-162 calls deleteOrphanedToolEmbeddings AFTER the
  upsert loop; the three Batch 2 retired toolIds still have vectors until
  pnpm tool-reembed runs. searchByVector has no active-id filter, so a
  retired vector can take a top-k slot and be dropped at the candidate join
  (dense-score.ts:39-40), shrinking results below limit. Reembed first.
- Local prerequisites: rendered compose at ~/.config/vex/compose/
  docker-compose.yml with services db (pgvector, 127.0.0.1:27432) and
  embeddings-runtime (llama.cpp server, embeddinggemma-300M-Q8_0,
  127.0.0.1:27134). NEITHER is running now (docker ps shows only an
  unrelated voxni-db). Embedding config is four plain env vars in
  ~/.config/vex/.env (EMBEDDING_BASE_URL/MODEL/DIM/PROVIDER), no key, loaded
  by loadProviderDotenv() (providers/env-resolution.ts:37-42). VEX_DB_URL is
  NOT in that file and is set only by Electron main; outside Electron the
  db client falls back to postgresql://vex:vex@localhost:5777/vex_test
  (db/client.ts:32) with a warning, which makes denseScore throw and degrade
  silently to lexical. It must be exported explicitly:
  VEX_DB_URL="postgresql://vex:<pg_password file>@127.0.0.1:27432/vex".
- Discovery filters by manifest.requiresEnv against process.env
  (discovery.ts:175), so loadProviderDotenv() must run before measuring or
  the catalog silently shrinks.
- No bootstrap needed: PROTOCOL_TOOLS is built eagerly at import
  (catalog.ts:87-99, 174); 134 manifests, all active and advertised.

## 4. Implementation mode

CONFIRMED by the owner (2026-08-22): builder subagents (Opus 5 low) on
DISJOINT file sets, each briefed with the github-mcp reference paths, the
rules, and the explicit prohibitions learned last wave (no shared-file git
operations, no global snapshot regen, no edits under embeddings/**). The
coordinator owns: the probe CLI, infra bring-up, snapshot regeneration,
baselines, gates, Codex.

Owner answers to the brief, all four:
- mode: builders;
- WP3 (mission contract sanitization): YES, in this arc;
- venues: the KyberSwap/Khalani preference stays in prompt prose AND the
  prompt states Uniswap and Relay are available as fallbacks with their
  chain coverage from the catalog (Wave 2 content, recorded as D13);
- Wave 2: one analysis subagent per protocol produces rich protocol
  descriptions for the prompt; no sessions selected for the replay gate, so
  the gate becomes characterization + the WP5 retrieval measurement +
  review, reinstated when sessions arrive (D13). Wave 2 is its own arc
  after this closure PR.

## 5. Work packages

### WP1 Sweep completion and lint reach (Builder 1)

Edits:
1. navigation/entries-market/morpho.ts:49: replace `solana.lend` with the
   namespace, "Use `solana` for lending on Solana." (Codex round 1:
   navigation owns namespace routing, D10/D13 keep per-tool inventory out of
   that projection, and the direct Solana names are hidden when
   JUPITER_API_KEY is absent.)
2. src/tools/morpho/request/shared.ts:36 and :95: morpho__vaults_discover,
   morpho__markets_discover. Text only; the error stays a sanitized domain
   outcome; no new provider detail.
3. src/tools/pendle/read/errors.ts:67: pendle__markets_discover.
4. protocols/trench/handlers/launch/execute-user-submit.ts:76: no manifest
   owns executeUserSubmittedLaunch (its refusal goes to the renderer and is
   later wrapped into the pending trench__launch_request_form result, whose
   tool-call identity already tells the model which tool produced it), so a
   publicName prefix would expose internal machinery to the human and could
   imply the agent called launch_execute. Use a human domain label:
   "Trench launch form submission". Keep any identity use separate (Codex
   round 1).
5. _manifest-lint/dotted-toolid-rules.ts: extend the subject set so
   navigation free-text fields (preferInstead and any other prose string in
   navigation/types.ts) are linted like descriptions; wire the subjects in
   manifest-lint.test.ts from the live PROTOCOL_NAMESPACE_NAVIGATION; the
   rule must still land at zero with no allowlist after edit 1.
6. src/__tests__/eval/lexical-retrieval.ts:38-42: correct the comment (every
   namespace is advertised; the reveal gate was removed in Batch 2 under D4).
7. (from the MCP-readiness audit, 2026-08-22) tool-surface-spec/
   mcp-export-scope.md:18 says "137 toolIds today"; the live catalog is 134.
   Correct the number.
8. (same audit) add one test pinning the 21 exported internal tool names to
   OPENAI_TOOL_NAME_PATTERN (registry/injected-protocol-tools.ts:61), next
   to the existing protocol-name assertion in
   __tests__/vex-agent/tools/registry/injected-protocol-tools.test.ts:60-68.
   All 21 pass today; the test only pins the invariant the MCP export needs.

MCP-readiness audit summary (measured over the 167 snapshots; full report
kept by the coordinator): 155 exported tools (21 internal + 134 protocol);
names 155/155 valid, max 37 chars (47 with an mcp__vex__ prefix); input
schema already plain JSON Schema with nothing to strip; titles MISSING on
all 155 (no per-tool source field exists); annotations derivable from
actionKind except idempotentHint (no field) and openWorldHint; read-only
filter = actionKind read (103 tools) with four contestable cells
(pools__launch_preview, two *_request_form, WalletSendPrepare); tools/list
variance = requiresEnv JUPITER_API_KEY on 34 solana tools (project
statically, typed-unsupported at call time) plus in-app-only mechanisms
(pressure gate, 40-tool session cap) that the export must not apply; 32 of
167 descriptions over 2048 B (31 exported, morpho 18), against the 7 the
owner ratified, reopened as an owner decision in D12; 24 paginated tools
emit no continuation field and 329 non-canonical param keys remain (both
Batch 4, both touch handler return shape or input contract, so both are
owner decisions under the frozen-behavior constraint). Behavior-class items
the export needs a Studio-side equivalent for, NAMED not fixed: prequote
gating blocks about 22 execute tools without a session, the approval round
trip for 47 broadcast tools, wallet scoping promised by 17 descriptions,
durable session writes, and the ToolSearch select-mode working-set write
(D2 says the export is read-only, so the projection must not reach it).

Rules for the builder: publicNames come from the catalog projection, never
hand-invented; if a dotted token resolves to no live tool, stop and report
(the lint's own doctrine); no behavior change; no snapshot regeneration; no
git stash/checkout/restore; do not touch embeddings/** or any manifest
description (Wave 1 owns those and they are done).

github-mcp references for the cross-reference style (bare callable name, "as
returned by X", "use X instead"): pkg/github/issues.go:2247,
pkg/github/pullrequests.go:1829, pkg/github/projects.go:667,
pkg/github/projects_batch.go:636.

### WP2 Morpho market-quote direction map (Builder 1, same lane)

- handlers/market-quote.ts:50-56: type EXECUTE_FOR as
  Readonly<Record<MorphoMarketDirection, string>> (the type is exported from
  read-params and already imported in this lane) and add supply and withdraw.
- Values: nextStep is prose telling the model what to CALL, so the value
  must be the callable publicName derived from the catalog projection for
  morpho.market.<direction>, not a hand-typed string. Builder checks every
  consumer of EXECUTE_FOR and of the sibling map in market-execute.ts:96-103:
  if any consumer uses the value as an identity (comparison, registry key,
  audit field), that consumer keeps the dotted toolId and the prose gets a
  separate projection. Identity and prose are never the same constant.
- Test: in market-quote-handler.test.ts, a table test over
  MORPHO_MARKET_DIRECTIONS asserting for each direction that nextStep names
  the publicName of morpho.market.<direction> and never contains
  "undefined". It must go red when the two rows are removed.

### WP3 Mission contract sanitization and comment fix (Builder 2; owner said YES)

Chosen approach, one owner at the trust boundary (matches how Loaded
Content, identity user instructions and memory are handled):
- engine/prompts/mission-run.ts:97: push
  sanitizeUntrustedBlock(runContext.missionPromptContext) with the import.
- engine/mission/mapper.ts:180: render the engine's own first line as
  "**Mission:** <title>" instead of an H1, because the block already sits
  under "## Mission Contract" and an H1 inside an H2 section was structurally
  wrong anyway. Builder greps every consumer of draftToPromptContext; if a UI
  consumer depends on the H1, stop and report.
- engine/prompts/sanitize.ts:42: comment names
  turn-envelope-system-boundaries.test.ts. No new test file.
- Tests (src/__tests__/vex-agent/engine/prompts/, next to
  mission-state-prompts.test.ts and sanitize-untrusted-block.test.ts):
  1. a goal or success criterion carrying <<<VEX_SYSTEM_BLOCK_END>>>, a
     pseudo role tag, a code fence and a "# heading" line never appears
     intact in the output of the real mission prompt builder;
  2. byte-stability: a benign contract renders byte-identical through the
     render site (the prompt-cache invariant);
  3. a legacy snapshot string that still carries the old "# Mission:" line
     is demoted at the boundary (documents the one-time prefix change for
     runs in flight across the upgrade).
- Consequences stated plainly: benign contracts produce identical bytes, so
  the provider prefix cache is untouched; only runs whose persisted snapshot
  predates this change see one prefix change (the old H1 demoted).

Alternatives considered:
- Base variant sanitizeForSystemPrompt only: byte-stable with no exception,
  but no heading or thematic-break defense, and inconsistent with the
  established untrusted-block pattern for multi-line Markdown input.
- Per-field sanitization inside mapper.ts: preserves the engine heading but
  leaves already-persisted snapshots unsanitized at the boundary and moves
  the sanitization owner away from the boundary every other site uses.

### WP4 Central reconciliation (coordinator)

After WP1 to WP3 return and their diffs are read:
1. UPDATE_TOOLSNAPS=true pnpm exec vitest run src/__tests__/vex-agent/tools/toolsnaps.test.ts
   exactly once.
2. git diff --stat src/vex-agent/tools/__toolsnaps__ and a sampled read of
   every namespace: only description and param-description text may change;
   any schema shape, required-list or enum-order change is a stop.
3. Re-run the toolsnaps test without the env var: must be 174/174.

### WP5 Retrieval verification (the user's ask; Opus 5 low agents per namespace)

Design decisions, grounded in the Explore evidence:
- Extend the existing harness, do not build a second runner. Metrics,
  method recording, baseline compare and dataset validators already exist.
- Retrieval stays GLOBAL (no namespace argument) because the agent's
  ToolSearch query mode almost never sets one; narrowing would measure an
  easier problem than the agent faces.
- Method recording is mandatory: a row counts only when
  retrieval.method === "dense" and !denseFailed. A lexical fallback is a
  failed measurement, never a result.
- Test agents read ONLY the namespace's manifests (publicName, description,
  params) and navigation entry, NOT embeddings/**. Their queries must be
  independent of the indexed embeddingText or the test measures recall of
  the index's own phrasing.

Steps:
1. Coordinator writes a probe CLI src/__tests__/eval/discovery-probe-cli.ts:
   loadProviderDotenv() first; requires VEX_DB_URL (no fallback; reuse the
   _preflight.ts pattern); assertToolEmbeddingsReady(); reads a dataset file
   (tolerant supplemental schema); runs evaluateDiscoverTools(rows, 5);
   prints per row: query, expected, hit rank, top-5 publicNames, method,
   denseFailed; exits non-zero if any row is not dense; closePool() at the
   end. Read-only against the DB.
2. Coordinator brings up infra: docker compose -f ~/.config/vex/compose/
   docker-compose.yml up -d db embeddings-runtime; curl the sidecar health;
   export VEX_DB_URL; pnpm tool-reembed (migrations, 134 vectors, orphan
   purge); pnpm tool-embeddings:health must print OK.
3. Coordinator reconciles the stale dense baseline BEFORE any new work:
   pnpm test:eval:dense to observe the identity drift, then
   pnpm test:eval:dense:update with a reconciliation note (dataset
   v3-agent-200 to v3-agent-116, pre-existing since 9e45b086, same cause as
   the Wave 0 lexical recapture). Metric deltas are recorded, not judged.
4. Test agents, one per namespace (11), concurrency capped at 4 because the
   embedding sidecar is a single llama.cpp process. Each agent: reads its
   manifests; writes at least two queries per tool (one blind, one
   protocol-aware) in the harness row shape with scenario and intentShape
   set honestly; writes ONLY datasets/tool-discovery-<namespace>.json (a new
   file; disjoint per agent); runs the probe CLI on it; reports per tool
   hit@1, hit@5, and for each miss the top-5 that came back instead, plus
   any query the dataset validators rejected. Forbidden: editing manifests,
   embeddings/**, baselines, the seed or supplemental datasets, any
   --update, tool-reembed, any git operation.
5. Builder 3 registers the per-namespace datasets as targets in BOTH lanes
   following the supplementalTarget() pattern (lexical-baseline-cli.ts) and
   the dense runner, so the numbers become durable baselines. Coordinator
   captures the baselines (lexical via the CLI --update, dense via
   test:eval:dense:update) once, after reading the datasets.
6. Misses are FINDINGS for the D9 retrieval benchmark, recorded in
   batch3/retrieval-findings.md with the evidence (query, expected, what
   ranked instead). They are not fixed in this batch: embeddingText is frozen
   and descriptions cannot move the dense ranking (D9, D11). The one
   exception: a miss whose cause is a wrong expectedToolId or a validator
   rejection is a dataset bug and the agent fixes its own row.

### WP6 Gates, Codex final review, PR

- pnpm test; pnpm exec tsc --noEmit; pnpm build; pnpm test:unsafe-escapes;
  pnpm typecheck:test:ratchet; git diff --check HEAD; manifest-lint suite;
  toolsnaps 174/174; pnpm test:eval:lexical (fallback guard; any delta is
  attributable to Wave 1 text against the Wave 0 recapture and is recorded
  with a reconciliation note, not silently updated); pnpm test:eval:dense
  (after step 3 above); pnpm prompt-budget:report compared with
  batch3/prompt-budget-baseline.md (report only; the capability map rebuild
  is Wave 2).
- Codex final review on thread harness-batch3 (up to three turns).
- Commit and PR only when the owner asks.

## 6. Wave 2 (prompt rebuild): its own arc, direction recorded as D13

The owner's direction today (owner-decisions.md D13): a default, declarative
prompt in the spirit of Claude Code's own, no push toward any protocol, with
RICH per-protocol descriptions produced by one analysis subagent per
namespace; the KyberSwap/Khalani preference stays and Uniswap/Relay are named
as fallbacks with catalog-proven chain coverage; richness replaces the
per-tool inventory and duplicated doctrine rather than stacking on them, and
the prompt budget report measures it. The owner did not select sessions, so
the v2 plan's pre-registered replay gate is replaced by characterization +
the WP5 retrieval measurement + review until sessions arrive. Wave 2 starts
after this closure PR. Nothing in WP1 to WP6 pre-empts it.

One tension to keep visible in Wave 2: the protocols section is already
71 KB of a 104 to 110 KB prompt (Wave 0 baseline), and the Morpho doctrine
alone is about 35 dense lines. "Rich" must be paid for by removing what the
injected definitions and ToolSearch already carry, which is what D10 and D13
both say.

Also recorded today, outside this plan's scope: the owner's clarified
truncation rule is now written in .claude/CLAUDE.md (local, gitignored): no
silent cutting of prompt layers, descriptions, tool outputs, transcripts,
approvals or errors; bounds that report their semantics (pagination,
truncated flags with counts, ring buffers, parsing slices) are allowed. An
audit of this program's diffs found zero content cuts added in Batch 3 and
only identifier, prefix and reported-bound slices in the merged batches.

## 7. Assumptions and uncertainties

- The rendered compose file and the GGUF model are present on this machine
  (the Explore agent saw the file; the model download is a one-shot init
  service). If the sidecar cannot start, the dense lane is blocked and the
  report says lexical-only, with no baseline recorded for dense.
- dense.json identity drift is pre-existing staleness, not a regression.
- draftToPromptContext has no UI consumer that depends on the H1 (builder
  verifies).
- searchByVector has no ORDER BY tiebreak; equal distances could reorder
  between runs. Advisory; the exact-equality baseline would expose it.
- The trench ENTRY_ID label is provenance only (builder verifies consumers).

## 8. Risks and stop conditions

- Stop if the central snapshot regen shows any non-text change.
- Stop if WP3 test 2 (byte-stability) is red: that means the change would
  bust the prefix cache for benign contracts.
- Stop if any builder edits embeddings/**, a manifest description, or tool
  behavior; the owner's constraint is text and projection only.
- Stop if a dotted token does not resolve to a live tool: report, do not
  invent.
- Dense lane: no baseline is recorded unless every row is method dense.
- Money path: WP1 item 2 touches a shared Morpho validator; the existing
  Morpho tests must stay green and the message must stay a domain outcome.
- Concurrency: test agents are read-only against the DB and the sidecar;
  they never write baselines or run reembed.

## 9. Verification plan

Per package: WP1 manifest-lint suite + the touched protocol tests; WP2 the
Morpho quote handler test (new table case) + morpho suite; WP3 the three new
tests + prompts suite + turn-envelope-system-boundaries.test.ts; WP4
toolsnaps 174/174; WP5 probe CLI output per namespace with method dense;
WP6 the full gate list above. Readiness is reported as ready, not ready, or
ready only if a named gap is accepted.

## 10. Codex review round 1 (DISCUSS, 2026-08-22) and the accepted changes (v4)

All four blockers were verified in the tree by the coordinator and are
accepted. Where a line above conflicts with this section, this section wins.

Blocker 1, dense baseline written before the dense assertions
(discovery-dense-baseline.int.ts:111 runBaselineTarget, assertions at
117-125): introduce one shared assertDenseMeasurement(report,
expectedCandidateCount) in src/__tests__/eval/ that asserts every row has
retrievalMethod === "dense" and !denseFailed and reports the expected
candidateCount, and call it BEFORE any baseline writer in the canonical
runner, in every per-namespace target, and in the probe CLI. The quality
floors also move before the writer.

Blocker 2, datasets can falsely pass: add a namespace-coverage dataset
validator (src/__tests__/eval/) that proves the dataset declares its
namespace; every live tool in that namespace has at least one blind and one
protocol-aware row; those rows carry the exact full toolId in
expectedToolIds (prefix tolerance is not accepted for per-namespace
datasets); no query contains any live toolId or publicName (the pin at
toolid-pin.ts resolves exact names and unique prefixes and keeps
method dense); every expected id belongs to the declared namespace; no live
tool is omitted. Update PROTOCOL_NAME_RE (retrieval-eval-harness.ts:28) to
the live protocol names (Khalani, KyberSwap, Jupiter, DexScreener, Morpho,
Pendle, Relay, Virtuals, Trench, pools.fun, Uniswap, Solana) and drop
Polymarket, before any agent authors a row. The validator runs in both
lanes and in the probe CLI.

Blocker 3, loadProviderDotenv() loads non-secret config only
(providers/env-resolution.ts:33-42 skips managed secret keys), so
requiresEnv tools such as the 34 JUPITER_API_KEY-gated solana tools stay
hidden and a run can report method dense over a reduced catalog: the probe
CLI and the per-namespace targets use an explicit eval-only opt-in (an env
flag named for the purpose) that sets non-secret sentinel values for the
active manifests' requiresEnv names in the eval process only, never loads
real provider credentials, and asserts candidateCount === 134 on every row
via assertDenseMeasurement. No handler executes in this path; discovery only
checks presence.

Blocker 4, owner writing rules violated by the current diff: 152 added
tracked lines outside toolsnaps contain em dashes (measured by the
coordinator; top files solana-jupiter/manifests/predict.ts 20,
registry/action-aliases.ts 6, solana-jupiter/manifests/lend.ts 6, ...) plus
the untracked dotted-toolid-rules.ts, and that lint's excerpt() at :92-97
slices the diagnostic field and adds ellipses, which the clarified rule
forbids. Accepted: (a) Builder 1 replaces em dashes on CHANGED LINES ONLY
(" - " or a comma or a period as the sentence needs; no repo-wide sweep,
rule 00 scope) in every file of the Batch 3 diff, including the lint file;
(b) the lint emits the complete normalized field in its diagnostic, no
excerpt, no ellipsis; (c) a changed-lines em-dash gate
scripts/check-no-em-dash.mjs scans added lines of git diff against the
merge-base with origin/main over authored-content paths (src/**, docs/**,
vex-app/src/**, *.md) and fails on U+2014; it is wired as a package script
and runs BEFORE the central snapshot regeneration (WP4) so snapshots are
regenerated from corrected sources. Pre-existing em dashes on untouched
lines are out of scope for this closure. The pre-existing 400-character cut
at vex-app/src/main/token-launch/execute-seam.ts:35
(MAX_LAUNCH_MESSAGE_CHARS, with its own execute-seam-message.test.ts) is an
OWNER DECISION recorded in the brief: fix in this arc (remove the cut,
update its tests; renderer-facing prose, not tool logic) or defer to its
own arc with the decision recorded. The coordinator does not decide it.

Design answers adopted:
- WP3: sanitizeUntrustedBlock at the render boundary stays; the mapper
  change is safe (no UI consumer of draftToPromptContext). Invariants
  corrected: benign text byte-identical through sanitizeUntrustedBlock; a
  new bold-form snapshot byte-identical at the render boundary; a legacy H1
  snapshot demoted with one expected prefix change; new runs use the new
  format from their first prompt, so no prior run-prefix cache exists to
  invalidate. The tests assert exactly these four.
- WP2: the sibling TOOL_ID map in market-execute.ts:96 is authority and
  audit identity (parsing, refusals, execution recording, broadcast inputs)
  and stays dotted. EXECUTE_FOR in market-quote.ts is prose only and emits
  publicNames derived namespace-locally from the Morpho manifest constants
  or MORPHO_TOOLS, following the existing projection in vaults-discover.ts;
  never import the global catalog into a handler (catalog imports the Morpho
  handler bundle; cycle). The test extracts the token following AUTHORIZES
  and compares exact equality per direction (toContain would pass
  morpho__market_supply against morpho__market_supply_collateral).
- WP5 shape: per-namespace JSON files for disjoint authorship, but ONE
  shared dataset registry and target factory consumed by both lanes (no
  eleven hand-written target blocks in two runners); the probe CLI takes
  --namespace <ns> validated against the live namespace set and derives the
  dataset path internally (no arbitrary filesystem path); one shared loader
  and completeness validator; one baseline file per namespace and mode; the
  coordinator runs the completed datasets centrally and SEQUENTIALLY (one
  llama.cpp process; concurrent streams add variability and nothing to
  authorship), then each agent inspects its namespace report and writes the
  findings. Agents therefore author rows blind and do not run the dense
  path themselves.
- WP1 lint: refactor the lint contract so catalog identities and prose
  subjects are separate inputs; scan navigation prose fields explicitly and
  exclude toolPrefixes, which are durable dotted identity; never fake a tool
  identity for a namespace navigation record.
- WP4: after the single regeneration, mechanically compare every HEAD
  snapshot with its regenerated counterpart after recursively removing
  description fields and require the structural projections to be
  identical; then review ALL changed description hunks, not a sample.
- Corrections to this plan's own claims: with global k = 134 and three
  retired rows, orphaned vectors do not normally push a global result below
  five; pnpm tool-reembed is still run for generation cleanliness. A
  tool_id secondary ORDER BY key would be a retrieval behavior change and
  belongs to the D9 exercise, not here.
- Morpho reluctance: Codex agrees with the coordinator's diagnosis; the
  defect is contributory at most, never a discovery cause; WP5 measures the
  upstream.

## 11. Codex review round 2 (DISCUSS) and the accepted corrections (v5)

Round 1's four blockers are resolved in v4's design. Two new deterministic
paths and one sequencing condition, all accepted:

1. Dataset validators. Adding "Solana" to PROTOCOL_NAME_RE would fail the
   frozen seed's blind rows that use Solana as a CHAIN word (Jupiter is the
   provider-aware signal for the solana namespace), and INTERNAL_TOOL_RE at
   retrieval-eval-harness.ts:29 rejects EVERY dotted token, so a
   protocol-aware pools.fun row could never validate. Corrections: keep
   Solana OUT of the brand regex (Jupiter stays the protocol-aware term for
   the solana namespace); escape pools\.fun as a brand; replace the generic
   dotted-token rejection with the catalog-exact toolId/publicName leak check
   the coverage validator already plans, retaining the explicit retired or
   internal tokens (gamma, clob, tokenpairs, zap) if still needed; run the
   revised validators over the frozen seed and the supplemental dataset
   BEFORE any namespace author starts. Acceptance: both existing datasets
   validate without edits, a protocol-aware pools.fun case validates, and an
   exact live toolId or publicName case fails.
2. Em-dash gate coverage. A merge-base git diff cannot see untracked files,
   and the worktree holds 11 untracked authored-content files (the dotted
   lint among them, with two em-dash lines). The gate scans added lines of
   the merge-base diff AND the full content of authored files returned by
   git ls-files --others --exclude-standard under the same path policy, with
   a small gate test or fixture proving an untracked authored file
   containing U+2014 fails.
3. Sequencing. The execute-seam decision gates only final closure if the
   owner chooses an in-arc fix. The 24 unratified long descriptions are
   different: an in-arc shortening pass would change snapshots AND lexical
   retrieval (lexical-score.ts:42 scores manifest.description directly).
   Therefore WP1 to WP3, dense infrastructure and dataset authoring proceed
   now; WP4 regeneration and the lexical baseline captures wait until the
   owner either accepts or defers the current descriptions or the in-arc
   edits are complete. Dense retrieval stays independent (embeddingText
   frozen). The owner's stated default is "leave the descriptions as they
   are, critical facts first"; absent a different ruling, WP4 proceeds on
   that default once WP1 to WP3 land.

No further disagreement recorded by Codex on WP2 authority versus prose,
WP3 boundary sanitization, pre-writer dense assertions, candidateCount 134,
the shared dataset registry, global retrieval, WP4 structural comparison,
or the Morpho diagnosis. Codex pre-committed to GREEN LIGHT for v4 with
these corrections; turn 3 asks for it explicitly.
