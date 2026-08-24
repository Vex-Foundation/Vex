import type { ProtocolToolManifest } from "../../types.js";
import { SOLANA_LEND_DISCOVERY } from "../../embeddings/solana-jupiter/lend.js";

export const LEND_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "solana.lend.rates",
    publicName: "solana__lend_earn_rates_list",
    namespace: "solana",
    lifecycle: "active",
    description: "Screen Jupiter Lend EARN markets - simple lending, where an asset is supplied for yield and nothing is borrowed against it. Use this when the user asks where to park an asset on Solana or what it would earn, and call it BEFORE a deposit to read the market's decimals. Returns one row per market: id, assetAddress, assetSymbol, assetPriceUsd, the Earn share token (earnTokenAddress, earnTokenSymbol), supplyRate, rewardsRate and totalRate as exact percent strings each with a raw *Bps basis-point sibling, totalAssetsRaw and totalSupplyRaw, and assetDecimals - which is what converts a human amount into the raw atomic-unit amountRaw that solana__lend_earn_deposit and solana__lend_earn_withdraw take. The assets filter and the minSupplyRate/minTotalRate thresholds are applied Vex-side. The rows are the whole answer; there is no continuation. Covers Earn yields only; collateralized-borrowing limits and thresholds are solana__lend_borrow_vaults_list.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "assets", type: "string", description: "Comma-separated list of asset identifiers to filter to — matches the underlying asset mint address, Earn share-token (jlToken) mint, symbol, or provider lending id. Case-insensitive for symbol. Omit for all markets." },
      { key: "minSupplyRate", type: "number", description: "Only return markets whose base supply APY percent is at or above this value, e.g. 3 for 3%." },
      { key: "minTotalRate", type: "number", description: "Only return markets whose combined (supply + rewards) APY percent is at or above this value, e.g. 5 for 5%." },
    ],
    exampleParams: { assets: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,SOL" },
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_LEND_DISCOVERY["solana.lend.rates"],
  },
  {
    toolId: "solana.lend.positions",
    publicName: "solana__lend_earn_positions_list",
    namespace: "solana",
    lifecycle: "active",
    description: "Read a wallet's open Jupiter Lend EARN positions. Use this when the user asks what they have lent on Solana or what it has earned, and before a withdrawal, to learn the raw balance actually available. Returns `positions`, one row per supplied asset with its balance in RAW atomic units, and `earnings`, the accrued yield alongside it - `earnings` comes back as an empty array when there is no position, never as null and never as an error. The wallet defaults to the session's selected Solana wallet, and under session scope a different address is rejected. The rows are the whole answer; there is no continuation. Covers Earn only; collateral-and-debt positions are solana__lend_borrow_positions_list.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "walletAddress", type: "string", description: "The wallet ACCOUNT to read, as a Solana address (not a token mint or a position key). Defaults to the session's selected Solana wallet — omit it to read your own. Under session scope a DIFFERENT address is rejected." },
    ],
    exampleParams: {},
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_LEND_DISCOVERY["solana.lend.positions"],
  },
  {
    toolId: "solana.lend.deposit",
    publicName: "solana__lend_earn_deposit",
    namespace: "solana",
    lifecycle: "active",
    description: "Deposit tokens into a Jupiter Lend EARN vault to start earning yield - simple lending, which supplies an asset and backs no loan. SPENDS REAL FUNDS: it signs and broadcasts an irreversible on-chain deposit with the session's Solana wallet and is approval-gated. Use this when the user wants to put an idle Solana balance to work; solana__lend_borrow_operate's depositAmountRaw is the different thing, collateral for a loan. Read solana__lend_earn_rates_list BEFORE calling, for the market's assetDecimals, because amountRaw is RAW atomic units and a human figure sent here moves the wrong amount. Returns TRUTHFUL-PENDING and never a confirmation: on a successful broadcast the reply carries the transaction signature and an explorer link, names the asset and amount, and says confirmation is tracked automatically and must not be resubmitted. A provider refusal before broadcast is reported with its own named cause and states that nothing went on-chain.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      { key: "asset", type: "string", required: true, description: "Token address to deposit." },
      { key: "amountRaw", type: "string", required: true, description: "Amount to deposit, in RAW atomic units of the asset as an integer string, never human decimals (e.g. USDC has 6 decimals, so 1 USDC = \"1000000\") - read the asset's decimals from solana__lend_earn_rates_list's assetDecimals, or from TokenFind, before building it." },
    ],
    exampleParams: { asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amountRaw: "1000000" },
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_LEND_DISCOVERY["solana.lend.deposit"],
  },
  {
    toolId: "solana.lend.withdraw",
    publicName: "solana__lend_earn_withdraw",
    namespace: "solana",
    lifecycle: "active",
    description: "Withdraw tokens from a Jupiter Lend EARN vault - simple lending, not a Borrow collateral withdrawal (for that, use solana__lend_borrow_operate's withdrawAmountRaw/withdrawAll instead). Pass exactly one of amountRaw (partial withdrawal) or withdrawAll: true (full exit - redeems the position's entire share balance, so no dust is left behind; an amountRaw-based \"everything\" withdrawal always strands a few units because the vault accrues interest between reading the balance and executing). SPENDS REAL FUNDS in the sense that it signs and broadcasts an irreversible on-chain withdrawal with the session's Solana wallet, and it is approval-gated. Use this when the user wants some or all of a Solana Earn position back; read solana__lend_earn_positions_list BEFORE calling, for the raw atomic-unit balance actually available. Returns TRUTHFUL-PENDING and never a confirmation: on a successful broadcast the reply carries the transaction signature and an explorer link, names the asset and amount, and says confirmation is tracked automatically and must not be resubmitted. Every refusal is named - withdrawAll: false, both params, neither param, no position for that asset, more than one matching position, or a share balance that cannot be redeemed - and each says nothing went on-chain.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      { key: "asset", type: "string", required: true, description: "Token address to withdraw." },
      { key: "amountRaw", type: "string", description: "Amount to withdraw, in RAW atomic units of the asset as an integer string, never human decimals (e.g. USDC has 6 decimals, so 1 USDC = \"1000000\") - see solana__lend_earn_positions_list for your current balance and the asset's decimals. Mutually exclusive with withdrawAll - provide exactly one, never both and never neither." },
      { key: "withdrawAll", type: "boolean", description: "Exit the ENTIRE Earn position for this asset, dust-free (redeems the position's full share balance rather than an underlying amount). Mutually exclusive with amountRaw — provide exactly one, never both. Never pass withdrawAll: false; omit it and pass amountRaw instead." },
    ],
    // The handler's XOR (`handlers/lend.ts` `resolveEarnWithdrawIntent`) is
    // EXACTLY-ONE — neither param present is "nothing to withdraw", both is
    // "some, and also everything". Declaring it makes the rule a schema fact
    // discovery can show before the call, instead of a refusal after it.
    exclusiveParamGroups: [["amountRaw", "withdrawAll"]],
    exampleParams: { asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amountRaw: "1000000" },
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_LEND_DISCOVERY["solana.lend.withdraw"],
  },
];
