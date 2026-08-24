# NOTE: section 15 (Codex round 1 corrections, v2) overrides every earlier section it conflicts with: declarations live in the existing navigation entries (no separate module family), task shapes render inside the existing protocol static layer (no new layer), no hidden search hints (static coupling invariant instead), D4 stated once in the swap and bridge task shapes, no placeholder renderer. Codex GREEN LIGHT 2026-08-22 on thread harness-wave2.

# Wave 2 plan: the Vex system prompt rebuilt as a declaration (v1)

Written 2026-08-22. Repository: worktree /home/kubas/Vex-wave2, branch
feat/prompt-wave2 cut from feat/tool-surface-3 at 4ef0cfda (the Batch 3
closure; PR #108 open against main, to be rebased onto main once merged).
Evidence base: src/vex-agent/tools/tool-surface-spec/wave2/recon.md (measured
2026-08-22) and the Wave 0 prompt ledger
(tool-surface-spec/batch3/prompt-ledger.md). Owner decisions in force: D4
(venue preference in prose, Uniswap and Relay visible), D9 (embeddingText,
aliases and intents frozen), D10 (the map names every protocol and what it
does; what goes is the per-tool inventory), D13 (default declarative prompt
in the spirit of Claude Code's own; rich per-namespace descriptions from one
analysis agent per namespace; preference stays and fallbacks are named with
catalog-proven chain coverage; richness replaces duplication), D14 (order:
this wave before Batch 4 and the MCP server; live tests last).

## 1. Task and latest owner constraints

The owner's words: the system prompt is to be default and declarative, like
the one the coordinator itself receives, without bias toward any protocol,
declaring what is available in the system, written the way the model would
want to receive it given this many protocols and several modes; the
subagents analyze each protocol separately to produce rich, meaty protocol
descriptions for the prompt; the KyberSwap/Khalani preference stays and
Uniswap/Relay are named as fallbacks (Relay does not cover Solana in our
integration). Tool behavior is frozen. No em dashes. No AI attribution. No
commit or push without the owner's word. Subagents are Opus 5 low.

Root cause this wave exists for (HANDOFF.md, "The thing this program is
actually for"): in a live session the agent matched tools to the noun in the
question and stopped at the discovery layer; the knowledge is in the model,
the default procedure is not in the prompt, which is organized as a tool
inventory by namespace.

## 2. Rules loaded and consequences

CLAUDE.md and all ten rules. 00: the prompt carries approval and money-path
doctrine, so every semantic change to a PRESERVE-VERBATIM section is a hard
stop; this plan moves and deletes prose but changes no rule. 03: protocols.ts
is a 313-line function owning four responsibilities; the wave splits it
behind the existing four-symbol facade. 06: a risky refactor starts with
characterization (byte-exact snapshots of every static layer per mode before
the first edit) and each wording change the 40 wording-pinning tests protect
is stated as a contract change. 09: prompts are versioned product artifacts;
the rebuilt prompt is committed as per-mode snapshot artifacts and the
request metadata carries the prompt revision (a v2 commitment not yet
delivered). 90: the safety contract, fee basis, wallet allowlist, launch
authority matrices, the Morpho 1.25 framing and the Virtuals anti-sniper
timing are irreversible-effect facts and are preserved verbatim.

## 3. Repo context (from recon.md, the numbers are measured)

Static prefix 102 to 109 KB per mode; protocols.ts is 69,568 B = 68 percent
of it: a registry-derived capability map (26,271 B: summary 4,632, Use when
4,390, Use instead 2,688, Examples 772, facets 10,749, Try 2,102), a chain
table (1,793) and six doctrine sections (41,016; Morpho alone 21,639, plus its
7,305 B capsule = 28 percent of the whole prefix for 19 tools). Duplication
against the injected descriptions: 32 of 40 Morpho bullets, 16 of 20 Pendle
bullets, all five Trench bullets and the pools.fun money bullets are
already carried by the tool descriptions (exact-phrase confirmed). The 14
judgment bullets the descriptions do NOT carry are listed in recon.md
section 2 and survive. The prompt nowhere states that Relay is EVM-only in
our integration or that Khalani bridges Solana (both catalog-proven). 304
tests with 773 string assertions pin the prompt: 264 invariants, 40
wording; six suites parse the prompt by heading. The only task-shaped
content is the Token Research Map in research.ts, organized by namespace.

## 4. Implementation mode

CHOSEN BY THE OWNER (2026-08-22): Codex build. After the plan is green-lit
on the thread harness-wave2, Codex implements it directly in the worktree
/home/kubas/Vex-wave2 (branch feat/prompt-wave2, never main) in
workspace-write mode, on the same thread so the review context is in it.
Codex is expected to use its own subagents for the breadth in WP1 (one
analyst per namespace writing one declaration file each, in parallel) and
to keep WP2 and WP3 sequential behind them. The coordinator (Claude) owns
WP0 (characterization snapshots, committed before Codex edits anything),
reads the whole diff Codex produces before accepting it, runs the
measurements and the gates, and reports. Codex-build safety: the worktree
is clean, the branch is not main, no commit or push by Codex, stop and
report instead of guessing when blocked.

## 5. Target shape of the prompt (what the model will read, in order)

Static prefix, same layer count and the same cache split:

1. Identity and precedence: unchanged text, minus the two relocations the
   ledger already marks (chain awareness moves to the declarations; the fee
   section stays verbatim).
2. Execution policy for the mode and permission: unchanged (six variants,
   one WAITING and one ERROR pattern).
3. Session wallets: verbatim.
4. Safety contract: verbatim, all eight sections.
5. Tool model: unchanged except the ledger's two DELETE blocks (the relocated
   "Reading an injected tool schema" walkthrough except its raw-units
   sentence); the deferred-schema loop sentence stays.
6. NEW "What Vex can reach": eleven protocol DECLARATIONS, one per namespace,
   each 1.2 to 2.5 KB, rendered from typed declaration modules (section 6).
   No Examples line, no facets, no Try line, no per-tool inventory, no
   dotted globs; one sentence once that a namespace is searched with
   ToolSearch and is never called by name. Availability by env stays a
   single line per gated namespace ("not available in this install until
   JUPITER_API_KEY is set"), keyed on the same env fingerprint.
7. NEW "How Vex works a task": task shapes, each with trigger, default
   procedure across layers, what to report, and the cross-namespace judgment
   that no description carries: research (discovery, depth, narrative; the
   DexScreener freshness lag; young-token guidance), swap (venue routing,
   failure classes, never switch venue for a trade-condition failure, same
   venue for quote and execute), bridge (Khalani primary; Relay for Robinhood
   Chain and only EVM; Khalani for Solana; reads on Robinhood go direct RPC),
   yield (the arbiter: fixed is Pendle, variable EVM is Morpho, Solana is
   Jupiter lend; never substitute a swap for a yield; Morpho vault versus
   market is who picks the venue), positions and risk (health factor framing,
   null health factor means no debt), launches (Trench versus pools.fun, the
   authority matrix pointer, cost before deploy), and the reporting
   contract. This is where the Robinhood-session defect is fixed.
8. Memory and learning, research tools, response formatting, time rules:
   unchanged except the ledger's RELOCATE rows (the WebResearch call-shape
   block folds into the research task shape; Tools Are Internal Machinery
   stays and gains its missing test).
9. Mode core: unchanged; the PRESERVE-VERBATIM sections untouched.
10. Loaded Content: verbatim.

Turn layers: unchanged, order unchanged, Safety Re-anchor last.

Venue policy text (D4 plus D13), stated once in the swap and bridge task
shapes and echoed in the four venue declarations: KyberSwap is the primary
swap route and Uniswap is an always-callable alternative for the pairs
KyberSwap cannot serve; Khalani is the primary bridge and bridges EVM and
Solana (khalani/manifest.ts:48); Relay is the only route to Robinhood Chain
4663 and, in this integration, signs EVM steps only
(src/tools/relay/chain-client.ts:179, health.ts:52); Trench and pools.fun
live on Robinhood Chain only. These facts are rendered from code constants
where one exists (TRENCH_CHAINS, POOLS_CHAINS, SOLANA_CHAINS,
KYBER_SWAP_CHAINS, the Khalani snapshot in chain-coverage.ts) and from a
new single Relay constant for the EVM-only fact, never from prose typed by
hand.

## 6. Protocol declarations: the new owner of per-namespace prompt prose

New module family src/vex-agent/tools/protocols/navigation/declarations/
<namespace>.ts exporting one typed ProtocolDeclaration:

- identity: one sentence, what the protocol is;
- offers: what Vex can do there, grouped by outcome (read, quote, act),
  without tool names;
- whenItApplies: the user intents that belong here, in the vocabulary of the
  frozen embeddingText for that namespace (D9 consequence: the model's own
  ToolSearch query must hit the index), listing which frozen terms the author
  echoed;
- characteristic: freshness, coverage, cost, rate limits, what it cannot do;
- chains: rendered from the catalog constants above;
- judgment: the cross-namespace bullets from recon.md section 2 that belong
  to this namespace (the descriptions do not carry them);
- searchHints: three queries the model would type into ToolSearch for this
  namespace, used by the retrieval gate in section 9.

The navigation entries keep their retrieval-facing fields untouched (facets,
hints, aliases, discoveryHints; D9). Their summary, whenToUse and
preferInstead stop being rendered into the prompt (they are superseded by the
declaration) but stay as they are for the lexical facets; the dotted-toolid
lint keeps scanning them. The renderer of the old capsule is deleted with the
Examples line and the EXAMPLE_TOOL_NAMES_PER_NAMESPACE constant.

Authoring: one Opus 5 low analyst per namespace reads the manifests, the
navigation entry, the doctrine section and the frozen embeddingText for its
namespace (the packet in recon.md section 8), and writes the declaration
file plus a short author note naming which doctrine sentences it judged
duplicated (with the description that carries them) and which it kept as
judgment. The coordinator reviews every note against the descriptions
before the doctrine section is deleted (ledger 2.7 caveat).

## 7. Facade split of protocols.ts

The four exported symbols keep their names and contracts
(buildProtocolsPrompt, buildBridgeCapabilityPrompt,
resetProtocolsPromptCache, protocolAvailabilityFingerprint). Internals move
to: declarations renderer (capability-map.ts), task-shapes.ts (new layer
builder exported through index.ts as its own static layer between Tool
Model and Memory), chain-coverage.ts (existing), bridge-capability turn
layer (existing), and the env-fingerprint cache (kept exactly, keyed on
requiresEnv NAMES). No memoization of capability-availability.ts.

## 8. Characterization, snapshots and the budget ratchet

1. BEFORE any edit: capture byte-exact snapshots of every static layer and
   the joined prefix for all six modes under both env fingerprints
   (JUPITER_API_KEY present and absent), committed as reviewed artifacts
   under src/vex-agent/engine/prompts/__promptsnaps__/ with a test that
   regenerates only under UPDATE_PROMPTSNAPS=true (the toolsnaps pattern).
   This is the ledger's own precondition and the diff reviewers read.
2. A byte-budget ratchet test: the committed per-mode static prefix size is
   pinned; growth fails the test; shrink updates the pin in the same change.
   The number is set from the measurement after the rebuild, never invented
   now.
3. The 40 wording-pinning tests are changed one by one with the contract
   change stated in each; the 264 invariant tests must stay green unchanged
   (any of them needing an edit is a stop: it means an invariant moved).
4. The heading-parsing suites get the new headings in the same change, with
   the snapshot diff as the review artifact.

## 9. Acceptance gate (D13 replaces the replay gate until sessions arrive)

- Characterization: 264 invariant tests green unchanged; every wording
  change stated.
- Budget: pnpm prompt-budget:report per mode, same env posture as Wave 0;
  the protocols-equivalent layers (declarations + task shapes) must land
  well under the 69.5 KB they replace; the expected order is 25 to 35 KB
  total, and the whole static prefix moves from 102-109 KB toward 60-70 KB.
  Reported, then pinned by the ratchet.
- Retrieval coupling (new, cheap, and the only measurable link between the
  prompt and ToolSearch): the 33 searchHints (3 per declaration) form a
  dataset measured on the dense path with the existing harness; the
  expectation per row is "at least one tool of that namespace in the top 5"
  (coverage group = the namespace's tools). Gate: every namespace passes. A
  miss means the declaration does not speak the index's vocabulary and the
  author rewrites the hint or the whenItApplies text, never the frozen
  index.
- The venue and chain facts are asserted by tests against the code
  constants they render from.
- Codex final review on the thread harness-wave2.
- The old-versus-new replay gate from the Batch 3 v2 plan is reinstated the
  moment the owner provides sessions; nothing here precludes it.

## 10. Work packages and sequencing

WP0 (coordinator): characterization snapshots under both fingerprints;
commit them first.
WP1 (eleven analysts, parallel, disjoint files): the declarations plus
author notes; each validated by a typed schema test and by the dotted-toolid
lint (declarations are prose the model reads).
WP2 (prompt builder): capability-map.ts renderer, task-shapes.ts, the facade
split, the deletion of the capsule renderer and of the duplicated doctrine
(per the reviewed author notes), the two ledger DELETE blocks in tool-model
and research, the Relay EVM-only constant, index.ts wiring, the budget
ratchet test, the missing test for Tools Are Internal Machinery.
WP3 (test builder): the 40 wording pins and the heading-parsing suites
aligned with stated contract changes; the promptsnaps regenerated once
centrally by the coordinator at the end.
WP4 (coordinator): measurements (budget, retrieval coupling), the combined
diff review, Codex final review, PR on the owner's word.

Order: WP0 -> WP1 and WP2 in parallel (WP2 renders a placeholder declaration
until WP1 lands) -> WP3 -> WP4.

## 11. Alternatives considered

- Grow the navigation entries' summary/whenToUse into the rich text instead
  of new declaration files: rejected, those fields double as lexical facets
  (D9 pressure on wording) and the dotted-toolid lint already treats them as
  retrieval-facing prose; a declaration is a prompt artifact with its own
  owner and tests.
- Keep the doctrine sections and only shorten them: rejected, the
  measurement shows the duplicated share is the majority and the surviving
  judgment is cross-namespace, which belongs to task shapes, not to protocol
  sections.
- A flag with two prompt stacks: rejected in the v2 review (second source of
  truth for the highest-leverage artifact); snapshots plus the ratchet are
  the rollback story (revert the commit).

## 12. Assumptions and uncertainties

- The analysts can judge duplication against the descriptions reliably; the
  coordinator's review of every author note is the control.
- The dense index vocabulary will be hit by the searchHints; if a namespace
  fails the coupling gate repeatedly, that is a D9 finding, not a reason to
  edit the index.
- The byte target is an expectation, not a requirement; the ratchet pins
  whatever is measured.

## 13. Risks and stop conditions

- Stop if any of the 264 invariant tests needs an edit.
- Stop if a PRESERVE-VERBATIM section changes by one byte (the promptsnaps
  diff shows it).
- Stop if a declaration states a chain fact from memory rather than from a
  constant, or names a dotted id, or pushes a venue outside the D4 pairs.
- Stop if the coupling gate fails for a namespace after one rewrite.
- No commit or push without the owner's word.

## 15. Codex plan review round 1 (DISCUSS) and the v2 changes

Where a line above conflicts with this section, this section wins.

1. Declaration owner (the aha): summary and whenToUse do NOT feed lexical
   retrieval (descriptions.ts getDiscoveryStringsForTool uses the namespace
   and the facet fields; metadata-compile.ts uses aliases and facet hints;
   dense uses the frozen embeddingText). So the simpler alternative stands:
   extend ProtocolNamespaceNavigation with a typed, readonly `declaration`
   object inside the existing eleven navigation entries (one metadata owner
   per namespace), keeping aliases, facets, facet hints, discoveryHints,
   exampleQueries and embeddingText byte-identical (a test pins that the
   retrieval-facing fields did not change between the pre-wave snapshot and
   the result). No separate declaration module family. summary, whenToUse
   and preferInstead stop rendering into the prompt and are superseded by
   the declaration; the dotted-toolid lint scans the declaration fields.
2. Layer count: task shapes are NOT a new static layer. buildProtocolsPrompt
   composes "What Vex can reach" (the declarations) and "How Vex works a
   task" (the task shapes) internally, so the layer count, the cache split,
   the layer-composition tests and the four-symbol facade are preserved.
3. Chain facts come from runtime-owned sources, not from the retrieval
   name lists: TRENCH_CHAIN_ID, POOLS_CHAIN_ID, SOLANA_SYNTHETIC_CHAIN_ID,
   getKyberChains(), Khalani's pinned and live capability projections
   (chain-coverage.ts and the bridge capability turn layer), and Relay's
   BRIDGE_FAMILY = "eip155". The static Chain Coverage table becomes a data
   projection consumed by the declarations (one rendering of coverage, per
   declaration), its existing tests re-pointed at the projection.
4. The retrieval-coupling gate is replaced by a STATIC coupling invariant:
   every retrieval term a declaration lists as model-visible vocabulary
   must be present in at least one embeddingText of that namespace (a
   unit test), plus the frozen-retrieval-field test from item 1. Hidden
   searchHints are dropped. Actual prompt-to-query behavior is deferred to a
   model replay or a model-query-generation eval when sessions exist.
5. Auditable migration artifacts, produced BEFORE any prose is deleted and
   reviewed by the coordinator: (a) a committed test-migration inventory
   naming every prompt-text test and assertion in the 26 files, its
   category (invariant: must not change; wording: may change), the old
   contract, the new contract and the destination; the numeric stop
   condition becomes "no edit to any test classified invariant"; (b) a
   doctrine migration ledger assigning every surviving sentence exactly
   once: protocol-local characteristic or limit to a declaration;
   cross-protocol routing or procedure to a task shape; approval or
   irreversible-effect prose to its exact preserved destination; every
   deleted sentence names the tool description that carries it.
6. Venue preference (D4) is stated ONCE, in the swap and bridge task shapes;
   the four venue declarations describe their venue neutrally.
7. Reporting is a cross-cutting communication contract (it stays where the
   response-format layer has it), not an eighth task shape. Prediction
   markets are declaration-only: the solana declaration states the
   multi-stage sequence (discover event, read market, buy or sell, claim)
   because it is single-namespace. A facet coverage matrix is added: every
   navigation facet is represented in a declaration; task shapes exist only
   for multi-stage or cross-namespace judgment.
8. No prompt-revision persistence in this wave. Versioning is the committed
   per-mode prompt snapshots plus the source revision.
9. Budget: 25 to 35 KB is a forecast, not a quota. The first landing must be
   semantically complete and below 69,568 B for the protocols layer; the
   ratchet is a CEILING set from the measured result (exact byte changes
   are already caught by the snapshots).
10. Sequencing under Codex build: WP0 (coordinator) commits the baseline
    snapshots and the recon doc so the tree is clean; Codex then produces
    the eleven analyst reports (its own subagents, batches of three) and
    reconciles them into the doctrine migration ledger and the test
    migration inventory; the coordinator reviews both; only then Codex
    renders declarations and task shapes inside the protocol layer, deletes
    prose per the ledger, aligns the wording pins, and the coordinator
    regenerates the prompt snapshots centrally and measures. No placeholder
    renderer.
11. Model note for the owner: Codex subagents run on Codex's model, not on
    Opus 5 low; the owner's "Opus 5 low always" applies to Claude's
    subagents. Under the owner's choice of Codex build, the analysts are
    Codex's.
12. Factual corrections taken: only two of the four protocols.ts exports
    have production callers (buildProtocolsPrompt,
    buildBridgeCapabilityPrompt); the facade is kept anyway, at low cost.
    The worktree was not clean (recon.md untracked); WP0 commits it.
13. The owner's "personality" set up in vex-app (the Personalize screen,
    SidebarProfile.tsx; schema vex-app/src/shared/schemas/user-profile.ts;
    IPC vex:settings:setUserProfile) already reaches the prompt as the
    "## User profile (style preferences)" block in identity.ts:97-151:
    address-as name, work description, tone preset, style traits, risk
    appetite (tone only, never authority), the free-form instructions
    Markdown through sanitizeUntrustedBlock, and the subordination clause
    LAST. Wave 2 renders this block byte-identically in its current
    position (the per-mode snapshots prove it), and no declaration or task
    shape restates, re-voices or references the profile: voice and address
    are the profile's job, capability and procedure are the rebuild's. The
    pre-existing em dash in the tone line (identity.ts:126) is an untouched
    line under O12 and is left as is unless the identity layer is rewritten
    for another reason.

## 14. Verification plan

pnpm test; tsc --noEmit; build; test:unsafe-escapes; typecheck:test:ratchet;
git diff --check; check:em-dash; toolsnaps (unchanged, must stay 174/174);
manifest-lint; promptsnaps; the budget ratchet; prompt-budget:report; the
retrieval coupling dataset through tool-retrieval-probe on the eval
database; test:eval:lexical 13/13 (nothing here touches descriptions, so no
drift is expected: a drift is a stop).
