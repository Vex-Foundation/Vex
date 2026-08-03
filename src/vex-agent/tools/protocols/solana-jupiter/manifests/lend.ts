import type { ProtocolToolManifest } from "../../types.js";
import { SOLANA_LEND_DISCOVERY } from "../../embeddings/solana-jupiter/lend.js";

export const LEND_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "solana.lend.rates",
    namespace: "solana",
    lifecycle: "active",
    description: "Get Jupiter Lend EARN (simple lending) yield rates — supply/rewards/total APY as exact percent strings (with raw basis-point *Bps siblings), TVL, total supply per market, and each market's assetDecimals for converting a human amount into solana.lend.deposit/withdraw's raw atomic-unit amount param. Optional asset filter and APY thresholds. Covers Earn yields only — for collateralized-borrowing limits and thresholds use solana.lend.borrowVaults instead.",
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
    namespace: "solana",
    lifecycle: "active",
    description: "Get a wallet's open Jupiter Lend EARN positions — supplied assets/balances (raw atomic units) plus accrued earnings, per position. Covers Earn (simple lending) only — for collateralized Borrow positions (collateral/debt) use solana.lend.borrowPositions instead.",
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
    namespace: "solana",
    lifecycle: "active",
    description: "Deposit tokens into a Jupiter Lend EARN vault to start earning yield — simple lending, not collateral for borrowing (for that, use solana.lend.borrowOperate's depositAmountRaw instead). Broadcasts and returns truthful-pending: confirmation is tracked automatically, do not resubmit. Read solana.lend.rates first for the vault's assetDecimals to convert a human amount into amountRaw's raw atomic units.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      { key: "asset", type: "string", required: true, description: "Token address to deposit." },
      { key: "amountRaw", type: "string", required: true, description: "Amount to deposit, in RAW atomic units of the asset as an integer string, never human decimals (e.g. USDC has 6 decimals, so 1 USDC = \"1000000\") — read the asset's decimals from solana.lend.rates' assetDecimals, or from token_find, before building it." },
    ],
    exampleParams: { asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amountRaw: "1000000" },
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_LEND_DISCOVERY["solana.lend.deposit"],
  },
  {
    toolId: "solana.lend.withdraw",
    namespace: "solana",
    lifecycle: "active",
    description: "Withdraw tokens from a Jupiter Lend EARN vault — simple lending, not a Borrow collateral withdrawal (for that, use solana.lend.borrowOperate's withdrawAmountRaw/withdrawAll instead). Pass exactly one of amountRaw (partial withdrawal) or withdrawAll: true (full exit — redeems the position's entire share balance, so no dust is left behind; an amountRaw-based \"everything\" withdrawal always strands a few units because the vault accrues interest between reading the balance and executing). Broadcasts and returns truthful-pending: confirmation is tracked automatically, do not resubmit. Read solana.lend.positions for the raw atomic-unit balance available to withdraw.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      { key: "asset", type: "string", required: true, description: "Token address to withdraw." },
      { key: "amountRaw", type: "string", description: "Amount to withdraw, in RAW atomic units of the asset as an integer string, never human decimals (e.g. USDC has 6 decimals, so 1 USDC = \"1000000\") — see solana.lend.positions for your current balance and the asset's decimals. Mutually exclusive with withdrawAll — provide exactly one, never both and never neither." },
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
