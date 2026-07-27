/**
 * Shared output-size bound for the DexScreener byte-budget suites.
 *
 * This was originally the engine's tool-output overflow threshold. That
 * engine mechanism died with D-4 — full
 * tool output now always goes inline into the transcript, so there is no
 * runtime cap left to mirror.
 *
 * The number is deliberately kept at its historical value and re-homed here as
 * a PRODUCT-LEVEL output size regression bound owned by these suites: the
 * DexScreener list surfaces should not grow past what they were measured and
 * tuned against. Changing it is a product decision, not a mechanical follow-on.
 */
export const DEXSCREENER_BYTE_BUDGET_BYTES = 16_384;
