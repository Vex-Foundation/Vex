/**
 * The sentence a refused analysis answers with.
 *
 * One wording for the protocol tools and the analysis card's channel, so a
 * refusal reads the same in the chat and under the chart. Every sentence
 * carries its code in parentheses, so a model (or a log reader) can branch on
 * it without parsing prose.
 */

import type { AnalysisRefusalReason } from "../../lib/market-analysis/result-schema.js";

const DEFAULT_SENTENCES: Readonly<Record<AnalysisRefusalReason, string>> = {
  market_not_found: "the market was not found",
  no_candles: "the provider returned no candles for this market and interval",
  not_enough_history: "there is not enough closed history for this interval",
  source_unavailable: "the candle source did not answer",
  no_candle_source: "no candle source is available here",
};

/**
 * `detail` is the specific reason when there is one: the loader's own
 * sentence, or the provider failure the caller already described for the
 * agent (never a raw error, which may carry a URL or a stack).
 */
export function describeAnalysisRefusal(
  venueLabel: string,
  reason: AnalysisRefusalReason,
  detail: string | null,
): string {
  const body = detail === null || detail.length === 0 ? DEFAULT_SENTENCES[reason] : detail;
  return `${venueLabel} technical analysis unavailable (${reason}): ${body.replace(/\.$/, "")}.`;
}
