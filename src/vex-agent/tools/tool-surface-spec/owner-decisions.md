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
