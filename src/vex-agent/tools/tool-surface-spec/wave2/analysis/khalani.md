# Khalani declaration analysis

## Packet finding

Khalani is a cross-chain bridge and token-resolution venue. Its registry covers EVM and Solana families. The packet exposes nine capabilities: eight reads or previews and one wallet-broadcast action. This report treats the navigation entry as the declaration owner and does not use retrieval-only chain-name lists as coverage evidence.

## Outcome-oriented offer

- Read: inspect the live bridge-chain registry; browse or resolve tokens; parse incomplete token, amount, and chain phrases; scan one wallet family's balances; list bridge history; and inspect one order with provider and Vex lifecycle views.
- Quote: preview route choices, expected output, ETA, gas, expiry, and the Vex fee without signing. A no-route result is a failure, not an empty successful result.
- Act: dry-run first, then sign and broadcast the origin-chain deposit after the required approval path. A real run records an in-progress attempt and must be followed to a verified terminal state. It never means instant destination delivery.

## Retrieval terms

Each term below is an exact case-insensitive, whitespace-normalized substring of the cited frozen `embeddingText` in `protocols/embeddings/khalani/manifest.ts`.

| Intended rendered term | Carrying frozen entry |
| --- | --- |
| `supported networks` | `khalani.chains.list` |
| `cross-chain transfer` | `khalani.quote.get`, `khalani.orders.get`, `khalani.bridge` |
| `exact contract address` | `khalani.tokens.search` |
| `source chain` | `khalani.tokens.search`, `khalani.orders.list` |
| `destination chain` | `khalani.tokens.search`, `khalani.orders.list` |
| `expected output amount` | `khalani.quote.get` |
| `compare bridge routes` | `khalani.quote.get` |
| `simulate cross-chain transfer` | `khalani.quote.get` |
| `bridge history` | `khalani.orders.list` |
| `bridge order` | `khalani.orders.list`, `khalani.orders.get` |
| `balances across multiple EVM and Solana chains` | `khalani.tokens.balances` |
| `move tokens cross-chain` | `khalani.bridge` |
| `get assets onto another network` | `khalani.bridge` |
| `bridge funds` | `khalani.bridge` |

The declaration deliberately drops navigation-only spellings that are not exact frozen `embeddingText` substrings, including `bridge quote`, `route quote`, `amount in smallest units`, `source chain id`, and `destination chain id`. Their retrieval metadata remains frozen.

## Characteristics and limits

| Topic | Packet-backed finding |
| --- | --- |
| Freshness | Supported chains come from the provider's live registry and have no stable count. The static prompt can state only the pinned projection; the per-turn projection owns live reach and staleness. Quotes have deadlines and execution re-quotes. |
| Coverage | Token resolution is limited to Khalani-registered chains. Robinhood Chain 4663 is absent from that registry. Balance scans cover one wallet family per call, so EVM plus Solana requires two reads. |
| Cost | A quote exposes gas and the Vex fee. The manifest pins the fee at 25 bps of input and distinguishes quote accounting from post-deposit collection. That exact fee basis must remain in its preserved destination rather than be rephrased here. |
| Result bounds | Token autocomplete and order listing accept 1 to 20 rows. The provider maximum is 20. Order listing is cursor-paginated; chain listing, token search, top tokens, and quote routes state that they are not paginated. |
| Rate limits | The packet establishes per-response limits but provides no request-rate limit or service guarantee. No request-rate claim belongs in the declaration. |
| Resolution | Popular-token results are not a resolver. Autocomplete returns suggestions, not confirmed identity. A ticker can match several contracts, so chain and address must be confirmed. |
| Execution | The bridge requires a fresh matching quote. Deadlines require re-quoting, not retrying. A submitted attempt must not be repeated for the same transfer. Provider and Vex order states can legitimately disagree until on-chain verification. |
| Cannot do | It does not swap within one chain, cover Robinhood balances, promise delivery at broadcast time, accept caller-chosen refund or referral-fee destinations, or prove a live chain route from the static pin alone. |

## Chain coverage source

The static source is `KHALANI_PINNED_EVM_CHAIN_IDS` in `engine/prompts/chain-coverage.ts`, pinned on 2026-08-17 to chain ids `1, 10, 56, 130, 137, 143, 324, 2741, 5000, 8453, 16661, 42161, 43114, 59144, 80094, 747474`. The manifest proves the venue supports both EVM and Solana families. The static declaration should render that pinned projection as an expectation, not as live truth.

Exact current reach remains in `buildBridgeCapabilityPrompt`, fed by the classified snapshot in `protocols/khalani/capability-snapshot.ts`. Live provider presence is filtered to `eip155` and `solana`, mapped through curated display names, and classified as available, stale after 60 minutes, or unavailable after 24 hours. The declaration must not absorb that live list, its staleness note, or the Relay health-gated Robinhood line.

## Facet coverage

| Navigation facet label | Declaration prose that represents it |
| --- | --- |
| `Chains and token resolution` | "Read the live supported networks, resolve a token to the exact contract address on its source chain or destination chain, parse incomplete intents, and inspect balances across multiple EVM and Solana chains." |
| `Bridge quotes and orders` | "Compare bridge routes and expected output amount, simulate cross-chain transfer before acting, then inspect bridge history or one bridge order until delivery is verified." |

Both frozen facet labels are represented. The second proposed sentence retains every listed phrase. The first uses `source chain` and `destination chain` separately while preserving both exact frozen substrings.

## Doctrine and capsule judgment

`DUPLICATED` means the sentence can leave the capsule or doctrine because the named manifest descriptions carry its meaning. `JUDGMENT` assigns it to the sole cross-protocol or procedural owner.

| Source | Sentence | Verdict | Evidence or destination |
| --- | --- | --- | --- |
| capsule `summary` | "The bridge Vex moves tokens between blockchains with, across the EVM and Solana chains its own live registry returns, and the canonical cross-chain token resolver behind it: resolve a ticker or address to the exact contract on a chain, read balances across chains, quote a transfer, execute it, and track the order to delivery." | DUPLICATED | Chain description: "List every chain Khalani can bridge to or from, EVM and Solana alike"; token-search description: "resolve a symbol, name, or address to exact token metadata across Khalani's chains"; balance description: "Scan one wallet's token balances across the Khalani-supported chains"; quote description: "Price a cross-chain transfer on Khalani without signing anything"; action description: "Move tokens between chains FOR REAL"; order descriptions carry history and lifecycle. |
| capsule `whenToUse` | "Use when the task crosses chains: bridge funds from one network to another, get assets onto the chain a trade needs, check what a transfer would deliver and how long it takes, or look up an in-flight or past bridge." | DUPLICATED | Action description: "Move tokens between chains FOR REAL"; quote description carries "what would arrive" and "how long it would take"; order-list description carries "bridge history" and "transfers are still in flight". |
| capsule `whenToUse` | "Also use it to resolve a token symbol or address before ANY EVM swap or bridge, through the `TokenFind` shortcut." | DUPLICATED | Token-search description: "Use either before any EVM mutation to get exact contract addresses" and "the engine behind `TokenFind`, the canonical token resolver". |
| capsule `whenToUse` | "Bridges quote first and then execute, and a real execution reports delivery still in progress rather than a completed transfer." | DUPLICATED | Quote description: "Use this before every bridge"; action description: "A fresh matching quote must already exist" and "A REAL RUN NEVER REPORTS SUCCESS". |
| capsule `preferInstead` | "Khalani is the PRIMARY bridge: use `relay` when Khalani has no route, and always when either side is Robinhood Chain (4663), which Khalani's registry does not carry." | JUDGMENT | `bridge` task shape. It owns D4 preference, no-route fallback, and the Robinhood Relay-only route. The declaration retains only Khalani's neutral local coverage limit. |
| capsule `preferInstead` | "Use `kyberswap` for EVM-only swaps and `solana` for Solana-only swaps." | JUDGMENT | `swap` task shape. This is cross-namespace venue routing, not a Khalani fact. |
| `Bridge Routing` | "Between two Khalani-supported chains, bridge with `BridgeQuote` then `BridgeExecute` (they auto-route to `khalani.*`)." | JUDGMENT | `bridge` task shape. This is the quote-then-act procedure and shortcut routing rule. |
| `Bridge Routing` | "The live chain list is in the turn state." | JUDGMENT | Exact preserved destination: the per-turn `buildBridgeCapabilityPrompt` projection. |
| `Bridge Routing` | "Quote and execute on the SAME bridge provider (`khalani` or `relay`)." | JUDGMENT | `bridge` task shape. This is cross-provider authorization continuity. |
| `Bridge Routing` | "The runtime enforces this." | JUDGMENT | `bridge` task shape, attached to the same-provider rule rather than rendered as a free-standing claim. |
| `Bridge Routing` | "Reads on Robinhood Chain go direct-RPC: `WalletBalances` for balances, `ChainRead` for tx receipts / ERC-721 mints / a direct `erc20_balance` read (alias `robinhood` / id 4663)." | JUDGMENT | `bridge` task shape. This is cross-namespace routing around the bridge registry's local-read gap. |
| `Bridge Routing` | "`khalani__token_balances_get` does NOT cover it." | DUPLICATED | Balance description: "It does NOT cover app-local chains such as Robinhood Chain (4663)". |

The Chain Coverage paragraph's reach-before-entry rule, pinned-versus-live distinction, and provider selection are cross-protocol judgment. They belong to the `bridge` task shape plus the preserved per-turn projection, not to this venue declaration. The generated pinned chain rows become the Khalani declaration's static coverage projection rather than independently authored sentences.

## D4 note

The declaration below is venue-neutral. It does not call Khalani primary, tell the model to prefer it, or name Relay as a fallback. The `bridge` task shape should state the Khalani-first preference and Relay fallback, including Relay-only Robinhood reach. The `swap` task shape owns swap venue preference. No preference sentence should be repeated in any of the four venue declarations.

## Draft declaration

The text inside this block is 1.2 to 2.5 KB and is the proposed model-visible declaration. It contains no tool names or dotted identifiers.

```text
Khalani is a cross-chain bridge and token-resolution venue for EVM and Solana networks.

Use it when the outcome requires bridge funds, move tokens cross-chain, get assets onto another network, resolve a token on its source chain or destination chain, compare bridge routes, or follow a bridge order. The static coverage projection is a pinned expectation for supported networks. Current reach comes from the live turn state and may be stale or unavailable, so confirm a route with a fresh quote. Robinhood Chain is outside Khalani's registry.

Read outcomes: inspect the live supported networks; browse popular bridge assets; resolve a symbol, name, or address to the exact contract address; parse an incomplete token, amount, and chain phrase; inspect balances across multiple EVM and Solana chains; read bridge history; or inspect one transfer's provider and Vex lifecycle. Popular assets are not token resolution, autocomplete results are suggestions, and one ticker can match several contracts. Confirm the chain and address before funds move. One balance scan covers one wallet family, so combined EVM and Solana holdings require separate reads.

Quote outcomes: preview expected output amount, gas, ETA, deadlines, route choices, and the Vex fee without signing. Use a quote to compare bridge routes or simulate cross-chain transfer. A no-route answer is a failure, not an empty success. Quote deadlines are action windows, not guarantees that a route will survive. Re-quote after expiry.

Action outcomes: dry-run first, then sign and broadcast the origin-chain deposit through the required approval path. Execution requires a fresh matching quote. A real run records an irreversible attempt whose destination fill is still being verified. Pending, failed, refunded, reverted, unconfirmed, and not-attempted legs must be reported as distinct states. Never repeat the same transfer merely because delivery is not yet verified; inspect its order until the provider and Vex records converge or explain their disagreement.

Limits: this venue does not perform same-chain swaps, read Robinhood balances, guarantee delivery at broadcast time, or accept caller-selected refund or referral-fee destinations. Token autocomplete and order pages are capped at 20 results. The packet states no request-rate contract. Chain coverage, token results, balances, quotes, and order state can change, so read or quote again when freshness matters.
```

## Packet sufficiency

The packet is sufficient for capabilities, the two navigation facets, frozen retrieval terms, pinned and live chain ownership, bridge costs, result bounds, and execution lifecycle. It is insufficient to state a request-rate limit or service-level guarantee, so the declaration states neither.
