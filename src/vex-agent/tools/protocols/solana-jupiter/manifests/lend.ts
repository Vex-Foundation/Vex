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
      { key: "address", type: "string", required: true, description: "Wallet address." },
    ],
    exampleParams: { address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_LEND_DISCOVERY["solana.lend.positions"],
  },
  {
    toolId: "solana.lend.deposit",
    namespace: "solana",
    lifecycle: "active",
    description: "Deposit tokens into a Jupiter Lend EARN vault to start earning yield — simple lending, not collateral for borrowing (for that, use solana.lend.borrowOperate's depositAmount instead). Broadcasts and returns truthful-pending: confirmation is tracked automatically, do not resubmit. Read solana.lend.rates first for the vault's assetDecimals to convert a human amount into amount's raw atomic units.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      { key: "asset", type: "string", required: true, description: "Token address to deposit." },
      { key: "amount", type: "string", required: true, description: "Amount in raw atomic units of the asset (e.g. USDC has 6 decimals, so 1 USDC = \"1000000\") — see solana.lend.rates' assetDecimals for other assets." },
    ],
    exampleParams: { asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: "1000000" },
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_LEND_DISCOVERY["solana.lend.deposit"],
  },
  {
    toolId: "solana.lend.withdraw",
    namespace: "solana",
    lifecycle: "active",
    description: "Withdraw tokens from a Jupiter Lend EARN vault — simple lending, not a Borrow collateral withdrawal (for that, use solana.lend.borrowOperate's withdrawAmount/withdrawAll instead). Pass exactly one of amount (partial withdrawal) or withdrawAll: true (full exit — redeems the position's entire share balance, so no dust is left behind; an amount-based \"everything\" withdrawal always strands a few units because the vault accrues interest between reading the balance and executing). Broadcasts and returns truthful-pending: confirmation is tracked automatically, do not resubmit. Read solana.lend.positions for the raw atomic-unit balance available to withdraw.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      { key: "asset", type: "string", required: true, description: "Token address to withdraw." },
      { key: "amount", type: "string", description: "Amount in raw atomic units of the asset (e.g. USDC has 6 decimals, so 1 USDC = \"1000000\") — see solana.lend.positions for your current balance. Mutually exclusive with withdrawAll: pass exactly one of the two." },
      { key: "withdrawAll", type: "boolean", description: "Exit the ENTIRE Earn position for this asset, dust-free (redeems the position's full share balance rather than an underlying amount). Mutually exclusive with amount: pass exactly one of the two, and never pass withdrawAll: false — omit it and pass amount instead." },
    ],
    exampleParams: { asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: "1000000" },
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_LEND_DISCOVERY["solana.lend.withdraw"],
  },
];
