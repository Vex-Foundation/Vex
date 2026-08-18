import type { ProtocolNamespaceNavigation } from "../types.js";

export const MORPHO_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "morpho",
  advertised: true,
  groupId: "evm-trading",
  groupLabel: "EVM Trading",
  summary:
    "Morpho variable-rate lending across nine EVM chains (Ethereum, Base, Arbitrum, Optimism, Polygon, Unichain, HyperEVM, Monad, Robinhood Chain), in two shapes: isolated Blue MARKETS screened by rate, size, utilization and liquidation threshold and read in full including bad debt and the oracle liquidations are decided against, and curated VAULTS (V1 MetaMorpho and V2) screened by deposits, net APY and curator fee and read in full including roles, timelocks, per-market allocations and withdrawal gating. Alongside them, two wallet-side reads: the incentive tokens a wallet can claim on top of its rate, and what a wallet holds together with the Morpho contracts it has already approved to move it. Alongside the reads, two PREVIEWS that sign nothing: what a specific deposit into or withdrawal from a vault would mint, cost and require, and what one operation on one Blue market would do to the position's health factor. And SEVEN EXECUTING tools that move real funds. On VAULTS, after a fresh preview: deposit assets for shares, and withdraw assets by burning shares. On a VOUCHED Blue MARKET, each after a fresh preview of its OWN direction: supply collateral, borrow against it, repay debt, and withdraw collateral. On REWARDS, needing no preview because a claim has no price or size to choose: claim the reward tokens the wallet has already earned. The one thing Vex deliberately does NOT do is combine two market operations atomically, because the atomic path would require granting an adapter a permanent standing authorization over the wallet's whole Morpho position.",
  whenToUse:
    "Use when the user wants to lend, deposit or earn interest on an asset at a FLOATING rate, wants somewhere passive to park an asset under a professional curator, wants to know where borrowing is cheapest, or wants to inspect a lending market or a vault before entering. Route by who picks the venue: a VAULT is a managed deposit spread across many markets by a curator who takes a fee, a MARKET is one loan asset against one collateral asset that the user chooses themselves. Start with morpho.vaults.discover or morpho.markets.discover to screen, then the matching get tool. When the user asks about what they ALREADY hold, what they owe, or whether they are near liquidation, that is morpho.positions.get, not a screening tool; when they ask what has happened in a market or want an address audited, that is morpho.markets.activity. When they ask about unclaimed rewards or incentive tokens earned on top of the rate, that is morpho.rewards.get, and when they tell Vex to actually collect them that is morpho.rewards.claim, which needs no quote because a claim has no price and no size to choose; when they ask what a wallet holds or which contracts it has approved to spend a token, that is morpho.wallet.balance, though a plain balance question with no approval angle belongs to wallet_balances instead. When the user names an AMOUNT and wants to know what depositing or withdrawing it would actually do, that is morpho.vault.quote, which prices the operation without performing it. When the user then tells Vex to go ahead, morpho.vault.deposit and morpho.vault.withdraw perform it on a VAULT, and each one requires a fresh morpho.vault.quote of the same operation first. BORROWING LIVES ON A MARKET, NOT A VAULT: morpho.market.quote prices supplying collateral, borrowing, repaying or withdrawing collateral on one market, and morpho.market.supplyCollateral, morpho.market.borrow, morpho.market.repay and morpho.market.withdrawCollateral perform them, each requiring a fresh quote of ITS OWN direction. LENDING ALSO LIVES ON A MARKET, DIRECTLY: morpho.market.supply lends the loan asset into ONE market to earn its own borrow rate with no curator and no fee, and morpho.market.withdraw takes it back out, both quoted per direction like the rest. That is the DIRECT alternative to a vault, and the tradeoff is measured rather than assumed - the gross rate is the same because the vaults allocate into these same markets, so what a curator's fee buys is diversification and somebody reallocating when a market degrades, while a direct supply concentrates the position in one market's collateral, oracle and LLTV. A market supply is NOT collateral, earns interest, and moves NO health factor; a market withdrawal is bounded by the wallet's own supplied position AND by the market's free liquidity. Vex acts only on markets whose oracle it can vouch for and refuses to sign anything projected to leave the health factor below 1.25, which is a pre-signature buffer rather than an on-chain guarantee. The one thing there is no tool for is an ATOMIC combination of market operations: supply-then-borrow and repay-then-withdraw are each two separately quoted and separately consented operations, kept safe by their ORDER rather than by atomicity. The APY-labelling, health-factor, vault-gating and permissionless-market rules live in the Lending (Morpho) doctrine below.",
  preferInstead:
    "Use `pendle` when the user wants a FIXED rate locked to a maturity date - Morpho rates float and never expire. Use `solana.lend` for lending on Solana; Morpho here is EVM-only. Use `kyberswap` for ordinary spot swaps.",
  exampleQueries: [
    'discover_tools(query="lend usdc morpho", namespace="morpho")',
    'discover_tools(query="cheapest borrow rate", namespace="morpho")',
    'discover_tools(query="is this lending market safe", namespace="morpho")',
    'discover_tools(query="am I close to liquidation", namespace="morpho")',
    'discover_tools(query="deposit into a morpho vault", namespace="morpho")',
  ],
  aliases: ["morpho", "lending", "lend", "borrow", "supply apy", "variable rate lending", "money market", "curated vault", "metamorpho", "vault curator", "health factor", "liquidation risk", "my positions", "liquidation history", "claimable rewards", "unclaimed rewards", "token allowance", "unlimited approval", "deposit into a vault", "withdraw from a vault", "redeem vault shares"],
  discoveryHints: [
    "where to lend usdc",
    "earn interest on stablecoins",
    "cheapest borrow rate",
    "borrow against cbbtc",
    "lending market liquidity",
    "liquidation threshold",
    "is this lending market safe",
    "morpho bad debt",
    "best vault for usdc",
    "curated vault yield",
    "can I withdraw from this vault",
    "am I close to liquidation",
    "what do I owe on morpho",
    "recent liquidations",
    "what rewards can I claim",
    "do I have unclaimed rewards",
    "claim my morpho rewards",
    "harvest my incentive tokens",
    "check my token balance and approvals",
    "do I have an unlimited allowance",
    "deposit into this morpho vault",
    "put my usdc in the vault now",
    "withdraw from this morpho vault",
    "take my money out of the vault",
  ],
  facets: [
    {
      label: "Lending market screening",
      summary:
        "Search Morpho Blue markets by chain, asset pair, size, utilization, rate and liquidation threshold to find where to lend or borrow.",
      toolPrefixes: ["morpho.markets"],
      hints: ["where to lend usdc", "cheapest borrow rate", "lending markets by collateral", "supply apy ranking"],
    },
    {
      label: "Lending market detail",
      summary:
        "Read one Morpho market in full before entering: bad debt, the oracle price liquidations use, free and reallocatable liquidity, supplying vaults, and averaged rate history.",
      toolPrefixes: ["morpho.market"],
      hints: ["is this lending market safe", "morpho bad debt", "how much liquidity is left", "average lending rate"],
    },
    {
      label: "Curated vault screening",
      summary:
        "Search Morpho V1 and V2 curated vaults by chain, deposit asset, curator, total deposits, net APY and fee to find a managed place to park an asset.",
      toolPrefixes: ["morpho.vaults"],
      hints: ["best vault for usdc", "top curated vaults", "which curator charges least", "somewhere passive to park stablecoins"],
    },
    {
      label: "Curated vault detail",
      summary:
        "Read one Morpho vault in full before depositing: who runs it, how fast they can change it, what it currently supplies and under what caps, and whether a gate can block a withdrawal.",
      toolPrefixes: ["morpho.vault"],
      hints: ["who runs this vault", "can I withdraw from this vault", "where is this vault putting the money", "is this vault gated"],
    },
    {
      label: "Preview a vault deposit or withdrawal",
      summary:
        "Price a SPECIFIC amount into or out of one vault before anything is committed: the shares it would mint or "
        + "burn, the share price the transaction would enforce, what the wallet would have to approve or sign first, "
        + "the decoded transaction and its gas. A preview only, and the mandatory first step before either executing tool.",
      toolPrefixes: ["morpho.vault.quote"],
      hints: [
        "preview a vault deposit",
        "how many shares would I get",
        "what approvals are needed before depositing",
        "simulate a morpho withdrawal",
      ],
    },
    {
      label: "Deposit into or withdraw from a vault",
      summary:
        "MOVE REAL FUNDS on one vault, after a fresh quote of the same operation: deposit assets and receive shares, or "
        + "withdraw assets by burning shares. A deposit sends two transactions in sequence behind one confirmation, a "
        + "permission for exactly that amount and then the deposit; a withdrawal is one direct call with no permission. "
        + "Both support a rehearsal that signs nothing, and both record the result in the activity ledger.",
      toolPrefixes: ["morpho.vault.deposit", "morpho.vault.withdraw"],
      hints: [
        "deposit into this morpho vault",
        "put my usdc in the vault now",
        "withdraw from this morpho vault",
        "take my money out of the vault",
        "redeem my vault shares",
      ],
    },
    {
      label: "Price a borrow or a collateral move before doing it",
      summary:
        "PRICE one operation on one Blue market without performing it: supplying collateral, borrowing against it, "
        + "repaying debt, taking collateral back out, LENDING the loan asset into the market, or taking what was "
        + "lent back out. Answers the conditional question - what would this do to my "
        + "health factor, how close to liquidation would it leave me, can the market fund it, what would I have to "
        + "permit first. Signs nothing. Mandatory before the matching execute, and a quote of one direction never "
        + "authorizes another.",
      toolPrefixes: ["morpho.market.quote"],
      hints: [
        "what would borrowing this do to my health factor",
        "how much can i safely borrow against this collateral",
        "how close to liquidation would this leave me",
        "preview supplying collateral on this market",
        "simulate paying off my morpho loan",
      ],
    },
    {
      label: "Borrow, repay and move collateral on a market",
      summary:
        "MOVE REAL FUNDS on one Blue market, after a fresh quote of the same direction. Supplying collateral and "
        + "repaying RAISE the health factor; borrowing and withdrawing collateral LOWER it, and borrowing is the only "
        + "one that creates liquidation risk where there was none. Supplying collateral and repaying send two "
        + "transactions behind one confirmation, a permission then the operation; borrowing and withdrawing collateral "
        + "are one direct call with no permission at all. Only a full-debt repayment can close a position, and "
        + "unwinding is repay-then-withdraw as two separate calls. All four support a rehearsal that signs nothing.",
      toolPrefixes: [
        "morpho.market.supplyCollateral",
        "morpho.market.withdrawCollateral",
        "morpho.market.borrow",
        "morpho.market.repay",
      ],
      hints: [
        "borrow usdc against my collateral",
        "post more collateral on this market",
        "repay my morpho loan",
        "pay off the debt completely and close the position",
        "withdraw my collateral from this market",
      ],
    },
    {
      label: "Lend directly into one market instead of a curated vault",
      summary:
        "LEND REAL FUNDS into ONE Blue market and take them back out, after a fresh quote of the same direction. "
        + "This is the LENDER'S side and it is not collateral: it earns the market's own borrow rate, it backs no "
        + "loan, and it moves NO health factor. It is the direct alternative to a curated vault, and the choice is a "
        + "fee against management: measured on Base, every curated USDC vault earns the same gross 4.13% because "
        + "they allocate into the same markets, so a 0%-fee curator nets 4.13% while a 25%-fee one nets 3.08%, while "
        + "supplying this market directly earns 4.13% with no fee at all. What the direct route gives up is "
        + "diversification and a curator who reallocates when a market degrades. Supplying sends two transactions "
        + "behind one confirmation, a permission then the supply; withdrawing is one direct call with no permission. "
        + "A withdrawal is bounded BOTH by the wallet's own supplied position and by the market's free liquidity, "
        + "and either bound is refused by name rather than quietly reduced.",
      toolPrefixes: [
        "morpho.market.supply",
        "morpho.market.withdraw",
      ],
      hints: [
        "lend usdc into this market directly",
        "supply to this market instead of paying a curator fee",
        "withdraw what i lent into this market",
        "stop lending into this market and take the interest",
        "earn the full rate on this market myself",
      ],
    },
    {
      label: "Position and liquidation risk",
      summary:
        "Read one wallet's own Morpho holdings: what it lent, what it put up as collateral, what it owes, the health factor of each borrowing position and how far the collateral price can fall before it is liquidated.",
      toolPrefixes: ["morpho.positions"],
      hints: ["show my morpho positions", "am I close to liquidation", "what do I owe", "my lending deposits and loans"],
    },
    {
      label: "Market activity and liquidation history",
      summary:
        "Read what has already happened in a Morpho market: supplies, borrows, repayments and every liquidation with what was repaid, what was seized and whether bad debt was left, filterable by market, address, event type and time window.",
      toolPrefixes: ["morpho.markets.activity"],
      hints: ["recent liquidations on this market", "market transaction history", "who liquidated me", "is this lending market still being used"],
    },
    {
      label: "Reward campaigns, read and claimed",
      summary:
        "Read the incentive tokens a wallet can claim on top of its lending rate, what is still accruing and not yet claimable, and which campaign and protocol produced each one. Then CLAIM them for real: one transaction sweeps every claimable row on one chain and can deliver several reward tokens at different scales, it needs no quote because a claim has no price and no size to choose, and it costs gas, which is worth saying before claiming a dust balance.",
      toolPrefixes: ["morpho.rewards"],
      hints: ["what rewards can I claim", "do I have unclaimed rewards", "how much have I earned in incentives", "reward tokens waiting", "claim my morpho rewards", "harvest my incentive tokens"],
    },
    {
      label: "Wallet holdings and Morpho approvals",
      summary:
        "Read on-chain what a wallet holds of named token contracts on one chain and which Morpho contracts it has already approved to move them, including whether any approval is the unlimited maximum.",
      toolPrefixes: ["morpho.wallet"],
      hints: ["check my token balance and approvals", "do I have an unlimited allowance", "which contracts can move my tokens", "is this token already approved"],
    },
  ],
};
