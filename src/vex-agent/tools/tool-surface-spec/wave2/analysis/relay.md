# Relay namespace analysis

## Identity and outcomes

Relay is Vex's keyless cross-chain bridge venue. It previews and executes token movement between EVM chains. Its special product role is reaching Robinhood Chain when the live Relay health gate says that route is serviceable.

- Read: inspect whether both route sides are serviceable and inspect returned route steps, amounts, timing, impact, fees, and provider state. The packet exposes these facts through a preview rather than a separate discovery read.
- Quote: preview a route without signing or broadcasting. The result distinguishes estimated USD values from executable amounts and reports the Vex fee split, minimum output, ETA, and serviceability.
- Act: after a fresh matching quote and user approval, sign and broadcast the origin deposit. The call returns while the destination fill is pending. Background confirmation owns finalization, so the caller must not repeat the bridge or poll the action in a loop.

## Retrieval terms

All terms below occur in `protocols/embeddings/relay/bridge.ts` after case and whitespace normalization. Each is also present in the draft declaration.

| Intended term | Carrying embedding passage |
| --- | --- |
| `cross-chain bridge` | quote and execute passages |
| `Relay quote to Robinhood Chain` | quote passage |
| `preview bridge Base ETH to Robinhood` | quote passage |
| `cost to bridge into Robinhood` | quote passage |
| `quote bridge out of Robinhood` | quote passage |
| `bridge ETH` | quote and execute passages |
| `move funds into Robinhood Chain` | execute passage |
| `fund my Robinhood wallet` | execute passage |
| `then swap on-chain` | quote and execute passages |

Dropped from the suggested packet vocabulary: `bridge quote to robinhood` and `bridge to/from robinhood`. Neither exact phrase occurs in an `embeddingText`; aliases are not evidence for this invariant.

## Characteristics, limits, and chain coverage

- Freshness: execution requires a fresh matching Relay quote. Route serviceability depends on the live Relay chain registry, with both sides required to be EVM, deposit-enabled, and not disabled.
- Cost: Vex charges 25 bps on the input token. The route is priced after that deduction, and the separate treasury transfer runs only after the origin deposit. Provider fees, impact, and USD values remain estimates until execution.
- Completion: an accepted execution is pending, not final. A missing provider status is unknown, not proof that the fill remains pending.
- Coverage: `BRIDGE_FAMILY = "eip155"` in `src/vex-agent/tools/protocols/relay/handlers/bridge/constants.ts`. `resolveRelayOnlyStepClients` and `foundChainHealthFailure` reject non-EVM chains. Therefore this integration is EVM-only and does not support Solana. The active Relay catalog entry proves the bridge surface exists, but the packet provides no static complete Relay chain list. Specific reach must come from the live registry and health gate.
- Robinhood Chain: chain id 4663 is absent from the pinned Khalani projection in `chain-coverage.ts`; the turn layer advertises Relay reach only when Relay health passes. This is a health-gated route fact, not an unconditional catalog claim.
- Rate limits: packet insufficient. No Relay rate-limit contract or numeric limit appears in the permitted sources.

## Facet coverage

| Frozen facet label | Declaration prose that represents it |
| --- | --- |
| Bridge quotes and execution | The Quote and Act paragraphs distinguish read-only route preview from an approved origin broadcast and pending destination fill. |

## Doctrine and capsule judgment

`DUPLICATED` means deletion is supported by an exact phrase in a tool description. `JUDGMENT` identifies the one destination that must retain the meaning.

| Source sentence or rendered line | Verdict | Evidence or destination |
| --- | --- | --- |
| "Relay is a keyless cross-chain bridge: it moves a token on one chain into a token on another with no bridge account and no manual claim, quoted first and then executed." | JUDGMENT | Declaration, local identity and quote-then-act capability. The no-account and no-manual-claim details are not individually stated in the descriptions. |
| "It is the ONLY route Vex has to or from Robinhood Chain (4663), which Khalani does not cover, and it also bridges across Relay's wider chain registry." | JUDGMENT | Declaration, local chain coverage, guarded by live health. The descriptions carry the Robinhood clause, but not the complete wider-registry limit. |
| "Use to bridge funds to or from Robinhood Chain (Khalani does not cover 4663): bridge ETH/USDG/VIRTUAL in to fund trading, or bridge back out." | DUPLICATED | `relay.bridge`: exact contiguous phrase before the source separator, "Use this when the user wants to move funds to or from Robinhood Chain (Relay is the ONLY bridge there"; source separator encoded as `U+2014`; exact contiguous phrase after it, "Khalani does not cover it): bridge ETH, USDG, or VIRTUAL into Robinhood Chain to fund trading, or bridge back out, then swap on-chain via Uniswap." |
| "Use `khalani` for bridges between its supported chains; use `relay` whenever either side is Robinhood Chain (or Khalani lacks the route)." | JUDGMENT | Bridge task shape. This is D4 cross-provider preference, not neutral venue identity. |
| "Quote/execute keyless cross-chain bridges to and from Robinhood Chain and Relay's other chains." | DUPLICATED | `relay.quote.get`: "PREVIEW a Relay cross-chain bridge without signing or sending anything"; `relay.bridge`: "Execute a REAL Relay cross-chain bridge." |
| "Examples: relay__bridge_quote_get, relay__bridge_execute" | DUPLICATED | Structural capsule line derived from the same two catalog descriptions. Delete with the capsule renderer; it adds no capability prose. |
| "Contains mutating tools (may require approval)." | DUPLICATED | `relay.bridge`: "SPENDS FUNDS: it signs and broadcasts the origin-chain deposit from the user's wallet, requires approval before it runs, and cannot be undone". Keep that description byte-exact. |
| "Try: ToolSearch(query=\"bridge to robinhood\", namespace=\"relay\") · ToolSearch(query=\"bridge quote relay\", namespace=\"relay\") · ToolSearch(query=\"bridge out of robinhood\", namespace=\"relay\")" | DUPLICATED | Frozen `exampleQueries`, aliases, discovery hints, and embedding passages continue to own retrieval. The rendered line may go; the fields must not change. |
| "Between two Khalani-supported chains, bridge with `BridgeQuote` then `BridgeExecute` (they auto-route to `khalani.*`)." | JUDGMENT | Bridge task shape, D4 preference and procedure. |
| "The live chain list is in the turn state." | JUDGMENT | Exact preserved destination: dynamic `buildBridgeCapabilityPrompt` turn layer. |
| "Quote and execute on the SAME bridge provider (`khalani` or `relay`)." | DUPLICATED | `relay.bridge`: "REQUIRES a fresh matching relay__bridge_quote_get first." |
| "The runtime enforces this." | DUPLICATED | Same execute-description phrase states the enforced prerequisite. |
| "Reads on Robinhood Chain go direct-RPC: `WalletBalances` for balances, `ChainRead` for tx receipts / ERC-721 mints / a direct `erc20_balance` read (alias `robinhood` / id 4663)." | JUDGMENT | Bridge task shape, cross-namespace procedure. Relay's packet cannot prove the named read contracts. |
| "`khalani__token_balances_get` does NOT cover it." | JUDGMENT | Bridge task shape, cross-provider limit. Relay's packet cannot independently prove the Khalani read limit. |
| "Before planning an action on a chain, confirm you can REACH it and LEAVE it: the venues per chain are listed below and do not change within a session, while live bridge reach is in the turn state." | JUDGMENT | Bridge task shape for the reach-and-leave check; exact preserved dynamic turn layer for live reach. |
| "A chain you can swap on but cannot bridge off is a position you can enter and not exit, so check the bridge column before committing funds, not after." | JUDGMENT | Bridge task shape, cross-namespace planning rule. |
| "Bridge column: `khalani+relay` means both bridges are expected to serve the chain and the router picks one automatically; `RELAY ONLY` means Khalani does not serve it and every bridge goes through Relay." | JUDGMENT | Per-declaration chain coverage projection plus bridge task shape. Replace the old table terminology; D4 preference belongs only in the task shape. |
| "The column is a pinned snapshot, so confirm a route by quoting before relying on it." | JUDGMENT | Bridge task shape for quote-before-reliance; declarations consume the pinned coverage projection. |
| Generated EVM chain rows from `chainLine` | JUDGMENT | Per-declaration chain coverage projection. Relay coverage remains live and EVM-only; do not turn the KyberSwap chain list into Relay truth. |
| "Solana: swap, lend via `solana.*` (Jupiter)." | JUDGMENT | Solana declaration, not Relay. |
| "Not an EVM chain and not in the table above; its bridge reach is in the turn state." | JUDGMENT | Relay declaration local limit for EVM-only; exact preserved dynamic turn layer for live bridge reach. |
| "Bridge-supported chains (Khalani): [live names]." | JUDGMENT | Exact preserved destination: dynamic `buildBridgeCapabilityPrompt` turn layer. |
| "This bridge chain list may be up to a day old; confirm a route by quoting before relying on it." | JUDGMENT | Exact preserved destination: dynamic turn layer. Preserve its actual punctuation and wording byte-exact. |
| "Bridge chain list unavailable; verify by quoting." | JUDGMENT | Exact preserved destination: dynamic turn layer. Preserve its actual punctuation and wording byte-exact. |
| "Robinhood Chain (4663): bridges via Relay only." | JUDGMENT | Dynamic turn layer remains health-gated; declaration states the conditional local coverage fact. |
| "To fund Robinhood Chain, bridge ETH, USDG, or VIRTUAL in with `BridgeQuote` then `BridgeExecute` (they auto-route to Relay for this chain), then swap on-chain with `SwapQuote`/`SwapExecute`; reverse the flow to exit." | JUDGMENT | Bridge task shape, multi-stage bridge-then-swap procedure. |

## D4 note

The Relay declaration below is neutral about venue preference. Khalani-first preference and Relay fallback criteria belong only in the bridge task shape. Relay's Robinhood role remains a coverage fact because the pinned Khalani projection excludes chain 4663 and the Relay turn layer is health-gated.

## Draft declaration

Relay is a keyless cross-chain bridge for moving a token from one EVM chain to another. It is quoted first and then executed, with no bridge account or manual destination claim. Its distinctive role is access to Robinhood Chain when live route health confirms serviceability, while its wider reach follows Relay's live chain registry.

Read: inspect a route's serviceability, source and destination, steps, input and output amounts, minimum output, estimated time, total impact, slippage, fee buckets, and last provider state. Human-readable USD values are estimates, not traded prices. An unreachable status source means the state is unknown.

Quote: preview a cross-chain bridge without signing or broadcasting. Use a Relay quote to Robinhood Chain to learn cost and ETA before moving funds. Relevant requests include preview bridge Base ETH to Robinhood, cost to bridge into Robinhood, quote bridge out of Robinhood, and bridge ETH or another supported token across chains.

Act: after a fresh matching quote and user approval, broadcast the origin deposit. The action returns while the destination fill is pending, and background confirmation finalizes it later. Do not submit the same bridge again or poll the action in a loop merely because the immediate result is not final. Approval, spend, and irreversible-effect wording remains in its exact preserved safety instructions.

This integration is EVM-only and does not support Solana. Both route sides must appear in the live registry as EVM, deposit-enabled, and active. Robinhood Chain 4663 is outside the pinned Khalani coverage projection, but Relay reach is advertised only when its live health gate passes. Do not infer a static complete chain list from another venue's registry.

Vex charges 25 bps on the input token. The quoted route uses the amount after that fee, and the separate treasury transfer occurs only after the origin deposit. Provider fees, impact, output, timing, and USD values can change, so refresh the quote before acting. The packet states no numeric Relay rate limit.

This namespace also applies when a user wants to move funds into Robinhood Chain, fund my Robinhood wallet, bridge back out, and then swap on-chain. Those phrases describe discoverable outcomes, not a preference over another bridge venue.
