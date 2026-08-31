# Owner Decisions - Tool Surface Program

Recorded 2026-08-21, after Batch 1 GREEN LIGHT. These ratify the open items
carried out of Batch 1 and bind the later batches.

## D1. Canonical free-text key: `query`

`query` is the canonical free-text search parameter fleet-wide. `search`
(morpho) migrates in the parameter wave; the conventions.ts ratification is
superseded by this decision. Continuation keys stay per API type: `offset`
for offset-paginated APIs, `cursor` for cursor APIs.

## D2. ToolSearch visible immediately, and exported to MCP

- In-app: the describe_tools reveal gate is retired; ToolSearch (the merged
  discovery tool) is visible from the first request.
- MCP export: ToolSearch IS exported, as a READ-ONLY catalog-search tool: it
  returns ranked matches (publicName, one-liner, whyMatched) over the same
  embedding+lexical index the in-app agent uses. It never mutates the MCP
  tools/list, which stays the full static catalog (spec 2026-07-28
  compliance). External agents get Vex's semantic search on top of their own
  deferred loading; the in-app agent keeps injection as today.
- execute_tool still never exports.

## D3. wallet_balances response_format default

Attempt the flip to `concise`, decided by a REAL equivalence test: a live
read-only probe using the vault credentials (agents-colab/agents_dm/.env),
comparing bare-call detailed vs concise output on a real funded wallet. Flip
only if nothing the agent relies on is lost; otherwise `detailed` stays as a
documented exception. Owner authorized the live probe.

## D4. Venue tools: un-gated, always visible, primary venue preferred

The Relay pair (bridge_quote_relay, bridge_execute_relay) and the Uniswap
pair (swap_quote_uniswap, swap_execute_uniswap) LOSE their reveal gating and
become always-visible internal tools alongside the Khalani/KyberSwap
routers. Naming follows the variant-B mapping (venue-suffixed PascalCase).
The system prompt (Tool Map doctrine) states the preference: KyberSwap is
the primary swap route and Khalani the primary bridge route; the venue tools
are alternatives, not the default choice. Consequences accepted: the typical
internal surface grows by ~4 tools; the three-mirror reveal sets
(relay-reveal, uniswap reveal ids, describe reveal) are DELETED in Batch 2,
which simplifies visibility.ts, injected-protocol-tools.ts, and the pressure
mirrors; toolsnaps regenerate accordingly.

## D5. Alias removal policy: liberal, preview-stage

The product is a production preview. Aliases exist primarily to keep
in-flight state safe (stored approvals, the rename transition itself), not
to guarantee indefinite compatibility. Removal proceeds via the
owner-acceptance branch of the removal condition: the owner accepts that a
durable artifact (an old active plan) may emit a retired name and receive
the unknown-tool answer with the discovery hint. removeAfter entries should
name this acceptance rather than long quiescence windows.

## D6. No method-enum consolidation

solana.predict and pendle read families stay as separate tools (mutually
exclusive required params make a method enum worse, per the S2 evidence).

## D7. Near-typo merges approved for Batch 2

- kyberswap.chains + kyberswap.chains.supported -> one kyberswap__chains_list
  with liveStatus, state joined by chainId, null with a stated reason when
  the live service is unavailable.
- virtuals.graduations: the stop condition FIRED and both tools were KEPT.
  Evidence (Batch 2): `matchesStatus` answers `graduated` on
  `status === "AVAILABLE"` alone, while `isGraduation` also requires
  `lpCreatedAt !== null`, so either direction of the merge changes what an
  AVAILABLE row with a null LP time does; the same guard also feeds the
  anti-sniper window. This line originally read "retired into
  virtuals__agents_discover", which described the proposal rather than the
  outcome and was corrected in Batch 3 after a builder read the record
  against the live tree and found the tool alive.
- dexscreener.profiles + profiles.recent and dexscreener.boosts + boosts.top
  merged (identical param surfaces).

## Task 0 authorized: wallet_send -> agent_activity, end to end

Fix the gap now, before the rename wave, as its own task: agent transfers
must land in the unified agent_activity history (agent_scan views, portfolio
history, AgentScan egress). Scope includes checking the AgentScan server
contract (github.com/BerzanTas/vex-agentscan) for transfer-event support and
completing the Vex side. Owner authorized a LIVE end-to-end test: one small
real transfer to 0xebbD6B3746d7e40DD6291566821f3a8159773836 from the local
funded wallet (vault credentials in agents-colab/agents_dm/.env), executed
through the normal approval flow after the fix lands, on the cheapest funded
chain.

## D8. Protocol description template: positive-only by default

Recorded 2026-08-21, binding for the description rewrite wave (Batch 3).

Crypto protocol tools are not GitHub tools: most have no overlapping sibling
to be confused with. The default protocol description is POSITIVE-ONLY:

- what the tool offers;
- when to use it;
- what it returns;
- SPENDS + approval + preconditions on mutations (unchanged, rule 90).

A "use X instead" routing sentence is permitted ONLY where a real overlap
exists and the model demonstrably picks wrong without it, and it names the
alternative concretely. The known overlap pairs: swap KyberSwap vs Uniswap,
bridge Khalani vs Relay, yield Morpho (variable) vs Pendle (fixed), the
search families. Nothing else carries a when-NOT clause; boilerplate
negative guidance on non-overlapping tools is a defect, not diligence. This
matches the reference's own rule (a second sentence exists only to resolve
a decision the model would otherwise get wrong) rather than copying its
surface form.

## D9. embeddingText frozen; retrieval is its own benchmark exercise

Recorded 2026-08-21, scoping Batch 3.

`discovery.embeddingText`, aliases and example intents STAY AS THEY ARE.
Retrieval quality gets its own measured exercise later, informed by the
ToolSearch traffic extractor (which records the queries the MODEL writes, not
the user's prose - the model reads the prompt, forms an intent, and searches
in its own words).

Consequences for Batch 3:

- Two surfaces in scope, not three: manifest `description` plus param
  descriptions, and the navigation metadata the capability map renders from.
- No re-embedding wave. Dense vectors read `embeddingText`, which does not
  change, so description edits cannot move them. What remains is an
  orphan/health pass for the three toolIds retired in Batch 2.
- The lexical eval still gates this batch: lexical scoring DOES read
  descriptions (`protocols/lexical-score.ts:50`), so a description wave moves
  lexical retrieval. Wave 0's recaptured baseline is exactly what makes that
  delta attributable.
- The vocabulary constraint reverses, and gets cheaper. Instead of tuning two
  surfaces toward each other, the capability map is written to match the
  vocabulary the FROZEN `embeddingText` already uses, so the queries the
  model forms from the prompt hit the tools that exist. Read it, then write
  the map to speak the same language.

### D9 amendment: one-time unfreeze for `khalani.tokens.balances`

Ruled 2026-08-29 by the owner, scoped to the wallet-solana arc.

The freeze is lifted ONCE, for the `discovery.embeddingText` of
`khalani.tokens.balances` only. Every other D9-frozen field stays frozen and
this is not a precedent for the retrieval exercise.

Why the exception was granted: the frozen text advertised a Solana balance
scan that the tool no longer performs and that Khalani never performed
correctly. Khalani's Solana scan answers ZERO tokens, so both agent tools
reported `$0` for a funded wallet while the Portfolio sidebar showed the real
balance (owner screenshot, 2026-08-28). The arc routed Solana to direct RPC in
both tools; leaving the retrieval text advertising the old, wrong source would
keep pointing the model at a capability description that no longer matches the
lane. A freeze that preserves an inaccurate claim about a money-path read is
protecting the wrong thing.

What changed: one clause added, stating that EVM balances are read through
Khalani while Solana balances are read directly from Solana RPC. The wording
matches the model-facing manifest description in the same change, so the two
surfaces speak the same language (the D9 vocabulary constraint above).

Consequences carried out with the edit:

- `__promptsnaps__/navigation-retrieval-fields.json` regenerated through the
  fixture's own escape flag, `UPDATE_RETRIEVAL_FIELDS_FIXTURE=true`. That flag
  exists, in the suite's own words, "for the day the owner unfreezes them";
  this ruling is that day, for this one field;
- the canonical lexical baseline recaptured. It did NOT move: measured
  2026-08-29, zero metric values changed. That is not luck, it is the lane's
  construction - `protocols/lexical-score.ts` scores navigation strings,
  param text and the manifest `description`, and contains no reference to
  `embeddingText` at all. The lexical movement earlier in this arc came from
  the description edits, which were never D9-frozen.

One consequence this amendment does NOT close. D9 above reasons that
"description edits cannot move [dense vectors], because dense vectors read
`embeddingText`, which does not change". For this one tool that premise is now
false: `khalani.tokens.balances` has a dense vector embedded from the OLD text.
Until it is re-embedded, its stored vector and its manifest disagree. Nothing
in the shipped product reads that vector today (the dense lane is opt-in,
`pnpm test:eval:dense`, and per OPEN-DECISIONS O18 the seed dense baseline is
already stale at v3-agent-200 and behind its floors), so this is a recorded
debt for the retrieval exercise rather than a live defect: whoever runs the
next re-embedding pass picks it up with everything else.

## D10. The capability map names every protocol and what it does

Recorded 2026-08-21, correcting the plan's "thin capability map".

The model writes its own ToolSearch query. It can only search for what the
prompt told it exists: a model that has never read the word "Morpho" cannot
form a query that finds Morpho. So the map is NOT thinned by dropping
protocols.

What stays: every namespace, what it is, what it is for, and its
characteristic (freshness, coverage, cost) - one to two lines each, enough to
form a good query. What goes: the per-tool inventory, example toolIds, every
facet and the per-namespace doctrine, which the injected tool definitions and
ToolSearch already carry and which the model currently reads twice.

## D11. Overlap pairs ranking together is the desired outcome

Recorded 2026-08-22, closing Batch 3 open item 6.

Wave 1's truthful description additions moved Relay above Khalani and Uniswap
above KyberSwap on some generic LEXICAL queries, because `lexical-score.ts`
has no length normalization. The owner ruled this a non-issue:

- The default ToolSearch path is dense retrieval over the FROZEN
  `embeddingText` (`protocols/dense-score.ts`); lexical scoring runs only as
  the fallback when the embedding model, DB or table fails. Description
  edits cannot move the default ranking at all (D9).
- KyberSwap with Uniswap, and Khalani with Relay, surfacing together at the
  top of a result is exactly what the model should see. The venue preference
  lives in prompt prose (D4), not in retrieval order.

Consequences: no ranking work is owed in Batch 3. `pnpm test:eval:lexical`
stays as a fallback-path regression guard with the Wave 0 recaptured
baseline, not as a ranking target. Length normalization, if ever wanted,
belongs to the D9 retrieval benchmark exercise.

## D12. Batch 3 open items ruled

Recorded 2026-08-22.

- `solana.predict.pnlHistory` stays shipped despite answering 404 for every
  wallet since 2026-07-24. No retirement, no hiding.
- The over-2048-byte descriptions. The owner ratified "seven fund-moving
  tools" on 2026-08-22; that count came from a builder's report and was
  NOT measured. Measured the same day over the contract snapshots: 32 of
  167 tools exceed 2048 bytes, 31 of them exported (morpho 18, internal 3
  exported plus LoopDefer, dexscreener 3, trench 2, pendle 2, pools 1,
  khalani 1, kyberswap 1), the largest morpho__vaults_discover at 6114 B.
  The seven fund-moving ones the owner saw are ratified. The other 24 are
  an OPEN decision: the bound matters only for consumers that truncate
  (Claude Code cuts MCP descriptions at about 2 KB; the in-app agent does
  not cut), so the choice is between accepting "critical facts first" as
  sufficient for the Studio export, or a dedicated metadata-only pass on
  the Morpho reads whose descriptions repeat doctrine the prompt already
  carries. No description changes until the owner rules.
- The AgentScan server branch `feat/transfer-kind` is pushed. Transfer
  egress on the Vex side is switched on only after that change is merged
  and deployed (Batch 4, Task 0b).

## D13. The system prompt: default, declarative, rich per-protocol descriptions

Recorded 2026-08-22 from the owner's words. Refines D10's "one to two lines"
and the venue sentence of D4; the v2 plan's Wave 2 gate is adjusted.

- Shape: a DEFAULT system prompt in the spirit of the one Claude Code gives
  its own model. It declares what exists in the system (identity, modes,
  tools, protocols, doctrine) and lets the model choose; it does not push the
  model toward any protocol. It is authored the way the model itself would
  want to receive it, given this many protocols and several modes.
- Protocols: every protocol gets a RICH description (what it is, what it
  offers, when it applies, its characteristic and its limits), produced by
  one analysis subagent per protocol that reads that namespace alone. What
  still goes is the per-tool inventory and the doctrine the injected tool
  definitions already carry: richness REPLACES duplication, it does not stack
  on top of it. `pnpm prompt-budget:report` against the Wave 0 baseline
  (103.7 to 110 KB, protocols 71 KB) measures the result.
- Venues: the KyberSwap and Khalani preference STAYS in prompt prose (D4),
  and the prompt ALSO states that Uniswap and Relay are available as
  fallbacks, with each venue's chain coverage taken from the catalog and
  navigation metadata, never from memory. Verified 2026-08-22: the Relay
  integration signs EVM steps only (`src/tools/relay/chain-client.ts:15,179`
  requires `vmType === "evm"`, `health.ts:10-11` puts Solana out of scope,
  `relay/handlers/bridge/legs.ts:192` refuses `vm_type_not_evm` by name);
  Khalani bridges EVM and Solana (`khalani/manifest.ts:48`); Relay is the
  only bridge for Robinhood Chain 4663, which Khalani's registry lacks
  (`relay/manifest.ts:3`). The prompt states exactly that.
- Acceptance: the owner did not select sessions for the old-versus-new
  replay. Wave 2's gate is characterization tests, the retrieval measurement
  from Batch 3 WP5, and coordinator plus Codex review. The pre-registered
  replay gate from the v2 plan is reinstated the moment sessions are
  provided.
- Wave 2 runs as its own arc after the Batch 3 closure PR.

## D14. Order of the remaining work

Recorded 2026-08-22 from the owner's words ("2 3 4 przed 1, nie mamy czasu
na razie").

1. Batch 3 closure PR (this arc).
2. Wave 2: the system prompt rebuilt from scratch (D13).
3. Batch 4: parameter vocabulary, output envelope, response_format, Task 0b
   egress (each item behavior-touching, owner decision per item: O3 to O5).
4. The Studio MCP server and its real test with a real client.
5. LAST, when there is time: the per-protocol live-test phase (every tool
   called for real through the dispatcher, O15 to O17, the funded harness
   mode and the on-chain spend guard).

The funded wallets stay as they are; nothing is spent before phase 5.

## D15. O3 ruling: ratify the vocabulary, alias the six renames

Recorded 2026-08-22 from the owner's choice on the Batch 4 brief (evidence:
`batch4/recon.md`).

- The 141 allowlisted keys that have no canonical target are RATIFIED into
  `CANONICAL_PARAM_KEYS` (`protocols/conventions.ts`), each with its reason,
  and their 325 `param-key` allowlist entries are deleted. Metadata only:
  no manifest, handler, snapshot or fingerprint changes.
- The six true renames, all on READ tools, land WITH input aliases:
  `wallet` -> `walletFamily` on `BridgeStatus`, `khalani.orders.list`,
  `khalani.tokens.balances`; `address` -> its canonical spelling on
  `BridgeStatus`; `search` -> `query` on `morpho.markets.discover` and
  `morpho.vaults.discover` (the rename D1 created).
- Alias contract: `ProtocolParamDef.aliases` names retired spellings. Step 0
  of `validateProtocolParams` rewrites an alias to its canonical key in
  place, before unknown-key rejection, so the handler, the capture row and
  every gate see one spelling. A call carrying both spellings is rejected
  by name. An alias is never emitted in the JSON schema the model sees.
  Aliases enter the manifest fingerprint (`tool-call-envelope.ts`) because
  normalization reads them. Each alias carries a `removeAfter` naming D5's
  owner-acceptance branch.

## D16. O4 ruling: describe what is emitted, make four silent handlers honest

Recorded 2026-08-22 from the owner's choice.

- METADATA: the descriptions of the fifteen tools whose handlers already
  emit a continuation signal name those fields exactly as emitted.
- BEHAVIOR, additive: `trench__images_list`, `WalletBalances`,
  `virtuals__genesis_launches_list` and `solana__predict_events_search`
  gain the continuation or truncation fields their pagination class
  requires (`parameter-vocabulary.md` section 4), computed from facts the
  handler already holds. No new provider call, no extra fetch.
- Still OPEN (O4 narrowed): the `summary` sweep over the 44 handlers
  without one (needs a naming rule first: a provider object named
  `summary` and fourteen `message` / `note` fields exist) and the five
  handlers whose honesty needs an extra fetch. O5 is deferred to the
  Studio MCP design (D14 step 4).

## D17. response_format: one module, four states, wallet_balances keeps detailed

Recorded 2026-08-22 from the owner's choice (R2 in `output-envelope.md`
section 7.3).

- One shared module owns the enum, the manifest param fragment, the Zod
  fragment, the raw-params reader and the retired-by-name rejection: four
  states (offers both with default `concise`; offers both with default
  `detailed`; does not offer the param; retired, rejected by name).
- `wallet_balances` keeps `detailed` as a ratified exception, because a
  `concise` default would make `{limit}` without a format start trimming
  and re-ordering rows on a money-adjacent read. A test pins today's
  behavior: `{limit: N}` without `response_format` returns every row.
- Task 0b stays closed: the AgentScan server branch has no pull request
  and is not in `dev`; the Vex-side switch is two SQL lists plus a
  readiness arm (`batch4/recon.md`).

## D18. Studio MCP server: github-mcp-server is the reference for code and architecture

Recorded 2026-08-22 from the owner's words ("github-mcp jako wzór dla kodu,
a także architektury").

- The reference checkout `agents-colab/github-mcp-server` is the quality
  bar for the Studio MCP server on BOTH axes: the code (how a production
  first-party server is structured, tested and documented) and the
  architecture (toolsets and their grouping, dynamic discovery, read-only
  mode, instructions, minimal output types, pagination reporting, error
  handling by audience, transports, auth handling). A pattern reference,
  never code to copy verbatim; repository rules and boundaries win on
  conflict.
- Before the Studio MCP design is written, a deep-research pass records
  what a modern MCP server looks like in 2026 (protocol revision,
  transports, auth, tool annotations, structured output, elicitation,
  tasks, dynamic tool lists, tool search and lazy loading, security
  guidance, how Claude Code and Codex CLI consume servers), with
  citations, in `tool-surface-spec/studio-mcp/`.

## D19. Research priorities in the task shape

Recorded 2026-08-22 from the owner's words on the rendered Research shape.
Applied on feat/prompt-wave2 (PR #109) in `engine/prompts/task-shapes.ts`.

- DexScreener is the PRIMARY research surface on every chain: identity,
  pairs, liquidity, volume, price sanity, narratives and promotion are
  resolved there first.
- Web search (`WebResearch`) and Twitter (`TwitterAccount`) add news,
  narrative and social evidence. Both are env-gated, so the sentence
  names only the tools whose key is configured (the availability
  fingerprint of the protocols layer now includes RETTIWT_API_KEY next to
  TAVILY_API_KEY and JUPITER_API_KEY).
- On Solana, Jupiter's `solana__tokens_discover` trending and recent feeds
  add fresh discovery (rendered only with JUPITER_API_KEY).
- Trench, pools.fun and Virtuals are launchpad-native reads of LOWER
  general value: reached for only when the token lives on that launchpad
  or the user names it. The freshness-lag sentence keeps the one case
  where they come first (a token DexScreener has not indexed yet).
- The three-layer rule and the mission-setup exception are unchanged.

WITHDRAWN the same day (2026-08-22, "niech widzi protokoły i sam sobie
wybierze"): the prompt carries NO ranking of research surfaces. The
Research shape keeps only the Codex-approved text (three layers in agent
sessions and mission runs, orientation in mission setup, the neutral note
that DexScreener indexing lags so a launchpad-native read or Jupiter's
recent feed can see a token first). The model reads the eleven protocol
declarations and chooses. feat/prompt-wave2 was restored to the 76f6306d
prompt text after 913b9405.
