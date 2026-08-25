/**
 * The chart library's REQUIRED attribution link, and the external-link allow
 * entry that makes it clickable.
 *
 * Lightweight Charts is Apache-2.0 and its notice asks that the product credit
 * TradingView with a link. The renderer disables the library's own logo widget
 * (it injects an anchor through `innerHTML` inside a privileged renderer) and
 * renders that credit as static, reviewable markup instead.
 *
 * WHY BOTH FACTS LIVE HERE. The anchor is in the renderer; the decision to open
 * an external URL belongs to main's `ALLOWED_EXTERNAL`. Held in two places they
 * drift, and the failure is silent: the attribution renders, the user clicks,
 * and nothing at all happens because the host was never admitted. So the URL
 * the component renders and the entry the allowlist spreads are the SAME
 * declaration, and `shared/__tests__/chart-attribution.test.ts` asserts the
 * real allowlist admits the real URL.
 *
 * SCOPE. `www.tradingview.com` exact-host, https only, no path prefix: the
 * credit points at the vendor's home page and the entry admits nothing else.
 * `isAllowedExternalUrl` matches `url.hostname === entry`, so lookalikes
 * (`tradingview.com.evil.example`, `nottradingview.com`, a bare
 * `tradingview.com` this link never emits) are all denied.
 */

/** Structurally identical to main's `ExternalAllowEntry`; shared must not import main. */
export type ChartAttributionAllowEntry =
  | string
  | { readonly host: string; readonly pathPrefix: string };

/** The exact URL the chart attribution anchor renders. */
export const CHART_ATTRIBUTION_URL = "https://www.tradingview.com/";

/** The visible credit text beside that link. */
export const CHART_ATTRIBUTION_LABEL = "TradingView Lightweight Charts";

/** Spread verbatim into main's `ALLOWED_EXTERNAL`. */
export const CHART_ATTRIBUTION_EXTERNAL_ALLOW: readonly ChartAttributionAllowEntry[] = [
  "www.tradingview.com",
];
