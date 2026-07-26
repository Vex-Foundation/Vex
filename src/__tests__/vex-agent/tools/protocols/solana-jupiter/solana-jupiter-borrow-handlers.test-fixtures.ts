import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

export const SUPPLY_MINT = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
export const BORROW_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export const VAULT = {
  id: 1,
  address: "VaultAddr1",
  supplyToken: { address: SUPPLY_MINT, chainId: "solana", name: "Marinade staked SOL", symbol: "mSOL", uiSymbol: "mSOL", decimals: 9, price: "80" },
  borrowToken: { address: BORROW_MINT, chainId: "solana", name: "USD Coin", symbol: "USDC", uiSymbol: "USDC", decimals: 6, price: "1" },
  collateralFactor: "800",
  liquidationThreshold: "850",
  borrowable: "1000000000",
  withdrawable: "900000000",
  minimumBorrowing: "100000",
};

export const WSOL_VAULT = {
  ...VAULT,
  id: 2,
  supplyToken: { address: WSOL_MINT, chainId: "solana", name: "Wrapped SOL", symbol: "WSOL", uiSymbol: "SOL", decimals: 9, price: "150" },
};

export function ctx(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-1",
    ...over,
  };
}

export const PREPARED = {
  serialized: new Uint8Array([1, 2, 3]),
  signature: "LocalSig111",
  recentBlockhash: "FreshBlockhash111",
  lastValidBlockHeight: 12345,
};
