import type { ProtocolNamespaceNavigation } from "../types.js";

export const MORPHO_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "morpho",
  advertised: true,
  groupId: "evm-trading",
  groupLabel: "EVM Trading",
  summary:
    "Morpho variable-rate lending across nine EVM chains (Ethereum, Base, Arbitrum, Optimism, Polygon, Unichain, HyperEVM, Monad, Robinhood Chain), in two shapes: isolated Blue MARKETS screened by rate, size, utilization and liquidation threshold and read in full including bad debt and the oracle liquidations are decided against, and curated VAULTS (V1 MetaMorpho and V2) screened by deposits, net APY and curator fee and read in full including roles, timelocks, per-market allocations and withdrawal gating. Alongside them, two wallet-side reads: the incentive tokens a wallet can claim on top of its rate, and what a wallet holds together with the Morpho contracts it has already approved to move it. Alongside the reads, one PREVIEW: what a specific deposit into or withdrawal from a vault would mint, cost and require, priced without signing or sending anything. Read-only today: Vex cannot move funds on Morpho.",
  whenToUse:
    "Use when the user wants to lend, deposit or earn interest on an asset at a FLOATING rate, wants somewhere passive to park an asset under a professional curator, wants to know where borrowing is cheapest, or wants to inspect a lending market or a vault before entering. Route by who picks the venue: a VAULT is a managed deposit spread across many markets by a curator who takes a fee, a MARKET is one loan asset against one collateral asset that the user chooses themselves. Start with morpho.vaults.discover or morpho.markets.discover to screen, then the matching get tool. When the user asks about what they ALREADY hold, what they owe, or whether they are near liquidation, that is morpho.positions.get, not a screening tool; when they ask what has happened in a market or want an address audited, that is morpho.markets.activity. When they ask about unclaimed rewards or incentive tokens earned on top of the rate, that is morpho.rewards.get; when they ask what a wallet holds or which contracts it has approved to spend a token, that is morpho.wallet.balance, though a plain balance question with no approval angle belongs to wallet_balances instead. When the user names an AMOUNT and wants to know what depositing or withdrawing it would actually do, that is morpho.vault.quote, which prices the operation without performing it. The APY-labelling, health-factor, vault-gating and permissionless-market rules live in the Lending (Morpho) doctrine below.",
  preferInstead:
    "Use `pendle` when the user wants a FIXED rate locked to a maturity date - Morpho rates float and never expire. Use `solana.lend` for lending on Solana; Morpho here is EVM-only. Use `kyberswap` for ordinary spot swaps.",
  exampleQueries: [
    'discover_tools(query="lend usdc morpho", namespace="morpho")',
    'discover_tools(query="cheapest borrow rate", namespace="morpho")',
    'discover_tools(query="is this lending market safe", namespace="morpho")',
    'discover_tools(query="am I close to liquidation", namespace="morpho")',
  ],
  aliases: ["morpho", "lending", "lend", "borrow", "supply apy", "variable rate lending", "money market", "curated vault", "metamorpho", "vault curator", "health factor", "liquidation risk", "my positions", "liquidation history", "claimable rewards", "unclaimed rewards", "token allowance", "unlimited approval"],
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
    "check my token balance and approvals",
    "do I have an unlimited allowance",
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
        + "the decoded transaction and its gas. A preview only, and Vex cannot execute the result.",
      toolPrefixes: ["morpho.vault.quote"],
      hints: [
        "preview a vault deposit",
        "how many shares would I get",
        "what approvals are needed before depositing",
        "simulate a morpho withdrawal",
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
      label: "Claimable reward campaigns",
      summary:
        "Read the incentive tokens a wallet can claim on top of its lending rate, what is still accruing and not yet claimable, and which campaign and protocol produced each one. Claiming itself is not available in Vex.",
      toolPrefixes: ["morpho.rewards"],
      hints: ["what rewards can I claim", "do I have unclaimed rewards", "how much have I earned in incentives", "reward tokens waiting"],
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
