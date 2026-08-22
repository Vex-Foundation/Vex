# Batch 3 plan v2: retrieval, descriptions, and a rebuilt system prompt

v2 after Codex plan review turn 1. The load-bearing correction is section 2:
there are THREE model-facing surfaces, not two, and the one this batch was
about to miss is the one that actually drives tool selection.

Repository /home/kubas/Vex, worktree /home/kubas/Vex-batch3 (branch
feat/tool-surface-3 from main ea5dea2a, which carries Task 0, Batch 1 and
Batch 2). Date 2026-08-21.

## 1. Why this batch exists, from live evidence

The owner ran a real session and it exposed the defect this batch targets.
Asked "co ciekawego na robinhood chain dzisiaj" (what is interesting on
Robinhood Chain today), the agent called three launchpad tools (trench,
pools.fun, virtuals) and STOPPED. It never touched DexScreener for pool depth
or Twitter for narrative. Challenged, it then produced an excellent
three-layer model unprompted: discovery (2s to minutes latency, sees a token
from the first block) then depth (DexScreener, measured ~7h discovery lag on
that chain but real liquidity) then narrative (Twitter, "is anyone even
talking about this"). It also produced genuinely good judgment on its own:
flagging WALL3's FDV 4.78M against a 728K market cap as a low-float signal,
and reading KARMA's +10% at 0.098 turnover as an absence of sellers rather
than demand.

So the knowledge is in the model. What is missing is a DEFAULT PROCEDURE. The
model matched tools to the noun in the question (Robinhood Chain -> tools that
serve Robinhood Chain) instead of to the SHAPE of the task (a market question
-> three layers). That is a prompt-architecture failure, not a model failure.

Diagnosis of the cause: the prompt stack is organized along the wrong axis.
Measured correctly (v1 quoted TypeScript source bytes, which include code and
comments - Codex's correction): the ASSEMBLED minimal prompt is about 104 to
111 KB depending on mode, of which `buildProtocolsPrompt()` alone renders
about 71 KB. So roughly two thirds of what the model actually reads is
protocol inventory - namespace summaries, alternatives, examples, every
facet - duplicating what ToolSearch and the injected tool definitions now
carry, while judgment, task shapes and the reporting contract get the
remainder. Wave 0 records assembled bytes per mode and provider token cost so
the batch's effect is measured, not asserted.

Contrast with the harness Claude Code itself runs under: that prompt spends
almost no space on what tools exist (the tool definitions carry that) and
almost all of it on identity, communication contract, decision procedure for
ambiguous cases, named anti-patterns, and progressive disclosure of detail.
There is a dependency here worth stating: a prompt can only be thin on tools
when the tool descriptions are good. Batch 3 fixes the descriptions AND the
prompt in one program precisely because the first enables the second.

## 2. Scope

Two halves of one job, run as coordinated waves.

### Half A: the system prompt, rebuilt from scratch

Not an edit pass. A new structure, along the task-shape axis:

1. Identity and product truth. Who Vex is, that funds are real and actions
   irreversible, honest uncertainty. Exists today inside identity.ts but
   buried among branding and token prose.
2. How to think about a request: TASK SHAPES with default procedures. The
   core of the rebuild. Candidate shapes, to be confirmed against real
   session evidence rather than invented: market question (the three-layer
   procedure with the latency and coverage reasons stated), position entry
   (quote, safety-check, approval, verify), portfolio state, safety
   assessment, transaction forensics (what happened to my tx). Each shape
   names its default sequence, its stopping condition, and what makes an
   answer complete.
3. Money-path doctrine. Approvals, ambiguity never terminalizes, never
   overstate certainty, fees and units. Already relocated here in Batch 2;
   keep it and keep it verbatim where it is load-bearing.
4. Communication contract. How to report, what counts as evidence, when to
   say "I do not know", how to present numbers the user acts on. The live
   session shows good instincts firing by luck rather than by contract.
5. Capability map, deliberately THIN. Not a menu: which namespace answers
   which kind of question, plus its characteristic (freshness, coverage,
   cost). The model calls ToolSearch for the rest.
6. Named anti-biases, drawn from observed failures: do not stop at the
   discovery layer; the chain named in the question does not mean the answer
   is that chain's tools; thin turnover is not demand; a launchpad listing is
   not a market.

Modes (agent, mission, plan, autonomous loop) keep their own layers, rewritten
to the same axis and to state what changes about the PROCEDURE in that mode.

### Half B: descriptions, D8 style, per-namespace waves

Owner decision D8 governs: positive-only by default (what it offers, when to
use it, what it returns, plus SPENDS/approval/preconditions on mutations). A
"use X instead" routing sentence only for the named overlap pairs: swap
KyberSwap vs Uniswap, bridge Khalani vs Relay, yield Morpho variable vs
Pendle fixed, and the search families. Boilerplate when-NOT on a tool nothing
competes with is a defect, not diligence.

Acceptance is an EXPLICIT INVENTORY, not "the allowlists got smaller" - too
weak a gate for a fleet-wide rewrite. Measured scope, corrected by Codex from
the live tree: 134 protocol manifests (three retired in Batch 2) plus 32
internal tools = 166 surfaces. The general allowlist holds 616 entries of
which 157 are `tool-description` across 92 subjects; the internal table holds
33 rows across 23 subjects (its own section comments are stale and get
corrected in passing). Wave 0 freezes that inventory and states the expected
residual debt per namespace; a builder REVIEWS every surface it owns but
EDITS only descriptions that fail D8, truthfulness or the style contract.

Also in this half:
- The phantom output cap, corrected inventory: 14 files mention it, of which
  SIX can reach the model (the research prompt, the Twitter retired-parameter
  error, WebResearch and Twitter param descriptions, the Solana manifest,
  DexScreener param descriptions), seven are stale internal comments and one
  is an unrelated explorer-reference cap. The spec's own inventory in
  output-envelope.md misses the research prompt and the runtime Twitter
  error. These edits belong to the namespace/internal builder already
  touching those files, not to a later coordinator pass over the same files.
- RETURNS validated THROUGH VEX, not through the provider. A description
  promises what the tool returns after validation, projection, filtering and
  envelope construction, so a raw provider probe cannot prove it. Probe
  through the registered read-only handler where practical (vault credentials
  in agents-colab/agents_dm/.env, read-only only, no mutation, no spend). For
  mutating tools use existing recorded live evidence, fixtures and
  deterministic handler tests - a read-only probe cannot validate a mutation's
  return shape.

### The three surfaces, and who owns which fact

Codex's review corrected the plan's central premise, verified in the tree:

- `protocols/embeddings/<namespace>/*.ts` define `discovery.embeddingText`,
  aliases and example intents. `pickSourceText` in
  `protocols/embeddings/reembed.ts:185` reads
  `embeddingText -> canonicalSummary -> description`, so while embeddingText
  exists the DENSE vectors never see a description. Rewriting descriptions
  alone would leave ToolSearch routing on the old language - which is the one
  thing this batch exists to fix.
- Manifest `description` + param descriptions: what the model reads once a
  tool is injected, and what lexical scoring reads
  (`protocols/lexical-score.ts:50`).
- `protocols/navigation/**` metadata: already the repository's owner of
  namespace summaries, consumed by the prompt AND by lexical retrieval
  (`navigation/types.ts:16`).

Consequence: a namespace builder owns all three for its namespace in ONE
pass, and the batch does NOT create a parallel capability-summary artifact -
the prompt renders thin routing capsules FROM the existing navigation
metadata. Retrieval facets, aliases and example queries stay out of the
prompt projection.

Ownership rule, replacing v1's "no duplication", which was too absolute and
conflicted with D8 and with the safety re-anchor:

> ONE CANONICAL OWNER PER FACT, with deliberate projections and parity tests
> where defense in depth requires repetition.

Routing detail and parameter mechanics are not duplicated casually. Funds,
irreversibility, approval, unknown outcome and refusal preconditions ARE
repeated deliberately - D8 requires mutations to state them in their own
descriptions, and the prompt carries the doctrine globally. Each such
repetition gets a parity test so the copies cannot drift.

## 3. What must not change (characterization first)

The prompt carries money-path doctrine and mission rules, so a from-scratch
rebuild is a behavior change on the money path. Before rewriting, capture what
must survive, using the existing prompt-stack tests as the starting point:
approval doctrine content, mission capital and wallet-policy banners, the
safety re-anchor, plan-mode acceptance rules, context-pressure behavior, the
sanitize boundary, and the system-boundary layer. Anything intentionally
dropped is named and justified, never dropped silently.

Also unchanged: durable identifiers, approval enforcement, ambiguity handling,
and the Batch 2 name contract (publicName is what the model calls).

## 4. Sequencing (v2: Wave 0 added, prompt split from descriptions)

Codex's shape, adopted: one program, but TWO independently verifiable change
sets so a regression is attributable. Stacked commits, one release if the
cache-flush cost matters.

Wave 0 - inventory, evidence and baselines (coordinator + one builder):
- Freeze the exact scope: 134 protocol manifests + 32 internal tools, with
  per-namespace counts and the expected residual allowlist debt.
- RECAPTURE both lexical baselines at ea5dea2a, as a separately reviewed
  artifact, BEFORE any description or navigation change. This resolves the
  dilemma rather than choosing a horn of it: the stored canonical baseline is
  `v3-agent-200` while the dataset measures `v3-agent-116` after an earlier
  program's teardown, so the check is already invalid and leaving it red
  destroys its value as a gate. Recapture, freeze, then measure Batch 3
  against the new baseline.
- Build the owner-approved request corpus (contract A below) and DERIVE the task shapes from three
  sources, not one: selected real sessions (actual intent, stopping failures,
  the user's own language), repository contracts (procedures that are rare
  but safety-critical), and retrieval queries as seed vocabulary only. The
  discovery dataset's `intentShape` is NOT the same concept - it is 96
  single / 15 workflow / 4 cross / 1 compare and measures retrieval coverage,
  not agent procedure. Treat v1's five shapes as HYPOTHESES with named
  weaknesses: "position entry" ignores exits, management, transfers, bridges,
  launches and claims; "safety assessment" is usually a subprocedure inside
  another shape; research and entry frequently compose in one request.
- Produce a PRESERVE / RELOCATE / DELETE ledger for every current prompt
  section, so nothing is dropped silently.

### Wave 0 contract A: the owner-approved request corpus

Renamed from "redacted transcript corpus", because the name should describe
both the evidence value and the privacy boundary. There IS a safe read-only
seam - `getAllMessages(sessionId)` in `db/repos/messages/read.ts:81` reads
archived and live history in canonical order without writing - but neither
existing export path is safe enough alone: the Markdown exporter carries
titles, timestamps, assistant prose, reasoning and tool names, and its
audit-first redactor deliberately PRESERVES wallet addresses and transaction
hashes. The shared diagnostics `redact()` is the better first pass because it
hard-redacts known secrets and masks addresses and hashes, but no redactor
recognizes arbitrary personal details, private strategy or commercially
sensitive prose.

So the boundary is explicit and narrow:

- The OWNER selects the sessions or turns. No broad database scrape.
- Extract ONLY: the chosen user request, session mode, language, and the
  subsequent tool command NAMES until the next user turn.
- Never extract: assistant prose or reasoning, tool arguments or results,
  session title, session id, timestamps, memory, wallet state, transaction
  data.
- Apply the shared `redact()` before any serialization.
- A detected hard secret REJECTS the whole case rather than persisting a
  redacted fragment.
- The raw worksheet stays gitignored and mode 0600; only the approved,
  minimized corpus enters the evaluation artifact; private cases are
  paraphrased and labelled as derived, not verbatim.
- The owner reviews every minimized case before it is used.

Twelve cases is a SEED corpus and is stated as such, never as statistical
coverage. It is supplemented by separately labelled repo-contract cases for
the rare safety-critical and money-path procedures that real sessions will
not happen to contain.

### Wave 0 contract B: the A/B decision rule, pre-registered

Defined BEFORE either variant runs, so the gate cannot be rationalized after
seeing results:

- Hard safety failures that automatically reject the new prompt.
- Required procedure and tool-layer coverage per case.
- The stopping-completeness rubric.
- Allowed mutation count, with ZERO mutations on research-only cases.
- Maximum accepted latency and cost regression.
- Repetitions per case, fixed temperature and seed where the provider
  supports them, because twelve single samples cannot separate prompt
  behavior from model variance.
- Deterministic trace scoring versus blinded human judgment, and how ties and
  nondeterminism are resolved.

Minimum bar, stated now: the original Robinhood case must complete discovery,
depth and narrative WITHOUT a mutation, and no safety-critical corpus case
may regress.
- Record assembled prompt bytes per mode and the provider token/cost
  baseline.

Wave 1 - change set A: retrieval, descriptions, navigation metadata
(parallel per-namespace builders, disjoint ownership):
- Review every surface owned; edit only evidence-backed failures.
- All THREE surfaces per namespace in one pass: `discovery.embeddingText` +
  aliases + example intents (dense), `description` + params (injected +
  lexical), navigation metadata (routing, the EXISTING owner - no new
  artifact).
- Validate RETURNS through Vex handlers and projectors.
- Correct every phantom-cap claim, model-facing and comment-only, in the
  files the builder already owns.
- Snapshots, manifest lint, lexical eval against the Wave 0 baseline.
- Re-embed: only where `embeddingText` intentionally changed, plus a
  current-generation health and orphan pass. Do not expect the reconcile
  report's `deleted` count to equal exactly the three retired ids - it also
  purges stale generations and the owner's database contents are unknown.

Wave 2 - change set B: the prompt rebuild:
- Preserve the `buildPromptStack` and turn-envelope boundary contract
  (`engine/core/turn-envelope.ts:49`), the static/turn cache split,
  sentinels, sanitization and safety re-anchor positioning. Those are
  structural contracts, not legacy prose.
- Render THIN routing capsules from navigation metadata; keep retrieval
  facets, aliases and example queries out of the prompt projection.
- Preserve deliberate safety repetition, with parity tests.
- Gate: semantic characterization PLUS an offline old-versus-new model
  replay (below).

Wave 3 - final verification and one live smoke.

### The prompt gate (v2, replacing "characterization tests are enough")

Codex is right that string characterization cannot justify direct landing:
the existing 24 prompt test files / 290 cases / 845 assertions pin
composition, headings, doctrine, mission behavior, sanitization and banners -
but NOT the reported defect. The original Robinhood question appears nowhere.

So: no production flag (there is no prompt-variant infrastructure, and a flag
would need version routing, logging, rollback ownership and eventual removal
- a second source of truth for the highest-leverage artifact in the product).
Instead, an OFFLINE A/B before cutover, against the pre-registered decision rule (contract B): run the approved corpus against
ea5dea2a and against the rebuilt branch, same model and endpoint pinned,
scoring selected namespaces and tools, required procedure layers, stopping
behavior, mutation attempts, completion quality, latency and cost. Include
the original Polish prompt and an English equivalent. Ship only after it
clears the gate, then land ONE production prompt directly.

## 5. Questions from v1, now answered

1. Task shapes: derive empirically, from three sources (transcripts, repo
   contracts, retrieval vocabulary as seed only). The five v1 shapes are
   hypotheses with named weaknesses. Wave 0 owns this.
2. How thin the capability map can get: measurable, and the offline replay in
   the Wave 2 gate is the measurement. Thin capsules render from navigation
   metadata; retrieval facets stay out.
3. Flag versus direct landing: no production flag. Offline A/B, then land one
   prompt directly.
4. One batch or two: one program, two independently verifiable change sets,
   stacked, so regressions are attributable.
5. Lexical baseline: recapture at ea5dea2a as Wave 0, before any change.

## 6. Risks

- Prompt-cache: one large fleet-wide flush, accepted, and the reason to batch
  the model-visible waves rather than trickle them.
- Re-embedding touches the owner's local database and needs the health check
  after. Scoped to intentional `embeddingText` changes plus orphan cleanup.
- Live probes are read-only but consume provider quota and can hit rate
  limits; bounded, and never on a mutating path.
- The prompt is the highest-leverage artifact in the product. A from-scratch
  rebuild that drops one money-path sentence is worse than no rebuild - hence
  the PRESERVE/RELOCATE/DELETE ledger and the parity tests on deliberate
  repetition.
- Comparisons must use the fixed SHA ea5dea2a or origin/main: local `main` is
  stale at 57eb2bdc.

## 7. Verification plan

- Wave 0 artifacts reviewed before Wave 1 starts: inventory, recaptured
  baselines, corpus, task shapes, prompt ledger, byte/token baseline.
- Change set A: manifest lint with the frozen inventory as the gate (not
  merely "smaller"); contract snapshots as a reviewed diff; discovery
  goldens; lexical eval against the Wave 0 baseline; embedding health and
  orphan verification.
- Change set B: the existing prompt-stack suites green or intentionally
  updated with the contract change stated; parity tests for deliberate
  repetition; the offline A/B replay report.
- Repository gates throughout: pnpm test, build, unsafe-escapes, type
  ratchet, git diff --check.
- One live smoke in both Polish and English on the original failing question,
  reported as evidence, not proof.

## 8. Adopted non-blocking suggestions

- A static prompt-budget report: assembled bytes per mode and each layer's
  contribution. This is how "the map got thin" stops being an assertion.
- A lint for stale global-cap wording across model-visible prompt,
  description, param and error strings, so the phantom cap cannot come back.
- Record prompt revision or content hash in request metadata, which is the
  precondition for any future production experiment.
- No em dashes in any newly authored description, prompt, snapshot or doc.

## 9. Revision log (v2, after Codex plan review turn 1)

1. THREE surfaces, not two. `discovery.embeddingText` drives dense retrieval
   and is preferred over descriptions by `pickSourceText`, so the v1 plan
   would have improved prompts and descriptions while ToolSearch kept routing
   on the old language. Namespace builders now own all three in one pass.
   (The aha: verified in reembed.ts:185 and in the separate
   protocols/embeddings/ tree.)
2. No new capability-summary artifact: navigation metadata is already the
   owner and the prompt renders capsules from it.
3. "No duplication" replaced by "one canonical owner per fact, with
   deliberate projections and parity tests" - D8 requires mutations to carry
   funds/approval/preconditions, and the safety re-anchor repeats invariants
   on purpose.
4. Prompt gate is an offline old-versus-new model replay, not string
   characterization alone; no production flag.
5. Wave 0 added: inventory freeze, lexical baseline recaptured BEFORE
   changes, transcript corpus, empirically derived task shapes,
   preserve/relocate/delete ledger, assembled-bytes and token baseline.
6. Counts corrected from the live tree: 134 protocol + 32 internal = 166
   surfaces; allowlist 616 with 157 tool-description across 92 subjects;
   internal table 33 rows across 23 subjects. Acceptance is the frozen
   inventory, not "strictly smaller".
7. RETURNS validated through Vex handlers and projectors, not raw provider
   probes; mutations use recorded evidence and deterministic tests.
8. Phantom cap: 6 model-facing files, 7 comment-only, 1 unrelated; owned by
   the builder already in those files; the spec's own inventory gets
   corrected.
9. Prompt size restated in ASSEMBLED bytes (about 104 to 111 KB, protocols
   about 71 KB), not TypeScript source footprint.
10. Two independently verifiable change sets, stacked.
