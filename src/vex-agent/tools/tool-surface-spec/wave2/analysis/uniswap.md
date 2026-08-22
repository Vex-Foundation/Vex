# Uniswap namespace analysis

## Packet sufficiency

The packet is sufficient for capabilities, outcome grouping, retrieval coupling, the single facet, fee and execution limits, and explicit Robinhood Chain support. It is not sufficient to prove the complete EVM chain set. The manifest says coverage is limited to EVM chains with a verified Vex Uniswap deployment and explicitly names Robinhood Chain 4663, but it imports no Uniswap deployment registry. `chain-coverage.ts` projects `getKyberChains()`, which proves KyberSwap coverage and must not be reused as proof of Uniswap coverage. The declaration therefore must not claim every EVM chain or enumerate an unsupported list.

## Identity and outcomes

Uniswap is an on-chain exact-input spot-swap venue. It compares V2 and V3 pools and uses the best route it can build.

- Read: there is no symbol or token search. Resolve contract addresses elsewhere before using this namespace.
- Quote: preview expected output, route, price impact, gas, and token-safety signals without executing.
- Act: sign and broadcast a swap only after a fresh matching quote. ERC-20 approval is handled automatically; native input needs no approval.

## Retrieval terms

Normalization below is limited to case folding and whitespace collapsing. Every term is present verbatim after that normalization in `protocols/embeddings/uniswap/swap.ts`.

| Intended declaration term | Frozen passage |
| --- | --- |
| `Uniswap` | quote and execute |
| `V2 and V3 pools` | quote |
| `best route` | quote and execute |
| `expected output` | quote |
| `price impact` | quote |
| `token-safety signals` | quote |
| `Robinhood Chain` | quote and execute |
| `VIRTUAL` | quote and execute |
| `route preview` | quote |
| `Read-only` | quote |
| `exact-input` | execute |
| `token approval` | execute |
| `swap` | quote and execute |
| `sell` | execute |
| `buy` | execute |

The frozen `HIDDEN fallback` phrase is intentionally not selected. It conflicts with D4 and does not belong in the neutral declaration.

## Characteristics, limits, and chain coverage

- Inputs are token contract addresses or native ETH. There is no symbol search.
- A quote is Read-only and reports expected output, route, price impact, gas, and safety signals.
- The input amount is the total wallet debit. The route prices the amount after Vex's fixed 25 bps fee.
- Execution spends funds, requires approval, signs and broadcasts, and requires a fresh matching quote from this venue.
- ERC-20 execution manages an exact-amount allowance, including reset to zero where required. Native input needs none.
- The quote and execution slippage value must match. The default is 50 bps, the cap is 1000 bps, and increasing it widens the accepted worst-case price.
- Slippage commonly fails before signing at no gas cost, but a later mined revert can spend gas. Requote after either outcome.
- Exact coverage is deployment-bound. `protocols/uniswap/manifests/swap.ts` proves supported EVM deployments and Robinhood Chain 4663 only. No exact Uniswap runtime registry is present in the packet.
- `engine/prompts/chain-coverage.ts` cannot fill that gap because its EVM rows come from `getKyberChains()`.
- No rate limit, quote lifetime, or fixed freshness duration is stated. Do not invent one. The only freshness contract in the packet is a fresh matching quote before execution.

## Facet coverage

| Navigation facet | Declaration prose that represents it |
| --- | --- |
| `Swaps` | "Use it to preview or execute a swap after resolving token addresses elsewhere. A route preview is Read-only. It reports expected output, price impact, gas, the path, and token-safety signals before funds move. Execution is an exact-input action that spends funds, signs, and broadcasts from the user's wallet after approval." |

The map is complete: the navigation entry has exactly one facet and the draft represents it in both quote and act outcomes.

## Doctrine judgment

The shared Swap Venue Routing section is allocated sentence by sentence below. Anchors identify sentences without introducing punctuation that this report is prohibited from writing.

| Sentence anchor | Verdict | Evidence or destination |
| --- | --- | --- |
| "On KyberSwap-supported EVM chains" | JUDGMENT | `swap` task shape. This is D4 preference, not a neutral venue fact. |
| "KyberSwap is the PRIMARY swap route and Khalani the PRIMARY bridge route" | JUDGMENT | Swap clause to `swap`; bridge clause to `bridge`. |
| "Switch venue when the primary CANNOT serve the trade" | JUDGMENT | `swap` and `bridge` routing procedure. |
| "Do NOT switch venue for a trade-condition failure" | JUDGMENT | `swap` task shape. |
| "A bad price quote is not a reason by itself" | JUDGMENT | `swap` task shape, including slippage, balance, allowance, and deadline correction. |
| "When you do switch, take a FRESH quote on the new venue" | JUDGMENT | `swap` task shape. It owns venue-local quote matching and the no-identical-route retry rule. |
| "On Robinhood Chain (4663), kyberswap is primary" | JUDGMENT | `swap` task shape for D4 preference. |
| "$VEX and other Virtuals agent tokens trade against VIRTUAL there" | JUDGMENT | Uniswap declaration for the local market fact; `swap` task shape for routing through VIRTUAL or WETH. The Uniswap embedding carries "Virtuals agent tokens trade against VIRTUAL". |
| "Robinhood caution: KyberSwap's indexed reserves can be stale" | JUDGMENT | `swap` task shape. This is KyberSwap-specific and its duplication status must be reconciled by the KyberSwap analyst. |
| "A quote whose priceImpact is strongly NEGATIVE" | JUDGMENT | `swap` task shape. This is a cross-step response to an unreliable primary quote. |
| "Trench exception, Robinhood Chain (4663)" | JUDGMENT | `launches` and `swap` task shapes. Local duplication must be reconciled by the Trench analyst. |
| "A failed swap quote there is not evidence the token is untradeable" | JUDGMENT | `swap` task shape. |
| "Once a Trench token GRADUATES" | JUDGMENT | `launches` and `swap` task shapes. |
| "pools.fun contrast, same chain" | JUDGMENT | `launches` and `swap` task shapes. Local duplication must be reconciled by the pools analyst. |
| "The pools namespace therefore has NO trade tool by design" | JUDGMENT | `launches` and `swap` task shapes. |
| "Never route a pools.fun token through trench" | JUDGMENT | `swap` task shape. |
| "Quote and execute on the SAME venue" | JUDGMENT | `swap` task shape. The local constraint is also carried by the execution description phrase "REQUIRES a fresh matching uniswap__swap_quote first." |
| "The runtime enforces this" | JUDGMENT | `swap` task shape as the enforcement qualifier of the preceding rule. |

### Capsule fields

| Capsule sentence | Verdict | Carrying description or destination |
| --- | --- | --- |
| "Uniswap is on-chain spot swapping straight against V2 and V3 pools, routed for the best of the two and quoted before it is executed." | DUPLICATED | Quote description: "Get the best Uniswap route across V2 + V3." Execute description: "Execute a Uniswap swap (best V2/V3 route, exact-input)." |
| "It is Vex's all-EVM alternative to the KyberSwap aggregator, and the venue that covers Robinhood Chain (4663), where $VEX and Virtuals agent tokens trade against VIRTUAL." | JUDGMENT | Neutral Robinhood and market facts to the declaration. The alternative and preference relationship goes only to the `swap` task shape. The exact all-EVM claim is narrowed because the packet lacks a Uniswap deployment registry. |
| "It takes token contract ADDRESSES; there is no symbol search." | DUPLICATED | Quote parameter description: "Input token CONTRACT ADDRESS or native ETH/native. Uniswap has no symbol search." |
| "Use as a fallback on any EVM chain when KyberSwap is unavailable or lacks a route, including Robinhood Chain (quote/execute against VIRTUAL/ETH)." | JUDGMENT | Preference and failover procedure to `swap`; verified local Robinhood fact to the declaration. Drop "any EVM chain" unless a runtime deployment source is supplied. |
| "Pass token contract ADDRESSES (no symbol search)." | DUPLICATED | Execute description: "Pass token ADDRESSES (no symbol search)." |
| "Prefer kyberswap on the chains it supports" | JUDGMENT | `swap` task shape only. The declaration remains neutral. |

Additional rendered capsule prose is also accounted for:

- `Contains mutating tools (may require approval).` is DUPLICATED by the execute description phrase "SPENDS FUNDS: it signs and broadcasts from your wallet and requires approval before it runs."
- The `Swaps` facet line is DUPLICATED by "Get the best Uniswap route across V2 + V3" and "Execute a Uniswap swap". The facet itself remains represented in the declaration.
- The `Try:` line is retrieval scaffolding rather than doctrine. Its examples remain frozen in navigation metadata and do not need to render in the declaration.

## D4 placement

The Uniswap declaration is venue-neutral. It does not say primary, fallback, hidden, preferred, or alternative. KyberSwap preference and the conditions for switching venues belong only in the `swap` task shape. The frozen retrieval phrase `HIDDEN fallback` remains untouched but is not echoed.

## Draft declaration

Uniswap is an on-chain spot-swap venue for supported EVM deployments. It compares V2 and V3 pools and selects the best route for an exact-input trade. Use it to preview or execute a swap after resolving token addresses elsewhere. It has no symbol search, so provide token contract addresses or native ETH.

A route preview is Read-only. It reports expected output, price impact, gas, the path, and token-safety signals before funds move. On Robinhood Chain 4663, $VEX and Virtuals agent tokens trade against VIRTUAL or ETH. The known packet proves Robinhood Chain support, but it does not expose the complete deployment registry, so do not infer that every EVM chain is available.

Execution is an exact-input action that spends funds, signs, and broadcasts from the user's wallet after approval. It requires a fresh matching quote from this venue. For ERC-20 input, token approval is handled automatically with an exact-amount allowance and a reset to zero first when the token requires it. Native input needs no allowance.

The entered amount is the total wallet debit. Vex charges a fixed 25 bps fee on the input, and the swap prices the remainder. The quoted and executed slippage settings must match. The default is 50 bps and the maximum is 1000 bps. A larger tolerance accepts a worse possible price. A thin or volatile pool may fail the pre-sign estimate without spending gas, or may revert after mining and spend gas. After either failure, obtain a new quote instead of assuming the pair is unavailable.

Use retrieval language such as Uniswap, route preview, best route, expected output, price impact, swap, sell, buy, VIRTUAL, and Robinhood Chain when searching for this capability.
