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
- virtuals.graduations retired into virtuals__agents_discover, with the
  recorded stop condition: if moving the lpCreatedAt guard changes
  status=graduated semantics for the affected rows, keep both.
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
