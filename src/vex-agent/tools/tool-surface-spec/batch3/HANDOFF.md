# Tool Surface Program - state and continuation

## Standing goal (set by the owner, 2026-08-22)

Finish the update of our agent tools modeled on github-mcp-server
(agents-colab/github-mcp-server is the quality reference), so that the
tools are presented to the current Vex agent in their best form and are
ready for the Vex Studio local MCP server: internal tools except memory and
runtime exported directly, protocol tools through ToolSearch, as in Vex.
Tool BEHAVIOR is frozen (handlers, parameter semantics, approvals,
agentscan writes); the work is naming, descriptions, schemas, metadata,
presentation and the runtime prompt. When unsure, dispatch Explore or ask
Codex; never decide without context.

At the end of the Studio preparation, one subagent per protocol (Opus 5 low,
always):
1. tests retrieval for that protocol (DONE in Batch 3: 357 blind-authored
   rows, recall@5 0.958, see retrieval-findings.md);
2. calls EVERY tool for real against the live provider API, mutating tools
   included, using the owner's funded wallets (Base, Arbitrum, Robinhood
   Chain, Solana; vault password via the VEX_KEYSTORE_PASSWORD name in
   agents-colab/agents_dm/.env, never printed), and judges each tool's
   description and behavior as if it were the Vex agent using the tool;
3. when a tool looks suspicious or its description says too little, reads
   the provider's real documentation and proposes a description fix (as a
   diff for the coordinator, not an edit);
4. and, at the very end, a real test of the Studio MCP server.

Coordinator additions the owner accepted: live calls go through the real
dispatcher with a real session (prequote gating, approval envelope, wallet
scoping, agent_activity writes), which needs the harness decisions in
OPEN-DECISIONS.md O16 and O17; the spend policy O15; a description-versus-
reality checklist per tool (RETURNS fields, units and decimals, pagination
and truncated flags, error causes, nextStep names callable names, empty
result distinct from error); evidence after every mutation (agent_activity
row, on-chain receipt, explorer event once AgentScan is deployed); one
restricted-mode case per protocol that stops at the approval queue; the MCP
server must be built before it can be tested, then tested with a real
client (Claude Code via `claude mcp add` plus the MCP Inspector), including
measuring what Claude Code shows of descriptions above 2 KB (O2).

Order of work (owner decision D14, 2026-08-22): Batch 3 closure PR (this
document) -> Wave 2 prompt rebuild (D13) -> Batch 4 (parameter vocabulary,
output envelope, response_format, Task 0b; behavior-touching, owner
decision per item, O3 to O5) -> Studio MCP server and its real test ->
LAST, when there is time, the live-test harness phase (funded mode and
on-chain spend guard, O16, O17) with the per-protocol live agents. Nothing
is spent from the funded wallets before that last phase.

Written 2026-08-22, mid Batch 3. Read this first if you are picking the
program up. It records where the work is, what is decided, what is still
open, and the mistakes that cost time so they are not repeated.

## Where the code is

- `main` at `ea5dea2a` carries THREE merged programs: Task 0 (PR #105),
  Batch 1 (PR #106), Batch 2 (PR #107).
- Batch 3 lives UNCOMMITTED in the worktree `/home/kubas/Vex-batch3`,
  branch `feat/tool-surface-3` cut from `ea5dea2a`. Roughly 350 files
  touched. Nothing is committed and nothing is pushed.
- A companion change sits UNCOMMITTED and UNPUSHED in the AgentScan server
  clone `/home/kubas/Vex/agents-colab/vex-agentscan`, branch
  `feat/transfer-kind`. It adds the `transfer` kind the Vex client needs
  before transfer egress can be switched on. It is waiting on an owner
  decision to push.

## What is already merged, in one paragraph each

**Task 0.** Agent wallet transfers now land in `agent_activity`. The
executors gained the staged-broadcast discipline every protocol handler
already had: resolve one exact plan, open the durable row, sign locally,
stage hash and nonce (EVM) or signature and blockhash evidence (Solana),
then submit the signed bytes once. Ambiguous transport leaves the row
pending; the protocol execution completes as the tool attempt on every known
outcome. Solana amounts are derived once with exact decimal arithmetic
(this replaced a `Number`/`Math.round` float hazard). An ERC-20 confirm
writes the executed amount only when the receipt's `Transfer` log proves it.
Verified end to end with a live dust transfer on Base.

**Batch 1.** The spec and the guardrails, with no model-visible change: the
naming map for all surfaces, the style guide, parameter and pagination
vocabulary, the output envelope, the identity and migration spec, the MCP
export scope; plus per-tool contract snapshots, the catalog-wide naming
gate, an ActionKind-aware description lint, and the deprecation alias
resolver wired into every name-bearing boundary.

**Batch 2.** The model-visible wave. 137 protocol manifests gained a
required `publicName` (`namespace__resource_action`) projected from a
catalog lookup, while the dotted `toolId` stayed the immutable internal and
audit identity so no durable table needed migrating. 31 internal tools took
PascalCase names behind typed deprecation aliases. `discover_tools` and
`describe_tools` merged into `ToolSearch` (three modes, 1287-byte
description where the pair cost about 4 KB, slim rows, schema by injection);
`execute_tool` retired from the registry while its approval envelope kept
working. The venue reveal mechanism was torn down at all four enforcement
points, so Uniswap and Relay are ordinary discoverable tools and route
preference lives in prompt prose. Global approval doctrine moved out of the
withheld `execute_tool` description, where no model could ever read it, into
the prompt stack.

## Batch 3: what is done and what is not

Approved plan: `/tmp/harness-batch3-plan.md` (v2, Codex GREEN LIGHT). If
`/tmp` has been cleared, the decisions survive in `owner-decisions.md` and
the artifacts under this directory.

**Wave 0 - DONE.** Five artifacts in this directory: `inventory.md` /
`inventory.json` (134 protocol + 32 internal = 166 surfaces, measured, every
plan number confirmed), `lexical-baseline-recapture.md` (the baseline was
invalid since commit `9e45b086` on 2026-07-23, which rewrote the dataset
`v3-agent-200` to `v3-agent-116` without recapturing; recaptured here so any
Batch 3 delta is attributable), `prompt-ledger.md` (66 sections across 25
modules with PRESERVE-VERBATIM 14 / PRESERVE 27 / RELOCATE 18 / DELETE 7),
`prompt-budget-baseline.md` plus a re-runnable `pnpm prompt-budget:report`
(assembled prompt 103.7 to 110 KB by mode, `buildProtocolsPrompt()` alone
71,172 B = 68.6%), and `phantom-cap.md` (6 model-facing sites fixed, 13
comment sites, plus a `stale-output-cap-claim` lint that lands at zero with
an empty allowlist).

**Wave 1 descriptions - DONE, four builders.** 166 surfaces reviewed, 127
edited. The manifest-lint allowlist went 616 to 454 rows with the
`tool-description` category emptied fleet-wide, and the internal description
allowlist went 33 to 0. The manifest-lint suite is green at 17/17 including
the no-stale-entry gate.

**Wave 1 dotted-toolId sweep - INTERRUPTED, this is the live work.** A
builder was substituting dotted toolIds for callable `publicName`s in
manifest prose and was stopped mid-run by the user for a context compaction.
State at that moment: `tsc` clean, all 161 protocol test files green, the
manifest-lint suite green at 17/17 (up from 12, so its new
`dotted-toolid-rules.ts` lint is landed and passing), and about 343 dotted
references still present in manifest prose (down from about 511 excluding
the `pools.fun` brand). So the work is partially applied and internally
consistent, not broken. Resume by re-dispatching the same brief with the
remaining count as the starting point.

**Wave 1 central reconciliation - NOT STARTED.** Owed by the coordinator,
in this order: regenerate ALL contract snapshots once centrally (several
builders regenerated the whole set mid-wave and baked each other's in-flight
text into artifacts, so only a central pass is trustworthy), run the
authoritative `pnpm test:eval:lexical` for the whole wave, then the full
gate set (`pnpm test`, `tsc --noEmit`, `build`, `test:unsafe-escapes`,
`typecheck:test:ratchet`, `git diff --check HEAD`).

**Wave 2, the prompt rebuild - NOT STARTED.** It is gated on the
owner-approved request corpus and the task shapes derived from it, which
require the owner to select sessions. Its acceptance gate is an offline
old-versus-new model replay against a decision rule pre-registered before
either variant runs, not string characterization alone.

## Closure arc status (2026-08-22, afternoon)

- Owner reframe recorded in the plan: the program's goal is tool READINESS
  for the Studio MCP server (naming, descriptions, schemas, metadata,
  presentation) plus the runtime prompt; tool behavior is frozen. See
  mcp-readiness-audit.md in this directory for the measured checklist.
- Codex plan review on thread harness-batch3: DISCUSS (4 blockers), DISCUSS
  (2 blockers + sequencing), GREEN LIGHT for v5. Plan file:
  /tmp/harness-batch3-close-plan.md (sections 10 and 11 carry the accepted
  corrections). Closure condition: record the owner's ruling on the
  execute-seam 400-character cut and on the 24 unratified long descriptions
  (defaults: defer; leave as is).
- Four builders dispatched on disjoint files in this worktree: 1a (sweep
  prose, em-dash cleanup on changed lines, scripts/check-no-em-dash.mjs,
  package.json script), 1b (dotted lint reach to navigation prose with full
  diagnostics, internal-name charset test, Morpho nextStep sentence), 2
  (mission contract sanitization at the render boundary, H1 to bold, comment
  fix), 3 (assertDenseMeasurement, dataset validators, shared dataset
  registry for both lanes, discovery-probe-cli.ts with --namespace and the
  requiresEnv sentinel opt-in).
- Eval infrastructure: the app's own Postgres port 27432 is held by a
  foreign instance (rejects our pg_password), so an isolated eval Postgres
  runs as docker container vex-eval-db on 127.0.0.1:27433 (image
  pgvector/pgvector:0.8.2-pg18-trixie, ephemeral, password in the session
  scratchpad file eval-pg-password, 0600). 79 migrations applied, 134 tools
  embedded (model ai/embeddinggemma:300M-Q8_0, dim 768), health OK. The
  embeddings sidecar on 127.0.0.1:27134 is an already-running external
  process serving the right model; it is used read-only. Remove with
  `docker rm -f vex-eval-db` when done.
- DONE later the same day: Builders 1a, 1b, 2, 3 landed and their diffs
  were read by the coordinator (Builder 2's test had its zero-width-space
  constant rewritten as an escape). Snapshots regenerated once centrally:
  174/174, 154 description-only changes, 0 structural diffs (checked by
  stripping every description field and comparing HEAD to the worktree),
  24 files mechanical-only and 130 with Wave 1 rewrites. Lexical fallback
  baselines were first recaptured on a catalog that silently lacked the 34
  JUPITER_API_KEY-gated Solana tools (seed recall@5 0.457, Solana all
  zeros): that capture was INVALID and was replaced later the same day by
  the full-catalog capture described below (seed recall@5 0.672); the
  reconciliation-reason template in baseline/run.ts lost its em dashes.
  Em-dash gate green (scripts/check-no-em-dash.mjs, package script
  check:em-dash, scans added lines plus untracked files). Prompt budget:
  every mode about 1.6 KB smaller than Wave 0, protocols layer 71,172 to
  69,568 B, other layers byte-identical. Eleven per-namespace datasets
  authored blind (357 rows), validated offline, measured sequentially on
  the dense path: recall@5 0.90 to 1.00 per namespace, 15 misses of 357
  rows, full write-up in retrieval-findings.md. Codex final review round 1
  was BLOCKED on three WP5 gate defects (dense runner accepted an
  environment-reduced catalog; lexical baselines captured over that reduced
  catalog, solana all zeros; per-namespace dense targets without floors;
  supplemental dataset missing from the dense lane); Builder 5 fixed the
  harness (see the next bullet) and all lexical baselines were then
  recaptured on the full 134-tool catalog. Canonical seed dense:
  recall@5 0.94 against the 0.95 floor (O18; dense.json stays stale, no
  floor lowered).
- OPEN-DECISIONS.md at src/vex-agent/tools/ holds O1 to O18, including the
  agents_dm findings for the future live-test phase: the harness is at
  agents-colab/agents_dm (the launcher's .env path is dead), its safety gate
  forbids funded runs by design, there is no on-chain spend guard, the
  launchpads are Robinhood Chain 4663 not Base, and a Solana keystore sits
  in the same vault.
- Builder 4 landed: twelve assertions in ten test files outside protocols/
  moved to the current prose with the source string cited for each; the
  protocol-discovery "matches by toolId substring" case pinned a lexical
  ranking coincidence (no substring rule exists; the pin covers exact
  toolId, exact publicName, unique prefix) and was replaced by a presence
  assertion plus a separate pin test. Three gate findings fixed by the
  coordinator: the two generated note templates in eval/baseline/run.ts
  carried em dashes into every recaptured baseline (both replaced, eleven
  baselines recaptured again); slippage-remediation-contract.test.ts pinned
  the source literal "kyberswap.swap.quote" (now kyberswap__swap_quote);
  error-bus.test.ts had a PRE-EXISTING test type error at ea5dea2a and on
  origin/main (EngineErrorEvent.detail required since 809d111b, fixtures
  never updated, ratchet baseline without an entry), fixed by adding
  `detail: null` to the two fixtures and disclosed as outside Batch 3.
- Solana balances (owner report, O19): measured live, Khalani's chain list
  still has Solana but its balance and token index has no Solana coverage
  at all; Vex has no other Solana balance source; the log's `chains: 0` is
  chains written, not scanned. Fix shape and the pricing-source decision are
  in OPEN-DECISIONS.md O19. Not touched in this arc.
- Codex final review round 1 (BLOCKED) was answered by Builder 5:
  src/__tests__/eval/requires-env-sentinels.ts (the one owner of the
  eval-only requiresEnv sentinels, applied unconditionally at module scope
  in both baseline commands and behind the opt-in flag in the probe CLI),
  live-catalog.ts (PINNED_LIVE_CATALOG_TOOL_COUNT = 134 with a ratchet test,
  expectedCandidateCount, assertFullDiscoveryCandidates called inside every
  lexical and dense measure before any writer), dense-quality-floors.ts (the
  four floors, enforced by denseTarget for every registered dataset, with a
  writer-protection test), and the dense runner iterating the shared
  registry including the supplemental dataset. All thirteen lexical
  baselines were then recaptured on the full 134-tool catalog (the earlier
  capture had the Solana tools hidden and read zero for every Solana row;
  full-catalog numbers are in retrieval-findings.md).
- Gate run after Builder 5 and the recapture: pnpm test 1059/1059 files
  and 14098/14098 tests; the FINAL gate run, after the dense runner split
  and the denseTarget seam: pnpm test 1059/1059 files and 14101/14101
  tests; tsc clean; test type ratchet green; build exit 0; unsafe-escapes
  clean; git diff --check clean; em-dash gate green; lexical 13/13 targets
  pass; toolsnaps 174/174; manifest-lint 21/21.
- Codex final review round 2 (DISCUSS) asked for one Vitest case per dense
  target so a failing dataset does not hide the others, a writer-protection
  test that goes through the real denseTarget, and two HANDOFF chronology
  fixes; all done. denseTarget gained an optional `evaluate` seam for tests
  (default evaluateDiscoverTools); the dense runner registers a case per
  registry target. Per-target dense run on the eval database: relay and
  virtuals clear every floor and have captured baselines
  (dense-relay.json, dense-virtuals.json, check PASSED); the other 11
  targets fail their own case on floors and write nothing (details in O18
  and retrieval-findings.md).
- Codex final review round 3 on harness-batch3: GREEN LIGHT (2026-08-22).
  The two reviewed plans are archived next to this file as
  plan-v2-codex-reviewed.md and closure-plan-v5-codex-reviewed.md; the /tmp
  copies are deleted.
- Still owed: the commit and the PR, on the owner's word only. Worktree
  state at closure: 447 entries (405 modified, 42 untracked), nothing
  committed, nothing pushed. The eval Postgres container vex-eval-db
  (127.0.0.1:27433) is still running for any further dense run; remove it
  with `docker rm -f vex-eval-db`. Remove the
  eval Postgres with `docker rm -f vex-eval-db` once the owner has no
  further dense runs to ask for.

## Owner decisions in force

D1 `query` canonical. D2 ToolSearch visible immediately and exported to MCP
as read-only catalog search. D3 attempt the `wallet_balances`
`response_format` flip only behind a real equivalence test. D4 venue tools
un-gated, preference stated in prompt prose. D5 aliases removed liberally
(production preview), owner-acceptance branch. D6 no method-enum
consolidation. D7 near-duplicate merges: kyberswap chains and the
dexscreener feeds merged; **virtuals.graduations KEPT because its stop
condition fired** (the record originally said "retired", which described the
proposal not the outcome, and was corrected in Batch 3). D8 protocol
descriptions are positive-only by default; a "use X instead" sentence only
for the named overlap pairs. D9 `embeddingText`, aliases and example intents
are FROZEN; retrieval quality is its own benchmark exercise later. D10 the
capability map names every protocol and what it does, because the model
writes its own ToolSearch query and cannot search for what it has never been
told exists; what goes is the per-tool inventory, not the protocols.

Full text in `../owner-decisions.md`.

## Open items needing an owner decision

1. CLOSED by D12 (2026-08-22): `solana.predict.pnlHistory` stays. It has
   answered a bare 404 for every wallet since 2026-07-24 (documented in its
   handler comment); the owner chose to keep the tool shipped as is.
2. PARTLY CLOSED by D12 (2026-08-22), then REOPENED by measurement the same
   day: the owner ratified "seven fund-moving tools" above 2048 bytes, but
   the snapshots show 32 of 167 (31 exported; morpho 18, the largest
   morpho__vaults_discover at 6114 B). The coordinator had quoted the
   builder's count without measuring. The seven stand; the remaining 24
   need an owner ruling (accept critical-facts-first for the Studio export,
   or a metadata-only Morpho description pass). See D12.
3. CLOSED (2026-08-22): the AgentScan branch `feat/transfer-kind` is
   committed (`1a1397f`) and pushed to `origin` after its lint, 1234 unit
   tests and the 34-test integration file passed locally. No PR was opened;
   the remote offers one at
   https://github.com/BerzanTas/vex-agentscan/pull/new/feat/transfer-kind.
   Transfer egress on the Vex side stays closed until the server change is
   merged and deployed (Batch 4, Task 0b).
4. Two pre-existing risks found in Wave 0 and deliberately not touched:
   `missionPromptContext` renders into the cached static prompt prefix
   unsanitized, unlike every other untrusted string; and `sanitize.ts` claims
   a `system-boundary.test.ts` pins the sentinel-regex lockstep, but that
   file does not exist, so a sentinel rename would disarm the boundary with
   no test failure.
5. A handler bug reported by a builder and not fixed:
   `morpho.market.quote` types its direction map as
   `Record<string, string>` and covers four of six directions, so
   `direction: "supply"` or `"withdraw"` renders "This quote AUTHORIZES
   `undefined`" to the model. Reachable from Vex's own routing pointer;
   `tsc` cannot catch it because of the loose typing.
6. CLOSED by D11 (2026-08-22). The lexical scorer has no length
   normalization, so Wave 1's truthful additions moved Relay above Khalani and
   Uniswap above KyberSwap on some generic queries. The owner ruled this
   acceptable: the default ToolSearch path is dense retrieval over the frozen
   `embeddingText` (`protocols/dense-score.ts`, lexical is the fallback when
   the embedding model, DB or table fails), and the overlap pairs surfacing
   together at the top is the desired outcome, with the prompt carrying the
   venue preference. The lexical eval remains a fallback-path regression
   guard, not a ranking target.
7. The owner authorized a 20 USD test budget for real trades. Coordinator
   position: the A/B evaluation must stay mutation-intercepted (executing
   trades makes runs non-comparable and burns the budget on gas), and the
   money is better spent on a few targeted live probes proving the renamed
   money path works end to end (a small KyberSwap swap, the same through
   Uniswap to prove the D4 un-gate, optionally a small bridge), plus one
   restricted-mode case that deliberately stops at the approval queue.

## Mistakes made in this program, so they are not repeated

- **Four builders in one shared worktree.** They collided on
  `_manifest-lint/allowlist.ts` and on `__toolsnaps__/`. Two ran
  `git stash` or `git checkout` on shared paths and one regenerated all 174
  snapshots mid-wave, baking other builders' in-flight text into artifacts.
  The allowlist damage self-healed because the lint's stale-entry test
  determines the correct final state from actual violations rather than from
  who deleted what. The snapshot damage is repaired by one central
  regeneration. Next time: either give each builder its own worktree, or
  forbid shared-file git operations and the global snapshot regen IN THE
  BRIEF, not after the first collision.
- **Numbers quoted from a plan rather than measured.** The plan said 137
  protocol tools and 228 KB of prompt; the truth was 134 (three were retired
  in Batch 2) and 104 to 110 KB assembled, because 228 KB was the TypeScript
  source footprint including code and comments. Measure from the tree.
- **A plan that would have missed its own point.** Batch 3 was originally
  scoped to rewrite descriptions and expected retrieval to improve. Dense
  retrieval reads `embeddingText`, which every one of the 134 manifests
  defines and which `pickSourceText` prefers over the description, so the
  rewrite could not have moved tool selection at all. Caught in review.

## The thing this program is actually for

A live session exposed the defect. Asked what was interesting on Robinhood
Chain, the agent called three launchpad tools and stopped, never reaching
DexScreener for pool depth or Twitter for narrative. Challenged, it produced
an excellent three-layer research model unprompted, with latency numbers and
a correct read that a 10 percent move at 0.098 turnover means absent sellers
rather than demand. The knowledge is in the model; the default procedure is
not in the prompt. The prompt is organized as a tool inventory, which
duplicates what the injected tool definitions carry, and underweights
judgment, task shapes and the reporting contract. Wave 2 is the fix, and
`research.ts`'s existing Token Research Map is its seed: it already encodes
the three-layer routing, but as a map organized by namespace rather than as
a procedure.
