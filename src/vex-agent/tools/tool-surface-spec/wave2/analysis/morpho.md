# Morpho declaration analysis

## Packet conclusion

Morpho Blue is variable-rate lending. Vex exposes two product shapes: an isolated market where a user chooses one loan asset and one collateral asset, and a curated vault where a manager allocates one deposited asset across markets for a fee. The packet supports two cross-cutting shapes: `yield` for choosing direct market lending versus a managed vault or fixed maturity product, and `positions and risk` for existing debt, liquidation exposure, allowances and recovery ordering. No additional task shape is evidenced.

### Outcomes

- Read: screen and inspect markets and both vault generations; inspect one wallet's lending, collateral, debt, health factors and vault deposits; inspect market activity and liquidations; read rewards, token balances and Morpho allowances.
- Quote: preview one vault deposit or withdrawal, or one market direction, including requirements, decoded transaction, gas, simulation, liquidity and health-factor projection. A quote signs and sends nothing.
- Act: deposit or withdraw from a vault; directly supply or withdraw the market loan asset; supply or withdraw collateral; borrow or repay; claim reward tokens. Priced actions require a fresh quote of the same direction. A reward claim has no quote because it has no price or amount to choose.

### Characteristics and limits

Rates float with utilization, have no maturity, and are point-in-time. Market APY is gross; vault APY is net of curator fees; reward APR is a separate token basis. Morpho Blue and vault publication are permissionless, so unlisted entries remain hidden during screening unless explicitly requested. Detail reads carry oracle warnings, bad debt, liquidity, gates, timelocks and allocation drift. USD values are oracle estimates. Reallocatable liquidity is not committed. V2 wallet-position coverage can be incomplete. Reads have no service guarantee. Writes cost gas, and reward tokens can be worth less than the gas to claim them. Vex cannot create or curate markets or vaults, liquidate other users, invoke Public Allocator reallocations, provide raw historical charts, or combine supply and borrow or repay and withdraw atomically.

### Runtime chain coverage

Source: `src/tools/morpho/chains.ts`, `MORPHO_CHAINS`. Supported slugs and ids are ethereum (1), optimism (10), unichain (130), polygon (137), monad (143), hyperevm (999), robinhood (4663), base (8453), and arbitrum (42161). `MORPHO_CHAINS_OUTSIDE_VEX` proves that Morpho serves World Chain (480), Stable (988), Tempo Mainnet (4217), Arc (5042), and Katana (747474), but Vex deliberately does not read them. This report uses neither discovery chain-name lists nor memory.

## Retrieval terms

Normalization check: case-fold and collapse whitespace only. Each intended term below occurs verbatim in the named frozen `embeddingText`.

| Term | Frozen source and carrying text |
| --- | --- |
| `Morpho lending markets` | `market-reads.ts`, both market reads: "Morpho lending markets" |
| `earn interest` | `market-reads.ts`, market screening: "where to earn interest" |
| `borrow against collateral` | `market-reads.ts`, market screening: "borrow against collateral" |
| `liquidation threshold` | `market-reads.ts`, market screening: "liquidation threshold" |
| `health factor` | `position-reads.ts`, positions: "health factor" |
| `close to liquidation` | `position-reads.ts`, positions: "close to liquidation" |
| `curated Morpho vaults` | `vault-reads.ts`, vault screening: "curated Morpho vaults" |
| `somewhere passive` | `vault-reads.ts`, vault screening: "somewhere passive" |
| `share price` | `vault-reads.ts`, both vault reads: "share price" |
| `claimable` | `wallet-reads.ts`, rewards: "amount claimable now" |
| `unlimited spending allowance` | `wallet-reads.ts`, wallet read: "unlimited spending allowance" |
| `supplying collateral` | `execute-borrow.ts`, market preview: "supplying collateral" |
| `withdraw collateral` | `execute-borrow.ts`, collateral withdrawal: "withdraw collateral" |
| `repay` | `execute-borrow.ts`, repayment: "repay this much" |
| `lend into this market` | `execute-borrow.ts`, direct supply: "lend into this market" |
| `skip the fee` | `execute-borrow.ts`, direct supply: "skip the fee" |

Dropped from the recon suggestion because it is not an exact `embeddingText` substring: `variable-rate lending`, `lend stablecoins`, `supply apy`, `bad debt`, `metamorpho`, `vault apy`, `managed deposit`, `gated vault`, `vault timelock`, `claimable rewards`, `merkl rewards`, `token allowance`, `unlimited approval`, `supply collateral`, `lend directly`, and `skip the curator`. Their concepts remain available through verified phrases above or through frozen aliases, but they are not declared as coupling terms.

## Facet coverage map

| Frozen facet label | Planned declaration prose |
| --- | --- |
| Lending market screening | "Screen Morpho lending markets by asset pair, utilization, rate, size and liquidation threshold." |
| Lending market detail | "Inspect oracle warnings, bad debt, available liquidity, supplying vaults and averaged rates before entering." |
| Curated vault screening | "Compare curated Morpho vaults by asset, curator, deposits, net yield and fee." |
| Curated vault detail | "Inspect ownership, timelocks, queued changes, allocations, caps and withdrawal gates." |
| Preview a vault deposit or withdrawal | "Preview shares, share price, requirements, gas and simulation for a specific amount without signing." |
| Deposit into or withdraw from a vault | "After a matching quote, deposit assets for shares or burn shares to withdraw assets." |
| Price a borrow or a collateral move before doing it | "Preview one market direction with health factor, free liquidity and required permission." |
| Borrow, repay and move collateral on a market | "Supply or remove collateral, borrow, or repay one separately quoted operation at a time." |
| Lend directly into one market instead of a curated vault | "Lend into one selected market without a curator fee, accepting concentrated market risk." |
| Position and liquidation risk | "Read what a wallet lent, posted, owes, and how close to liquidation each borrowing position is." |
| Market activity and liquidation history | "Read supplies, withdrawals, borrows, repayments and liquidations as historical events." |
| Reward campaigns, read and claimed | "Read claimable and pending incentive tokens, or claim whole token rows for gas." |
| Wallet holdings and Morpho approvals | "Read named token balances and standing Morpho allowances, including effectively unlimited permissions." |

## Draft declaration

> Morpho is variable-rate lending to earn interest or borrow across nine EVM chains. A Morpho Blue market pairs one loan asset with one collateral asset at a fixed liquidation threshold, while curated Morpho vaults let a manager spread one deposited asset across markets for a fee. Rates float with utilization and have no maturity.
>
> Read: screen Morpho lending markets by asset pair, utilization, rate, size and liquidation threshold, then inspect oracle warnings, bad debt, liquidity and rates. Compare curated Morpho vaults by asset, curator, deposits, net yield and fee, then inspect timelocks, queued changes, allocations and withdrawal gates. Read what a wallet lent, posted as collateral, owes, and how close to liquidation each position is. Read activity, claimable incentives, token balances and standing allowances, including an unlimited spending allowance.
>
> Quote: preview a specific vault deposit or withdrawal with shares, share price, requirements, gas and simulation. Preview one market direction, including supplying collateral, borrow, repay, withdraw collateral, direct supply or direct withdrawal, with health factor and free liquidity. A quote signs and sends nothing and authorizes only the same direction.
>
> Act: after a fresh matching quote, deposit into or withdraw from a vault; lend into this market or exit; supply or withdraw collateral; borrow or repay. Claim rewards without a quote because a claim has no price or amount to choose. Writes spend gas. Token-pulling actions may require an exact-amount approval. Vex performs one operation at a time and never grants the permanent authorization required for atomic combinations.
>
> Choose a vault for somewhere passive where a curator manages diversification. Choose a market to pick the pair, skip the fee, lend directly, or borrow against collateral. Direct lending concentrates oracle, collateral and liquidity risk in one market. Market APY is gross, vault APY is net of curator fees, and reward APR is a separate token basis. Rates, balances, allowances, health factor and liquidity are point-in-time. USD figures are oracle estimates, reallocatable liquidity is not committed, vault allocations can change, V2 position coverage can be partial, and Morpho publishes no service guarantee.
>
> Coverage is Ethereum, Optimism, Unichain, Polygon, Monad, HyperEVM, Robinhood Chain, Base and Arbitrum. Morpho also serves World Chain, Stable, Tempo Mainnet, Arc and Katana, but Vex does not read those chains.

Draft size target: 1.2 to 2.5 KB. It contains no tool name or dotted id.

## Doctrine carrier catalog

The exact phrases below are from the evaluated manifest descriptions. A doctrine row marked DUPLICATED names one of these carriers.

- C1, market screening description: "A Morpho market is ONE loan asset borrowed against ONE collateral asset at a fixed liquidation threshold; rates float with utilization and there is no maturity." Also: "APY LABELLING IS THE CONTRACT"; "`listedOnly` defaults to TRUE because Morpho Blue is permissionless"; "rates are point-in-time and move with every block"; "USD values are the market oracle's marks rather than traded prices"; "`liquidity.reallocatable` is liquidity that COULD be moved in and is not committed"; "Morpho publishes no SLA".
- C2, market detail description: "Use this AFTER `morpho__markets_discover` has narrowed the candidates and before treating a market as an entry, because it returns the risk facts the screening call cannot carry." Also: "outstanding and realized badDebt in loan-asset units"; "an `oracle_unusable` flag makes every USD figure and every liquidation price here unreliable"; "`reallocatable` liquidity is not committed and can be gone next block".
- C3, vault screening description: "A Morpho vault is a CURATED, MANAGED deposit: the depositor hands one asset to a curator who spreads it across many Morpho Blue lending markets and takes a fee from the yield." Also: "a vault APY is NET of the vault's fee while a market APY is GROSS"; "`gating.withdrawalGated` true means a gate contract decides whether a depositor may exit at all"; "a curator can change a vault's allocations and therefore its risk at any time subject to a timelock".
- C4, vault detail description: "CURATOR DRIFT IS THE MAIN RISK THIS TOOL EXISTS TO SURFACE." Also: "`pendingConfigCount`, the number of governance changes ALREADY QUEUED"; "a loss in an underlying market is socialised through the vault's SHARE PRICE"; "Only V2 vaults have gates".
- C5, positions description: "HEALTH FACTOR IS A RATIO, NOT A PERCENT"; "Below 1 the position is liquidatable RIGHT NOW"; "Morpho Blue has NO CLOSE FACTOR"; "Treat anything under about 1.25 as an emergency, not a warning"; "A NULL HEALTH FACTOR MEANS NO DEBT, NOT SAFETY"; "ONE WALLET PER CALL"; "when `vaultV2Coverage.complete` is false a V2 position may exist that is not listed".
- C6, activity description: "Frequent or large liquidations are a risk signal about the MARKET, not only its borrowers"; "There is no USD figure on any transaction row"; "supply, withdraw, borrow and repay move the LOAN asset; collateral movements move the COLLATERAL asset; a liquidation moves both"; "This is history, not a recommendation signal."
- C7, rewards-read description: "`claimable` is the lifetime accrued amount MINUS what has already been claimed on-chain"; "`pending` is accrual the distributor has computed but NOT yet published into a claimable root"; "A reward token is a SEPARATE asset whose price moves independently"; "When a campaign cannot be resolved its slice is labelled UNRESOLVED".
- C8, wallet-read description: "Treat either flag as a standing risk worth naming, because it lets that contract move the whole balance later without another signature." Also: "AN UNANSWERED READ IS REPORTED AS UNKNOWN, NEVER AS ZERO"; "a wallet holding tokens with no native balance cannot send any transaction"; "Balances and allowances are POINT-IN-TIME"; "cannot grant or revoke an approval."
- C9, vault-preview description: "THIS IS A PREVIEW AND IT COMMITS NOTHING: nothing is signed, nothing is sent, no approval is granted and no funds move." Also: "THE TWO SCALES ARE DIFFERENT and this is the most expensive confusion here"; "A DEPOSIT SIMULATION THAT REVERTS BEFORE THE APPROVAL EXISTS IS NORMAL"; "`transport-ambiguous` means the node did not answer"; "a quote for one direction never authorizes the other."
- C10, vault-deposit description: "a deposit is TWO transactions behind ONE consent." Also: "First a plain ERC-20 `approve()` for EXACTLY this operation's amount"; "the two transactions are not atomic, so if the approval lands and the deposit then fails, a standing allowance is left behind"; "Vex NEVER grants an unlimited approval".
- C11, vault-withdraw description: "A withdrawal is a DIRECT call on the vault on both generations, so there is no approval, no bundle and no standing allowance left behind."
- C12, market-preview description: "REFUSED below a health factor of 1.25, projected fresh and re-checked immediately before signing." Also: "That floor is a PRE-SIGNATURE BUFFER, not an on-chain guarantee"; "A quote of one direction NEVER authorizes another"; "It signs NOTHING, sends nothing, approves nothing and moves no funds".
- C13, collateral-supply description: "What makes the in-between state safe is ORDERING - collateral in before debt out, debt down before collateral out - so a second leg that never lands leaves the position safer than it started." Also: "NOT ATOMIC with any other operation".
- C14, borrow description: "THIS IS THE ONE OPERATION THAT CREATES LIQUIDATION RISK" and "LIQUIDITY IS A SEPARATE LIMIT: a borrow larger than the market's free liquidity (total supplied minus total borrowed, in the loan token) is refused no matter how healthy the position is, and supplying more collateral does not help."
- C15, repay description: "`repayFullDebt: true` closes the debt COMPLETELY by burning the position's exact borrow shares" and "naming `repayAmountRaw` repays exactly that much and LEAVES THE POSITION OPEN."
- C16, collateral-withdraw description: "IT MAKES A POSITION LESS SAFE whenever any debt remains" and "To exit a position entirely, repay the debt to zero FIRST with `morpho__market_repay` and `repayFullDebt`, then withdraw the collateral: the two are separate transactions and the repayment must land before the withdrawal can take everything."
- C17, direct-supply description: "THIS IS THE LENDER'S SIDE AND IT IS NOT COLLATERAL"; "THIS DOES NOT MOVE THE HEALTH FACTOR"; "supplied assets are accounted in SUPPLY SHARES, not an ERC-20 token"; "Supplying cbBTC/USDC DIRECTLY earns the full 4.13% with NO fee".
- C18, direct-withdraw description: "TWO INDEPENDENT LIMITS, each REFUSED BY NAME rather than silently clamped. First, YOUR OWN SUPPLIED POSITION: you cannot withdraw more than you have supplied plus the interest it accrued. Second, THE MARKET'S AVAILABLE LIQUIDITY: supplied assets that borrowers have already drawn are not there to withdraw, so a market that is fully utilised can refuse a withdrawal you are otherwise entitled to."
- C19, reward-claim description: "NO QUOTE IS NEEDED AND NONE EXISTS"; "one claim can deliver several different tokens at DIFFERENT DECIMALS"; "This SPENDS real funds in the sense that it signs and broadcasts an on-chain transaction and costs gas".

## Capsule judgment

- S1. "Morpho is variable-rate lending on nine EVM chains, in two shapes: an isolated Blue MARKET, where one loan asset is borrowed against one collateral asset at a fixed liquidation threshold, and a curated VAULT, where a manager spreads one deposited asset across many of those markets for a fee." DUPLICATED by C1 and C3.
- S2. "Use it to earn interest on an asset, to borrow against collateral, or to inspect a market, a vault or a wallet's own position before acting." JUDGMENT, local capability to declaration.
- S3. "Rates float with utilization and never expire, every borrowing position carries a health factor, and Vex reads, prices and executes all of it." JUDGMENT, split between declaration characteristics and capability outcome groups; the final absolute is narrowed by the proven atomic-combination limit.
- W1. "Use when the user wants to lend, deposit or earn interest on an asset at a FLOATING rate, wants somewhere passive to park an asset under a professional curator, wants to know where borrowing is cheapest, wants to inspect a lending market or a vault before entering, or asks what they already hold, owe or risk being liquidated on." JUDGMENT, local applicability to declaration.
- W2. "The one routing decision to make first is WHO PICKS THE VENUE: a VAULT is a managed deposit a curator spreads across many markets for a fee, a MARKET is one loan asset against one collateral asset the user chooses themselves, and BORROWING LIVES ONLY ON A MARKET." JUDGMENT, `yield` task shape plus concise local distinction in declaration.
- W3. "Search the namespace for the rest: every operation is quoted before it is executed, a quote authorizes only its own direction, and the health-factor, APY-labelling, vault-gating and permissionless-market rules are in the Lending (Morpho) doctrine below." JUDGMENT, remove the doctrine pointer; preserve direction-specific quote gates exactly in C9 and C12, and render the local limits in the declaration. Reward claims remain the proven exception in C19.
- P1. "Use pendle when the user wants a FIXED rate locked to a maturity date - Morpho rates float and never expire." JUDGMENT, `yield` task shape.
- P2. "Use solana for lending on Solana; Morpho here is EVM-only." JUDGMENT, `yield` task shape and runtime-derived declaration coverage.
- P3. "Use kyberswap for ordinary spot swaps." JUDGMENT, `swap` task shape.

## Full doctrine sentence judgment

Each source sentence preserves an em dash as the HTML entity `&#8212;`, never as the literal character.

1. "morpho.* is VARIABLE-RATE lending on Morpho Blue across nine EVM chains." DUPLICATED by C1.
2. "A market is ONE loan asset borrowed against ONE collateral asset at a fixed liquidation threshold (LLTV); the rate floats with utilization and NEVER expires." DUPLICATED by C1.
3. "This is the opposite shape to pendle.*, which locks a FIXED rate until a maturity date &#8212; when a user asks for a guaranteed or fixed return, that is Pendle, not Morpho." JUDGMENT, `yield` task shape.
4. "Solana lending is solana__lend_*; Morpho here is EVM-only." JUDGMENT, `yield` task shape and runtime-derived declaration coverage.
5. "Vex can DEPOSIT into and WITHDRAW from a curated VAULT, and on a VOUCHED market it can SUPPLY COLLATERAL, BORROW, REPAY and WITHDRAW COLLATERAL - always after quoting that same operation first." JUDGMENT, local capability summary in declaration; exact quote and vouching gates remain in C9, C10, C11 and C12 through C16.
6. "Vex can also CLAIM the reward tokens a position has earned, with morpho__rewards_claim." DUPLICATED by C19: "CLAIM the reward tokens the wallet has already earned on Morpho".
7. "What Vex still CANNOT do on Morpho: atomic supply-and-borrow combinations (each operation is its own gated transaction)." DUPLICATED by C13.
8. "Say so plainly instead of implying otherwise." JUDGMENT, declaration local limit.
9. "WORKFLOW: each lane is screen-then-read. morpho__markets_discover then morpho__market_get for markets; morpho__vaults_discover then morpho__vault_get for vaults." DUPLICATED by C2 and C4.
10. "Never recommend a market or a vault from the screening row alone &#8212; the detail call is the only one that returns bad debt, the oracle price, and total liquidity." DUPLICATED by C2 and C4.
11. "APY BASES ARE NOT COMPARABLE UNLABELLED. supplyApyPercent and borrowApyPercent EXCLUDE incentives; netSupplyApyPercent and netBorrowApyPercent INCLUDE them; each rewards[] entry is a separate APR paid in ITS OWN token, whose price can move independently." DUPLICATED by C1, C3 and C7.
12. "Never rank a net figure against a base figure, never add a reward APR to a net APY, and always say which basis a number you quote came from." JUDGMENT, `yield` task shape.
13. "A market APY is GROSS of any vault fee; a supplying vault's netApyPercent is NET of it &#8212; those two are different bases and must never be ranked against each other." DUPLICATED by C2 and C3.
14. "MORPHO BLUE IS PERMISSIONLESS." DUPLICATED by C1.
15. "Anyone can deploy a market, so listedOnly defaults to true and you must keep it that way unless the user explicitly asks for uncurated markets." DUPLICATED by C1.
16. "When listed is false nobody vetted the market; an enormous headline APY on a market holding almost nothing is the normal appearance of a broken or empty market, not an opportunity." DUPLICATED by C1: "ranking UNLISTED markets by net supply APY returned 297,995% on a market holding 0.04 USD and flagged `oracle_unusable`".
17. "READ THE WARNINGS BEFORE THE RATE." JUDGMENT, `yield` and `positions and risk` task shapes.
18. "A RED warning names a concrete defect. oracle_unusable in particular means every USD value AND every liquidation price on that market is unreliable, so the size figures cannot be used to judge it." DUPLICATED by C2.
19. "Non-zero outstanding badDebt means suppliers have ALREADY lost principal and it is socialised across everyone supplying that market." DUPLICATED by C2 and C6.
20. "USD VALUES ARE ORACLE ESTIMATES, not traded prices: they come from the market's own price feed." DUPLICATED by C1 and C2.
21. "Present them as estimates, and never present one from a market with an oracle warning at all." JUDGMENT, declaration limit and `positions and risk` task shape.
22. "LIQUIDITY: liquidity.available is what can be borrowed or withdrawn right now. liquidity.reallocatable and the Public Allocator breakdown are liquidity that COULD be moved in by a vault &#8212; it is not committed and can be gone in the next block." DUPLICATED by C2.
23. "Never promise a withdrawal or a borrow against reallocatable liquidity." DUPLICATED by C2.
24. "A market at or near full utilization pays the highest supply rate and has the LEAST withdrawable liquidity." JUDGMENT, declaration local characteristic.
25. "Say both halves; quoting the rate without the exit risk is a misleading recommendation." JUDGMENT, `yield` task shape.
26. "A higher LLTV means a borrower may take more debt per unit of collateral AND is liquidated sooner in a drawdown." JUDGMENT, declaration local characteristic and `positions and risk` task shape.
27. "Neither direction is safer on its own &#8212; state the trade-off rather than ranking LLTV as a quality score." JUDGMENT, `positions and risk` task shape.
28. "IDENTIFIERS: a Morpho marketId is a 64-hex hash and is CHAIN-SCOPED, not a contract address. morpho__market_get needs both marketId and chain; the same id on the wrong chain resolves to nothing." DUPLICATED by C2: "both REQUIRED - a market id is chain-scoped and the same id on the wrong chain resolves to nothing".
29. "Morpho publishes NO service guarantee." DUPLICATED by C1 and C2.
30. "A Morpho read is never a hard dependency: if it fails, report the named failure honestly rather than proceeding on a guess." JUDGMENT, declaration limit.
31. "TWO SHAPES, ROUTE BY WHO PICKS THE VENUE." JUDGMENT, `yield` task shape.
32. "A curated VAULT is a MANAGED deposit: the user hands one asset to a curator who spreads it across many markets and takes a fee." DUPLICATED by C3.
33. "A MARKET is one loan asset against one collateral asset that the user picks themselves, and it is also the only way to BORROW, which Vex can now do." JUDGMENT, declaration local distinction and `yield` task shape.
34. "Passive, set-and-forget, or where do I park this means vault." JUDGMENT, declaration applicability using the verified term `somewhere passive`.
35. "Naming an asset pair, choosing a collateral, or borrowing means market." JUDGMENT, declaration applicability and `yield` task shape.
36. "A VAULT APY IS NET OF THE CURATOR FEE; A MARKET APY IS GROSS." DUPLICATED by C3.
37. "Never rank a vault netApyPercent against a market supplyApyPercent, and never present the gap between a vault and the markets it allocates to as an opportunity &#8212; that gap IS the fee." DUPLICATED by C2 and C3.
38. "On a vault row apyPercent is before the fee, netApyPercent is what a depositor earns, netApyExcludingRewardsPercent is after the fee without incentives, and each reward is an APR in its own token." DUPLICATED by C3.
39. "GATED VAULTS CAN BLOCK A WITHDRAWAL." DUPLICATED by C3.
40. "Only V2 vaults have gates and they are surfaced by the gating block: withdrawalGated true means a contract decides whether a depositor may exit, depositGated blocks entry." DUPLICATED by C3 and C4.
41. "Read that flag before recommending any deposit and state it plainly when it is set." DUPLICATED by C3: "never recommend a deposit without reading this flag".
42. "A V1 vault reports gating: null, which means no such mechanism exists, not that it was not checked." DUPLICATED by C3: "V1 vaults report `gating: null`".
43. "CURATOR DRIFT: a vault's allocations, and therefore its risk, are a CHOICE the curator can change, subject to timelocks that run from zero to about three weeks depending on the function." DUPLICATED by C4.
44. "What a vault holds today is not what it will hold tomorrow." DUPLICATED by C4: "Today's allocations are not a property of the vault".
45. "Re-read the vault before acting on an allocation list from earlier in the conversation, and treat pendingConfigCount above zero as a change already in flight." DUPLICATED by C4.
46. "On a V2 vault a loss in an underlying market is socialised through the SHARE PRICE, so it reaches every depositor rather than only the position that caused it." DUPLICATED by C4.
47. "Vault screening covers BOTH generations by default. search and assetSymbol are V1-only predicates and sort: name is a V1-only ranking; asking for one while V2 is in scope is refused BY NAME rather than applied to half the results." DUPLICATED by C3: "COVERS BOTH VAULT GENERATIONS" and "REJECTED BY NAME when v2 is in scope".
48. "Use assetTokenAddress when the user names an asset, since both generations serve it." DUPLICATED by C3: "`direct` and `both` need `assetTokenAddress` to name EXACTLY ONE asset".
49. "POSITIONS ARE A SEPARATE INTENT FROM SCREENING. morpho__positions_get answers what a wallet ALREADY holds and owes; morpho__markets_activity_list answers what already HAPPENED in a market." DUPLICATED by C5 and C6.
50. "Neither is a way to find somewhere to lend." JUDGMENT, `positions and risk` task shape.
51. "Route a question about the user's own money, their debt, or their liquidation risk to the positions read, never to a discover tool." JUDGMENT, `positions and risk` task shape.
52. "HEALTH FACTOR IS A RATIO, NOT A PERCENTAGE, and 1 is the line." DUPLICATED by C5.
53. "Below 1 the position is liquidatable RIGHT NOW." DUPLICATED by C5.
54. "Morpho Blue has NO CLOSE FACTOR: one liquidation can repay the ENTIRE debt and seize collateral worth up to the liquidation incentive on top, so a whole position can go in a single block." DUPLICATED by C5.
55. "There is no partial-liquidation cushion to rely on." DUPLICATED by C5: "there is no partial-liquidation cushion".
56. "Treat anything under roughly 1.25 as an emergency rather than a warning, state the number and its band, and never reassure on a thin margin." DUPLICATED by C5.
57. "A NULL HEALTH FACTOR MEANS NO DEBT, NOT SAFETY." DUPLICATED by C5.
58. "A supply-only position has nothing to liquidate, so Morpho returns nothing to report." DUPLICATED by C5: "a supply-only position has nothing to liquidate".
59. "Never describe such a row as safe, healthy or checked on the strength of an absent number, and never fill the gap with an assumed value." DUPLICATED by C5: "Never read that absence as a checked, healthy position."
60. "POSITIONS ARE READ ONE WALLET AT A TIME, by design rather than by API limitation." DUPLICATED by C5.
61. "Do not attempt to combine several addresses into one call, and do not present one wallet's reading as a person's whole exposure: another address they control is simply not in scope, and its absence is not evidence that nothing is there." DUPLICATED by C5: "A second address is rejected by name."
62. "A PORTFOLIO TOTAL IN USD IS AN ORACLE ESTIMATE, summed from each market's own price feed." DUPLICATED by C5: "USD figures are Morpho's oracle marks, not traded prices, so totals are estimates".
63. "Present it as an estimate, say when rows could not be priced at all, and never quote a total that includes a market carrying an oracle warning without naming that warning." JUDGMENT, `positions and risk` task shape.
64. "LIQUIDATION HISTORY IS A MARKET-RISK SIGNAL, not only a borrower's misfortune." DUPLICATED by C6.
65. "Frequent or large liquidations say the market's oracle or its liquidity already failed somebody there, and a liquidation leaving BAD DEBT means suppliers lost principal that is socialised across everyone in the market." DUPLICATED by C6.
66. "Read activity before recommending a market that looks attractive on rate alone, and read volume next to the market's size rather than on its own." JUDGMENT, `yield` and `positions and risk` task shapes.
67. "ACTIVITY AMOUNTS HAVE NO USD AND THEIR ASSET DEPENDS ON THE EVENT." DUPLICATED by C6.
68. "Supply, withdraw, borrow and repay move the LOAN asset; collateral movements move the COLLATERAL asset; a liquidation moves both, with repaid and bad debt in the loan asset and seized in the collateral asset." DUPLICATED by C6.
69. "Each amount carries its own decimals, so never read one with the other leg's scale, and never price a historical amount at today's mark and present the product as what happened." DUPLICATED by C6.
70. "VAULT V2 POSITION COVERAGE IS COMPOSED AND CAN BE PARTIAL." DUPLICATED by C5.
71. "Morpho publishes no per-user list of V2 vault positions, so Vex finds candidates from the wallet's own V2 transaction history and reads each one." DUPLICATED by C5.
72. "When the reply's vaultV2Coverage.complete is false, say that a V2 position may exist that is not listed rather than presenting the list as the whole picture." DUPLICATED by C5.
73. "REWARDS ARE SEPARATE TOKENS AND NOT GUARANTEED INCOME." DUPLICATED by C7 and C19.
74. "An incentive reward is paid in its OWN asset, whose price moves independently of whatever was supplied to earn it, and a campaign can end." DUPLICATED by C7.
75. "Report claimable as what a claim would deliver now and pending as accrual that is not claimable yet and can still change; never present the lifetime accrued figure as a claimable balance, and never treat a reward APR as part of the lending rate." DUPLICATED by C7.
76. "Claiming is an on-chain transaction that costs gas and Vex CAN perform it with morpho__rewards_claim: it needs NO quote, sweeps every claimable row on one chain in ONE transaction, and can deliver SEVERAL different reward tokens at different decimals, which must never be added together." DUPLICATED by C19.
77. "Because it costs gas, say so before claiming a dust balance." JUDGMENT, declaration local cost and exact effect disclosure retained in C19.
78. "A claim delivers whole token rows, so morphoOnly narrows which ROWS are swept and never the amounts inside one." DUPLICATED by C19: "A CLAIM TAKES WHOLE TOKEN ROWS."
79. "When reward attribution is reported as incomplete, say the Morpho share is unknown rather than saying there is none." DUPLICATED by C7.
80. "AN UNLIMITED ALLOWANCE IS A STANDING RISK WORTH NAMING." JUDGMENT, exact-preserve in C8.
81. "An approval survives until it is changed, so an unlimited one lets that contract move the entire balance of that token later without another signature." JUDGMENT, exact-preserve carrying sentence in C8.
82. "A max approval that has been partly drawn no longer equals the maximum but is still unbounded in practice, so treat effectivelyUnlimited as the flag to act on and unlimited as the narrower question of whether it is untouched." JUDGMENT, exact-preserve C8 distinction between `unlimited` and `effectivelyUnlimited`.
83. "When a wallet read shows one, name the contract, say what it can do, and say Vex cannot revoke it." JUDGMENT, exact-preserve in C8, including "cannot grant or revoke an approval."
84. "Never report an approval or a balance that could not actually be read as zero: an unknown reported as zero reads as safety, and on an approval that is the reassuring answer and the wrong one." JUDGMENT, exact-preserve in C8: "AN UNANSWERED READ IS REPORTED AS UNKNOWN, NEVER AS ZERO."
85. "BALANCES AND ALLOWANCES ARE POINT-IN-TIME." DUPLICATED by C8.
86. "They are read at one block and can change before anything built on them is sent, so re-read immediately before acting rather than relying on an earlier reading in the conversation." DUPLICATED by C8.
87. "The native balance is the gas budget: a wallet with tokens and no native balance cannot send anything on that chain, whatever its approvals say." DUPLICATED by C8.
88. "QUOTE BEFORE ANY DEPOSIT OR WITHDRAWAL, AND A QUOTE COMMITS NOTHING. morpho__vault_quote prices one specific amount into or out of one vault: the shares it would mint or burn, the share price the transaction would enforce, what the wallet would have to approve first, the decoded transaction, its gas, and a simulation verdict." DUPLICATED by C9.
89. "It is MANDATORY before morpho__vault_deposit and morpho__vault_withdraw, which REFUSE without a fresh quote of the same operation, and it is also the right call whenever the question is how many shares an amount would buy." DUPLICATED by C9.
90. "It signs nothing, sends nothing and approves nothing, so there is no reason to hesitate over one." DUPLICATED by C9.
91. "Pass walletAddress to learn which requirements would actually still apply to that wallet; without it the answer is what a fresh wallet would face." DUPLICATED by C9: "Pass `walletAddress` to have the requirements reflect that wallet's CURRENT allowance; without it they are what a fresh wallet would face."
92. "READING A QUOTE HONESTLY. input and expectedShares are in DIFFERENT units, each carrying its own decimals, so never compare or subtract the two raw figures." DUPLICATED by C9.
93. "A DEPOSIT quote carries an on-chain share-price ceiling and requirements; a WITHDRAWAL quote has neither, and neither absence is a defect." DUPLICATED by C9.
94. "A deposit simulation that REVERTS before the one-time approval exists is normal and is not a fault in the vault: report it as a missing approval, never as a broken vault. transport-ambiguous means the node did not answer, which is not the same as a proven revert, and a null gas figure means the node refused to estimate rather than that the transaction is free." DUPLICATED by C9.
95. "A DEPOSIT IS TWO TRANSACTIONS BEHIND ONE CONSENT AND IS NOT ATOMIC." JUDGMENT, exact-preserve in C10.
96. "There is no signature path at all: Vex sends a plain ERC-20 approval for EXACTLY the deposit amount to the chain's pinned adapter, then the deposit." JUDGMENT, exact-preserve in C10.
97. "If the second fails after the first lands, an allowance bounded to that one amount is left standing; report that plainly rather than as a clean failure, and say a retry consumes it." JUDGMENT, exact-preserve in C10.
98. "A WITHDRAWAL is one direct call on the vault, no approval and no bundle." JUDGMENT, exact-preserve in C11.
99. "NINETEEN MORPHO TOOLS: ten reads and previews, plus NINE that move real funds." JUDGMENT, replace inventory count with declaration outcome groups so it cannot drift.
100. "On VAULTS: morpho__vault_deposit and morpho__vault_withdraw." JUDGMENT, declaration act outcome without tool names.
101. "On BLUE MARKETS, the borrower's side: morpho__market_supply_collateral, morpho__market_borrow, morpho__market_repay and morpho__market_withdraw_collateral; and the LENDER'S side: morpho__market_supply and morpho__market_withdraw." JUDGMENT, declaration act outcome without tool names.
102. "On REWARDS: morpho__rewards_claim." JUDGMENT, declaration act outcome without tool names.
103. "Vex can now run the whole borrowing lifecycle on a market it vouches for, so it CAN act on a position near liquidation: supplying collateral or repaying debt both raise the health factor." JUDGMENT, `positions and risk` task shape; operation facts remain in C13, C14 and C15.
104. "It can also LEND directly into a single market instead of through a curated vault." DUPLICATED by C17.
105. "Every one of the nine takes dryRun for a rehearsal that signs nothing and records its outcome in the activity ledger." DUPLICATED by each write manifest's `dryRun` parameter carrying phrase, "Set true to get the FULL preview and sign nothing", and by the write descriptions' recorded-outcome clauses.
106. "EIGHT of the nine are gated on a fresh matching quote; morpho__rewards_claim is NOT, because a claim has no price, no slippage and no size to quote - do not look for a rewards quote tool, there is none." DUPLICATED by C9, C12 and C19.
107. "QUOTE BEFORE ANY MARKET OPERATION, PER DIRECTION. morpho__market_quote prices one operation on one market - direction is supplyCollateral, withdrawCollateral, borrow, repay, supply or withdraw - and returns the vouching verdict, the health factor BEFORE and AFTER against the floor, the position, the market's free liquidity, the allowance plan and the decoded transaction." DUPLICATED by C12.
108. "It signs nothing." DUPLICATED by C12.
109. "It is MANDATORY before the matching execute, and a quote of ONE direction NEVER authorizes another: a collateral quote cannot authorize a borrow." DUPLICATED by C12.
110. "Every projection belongs to ONE wallet - the one named, else the session's, else a stand-in with no position, which the reply says out loud." DUPLICATED by C12: "Every projection belongs to ONE wallet: the one named, else the session's selected wallet, else a stand-in with NO position, which the reply says out loud rather than implying the numbers are somebody's."
111. "THE 1.25 HEALTH-FACTOR FLOOR IS A REFUSAL, NOT ADVICE, AND IT IS A BUFFER RATHER THAN A GUARANTEE." JUDGMENT, exact-preserve in C12 and every affected execute description.
112. "Vex REFUSES any market operation projected to leave the position below 1.25, computed from freshly accrued state and re-checked immediately before signing, so an operation that cleared the floor when planned is refused rather than sent if the oracle moved first." JUDGMENT, exact-preserve in C12 and affected execute descriptions.
113. "What it CANNOT do is bind the chain: the transaction Vex signs is a plain Morpho Blue call carrying no floor of its own, so an oracle move between signing and inclusion can land the position below 1.25 while still above Morpho's own liquidation threshold of 1." JUDGMENT, exact-preserve in C12 and affected execute descriptions.
114. "Present 1.25 as a pre-signature risk buffer, never as a level the position is guaranteed to hold." JUDGMENT, exact-preserve in C12 and `positions and risk` task shape.
115. "This is why the buffer is that wide: Morpho has NO CLOSE FACTOR, so one liquidation takes the WHOLE position rather than the underwater part." JUDGMENT, exact-preserve in C5 and C12.
116. "Tell a user asking for a bigger borrow that the floor refused it and what would make it possible - more collateral, or a smaller amount - rather than implying the market said no." JUDGMENT, `positions and risk` task shape; refusal detail remains in C12 and C14.
117. "VEX ONLY ACTS ON MARKETS IT CAN VOUCH FOR." JUDGMENT, exact-preserve in C12 and each market execute description.
118. "Blue is permissionless and a market with a manipulable oracle can drain a position, so an operation is refused unless the IRM is the chain's pinned one AND the oracle was either minted by the Chainlink oracle factory or is on the owner's allowlist." JUDGMENT, exact-preserve in the market quote and execute descriptions under C12 through C18.
119. "The gate is strict on purpose: of 100 Base markets sampled on 2026-08-17, only 9 passed it." JUDGMENT, exact-preserve in C12 and each market execute description: "only 9 of 100 Base markets sampled passed it."
120. "A refusal names which predicate failed, and it is a statement about Vex's confidence rather than a verdict that the market is a scam." JUDGMENT, `positions and risk` task shape; named refusal remains in C12 through C18.
121. "Reads are NOT gated - morpho__market_get describes any market, including ones Vex will not act on." DUPLICATED by C2 and C12.
122. "ONE OPERATION AT A TIME, AND NO ATOMIC COMBINATIONS." JUDGMENT, exact-preserve in C13 through C18 and concise declaration limit.
123. "Each market operation moves exactly ONE token in ONE direction and is its own transaction: there is no supply-and-borrow and no repay-and-withdraw." JUDGMENT, exact-preserve in C13 through C18.
124. "Morpho offers both as atomic bundles, but each requires granting an adapter a STANDING, PERMANENT authorization over the wallet's entire Morpho position on every market on the chain, which Vex NEVER grants." JUDGMENT, exact-preserve in C13 through C18.
125. "So a leveraged loop is not something Vex can do: it would be N separate transactions with the position exposed in between, and promising a loop, a leveraged long or multiplied exposure would promise a product Vex does not have." JUDGMENT, declaration local limit and `positions and risk` task shape.
126. "Say what Vex can actually do, one step at a time." JUDGMENT, `positions and risk` task shape.
127. "What protects the in-between state is ORDERING, not the health-factor floor: collateral goes IN before debt goes out, and debt comes DOWN before collateral comes out, so a failure of the second leg leaves the position safer than it started rather than exposed." JUDGMENT, exact-preserve in C13 through C18 and `positions and risk` task shape.
128. "Each step is also quoted and gated on its own projected post-state, but that projection is a buffer taken before signing and not a promise about the block it lands in." JUDGMENT, exact-preserve in C12 through C18.
129. "DIRECT VERSUS CURATED IS A FEE-AGAINST-MANAGEMENT CHOICE, AND THE NUMBERS ARE MEASURED RATHER THAN ASSUMED. morpho__market_supply lends the loan asset into ONE Blue market and morpho__market_withdraw takes it back out; morpho__vault_deposit hands the same money to a curator who spreads it across several markets." JUDGMENT, `yield` task shape; local facts remain in C3 and C17.
130. "Measured on Base: every curated USDC vault earns the SAME gross 4.13%, because they allocate into these same markets, and the only thing separating them is the curator's performance fee - Gauntlet at 0% nets 4.13%, Steakhouse Prime at 5% nets 3.92%, Spark at 10% nets 3.71%, Steakhouse USDC at 25% nets 3.08%." DUPLICATED by C17.
131. "Supplying cbBTC/USDC directly earns the full 4.13% with no fee at all." DUPLICATED by C17.
132. "So the fee is not waste: it buys diversification and somebody who REALLOCATES when a market degrades, and a direct supply concentrates the whole position in one market's collateral, oracle and LLTV with nobody moving it for you." DUPLICATED by C17.
133. "Present BOTH halves and let the user choose; do not default to 'the vault is safer' or to 'direct is cheaper'." JUDGMENT, `yield` task shape.
134. "A MARKET SUPPLY IS THE LENDER'S SIDE AND MOVES NO HEALTH FACTOR." DUPLICATED by C17.
135. "It earns interest, it backs no loan, it cannot be liquidated, and it is denominated in the market's LOAN token rather than its collateral token - supplyAmountRaw and supplyCollateralAmountRaw are different operations on different tokens, and each is refused by name at the other's tool." DUPLICATED by C17.
136. "The position is accounted in SUPPLY SHARES rather than an ERC-20, so nothing is minted to the wallet and nothing appears in a token balance: read it back with morpho__positions_get." DUPLICATED by C17.
137. "Interest accrues into the share price, so what is withdrawable grows with no further transaction." DUPLICATED by C17.
138. "A WITHDRAWAL has TWO independent limits, both refused by name rather than clamped: the wallet's own supplied position, and the market's FREE LIQUIDITY - assets that borrowers have already drawn are not there to take back, so a fully utilised market can refuse a withdrawal the wallet is otherwise entitled to." DUPLICATED by C18.
139. "That is the real cost of lending directly; the remedy is to wait for a repayment or withdraw the part that is free, not to retry." DUPLICATED by C18.
140. "SUPPLYING COLLATERAL IS NOT DEPOSITING." DUPLICATED by C13 and C17.
141. "Collateral sits on a market to support borrowing and EARNS NOTHING; a vault deposit earns yield." DUPLICATED by C13: "COLLATERAL IS NOT A DEPOSIT AND EARNS NOTHING: it sits on the market to support borrowing and to hold the position away from liquidation." The vault contrast is carried by C17.
142. "A user who wants to earn on an asset wants morpho__vault_deposit." JUDGMENT, `yield` task shape, narrowed to preserve the direct-market alternative proven by C17.
143. "Of the four BORROWER-side market operations, supplying collateral and repaying always RAISE the health factor, while borrowing and withdrawing collateral LOWER it - and borrowing is the only one that creates liquidation risk where there was none." DUPLICATED across C13 through C16.
144. "The two LENDER-side operations move it not at all." DUPLICATED by C17 and C18.
145. "ONLY A FULL-DEBT REPAYMENT REACHES ZERO. repayAmountRaw repays exactly that much and LEAVES THE POSITION OPEN; an amount can never close a debt, because interest accrues between the block it is computed and the block it lands, leaving dust that keeps accruing and keeps the collateral locked. repayFullDebt: true burns the position's exact borrow SHARES and lands at zero." DUPLICATED by C15.
146. "Because those shares cost slightly more by the time they land, that mode pulls a little MORE than the debt and sweeps the residual back in the same transaction: report the PROVEN settled amount, never the pull." DUPLICATED by C15.
147. "To exit a position entirely, repay in full FIRST, then withdraw the collateral - two transactions, in that order." DUPLICATED by C15 and C16.
148. "WHAT VEX STILL CANNOT DO ON MORPHO, deliberately, is exactly ONE thing: any ATOMIC combination of the operations above - no supply-and-borrow in one transaction and no repay-and-withdraw in one transaction." JUDGMENT, exact-preserve in C13 through C18 and concise declaration limit.
149. "That is not an oversight and it is not coming for free, because the atomic path costs a permanent standing authorization of the adapter over the whole wallet's Morpho position." JUDGMENT, exact-preserve in C13 through C18.
150. "Everything else in this namespace Vex CAN do, claiming rewards included: do not tell a user to go elsewhere for a claim, a borrow, a repayment or a collateral move." JUDGMENT, declaration capability groups, narrowed by all packet-backed limits rather than retaining the absolute.

## D4 note

Not applicable. Morpho is not one of the four swap or bridge venue namespaces. Any venue preference belongs only in the swap and bridge task shapes.

## Packet sufficiency

The assigned packet was sufficient. The only retrieval issue was productive: several recon vocabulary suggestions exist only in frozen aliases or example intents, not in `embeddingText`. They were excluded from the declaration coupling list instead of being guessed. Every capsule and doctrine sentence is assigned.
