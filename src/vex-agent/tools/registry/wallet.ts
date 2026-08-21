/**
 * Wallet tools — read state and prepare/confirm transfers.
 *
 * `WalletSendPrepare` returns an intent ID; `WalletSendConfirm` broadcasts.
 * Confirm is the only mutating tool here.
 */

import type { ToolDef } from "../types.js";
import { CANONICAL_HUMAN_AMOUNT_SENTENCE } from "../protocols/conventions.js";

/**
 * The wallet FAMILY selector (SPEC §1.1). `network` and `wallet` both named it
 * before and both read as "a chain" — the one thing it is not.
 */
const WALLET_FAMILY_DESCRIPTION =
  "Which wallet FAMILY to act on — 'eip155' for your EVM wallet or 'solana' for your Solana wallet. This is a wallet family, not a chain: the EVM chain goes in `chain`.";

export const WALLET_TOOLS: readonly ToolDef[] = [
  {
    name: "WalletBalances", kind: "internal", mutating: false, pressureSafety: "read_only", actionKind: "read",
    description: "Read your token balances on every chain Vex can reach: Khalani-covered chains via Khalani, plus local chains like Robinhood Chain (4663) read directly from RPC. Defaults to your personal wallets — both EVM (`eip155`) and Solana — aggregated in one call. Pass `walletFamily` or `chainIds` only when you want to narrow the scan.",
    parameters: { type: "object", properties: {
      walletFamily: { type: "string", enum: ["eip155", "solana", "all"], description: "Which wallet FAMILY to read — 'eip155', 'solana', or 'all'. Default 'all' aggregates your EVM + Solana wallets. This is a wallet family, not a chain: chains go in `chainIds`." },
      // Accepts BOTH spellings the model reaches for: the CSV string and a real
      // JSON array (`acceptsStringArray` semantics, compiled the same way
      // `registry/khalani.ts` compiles a protocol param's union — no outer
      // `type`, or the array branch becomes unsatisfiable).
      chainIds: {
        anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        description: "Optional. Omit (or pass empty) to scan all supported chains (Khalani + local). To restrict, pass chain IDs/aliases either comma-separated ('ethereum,base,solana') or as an array (['ethereum','base']).",
      },
      response_format: { type: "string", enum: ["concise", "detailed"], description: "Output verbosity. Default 'detailed' returns every token per wallet. Set 'concise' to enable the `limit` trim (top tokens by held USD value)." },
      limit: { type: "number", description: "Optional. Caps the PRICED rows per wallet snapshot, top-N by held USD value. Held tokens with no usable price are appended after them, outside this limit, marked `priceUnavailable` so 'no price feed' never reads as 'not held'; they are capped at 20 with the surplus counted in `unpricedOmitted`. Only applied when response_format='concise'; ignored under the default 'detailed'. `tokenCount`/`totalUsd` always reflect the full scan." },
    } },
  },
  {
    name: "WalletTrackToken", kind: "internal", mutating: false, pressureSafety: "read_only", actionKind: "local_write",
    description: "Pin an ERC-20 token on a LOCAL chain (e.g. Robinhood 4663) so `WalletBalances` and the portfolio track it. Local chains scan a fixed set (seed tokens + pins); pin any token received by transfer or airdrop — swap and bridge executes auto-pin theirs. DB-only bookmark: no on-chain transaction. Khalani-covered chains do not need pinning.",
    parameters: { type: "object", properties: {
      action: { type: "string", enum: ["pin", "unpin", "list"], description: "pin adds a token to tracking, unpin removes it, list shows the chain's seed + pinned set." },
      chain: { type: "string", description: "Local chain alias or id (e.g. 'robinhood', '4663')." },
      token: { type: "string", description: "ERC-20 contract ADDRESS (0x…). Required for pin/unpin; ignored for list. Resolve a symbol to its address first." },
    }, required: ["action", "chain"] },
  },
  {
    name: "WalletSendPrepare", kind: "internal", mutating: false, pressureSafety: "mutating", actionKind: "approval_prepare",
    description: "Prepare a transfer intent (no broadcast). Returns intent ID for confirmation. Supports native tokens, ERC-20, and ERC-721 on any EVM chain. Solana: SOL + SPL tokens only (no pNFT/cNFT).",
    parameters: { type: "object", properties: {
      walletFamily: { type: "string", enum: ["eip155", "solana"], description: WALLET_FAMILY_DESCRIPTION },
      chain: { type: "string", description: "Required for eip155. EVM chain ID or alias (e.g. 'polygon', '137', 'base'). Ignored for solana." },
      to: { type: "string", description: "Recipient address" },
      amountIn: { type: "string", description: `Amount of the token to send (for native/ERC-20), or "1" for an ERC-721. ${CANONICAL_HUMAN_AMOUNT_SENTENCE}` },
      token: { type: "string", description: "Token: 'native' for chain native, contract address for ERC-20, 'nft:{contract}:{tokenId}' for ERC-721. Solana: symbol or mint (SOL + SPL only, NFT not supported)." },
    }, required: ["walletFamily", "to", "amountIn"] },
  },
  {
    name: "WalletSendConfirm", kind: "internal", mutating: true, pressureSafety: "mutating", actionKind: "user_wallet_broadcast",
    description: "Confirm and broadcast a prepared transfer. Requires approval in restricted/off mode.",
    parameters: { type: "object", properties: {
      walletFamily: { type: "string", enum: ["eip155", "solana"], description: WALLET_FAMILY_DESCRIPTION },
      intentId: { type: "string", description: "Prepared intent ID" },
    }, required: ["walletFamily", "intentId"] },
  },
];
