/**
 * Stable Jupiter Prediction constants from indexed docs.
 */

export const JUPITER_PREDICTION_API_BASE_URL = "https://api.jup.ag/prediction/v1";

/** The mint an order DEPOSITS. Chain-proven on the buy `4VLWmR6QQF…`: USDC 18383433 → 13383433. */
export const JUPITER_PREDICTION_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * The mint a prediction position PAYS OUT — JupUSD, NOT the USDC it was
 * deposited in. The deposit and the payout are different assets; every reader
 * that assumed symmetry recorded a payout leg that could never be proven.
 *
 * CHAIN-PROVEN, twice over, on the 2026-07-25 funded gate:
 *   - sell `5AChd2vmZt…`: the ONLY mint in the transaction is this one, and
 *     the wallet's balance is identical pre and post (271024 both sides) —
 *     the proceeds arrive LATER, in a keeper's fill;
 *   - the buy's own refund leg: `transferAmountToken: "266025"` on the
 *     `order_closed` history event equals the wallet's observed JupUSD credit
 *     exactly (4999 → 271024), and equals
 *     `depositAmountUsd − totalCostUsd − feeUsd` (4994898 − 4665593 − 63280).
 * The claim path has never run live; the first real claim confirms or refutes it.
 *
 * A CONSTANT, DELIBERATELY — never resolved from the transaction. Reading the
 * mint out of whatever the settlement happened to carry would make Vex follow
 * an asset migration silently and record the new asset as if we had always
 * expected it. A named constant is a testable protocol assertion instead: any
 * future payout reader must DECLINE a settlement carrying another mint, leaving
 * the row honestly pending rather than confirming an asset we never predicted.
 */
export const JUPITER_PREDICTION_PAYOUT_MINT = "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD";

/** Display symbol of {@link JUPITER_PREDICTION_PAYOUT_MINT}. */
export const JUPITER_PREDICTION_PAYOUT_SYMBOL = "JupUSD";

/**
 * Decimals of {@link JUPITER_PREDICTION_PAYOUT_MINT}. Required to read any
 * JupUSD raw amount at all — `"266025"` is 0.266025 at 6 and 0.000266025 at 9.
 * Confirmed by the free Khalani registry probe (`symbol JupUSD, decimals 6`)
 * and by the micro-USD arithmetic above matching to the unit.
 */
export const JUPITER_PREDICTION_PAYOUT_DECIMALS = 6;
