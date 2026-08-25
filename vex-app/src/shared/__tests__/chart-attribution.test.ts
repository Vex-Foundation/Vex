/**
 * Chart-attribution coupling - the anchor the board chart renders and the
 * external-link policy that gates `shell.openExternal` must never drift.
 *
 * This suite runs the REAL `isAllowedExternalUrl` against the REAL
 * `CHART_ATTRIBUTION_EXTERNAL_ALLOW` (the exact list `main-window.ts` spreads
 * into `ALLOWED_EXTERNAL`) and the REAL `CHART_ATTRIBUTION_URL` the component
 * puts in `href`. No mirrored fixture: a fixture is what let the previous
 * version ship an attribution link that silently did nothing when clicked.
 *
 * `CHART_ATTRIBUTION_EXTERNAL_ALLOW` is a subset of `ALLOWED_EXTERNAL`, and
 * `www.tradingview.com` appears ONLY in that subset, so "allowed by the subset"
 * implies "allowed by the full list", and a URL on that host denied here is
 * denied by the full list too. Testing the subset is therefore faithful and
 * avoids importing `main-window.ts` (electron).
 */

import { describe, expect, it } from "vitest";
import {
  CHART_ATTRIBUTION_EXTERNAL_ALLOW,
  CHART_ATTRIBUTION_LABEL,
  CHART_ATTRIBUTION_URL,
} from "../chart-attribution.js";
import { isAllowedExternalUrl } from "../../main/security/url.js";

function allowed(url: string): boolean {
  return isAllowedExternalUrl(url, CHART_ATTRIBUTION_EXTERNAL_ALLOW);
}

describe("chart attribution link", () => {
  it("admits the exact URL the component renders", () => {
    expect(allowed(CHART_ATTRIBUTION_URL)).toBe(true);
  });

  it("credits the library by name", () => {
    // The Apache-2.0 notice asks for the credit; an empty or renamed label
    // would satisfy the allowlist and still fail the obligation.
    expect(CHART_ATTRIBUTION_LABEL).toContain("TradingView");
  });

  it("denies lookalike hosts, subdomain suffixes and the bare apex", () => {
    for (const url of [
      "https://www.tradingview.com.evil.example/",
      "https://nottradingview.com/",
      "https://www-tradingview.com/",
      "https://tradingview.com/", // the apex is NOT what the anchor emits
      "https://evil.example/?next=https://www.tradingview.com/",
      "https://wwwXtradingview.com/",
    ]) {
      expect(allowed(url), url).toBe(false);
    }
  });

  it("denies the same host over http and over a non-web scheme", () => {
    expect(allowed("http://www.tradingview.com/")).toBe(false);
    expect(allowed("file:///www.tradingview.com/")).toBe(false);
  });
});
