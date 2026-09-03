/**
 * Wallet tools - read state and prepare/confirm transfers.
 *
 * `WalletSendPrepare` returns an intent ID; `WalletSendConfirm` broadcasts.
 * Confirm is the only mutating tool here.
 */

import type { ToolDef } from "../types.js";
import { READ_ONLY_NO_VEX_FEE, SEND_NO_VEX_FEE } from "../vex-fee-notes.js";
import {
  CANONICAL_HUMAN_AMOUNT_SENTENCE,
  CANONICAL_MCP_APPROVAL_SENTENCE,
} from "../protocols/conventions.js";
import { responseFormatParam } from "@vex-agent/response-format.js";

/**
 * The wallet FAMILY selector (SPEC §1.1). `network` and `wallet` both named it
 * before and both read as "a chain" - the one thing it is not.
 */
const WALLET_FAMILY_DESCRIPTION =
  "Which wallet FAMILY to act on - 'eip155' for your EVM wallet or 'solana' for your Solana wallet. This is a wallet family, not a chain: the EVM chain goes in `chain`.";

export const WALLET_TOOLS: readonly ToolDef[] = [
  {
    name: "WalletBalances", kind: "internal", mutating: false, pressureSafety: "read_only", actionKind: "read",
    description: "Read your token balances on every chain Vex can reach: Khalani-covered EVM chains via Khalani, plus Solana and local chains like Robinhood Chain (4663) read directly from RPC. Defaults to your personal wallets - both EVM (`eip155`) and Solana - aggregated in one call. Pass `walletFamily` or `chainIds` only when you want to narrow the scan. Use this when the user asks what they hold or what a position is worth, and after a swap, bridge or transfer to confirm the tokens actually landed - this reads live balances, while `AgentScan` reads recorded history. RETURNS walletFamily, walletCount, totalUsd, walletErrors, and one snapshot per wallet carrying address, tokenCount, totalUsd, scannedChainIds, chainErrors, tokenErrors, accountErrors and tokens; each token row has symbol, name, address, chainId, decimals and balance in smallest units, plus priceUsd and isRiskToken when known. On Solana rows `symbol` and `name` are null when no metadata source could label the mint - that is an unlabelled holding, not a missing balance, and the mint address is never substituted for a ticker. A chain or token that could not be read appears in chainErrors/tokenErrors rather than vanishing; a Solana token ACCOUNT that could not be trusted appears in `accountErrors` ({chainId, accountAddress, reason}), whose holdings are therefore absent from `tokens`. `tokenErrorsOmitted`/`accountErrorsOmitted`/`unpricedOmitted` count what those 20-row caps left out. Every snapshot also carries `truncated`: false means you are seeing every row of the full projected scan, true means the concise trim left rows out (priced rows past `limit`, unpriced rows past the 20-row cap, or zero-balance unpriced rows) and a `truncationNote` says how to widen the read: response_format 'detailed' returns every row, while raising `limit` recovers only the priced rows it cut; there is no continuation to fetch. `tokenCount` and `totalUsd` always describe the FULL scan even when `limit` trimmed the rows you can see.",
    returns: "RETURNS walletFamily, walletCount, totalUsd, walletErrors, and one snapshot per wallet carrying address, tokenCount, totalUsd, scannedChainIds, chainErrors, tokenErrors, accountErrors and tokens; each token row has symbol, name, address, chainId, decimals and balance in smallest units, plus priceUsd and isRiskToken when known. On Solana rows `symbol` and `name` are null when no metadata source could label the mint - that is an unlabelled holding, not a missing balance, and the mint address is never substituted for a ticker. A chain or token that could not be read appears in chainErrors/tokenErrors rather than vanishing; a Solana token ACCOUNT that could not be trusted appears in `accountErrors` ({chainId, accountAddress, reason}), whose holdings are therefore absent from `tokens`. `tokenErrorsOmitted`/`accountErrorsOmitted`/`unpricedOmitted` count what those 20-row caps left out. Every snapshot also carries `truncated`: false means you are seeing every row of the full projected scan, true means the concise trim left rows out (priced rows past `limit`, unpriced rows past the 20-row cap, or zero-balance unpriced rows) and a `truncationNote` says how to widen the read: response_format 'detailed' returns every row, while raising `limit` recovers only the priced rows it cut; there is no continuation to fetch. `tokenCount` and `totalUsd` always describe the FULL scan even when `limit` trimmed the rows you can see.",
    vexFee: READ_ONLY_NO_VEX_FEE,
    parameters: { type: "object", properties: {
      walletFamily: { type: "string", enum: ["eip155", "solana", "all"], description: "Which wallet FAMILY to read - 'eip155', 'solana', or 'all'. Default 'all' aggregates your EVM + Solana wallets. This is a wallet family, not a chain: chains go in `chainIds`." },
      // Accepts BOTH spellings the model reaches for: the CSV string and a real
      // JSON array (`acceptsStringArray` semantics, compiled the same way
      // `registry/khalani.ts` compiles a protocol param's union - no outer
      // `type`, or the array branch becomes unsatisfiable).
      chainIds: {
        anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        description: "Optional. Omit (or pass empty) to scan all supported chains (Khalani + local). To restrict, pass chain IDs/aliases either comma-separated ('ethereum,base,solana') or as an array (['ethereum','base']).",
      },
      response_format: responseFormatParam({
        default: "detailed",
        whatDetailedAdds:
          "returns every token per wallet; 'concise' is what enables the `limit` trim "
          + "(top rows by held USD value) and sets `truncated` when rows were left out",
      }),
      limit: { type: "number", description: "Optional. Caps the PRICED rows per wallet snapshot, top-N by held USD value. Held tokens with no usable price are appended after them, outside this limit, marked `priceUnavailable` so 'no price feed' never reads as 'not held'; they are capped at 20 with the surplus counted in `unpricedOmitted`. Only applied when response_format='concise'; ignored under the default 'detailed'. `tokenCount`/`totalUsd` always reflect the full scan." },
    } },
  },
  {
    name: "WalletTrackToken", kind: "internal", mutating: false, pressureSafety: "read_only", actionKind: "local_write",
    description: "Pin an ERC-20 token on a LOCAL chain (e.g. Robinhood 4663) so `WalletBalances` and the portfolio track it. Local chains scan a fixed set (seed tokens + pins), so a token outside that set is invisible until it is pinned. Use this when a token arrived on a local chain by transfer or airdrop and does not show up in balances; swap and bridge executes auto-pin what they buy, so you rarely need it after a trade. It writes a DB-only bookmark against your wallet and that chain - no on-chain transaction, nothing signed, nothing spent, and NO approval card: a local write is not a spend and never raises one - and the effect the user sees is the extra token appearing in `WalletBalances` and the portfolio. Khalani-covered chains discover tokens on their own and are refused by name here. RETURNS chain and chainId with, for pin, the token and `pinned`, plus a note when the address was already a seed token; for unpin, the token and `unpinned`; and for list, the wallet with `seedTokens` (address, label) and `pinned` (address, source, createdAt).",
    returns: "RETURNS chain and chainId with, for pin, the token and `pinned`, plus a note when the address was already a seed token; for unpin, the token and `unpinned`; and for list, the wallet with `seedTokens` (address, label) and `pinned` (address, source, createdAt).",
    vexFee: READ_ONLY_NO_VEX_FEE,
    parameters: { type: "object", properties: {
      action: { type: "string", enum: ["pin", "unpin", "list"], description: "pin adds a token to tracking, unpin removes it, list shows the chain's seed + pinned set." },
      chain: { type: "string", description: "Local chain alias or id (e.g. 'robinhood', '4663')." },
      token: { type: "string", description: "ERC-20 contract ADDRESS (0x…). Required for pin/unpin; ignored for list. Resolve a symbol to its address first." },
    }, required: ["action", "chain"] },
  },
  {
    name: "WalletSendPrepare", kind: "internal", mutating: false, pressureSafety: "mutating", actionKind: "approval_prepare",
    description: "Prepare a wallet-to-wallet transfer for approval. It SPENDS NOTHING and signs nothing: it writes one durable transfer intent and hands back its id. THE INTENT IS WHAT GETS APPROVED - Vex passes it straight to `WalletSendConfirm` as a trusted follow-up, and the chain, recipient, amount and token recorded here are exactly what the user is shown and confirms, so a mistake at this step is a mistake the approval carries. Use this when the user asks to send native coin, an ERC-20, an NFT or SPL tokens to an address, and before any call to `WalletSendConfirm` - confirm has no other way to obtain an intentId. Covers native coin and ERC-20 on any EVM chain, and ERC-721 through token 'nft:{contract}:{tokenId}'; on Solana, SOL and SPL tokens only, with no pNFT or cNFT. `amountIn` is a HUMAN decimal STRING (\"1.5\", never the number 1.5, never wei or lamports), and `chain` is required for eip155 and ignored for solana; each is refused BY NAME rather than guessed. VEX CHARGES NO FEE on this path: the only cost is the network fee of the transfer itself. RETURNS intentId, network, chain, to, amount, token, status 'prepared' and expiresAt. The intent expires 10 minutes after this call, is scoped to this session, and binds the wallet selected right now - if the selection changes, confirm refuses instead of sending from a different address.",
    returns: "RETURNS intentId, network, chain, to, amount, token, status 'prepared' and expiresAt.",
    vexFee: SEND_NO_VEX_FEE,
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
    description: "Broadcast the transfer that `WalletSendPrepare` already prepared. SPENDS REAL FUNDS AND IS IRREVERSIBLE: this is the call that signs the transaction with the user's wallet and sends it. " + CANONICAL_MCP_APPROVAL_SENTENCE + " The intent is consumed only when the call is authorized. Vex charges NO fee on this path. Vex normally dispatches this itself as the trusted follow-up to `WalletSendPrepare`, so call it by hand only when that follow-up did not run. PRECONDITIONS, each refused BY NAME rather than guessed: the intentId must belong to THIS session, still be pending, and be inside its 10-minute expiry; `walletFamily` must match the one the intent recorded; and the session's currently selected wallet must be the exact wallet the intent bound, or it refuses and asks you to re-prepare rather than signing from a different address. The intent is consumed atomically, so one prepared transfer can be broadcast at most once. RETURNS txHash, chain and status, plus blockNumber on EVM and explorerUrl on Solana. Every other outcome is a sentence, and they do not mean the same thing: reverted on-chain (a real transaction, no transfer), broadcast but confirmation UNKNOWN (the transaction exists and may still settle - do NOT retry, read it yourself with `ChainRead` action tx_receipt), and failed before broadcast (nothing was sent). Only the last is safe to prepare again.",
    returns: "RETURNS txHash, chain and status, plus blockNumber on EVM and explorerUrl on Solana. Every other outcome is a sentence, and they do not mean the same thing: reverted on-chain (a real transaction, no transfer), broadcast but confirmation UNKNOWN (the transaction exists and may still settle - do NOT retry, read it yourself with `ChainRead` action tx_receipt), and failed before broadcast (nothing was sent). Only the last is safe to prepare again.",
    vexFee: SEND_NO_VEX_FEE,
    parameters: { type: "object", properties: {
      walletFamily: { type: "string", enum: ["eip155", "solana"], description: WALLET_FAMILY_DESCRIPTION },
      intentId: { type: "string", description: "Prepared intent ID" },
    }, required: ["walletFamily", "intentId"] },
  },
];
