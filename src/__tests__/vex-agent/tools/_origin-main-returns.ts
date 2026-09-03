/**
 * THE RETURNS TEXT AS origin/main WROTE IT, for the eight always-loaded tools
 * whose field-by-field result list was taken OUT of the model-visible
 * description to fit the 2048 characters a client shows
 * (`mcp/inventory/types.ts`, `ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS`).
 *
 * WHY IT EXISTS. Moving a contract sentence out of a description is only honest
 * if the text SURVIVES the move whole. `tool-contract-fields.test.ts` compares
 * each tool's authored `returns` field against the entry here BYTE FOR BYTE, so
 * a future edit that paraphrases, re-wraps or trims one of them turns red
 * instead of quietly shrinking what an agent can read.
 *
 * GENERATED, NOT TYPED. Every entry was read from
 * `git show f415a9e3b11945778178a62e7e8999e94bbc9974:src/vex-agent/tools/registry/<file>`
 * by concatenating that description's own string literals in source order and
 * slicing from its first `RETURNS` to the end of its result run. The generator
 * asserts, per entry, that the slice starts AT the description's `RETURNS` and
 * is CONTIGUOUS in the original text - no transcription step sits between the
 * commit and the assertion. Do not edit by hand.
 *
 * WebResearch used to be the ninth pointer and was deliberately absent here:
 * its description on origin/main carried NO RETURNS list, so nothing was moved
 * out of it. It left the MCP export on 2026-09-03 (its `returns` is still
 * authored from the result builder, `internal/web-research/result-shape.ts`,
 * for the in-app agent), so the eight entries below are now the whole set.
 */

export const ORIGIN_MAIN_RETURNS: Readonly<Record<string, string>> = {
  AgentScan:
    "RETURNS `view` and `count` on every view, with the rows under a per-view key: `transactions` (each row a readable summary line plus its full recorded fields), `activities`, `snapshots` or `executions`. `transactions` is the ONLY paginated view: it returns `nextCursor` and `hasMore`, and you pass the cursor back rather than computing one. `activity` and `executions` apply `limit` silently, with no hasMore and no omission counter, so a short list there is not evidence there is no more. `summary` returns totalBalanceUsd, openPositionCount and latestSnapshot; `balances` returns totalUsd; `mission_baseline` returns the run's start and now valuations, changeSinceStartUsdEstimate and deployedCapital, or status 'absent' with a reason when the baseline was never recorded.",
  TwitterAccount:
    "RETURNS the action you asked for, `rateLimit` when the provider reported one, and `filtersApplied` on tweet_search, then the payload for that action: `tweets` with a `next` cursor for the post-list actions, `users` with a `next` cursor for the account-list actions, or a single `tweet`, `user`, `space` or `account`. CONTINUATION IS `next`: send it back as `cursor` for the following page, keeping every other argument identical. An EMPTY STRING is the end-of-list signal: `next: \"\"` means the provider returned no cursor, so there is no further page to ask for. There is no hasMore field. The cursor is opaque: pass it back verbatim, never construct or parse one. A post row carries id, url, createdAt, createdAtMs, fullText, lang and the like/reply/retweet counts, with its author reduced to userName, fullName, followersCount and isVerified; an account row carries id, userName, fullName, followersCount, followingsCount and isVerified. Zero rows on tweet_likers and tweet_replies come back with an explicit note, because an empty list there usually means the post has none rather than that the call failed.",
  WalletEvmTransactionPrepare:
    "RETURNS intentId, chain, chainId, walletAddress, status 'prepared', expiresAt, the decoded effects, the approval preview, approvedFeeBounds echoing the caps you supplied, and vexFee stating the charge or the reason there is none.",
  WalletEvmTransactionConfirm:
    "RETURNS the outcome, txHash, chain and the echoed approvedFeeBounds, with a DISTINCT outcome for confirmed, reverted on-chain, broadcast with confirmation UNKNOWN, and failed before broadcast.",
  WalletWrapPrepare:
    "RETURNS intentId, chain, chainId, walletAddress, status 'prepared', direction, wrappedNativeContract (address, symbol, decimals), amountRaw, amountHuman, rate '1:1', expiresAt, the approval preview, approvedFeeBounds echoing the caps you supplied, and nativeCurrency.",
  WalletWrapConfirm:
    "RETURNS the outcome, txHash, chain, chainId, direction, amountRaw, amountHuman, wrappedNativeContract and the echoed approvedFeeBounds, with a DISTINCT outcome for confirmed, reverted on-chain, broadcast with confirmation UNKNOWN, and failed before broadcast.",
  SwapExecute:
    "RETURNS, on a confirmed EVM swap, a summary with chain, chainId, txHash, tokenIn, tokenOut, the DECODED amountIn and amountOut in human units, a status of confirmed or confirmed_unrecorded, and a deliveryCheck when one was made. Every other EVM outcome is a sentence, and they differ: reverted on-chain, confirmed but the amounts could not be decoded yet, refused before signing, and broadcast but NOT yet confirmed - that last one says do not retry and names the ChainRead tx_receipt call you can make yourself. On Solana there is no JSON success arm at all: a broadcast answers \"Swap broadcast (signature ...) - confirmation pending, tracked automatically. Do not retry.\", and terminality is settled by a background sweep, so never read that sentence as a completed swap. Failed and pending attempts are recorded and shown with chain + tx hash + explorer link, same as confirmed ones.",
  BridgeExecute:
    "RETURNS status, summary, message, fromChain, toChain, legs (role, chain, txHash, status) and vexFee; on the Khalani route also orderId, depositTxHash, route, etaSeconds, amountIn/amountOut and nativeCost, and on the Relay route requestId, providerStatus, amounts and inTxHashes. IT NEVER REPORTS SUCCESS: a deposit that broadcast is not a delivered bridge. `status` is pending, filled_unverified, failed or refunded, delivery is verified by a background tracker, and every arm says the same thing - do NOT re-bridge. Follow the order with BridgeStatus.",
};
