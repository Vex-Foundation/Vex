# Pendle analyst report

## Protocol and outcomes

Pendle is an EVM term-yield venue. A yield-bearing asset is split into a principal token (PT), which locks a fixed rate to a market maturity, and a yield token (YT), which carries variable, leveraged yield and decays to zero at expiry. A market and every PT, YT, LP, or SY position is chain-specific and maturity-sensitive.

- **Read:** screen and rank active or matured term markets; inspect one market, accepted assets, expiry, current and historical rates, TVL, candles, and resting orders; mark PT, YT, LP, and SY assets; value the session wallet's positions and accrued income; list campaign rewards.
- **Quote:** preview exact-input PT and YT trades, pre-expiry PT+YT mint or unwind, and single-token liquidity changes. Quotes report estimated output, liquidity, price impact, route fees, slippage, and expiry. Other term moves, SY conversions, and two-leg liquidity actions quote through their own dry run.
- **Act:** buy, sell, or redeem PT; buy or sell YT; mint or unwind an equal PT+YT pair; add or remove liquidity; keep YT on a single-token add or retain PT on a two-output removal; roll PT, move LP, or convert LP to the same market's PT; wrap or unwrap SY; claim on-chain income.

## Retrieval terms

Matching is case-insensitive with whitespace collapsed. Each phrase below occurs verbatim in at least one frozen `embeddingText`.

| Intended rendered term | Verified frozen passage |
|---|---|
| `fixed-yield markets` | `embeddings/pendle/yields.ts`, market screening |
| `implied APY` | `embeddings/pendle/yields.ts`, market screening |
| `principal token` | `embeddings/pendle/pt.ts`, PT buy |
| `yield token` | `embeddings/pendle/yt.ts`, YT buy |
| `single-token liquidity` | `embeddings/pendle/lp.ts`, LP quote |
| `move Pendle liquidity` | `embeddings/pendle/reflect.ts`, LP transfer |
| `standardised yield` | `embeddings/pendle/sy.ts`, SY wrap |
| `price candles` | `embeddings/pendle/market-reads.ts`, candles |
| `resting orders` | `embeddings/pendle/market-reads.ts`, order book |
| `dollar price marks` | `embeddings/pendle/market-reads.ts`, asset prices |
| `Pendle positions` | `embeddings/pendle/yields.ts`, position value |
| `accrued interest and rewards` | `embeddings/pendle/yt.ts`, claim |

## Characteristics and limits

- PT funds remain committed until maturity unless sold early at the current market price, which can realize a loss. Matured PT is valued and redeemed at roughly face value.
- YT is not fixed yield. It can lose money and becomes worthless at expiry. LP earns fees and rewards only until expiry and is not a fixed-rate lock.
- Trades are exact-input estimates. Executable paths use Pendle's AMM only and cannot fill resting limit orders. Thin liquidity can create high exit price impact.
- Asset dollar marks refresh roughly every 15 to 60 seconds and are not executable quotes. Wallet dashboard data can lag by weeks, and each chain's freshness must be checked. Historical data does not predict execution.
- Market screens page explicitly. Series and reward reads are capped and disclose rejection or truncation. The packet documents no provider request-rate limit, so none should be claimed.
- Campaign and incentive rewards can be read but not claimed by Vex because the public API omits the proof. On-chain accrued interest and LP rewards are a separate claimable pot.
- No two-token liquidity add, direct PT-to-YT swap, exact-output trade, cross-chain term move, native-currency leg, or arbitrary recipient is available. A pricing-service fallback can redeem matured PT into SY, which still must be unwrapped before the exit is complete.

## Chain coverage

Runtime source: `src/tools/pendle/chains.ts`, `PENDLE_CHAIN_REGISTRY` and its projection `PENDLE_SUPPORTED_CHAIN_IDS`. The 11 entries are Ethereum (1), Optimism (10), BNB Smart Chain (56), Monad (143), Sonic (146), HyperEVM (999), Mantle (5000), Base (8453), Plasma (9745), Arbitrum One (42161), and Berachain (80094). The registry says some supported chains may currently have no active markets. This coverage does not use retrieval chain-name lists.

## Facet coverage

| Frozen facet label | Declaration prose that represents it |
|---|---|
| Yield markets | "screen and rank active or matured term markets" plus fixed-yield markets, implied APY, liquidity, and maturity screening |
| PT trading | "buy, sell, or redeem PT" with fixed-rate lock, early-loss, and matured-face rules |
| YT trading | "buy or sell YT" with variable-yield, decay, and expiry limits |
| Mint and redeem (PT + YT) | "mint or unwind an equal PT+YT pair" with pre-expiry restriction |
| Liquidity (LP) | "single-token liquidity changes" and add/remove outcomes with fee expiry |
| Dual-leg liquidity | "keep YT on a single-token add or retain PT on a two-output removal" and no-two-token-add limit |
| Move a position (term mobility) | "roll PT, move LP, or convert LP to the same market's PT" with active-destination limits |
| SY wrap and unwrap | "wrap or unwrap SY" and fallback completion |
| Market detail and history | market inspection, accepted assets, expiry, current and historical rates, TVL, and candles |
| Order-book depth | resting-order read plus AMM-only, cannot-fill limit |
| Asset prices | PT, YT, LP, and SY marks plus freshness and non-executable status |
| Positions and income | wallet valuation, maturity state, accrued income, campaign rewards, and claimability split |

## Doctrine judgment

Source quotations below replace source em-dash punctuation with `--` to satisfy the artifact character rule. The words are otherwise unchanged. `DUPLICATED` always cites an exact phrase from a manifest `description`, not discovery metadata.

### Rendered capsule

| ID | Source sentence | Verdict and evidence or destination |
|---|---|---|
| C1 | "Where Vex trades TERM yield on 11 EVM chains: Pendle splits a yield-bearing asset into a principal token (PT), whose rate is FIXED until a maturity date, and a yield token (YT), whose yield is VARIABLE and decays to zero at that same expiry." | DUPLICATED. `manifests/read.ts`: "principal tokens (PT) locking a FIXED rate to a maturity date, yield tokens (YT), and LP"; `manifests/py.ts`: "yield token (YT, variable yield that decays to zero at expiry)". |
| C2 | "Every position here has an expiry, and that date is what decides which action is possible on it." | JUDGMENT, declaration local maturity rule. No one description carries the universal choice rule. |
| C3 | "Use when the user wants a rate LOCKED to a date rather than one that floats: find or inspect a market and its implied APY, lock or exit a fixed rate with PT, take or exit variable yield with YT, mint or unwind the PT+YT pair, provide or move single-token liquidity, roll a position into a later maturity, wrap or unwrap SY, value what they already hold, or claim accrued income." | JUDGMENT, declaration outcome inventory. Individual outcomes are duplicated, but the complete selection map is cross-manifest judgment. |
| C4 | "Also use it whenever a Pendle position is nearing or past its expiry, because a matured position can only be redeemed or removed." | DUPLICATED. `manifests/read.ts`: "include expired markets, which can only be redeemed or removed, never bought." |
| C5 | "The PT/YT/LP/SY rules - including quote-first and dryRun-first - live in the Fixed Yield (Pendle) doctrine below." | JUDGMENT, delete structural pointer; move the local quote/dry-run procedure to the yield task shape, while approval and irreversible-effect text stays in its existing preserved prompt destination. |
| C6 | "Pendle is specifically for a FIXED rate locked to a maturity date: use `morpho` when the user wants a VARIABLE rate that floats with utilization and has no expiry, and `kyberswap` for an ordinary spot swap with no yield term at all." | JUDGMENT, yield task shape. This is cross-protocol arbitration, not neutral Pendle declaration prose. |

### Fixed Yield doctrine

| ID | Source sentence | Verdict and evidence or destination |
|---|---|---|
| P1 | "There is NO plain staking tool in this install." | JUDGMENT, yield task shape capability boundary. |
| P2 | "When the user asks to stake or to earn yield, route by family: term/fixed yield on EVM chains is `pendle.*`, variable-rate EVM lending is `morpho.*`, and Solana lending/earn is `solana__lend_*` when available." | JUDGMENT, yield task shape and its runtime-availability clause. |
| P3 | "If none of those families fits what they asked for, say the capability does not exist &#8212; never substitute a swap for a yield position." | JUDGMENT, yield task shape. This is the yield arbiter's central cross-protocol procedure. |
| P4 | "`pendle.*` is fixed-yield across 11 chains (Ethereum, Arbitrum, Base, BSC, and more)." | DUPLICATED. `manifests/read.ts`: "Screen Pendle term-yield markets across all Pendle-supported chains" and "principal tokens (PT) locking a FIXED rate to a maturity date". Chain rendering must come from `PENDLE_CHAIN_REGISTRY`. |
| P5 | "A principal token (PT) is a TERM COMMITMENT: buying a PT locks a fixed rate until the market's expiry date." | DUPLICATED. `manifests/pt.ts`: "LOCKS A FIXED YIELD UNTIL THE MARKET EXPIRES." |
| P6 | "Always pass the `chain` the PT lives on." | DUPLICATED. `manifests/pt.ts` chain parameter: "Chain slug or id &#8212; one of Pendle's 11 chains". |
| P7 | "Buying a PT locks funds until maturity." | DUPLICATED. `manifests/pt.ts`: "Funds are committed until maturity; there is no early unlock". |
| P8 | "Exiting EARLY (`pendle__pt_sell`) is market-priced and CAN lose money versus the locked rate &#8212; say so before recommending a buy." | DUPLICATED. `manifests/pt.ts`: "an EARLY EXIT priced at the current market, which can be WORSE than the locked rate the PT was bought at." The recommendation framing remains in the declaration local risk limit. |
| P9 | "A MATURED PT redeems ~1:1 to its accounting asset via `pendle__pt_redeem`; value a matured PT at face, never at the underlying spot price." | DUPLICATED. `manifests/pt.ts`: "redemption of the PT for its accounting asset at roughly 1:1"; `manifests/read.ts`: "A matured PT is valued at its face and accounting value, never underlying spot." |
| P10 | "A yield token (YT) is the OPPOSITE leg: `pendle__yt_buy` is VARIABLE, leveraged yield exposure that DECAYS TO ZERO at expiry and is worth nothing after it &#8212; NOT fixed yield, and it can lose money." | DUPLICATED. `manifests/yt.ts`: "leveraged VARIABLE yield exposure" and "A YT DECAYS TO ZERO at expiry and is worth nothing after it; this is NOT a fixed rate and it loses money". |
| P11 | "Frame YT as a variable-yield bet, never as a guaranteed or fixed return; `pendle__yt_sell` exits early at the market price." | JUDGMENT, declaration local risk framing. Carrying facts are in `manifests/yt.ts`: "variable-yield exposure" and "an early exit priced at the current market." |
| P12 | "`pendle__rewards_claim` sweeps ACCRUED interest and rewards (from held YTs and LP positions) to the wallet WITHOUT closing any position &#8212; it moves only income, never principal." | DUPLICATED. `manifests/yt.ts`: "collects the interest held YTs have earned and the rewards liquidity positions have earned" and "it moves ONLY accrued income, never principal". |
| P13 | "`pendle__py_mint` splits ONE token into BOTH an equal PT and YT in a single transaction; `pendle__py_redeem` burns an EQUAL PT+YT pair back to a token BEFORE expiry." | DUPLICATED. `manifests/py.ts`: "splits the token into an EQUAL amount of principal token" and "yield token"; "burns an EQUAL amount of principal token (PT) and yield token (YT) and returns the output token." |
| P14 | "Both need a fresh matching `pendle__py_quote`; a MATURED PT (PT only, no YT) uses `pendle__pt_redeem` instead." | DUPLICATED. `manifests/py.ts`: "a fresh matching pendle__py_quote" and "a MATURED PT held without its YT redeems with pendle__pt_redeem instead." |
| P15 | "`pendle__lp_add` provides single-token liquidity (one token to the market's LP), which earns swap fees and rewards; `pendle__lp_remove` burns the LP back to one token." | DUPLICATED. `manifests/lp.ts`: "deposit of ONE token in exchange for the market's LP token, which earns swap fees and rewards" and "burn of the market's LP token in exchange for ONE output token." |
| P16 | "LP is NOT a fixed-rate lock: after expiry it stops earning and only the principal side remains removable." | DUPLICATED. `manifests/lp.ts`: "LP is NOT a fixed-rate lock: after expiry it stops earning entirely" and "a matured market can still be exited here". |
| P17 | "Both need a fresh matching `pendle__lp_quote`; approval-gated." | DUPLICATED. `manifests/lp.ts`: "a fresh matching pendle__lp_quote" and "APPROVAL: in a RESTRICTED session this does not execute, it returns pending approval". Existing approval prose remains byte-preserved at its prompt destination. |
| P18 | "SY is Pendle's standardised-yield form of a yield-bearing asset &#8212; the token PT and YT are actually minted from." | DUPLICATED. `manifests/sy.ts`: "the wrapper form of a yield-bearing asset that PT and YT are minted from." |
| P19 | "`pendle__sy_mint` wraps a plain ERC-20 into SY; `pendle__sy_redeem` unwraps SY back to a plain ERC-20." | DUPLICATED. `manifests/sy.ts`: "Wrap a plain token into Pendle SY" and "Unwrap Pendle SY (Standardised Yield) back into a plain token." |
| P20 | "Neither buys a PT (`pendle__pt_buy`) nor mints a PT+YT pair (`pendle__py_mint`) &#8212; do not substitute one for the other." | DUPLICATED. `manifests/sy.ts`: "CANNOT: mint PT or YT (use pendle__py_mint), buy a PT (pendle__pt_buy)". |
| P21 | "`pendle__sy_redeem` is the FALLBACK-SY UNWRAP: when `pendle__pt_redeem` cannot reach Pendle's pricing service it falls back to a direct Router redeem that pays SY, NOT the market's underlying, and reports it as `deliveredAsset`." | DUPLICATED. `manifests/pt.ts`: "if Pendle's pricing service is unavailable Vex falls back to a direct on-chain redeem that delivers SY, the wrapped yield-bearing token, NOT the market's underlying asset"; `manifests/sy.ts`: "THIS IS THE RECOVERY PATH". |
| P22 | "That exit is NOT finished &#8212; pass that `deliveredAsset` to `pendle__sy_redeem` as `sy` to convert it, and tell the user that is what happened rather than reporting the redeem as complete." | JUDGMENT, yield task shape procedure and declaration local fallback limit. Carrying description in `manifests/sy.ts`: "pass that address here as `sy` to finish the exit." |
| P23 | "MOVING A TERM IS ITS OWN ACTION, not a sell followed by a buy." | JUDGMENT, yield task shape procedure. |
| P24 | "When a user wants to EXTEND a fixed rate, roll a maturing position, chase a better rate, or change maturity, reach for `pendle__pt_rollover` (PT to a later-expiry PT of another market) &#8212; it never puts the underlying in the wallet in between, and it reports the implied APY BEFORE and AFTER so you can say whether the roll actually improves the rate." | DUPLICATED. `manifests/reflect.ts`: "Roll a Pendle PT into a LATER-expiry PT of another market in ONE transaction"; "without ever holding the underlying"; "impliedApyBeforePercent / impliedApyAfterPercent". |
| P25 | "Do not manufacture the same outcome from `pendle__pt_sell` + `pendle__pt_buy`." | JUDGMENT, yield task shape procedure. |
| P26 | "`pendle__lp_transfer` is the same primitive for liquidity (LP to another market's LP)." | DUPLICATED. `manifests/reflect.ts`: "Move Pendle liquidity from one market's LP straight into another market's LP in ONE transaction". |
| P27 | "For all of these the SOURCE may be MATURED &#8212; leaving an expired position is exactly the point &#8212; but the DESTINATION must be ACTIVE, and a matured destination is refused by name." | DUPLICATED. `manifests/reflect.ts`: "The SOURCE PT MAY BE MATURED" and "the DESTINATION PT MUST BE ACTIVE"; the LP description carries the same clauses. |
| P28 | "`pendle__lp_to_pt` converts an LP into the SAME market's PT in one step &#8212; variable pool exposure traded for that market's fixed rate." | DUPLICATED. `manifests/reflect.ts`: "Convert a Pendle LP position into the SAME market's PT in one transaction" and "swap variable pool exposure for that market's fixed yield". |
| P29 | "There is no underlying to choose: the PT you receive is that market's own, the optional `pt` param is only a CHECK, and a PT from a different underlying is refused rather than silently substituted." | DUPLICATED. `manifests/reflect.ts`: "the PT you receive is the market's own PT, so there is no underlying to choose" and "The optional `pt` param is a CHECK, not a destination". |
| P30 | "It needs an ACTIVE market; a MATURED LP should be withdrawn with `pendle__lp_remove` instead." | DUPLICATED. `manifests/reflect.ts`: "The market MUST BE ACTIVE" and "a matured LP should be withdrawn with pendle__lp_remove instead." |
| P31 | "To reach a DIFFERENT market's PT, use `pendle__lp_transfer` then `pendle__lp_to_pt`, or exit and buy." | JUDGMENT, yield task shape procedure. No single description carries this two-stage route. |
| P32 | "`pendle__lp_remove_dual` and `pendle__lp_add_keep_yt` each produce TWO instruments where the plain LP tools produce one: removeDual burns the LP into a plain token AND the market's PT, addKeepYt deposits and hands you the LP AND the YT that `pendle__lp_add` would have sold into the pool." | DUPLICATED. `manifests/lp-dual.ts`: "Remove Pendle liquidity into TWO outputs at once: a plain token AND the market's principal token" and "receiving TWO instruments: the market's LP token and its YT." |
| P33 | "Report BOTH legs to the user &#8212; describing either as a single-asset result is wrong." | JUDGMENT, response-format preserved destination for multi-output reporting. |
| P34 | "Be honest about what does NOT exist: there is NO two-token deposit on Pendle, so addKeepYt is still a SINGLE-token add, and `pendle__lp_transfer` has NO keep-YT variant." | DUPLICATED. `manifests/lp-dual.ts`: "It is still a SINGLE-token deposit - Pendle has no two-token 'dual add'." `manifests/reflect.ts`: "keep the YT (no keepYt variant is served)". |
| P35 | "Never offer one." | JUDGMENT, declaration local capability limit. |
| P36 | "The SY, dual-LP and term-mobility tools carry their quote INSIDE the tool instead of a separate `*_quote` tool: call the SAME tool first with `dryRun: true`, which prices the route, runs every fund-safety check and records the authorization, then repeat the call with the EXACT same params to broadcast." | DUPLICATED. `manifests/sy.ts`, `manifests/lp-dual.ts`, and `manifests/reflect.ts`: "CALL IT TWICE: first with dryRun: true, which quotes and records the authorization; then with the EXACT same params to broadcast." Fund-safety and authorization wording stays in the existing exact preserved prompt destination. |
| P37 | "Without that fresh dry run the broadcast is refused." | DUPLICATED. Each cited manifest says: "Without that fresh dry run the execute is refused." |
| P38 | "They are exact-input only &#8212; you choose `amountIn` and receive an ESTIMATE out, never a guaranteed output &#8212; and they take ERC-20 addresses only, never native currency." | DUPLICATED. `manifests/sy.ts`: "guarantee an exact output amount, accept native currency"; the dual and mobility descriptions carry the same limits. |
| P39 | "Before quoting an unfamiliar market, read it with `pendle__market_get` (by market, PT or YT address): it returns the legs, expiry, the tokens the market ACCEPTS, and Pendle's own current rates &#8212; passing a token that is not on those lists is the most common Pendle rejection." | JUDGMENT, yield task shape research-before-quote procedure. `manifests/market-get.ts` carries the local facts about legs, accepted inputs, expiry, and rates. |
| P40 | "It is also the only Pendle read that resolves a MATURED market, which returns no live rates." | DUPLICATED. `manifests/market-get.ts`: "Works for MATURED markets, which the trading tools cannot resolve" and "rates: null, because Pendle serves no live rates once a market expires." |
| P41 | "`pendle__market_history_get` (implied APY / underlying APY / TVL over time) and `pendle__market_candles_get` (PT, YT or LP price candles) answer whether today's rate is high or low for that market &#8212; a rate is never high or low on its own." | JUDGMENT, research task shape comparison procedure. `manifests/market-history.ts` carries the historical series and `manifests/market-candles.ts` carries PT, YT, and LP candles. |
| P42 | "`pendle__asset_prices_get` prices Pendle assets the wallet does not hold; both are display marks, never an executable quote." | DUPLICATED. `manifests/prices-assets.ts`: "including ones the session wallet does not hold" and "NOT executable quotes". |
| P43 | "`pendle__market_orderbook_get` shows resting limit orders." | DUPLICATED. `manifests/orderbook.ts`: "Show the resting LIMIT-ORDER depth on one Pendle market". |
| P44 | "Vex quotes and trades through Pendle's AMM ONLY, so that depth is the price quality being forgone and Vex CANNOT fill it &#8212; never promise a user a price from it." | DUPLICATED. `manifests/orderbook.ts`: "Vex CANNOT FILL these orders" and "every Pendle quote and trade Vex builds routes through the AMM only, so this is the price quality being forgone, not a price you can take." The promise prohibition is a declaration local limit. |
| P45 | "`pendle__merkle_rewards_list` reads campaign/incentive rewards accrued to the wallet." | DUPLICATED. `manifests/rewards-merkle.ts`: "Pendle rewards accrued to the session wallet" and "campaign and incentive rewards distributed off-market". |
| P46 | "Vex can NEVER claim them: Pendle publishes the amount but not the proof a claim needs." | DUPLICATED. `manifests/rewards-merkle.ts`: "VEX CANNOT CLAIM THEM: Pendle's public API publishes the amount but not the merkle proof a claim transaction needs". |
| P47 | "Say so and point the user to app.pendle.finance; `pendle__rewards_claim` is for the accrued interest and rewards Vex can actually sweep." | DUPLICATED. `manifests/rewards-merkle.ts`: "claim at app.pendle.finance instead" and "use pendle__rewards_claim instead when they want Vex to actually collect the on-chain interest and LP rewards". |
| P48 | "NEVER present points as yield." | JUDGMENT, declaration local risk limit. No manifest description carries this sentence. |
| P49 | "A `pointsWarning` on a market means it pays speculative points, not a guaranteed return." | JUDGMENT, declaration local risk limit. The packet's market description exposes points risk flags but does not carry this interpretation. |
| P50 | "Check liquidity before sizing &#8212; thin markets mean high price impact on exit." | JUDGMENT, yield task shape sizing procedure. `manifests/read.ts` carries "screen out thin markets you could not exit", and quote descriptions return `liquidityUsd` and `priceImpact`. |
| P51 | "Always preview with `pendle__pt_quote` (or `pendle__yt_quote` for YT) first; PT/YT buy/sell/redeem require a fresh matching quote and are approval-gated." | DUPLICATED. `manifests/pt.ts`: "a fresh matching pendle__pt_quote must already exist"; `manifests/yt.ts`: "a fresh matching pendle__yt_quote must already exist"; both say "APPROVAL: in a RESTRICTED session this does not execute, it returns pending approval". Existing approval semantics remain at their exact preserved prompt destination. |

## Draft declaration

Pendle is a term-yield venue on Ethereum, Optimism, BNB Smart Chain, Monad, Sonic, HyperEVM, Mantle, Base, Plasma, Arbitrum One, and Berachain. Some chains may have no active markets. Each market splits a yield-bearing asset into a principal token, whose rate is fixed until expiry, and a yield token, whose variable yield decays to zero at expiry.

Read: screen fixed-yield markets by implied APY, liquidity, asset, and maturity. Inspect accepted assets, expiry, current rates, market history, TVL, price candles, and resting orders. Get dollar price marks for PT, YT, LP, and standardised yield assets. Value Pendle positions, maturity state, accrued interest and rewards, and campaign incentives.

Quote: preview exact-input PT or YT entry and exit, equal PT and YT mint or unwind, and single-token liquidity changes. Compare output, price impact, fees, liquidity, and expiry. Marks and resting orders are research only, not executable quotes. Execution uses Pendle's automated market maker and cannot fill resting orders.

Act: buy a principal token to lock fixed yield, sell it early at market price, or redeem it after maturity near face value. Buy or sell a yield token for variable yield exposure. Mint or unwind an equal PT and YT pair before expiry. Add or remove single-token liquidity, add while keeping YT, or remove into a token and the market's PT. Move Pendle liquidity, roll PT to a later active maturity, or convert LP to the same market's PT. Wrap or unwrap standardised yield. Claim on-chain income without closing principal.

Limits: early PT exit can realize a loss. YT is worthless at expiry. LP is not a fixed-rate lock and stops earning after expiry. Thin liquidity can cause high exit price impact. Marks refresh roughly every 15 to 60 seconds, wallet data may lag by weeks, and history does not predict execution. Campaign rewards are readable but not claimable here because their proof is unavailable. Points are speculative incentives, not yield. There is no two-token liquidity add, direct PT-to-YT swap, exact-output trade, cross-chain term move, native-currency leg, or arbitrary recipient. If matured PT redemption delivers SY, unwrap it before treating the exit as complete.

When choosing an action, inspect the market and its expiry first. A source position may be matured when leaving it, but a destination must be active. Preview the exact action before any broadcast and retain the existing approval and irreversible-effect safeguards.

## Packet insufficiency

The packet documents pagination, row caps, truncation, caching, and freshness, but no provider request-rate limit. No request-rate claim is proposed. The packet also does not expose the name of the separate preserved prompt module that owns approval and irreversible-effect wording; the reconciliation ledger must resolve that destination from its wider packet rather than guessing here.
