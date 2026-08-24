# KyberSwap namespace analysis

## Packet and evidence boundary

This report uses the KyberSwap packet in `recon.md` section 8, the two navigation facets, the three manifests and their frozen embedding passages, the Swap Venue Routing and Chain Coverage prompt sections, and `getKyberChains()` from `src/tools/kyberswap/chains.ts`. Retrieval-only chain lists are not used as capability evidence.

## Capability by outcome

- **Read:** inspect the compiled EVM chain registry and optionally join current active, inactive, or new state from the provider's Common Service. Audit one EVM contract for honeypot behavior and fee-on-transfer tax. The audit is a provider opinion at one moment, not proof of liquidity, price fairness, or future behavior.
- **Quote:** preview an exact-input EVM swap without signing. The result includes route paths and hops, output, gas and L1 fee estimates, price impact, integrator fee, and safety results for both legs. Raw route amounts and the humanized summary use different units.
- **Act:** sign and broadcast an exact-input EVM swap only after a fresh quote with identical parameters, including slippage tolerance. Execution spends real funds, can incur an integrator fee and gas, and can settle, revert after spending gas, be refused before signing at no gas cost, or remain pending with an unknown outcome.

## When it applies and retrieval coupling

Use this namespace for EVM swap-chain discovery, token-contract safety checks, quote inspection, and a requested buy, sell, token swap, or position exit. The declaration should render the following terms exactly. Each was verified as a case-insensitive, whitespace-normalized substring of at least one frozen `embeddingText`.

| Retrieval term | Frozen carrying passage |
| --- | --- |
| `EVM chains` | `embeddings/kyberswap/chains.ts`, `kyberswap.chains` |
| `chain ids` | `embeddings/kyberswap/chains.ts`, `kyberswap.chains` |
| `feature matrix` | `embeddings/kyberswap/chains.ts`, `kyberswap.chains` |
| `live chain status` | `embeddings/kyberswap/chains.ts`, `kyberswap.chains` |
| `preview a token swap` | `embeddings/kyberswap/swap.ts`, quote passage |
| `best price` | `embeddings/kyberswap/swap.ts`, quote and execute passages |
| `route` | `embeddings/kyberswap/swap.ts`, quote passage |
| `price impact` | `embeddings/kyberswap/swap.ts`, quote passage |
| `slippage` | `embeddings/kyberswap/swap.ts`, quote passage |
| `buy` | `embeddings/kyberswap/swap.ts`, execute passage |
| `sell` | `embeddings/kyberswap/swap.ts`, execute passage |
| `exit a position` | `embeddings/kyberswap/swap.ts`, execute passage |
| `safety check` | `embeddings/kyberswap/tokens.ts`, token passage |
| `honeypot` | `embeddings/kyberswap/tokens.ts`, token passage |
| `fee-on-transfer` | `embeddings/kyberswap/tokens.ts`, token passage |

Dropped from the proposed declaration because it is not an exact substring of an embedding passage: `swap quote`, `route preview`, `best route`, `RFQ liquidity`, `execute swap`, `token safety`, and `supported networks`. These remain frozen retrieval metadata but should not be named as declaration retrieval terms.

## Characteristics and limits

- Routing is exact-input and aggregates more than 400 DEXes. The quote is read-only and complete, with no pagination.
- Quote USD, gas, and L1 fee values are provider estimates. A quote's safety field is informational; confirmed honeypot refusal occurs on execution.
- A standalone safety result covers one contract at one moment. Missing provider tax data defaults to zero, so zero is not proof of no tax. It does not establish liquidity or a fair price.
- Chain live state is optional. A Common Service failure removes only the state field and reason, not the compiled registry rows. No quantitative rate limit is stated in the packet. Rate limiting is documented only as a venue-unavailable failure class.
- Execution requires contract addresses or the native keyword, a fresh matching quote, identical slippage, and a known router. Symbols are not resolved there. Slippage is capped at 1,000 bps and is never clamped.
- A pre-sign slippage refusal spends no gas. A mined revert spends gas. A pending result has unknown outcome and must not be retried or rebroadcast.
- Robinhood Chain support is explicitly provisional in the runtime registry. The packet documents live route verification dated 2026-07-13, but it provides no underlying measurement artifact for the separate stale-reserve warning or the 13-of-13 pools.fun sample. Those two claims must not be newly restated as measured declaration facts from this packet alone.

## Runtime-derived chain coverage

Source: `getKyberChains()` in `src/tools/kyberswap/chains.ts:27-50,95-97`. All current rows have `aggregator: true`: Ethereum (1), BSC (56), Arbitrum (42161), Polygon (137), Optimism (10), Avalanche (43114), Base (8453), Linea (59144), Mantle (5000), Sonic (146), Berachain (80094), Ronin (2020), Unichain (130), HyperEVM (999), Plasma (9745), Monad (143), MegaETH (4326), and Robinhood Chain (4663). Robinhood is marked aggregator-only and provisional. Scroll, zkSync, and Etherlink are deliberately absent from the runtime registry. The declaration projection must filter `aggregator: true` and render these runtime rows, not `KYBER_SWAP_CHAINS` from discovery metadata.

## Facet coverage map

| Frozen facet label | Declaration prose that represents it |
| --- | --- |
| `Chains and token safety` | The Read paragraph lists EVM chains, `chain ids`, `feature matrix`, optional `live chain status`, and the one-contract `safety check` for `honeypot` and `fee-on-transfer`, including provider and freshness limits. |
| `Swaps` | The Quote and Act paragraphs cover `preview a token swap`, `best price`, `route`, `price impact`, `slippage`, `buy`, `sell`, `exit a position`, matching-quote sequencing, costs, and outcome handling. |

## Doctrine judgment

`DUPLICATED` means a current tool description carries the same operational fact. `JUDGMENT` means the sentence supplies protocol selection or multi-stage procedure beyond a single description. Literal em dash punctuation is encoded as `&#8212;` so this artifact contains no em dash character.

| ID | Current sentence | Verdict | Evidence or exact destination |
| --- | --- | --- | --- |
| S1 | "On KyberSwap-supported EVM chains, prefer `kyberswap.*` (aggregated pricing plus honeypot/fee-on-transfer flags)." | JUDGMENT | `swap` task shape. This is D4 preference, not neutral venue identity. |
| S2 | "KyberSwap is the PRIMARY swap route and Khalani the PRIMARY bridge route." | JUDGMENT | Split by subject into the `swap` and `bridge` task shapes; do not place either preference in venue declarations. |
| S3 | "`SwapQuoteUniswap` / `SwapExecuteUniswap` and `BridgeQuoteRelay` / `BridgeExecuteRelay` are always callable alternatives, not the default choice: quote the primary venue first." | JUDGMENT | Split into `swap` and `bridge` task shapes. |
| S4 | "Switch venue when the primary CANNOT serve the trade: no aggregator support for the chain, a route or token it cannot price, a build or pre-sign check that its own route fails, the execute transaction reverting on-chain, or the venue being unavailable to us at all (refused at its edge, unreachable, rate limited, or erroring)." | JUDGMENT | `swap` task shape, cross-venue failure classification. |
| S5 | "The failure output names the alternative when switching is the right move." | JUDGMENT | `swap` task shape. The KyberSwap quote description names only two alternative triggers and does not carry this general failure-output promise. |
| S6 | "Do NOT switch venue for a trade-condition failure." | JUDGMENT | `swap` task shape. |
| S7 | "A bad price quote is not a reason by itself, and neither is a slippage, balance, allowance, or deadline failure: each of those clears with a fresh quote or a corrected amount, and the other venue will refuse them the same way." | JUDGMENT | `swap` task shape. No single KyberSwap description carries the cross-venue conclusion. |
| S8 | "When you do switch, take a FRESH quote on the new venue before executing &#8212; an execute is authorized only by a matching quote from the SAME venue &#8212; and never resubmit the identical failing route." | JUDGMENT | `swap` task shape. The local matching-quote part is duplicated, but switching and no-resubmit are cross-venue procedure. |
| S9 | "On Robinhood Chain (4663), `kyberswap.*` is primary (provisional aggregator support)." | JUDGMENT | Preference to `swap` task shape. Neutral provisional coverage is separately projected into the declaration from the runtime registry. |
| S10 | "$VEX and other Virtuals agent tokens trade against VIRTUAL there, so route through VIRTUAL (or WETH) as the base pair." | JUDGMENT | `swap` task shape, cross-namespace token routing. |
| S11 | "Robinhood caution: KyberSwap's indexed reserves can be stale on thin pairs there." | JUDGMENT | Exact preserved destination: current Swap Venue Routing sentence until an evidence packet proves the warning. Do not promote it into the declaration from this packet alone. |
| S12 | "A quote whose priceImpact is strongly NEGATIVE (output supposedly worth more than input), or an execute reverting with 'Return amount is not enough', means the quote overestimated the pool &#8212; do NOT retry with higher slippage; re-quote, or tell the user KyberSwap's pricing looks unreliable for this pair." | JUDGMENT | Exact preserved destination with S11 pending evidence. If proven, procedure belongs in `swap`; it is not the generic thin-pair slippage advice in the manifest. |
| S13 | "Trench exception, Robinhood Chain (4663): a Trench Express token that is still on its bonding curve trades ONLY against ETH on that curve &#8212; quote with `trench__trade_quote`, then execute with `trench__trade_execute`." | JUDGMENT | `swap` task shape, with sequence also represented in `launches`. |
| S14 | "`kyberswap.*` has no route for a curve token, so a failed swap quote there is not evidence the token is untradeable." | JUDGMENT | `swap` task shape, cross-namespace exception. |
| S15 | "Once a Trench token GRADUATES it leaves the curve for a WETH-paired pool and the normal venue rules apply again." | JUDGMENT | `swap` task shape, with lifecycle context in `launches`. |
| S16 | "pools.fun contrast, same chain: a pools.fun token has NO bonding curve and NO graduation, so it sits in a real SushiSwap V3 pool from its FIRST block and trades through `kyberswap.*` like any other ERC-20 (measured: 13 of 13 sampled tokens routed, including ones launched minutes earlier)." | JUDGMENT | `swap` and `launches` task shapes, subject to corroboration by the pools.fun packet. The KyberSwap packet contains no sample record. |
| S17 | "The `pools.*` namespace therefore has NO trade tool by design." | JUDGMENT | `pools` declaration as a local limit; reconciliation requires the pools.fun analyst's evidence. |
| S18 | "Never route a pools.fun token through `trench__trade_*`, and never route a Trench curve token through `kyberswap.*`." | JUDGMENT | `swap` task shape, cross-namespace routing prohibition. |
| S19 | "Quote and execute on the SAME venue: a swap execute runs only against a fresh quote from the exact venue it will broadcast on (the same rule holds for every venue, not just `kyberswap`)." | DUPLICATED | Quote description: "seed the prequote `kyberswap__swap_execute` is matched against" and execute description: "a fresh `kyberswap__swap_quote` with IDENTICAL params including `slippageBps` must already exist". The universal cross-venue restatement may remain in `swap`, but KyberSwap needs no second local copy. |
| S20 | "The runtime enforces this." | DUPLICATED | Execute description: "PRECONDITIONS, each refused BY NAME rather than worked around" followed by the fresh matching quote requirement. |

### Rendered capsule prose

| ID | Current sentence | Verdict | Evidence or exact destination |
| --- | --- | --- | --- |
| C1 | "The aggregator Vex swaps EVM tokens through: one exact-input trade routed across 400+ DEXes for the best price, quoted before it is signed, plus a honeypot and fee-on-transfer safety check on any EVM token." | DUPLICATED | Quote description: "Price an exact-input EVM swap through the KyberSwap aggregator (400+ DEXs, on the chains `kyberswap__chains_list` returns) without signing anything, and seed the prequote `kyberswap__swap_execute` is matched against" and "safety, which carries per leg either a honeypot and fee-on-transfer verdict". |
| C2 | "Swap-supported EVM chains: [runtime slug projection]." | DUPLICATED | Chains description: "List the EVM chains KyberSwap aggregator swaps run on". The replacement declaration projects the same source via `getKyberChains()`. |
| W1 | "Use when the user wants to buy, sell, swap or exit a token on an EVM chain, wants the rate, route, gas cost or price impact before trading, or wants a token checked for honeypot or fee-on-transfer behaviour." | DUPLICATED | Quote description: "what a trade would return, what the rate or the price impact is, or which venues a route crosses"; execute embedding and description cover buy, sell, and exit; token description says "honeypot behaviour and a fee-on-transfer tax". |
| W2 | "Quote first, then execute with the same params." | DUPLICATED | Quote description: "Pass the SAME `slippageBps` on the execute"; execute description: "a fresh `kyberswap__swap_quote` with IDENTICAL params including `slippageBps` must already exist". |
| P1 | "KyberSwap is the PRIMARY EVM swap route: use `uniswap` when KyberSwap has no aggregator support for the chain or cannot route the pair, `khalani` to resolve token addresses across chains or to bridge between them, `solana` for Solana trading, and `dexscreener` for read-only research." | JUDGMENT | `swap` task shape owns EVM versus Solana selection and fallback; `bridge` owns bridge selection; `research` owns the read-only research handoff. D4 preference is absent from every venue declaration. |

## D4 note

KyberSwap's declaration is venue-neutral. It states capability, runtime coverage, requirements, and limitations without calling the venue primary or calling another venue a fallback. The KyberSwap versus Uniswap preference belongs only in the `swap` task shape. Khalani versus Relay preference belongs only in the `bridge` task shape.

## Draft declaration prose

> KyberSwap is an EVM swap aggregator that routes exact-input trades across more than 400 DEXes. It applies when the user needs to inspect EVM chains, preview a token swap, perform a safety check, or buy, sell, swap, or exit a position. It describes this venue neutrally; protocol preference and fallback decisions belong to task routing.
>
> **Read:** list the compiled swap registry with chain ids and its feature matrix. An optional live chain status lookup reports active, inactive, or new state without replacing the compiled rows. Check one token contract for a honeypot or fee-on-transfer tax before trading. That result is a provider opinion at one moment. A missing tax value becomes zero, so zero is not proof of no tax, and the check does not prove liquidity, a fair price, or future contract behavior.
>
> **Quote:** get a read-only exact-input preview before signing. It reports the best price route, output, route hops and paths, gas and L1 fee estimates, price impact, slippage authorization, integrator fee, and safety results for both token legs. The summary uses human units while detailed route amounts use raw base units. USD and gas values are estimates. The quote is complete and not paginated.
>
> **Act:** sign and broadcast only after a fresh quote with identical chain, token contracts, amount, and slippage. Contract addresses or the native-token keyword are required. A confirmed honeypot blocks signing, while fee-on-transfer tax warns. Slippage above 1,000 basis points is rejected. A pre-sign refusal spends no gas; a mined revert spends gas; a pending result has unknown outcome and must not be retried or rebroadcast. Execution spends real funds, is irreversible, and may include the integrator fee disclosed by the quote.
>
> **Coverage and limits:** swap support is projected from the runtime registry: Ethereum, BSC, Arbitrum, Polygon, Optimism, Avalanche, Base, Linea, Mantle, Sonic, Berachain, Ronin, Unichain, HyperEVM, Plasma, Monad, MegaETH, and Robinhood Chain. Robinhood support is provisional. No quantitative provider rate limit is stated; rate limiting or provider unavailability can prevent routing. A failed Common Service lookup removes live state, not the compiled chain rows.
