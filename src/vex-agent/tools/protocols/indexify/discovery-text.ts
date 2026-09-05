/**
 * Shared discovery vocabulary for the indexify namespace.
 *
 * Indexify is Solana-only: every stack, token, order and balance lives on
 * Solana mainnet, traded in USDC through the account's Indexify-embedded
 * wallet. The chains list feeds the low-weight lexical search field so
 * "index funds on solana" recalls these tools.
 */

export const INDEXIFY_CHAINS = ["solana"] as const;
