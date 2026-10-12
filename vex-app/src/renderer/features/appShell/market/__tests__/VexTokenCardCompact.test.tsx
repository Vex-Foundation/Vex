/**
 * VexTokenCardCompact render-state tests (T1, rail widget).
 *
 * Every state must resolve to a visible surface so the sessions rail is never
 * blank: loading skeleton, error line, the data card, the stale marker, and a
 * graceful empty-sparkline track. Data flows through the mocked
 * `window.vex.market` bridge; the live-sync effect's `onVexUpdate` is a no-op
 * unsubscribe here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { Result } from "@shared/ipc/result.js";
import type { VexMarketSnapshot } from "@shared/schemas/market.js";
import { VexTokenCardCompact } from "../VexTokenCardCompact.js";

type SnapshotResult = Result<VexMarketSnapshot | null>;

function snapshot(overrides: Partial<VexMarketSnapshot> = {}): VexMarketSnapshot {
  return {
    priceUsd: 0.000543,
    priceChange: { h1: -1.73, h24: 113 },
    marketCap: 543068,
    fdv: 543068,
    liquidityUsd: 75189.01,
    volumeH24: 464284.04,
    txnsH24: { buys: 1235, sells: 856 },
    holderCount: 354,
    sparkline: [
      [1783166400, 0.000527],
      [1783170000, 0.00055],
    ],
    updatedAt: 1783172700000,
    stale: false,
    ...overrides,
  };
}

function setMarket(getVexSnapshot: () => Promise<SnapshotResult>): void {
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      market: {
        getVexSnapshot,
        onVexUpdate: () => () => {},
      },
    },
  });
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function freshClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

afterEach(() => {
  Reflect.deleteProperty(window, "vex");
});

describe("VexTokenCardCompact", () => {
  it("renders the slim data line: price, the change with its arrow, the spark - NO stat grid", async () => {
    setMarket(vi.fn().mockResolvedValue({ ok: true, data: snapshot() }));
    const { container } = render(createElement(VexTokenCardCompact), {
      wrapper: makeWrapper(freshClient()),
    });

    await waitFor(() => {
      const card = container.querySelector(
        '[data-vex-area="vex-token-compact"][data-state="data"]',
      );
      expect(card).not.toBeNull();
      expect(card?.getAttribute("aria-label")).toContain("$0.0005430");
    });
    expect(container.textContent).toContain("$0.0005430");
    expect(container.textContent).toContain("+113.00%");
    // Chronos slim cut: the 2×2 micro-grid is retired.
    expect(container.textContent).not.toContain("MCAP");
    expect(container.textContent).not.toContain("LIQ");
    expect(container.textContent).not.toContain("24H VOL");
    expect(container.textContent).not.toContain("HOLDERS");
    // The change is one ink on the ground: its direction is the arrow and
    // the sign, never a colour (docs/design/V10-SPREAD.md section 1), and it
    // no longer shimmers.
    const delta = container.querySelector('[data-vex-area="vex-token-delta"]');
    expect(delta).not.toBeNull();
    expect(delta?.getAttribute("data-direction")).toBe("up");
    expect(delta?.textContent).toBe("↑ +113.00%");
    expect(delta?.className).not.toMatch(/text-(success|warning|danger)/);
    expect(delta?.className).not.toContain("shimmer");
    expect(delta?.className).not.toContain("border");
    expect(
      container.querySelector(
        '[data-vex-area="vex-token-sparkline"][data-empty="false"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-vex-area="vex-token-stale"]'),
    ).toBeNull();
  });

  it("wraps the data card in a whole-card link to the $VEX DexScreener pair", async () => {
    setMarket(vi.fn().mockResolvedValue({ ok: true, data: snapshot() }));
    const { container } = render(createElement(VexTokenCardCompact), {
      wrapper: makeWrapper(freshClient()),
    });

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-vex-area="vex-token-compact"][data-state="data"]',
        ),
      ).not.toBeNull();
    });
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe(
      "https://dexscreener.com/robinhood/0x817f16f5d8da83d1b089b082c0172af3923618da",
    );
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link?.getAttribute("aria-label")).toBe("Open $VEX on DexScreener");
  });

  it("shows a loading skeleton before the first snapshot arrives (ok(null))", async () => {
    setMarket(vi.fn().mockResolvedValue({ ok: true, data: null }));
    const { container } = render(createElement(VexTokenCardCompact), {
      wrapper: makeWrapper(freshClient()),
    });

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-vex-area="vex-token-compact"][data-state="loading"]',
        ),
      ).not.toBeNull();
    });
    // Never blank: the $VEX label is always present.
    expect(container.textContent).toContain("$VEX");
    // Only the data line links out; the loading skeleton stays inert.
    expect(container.querySelector("a")).toBeNull();
  });

  it("shows an error line when the bridge returns an error", async () => {
    setMarket(
      vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: "internal.unexpected",
          domain: "market",
          message: "boom",
          retryable: false,
          userActionable: false,
          redacted: true,
          correlationId: "c",
        },
      } satisfies SnapshotResult),
    );
    const { container } = render(createElement(VexTokenCardCompact), {
      wrapper: makeWrapper(freshClient()),
    });

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-vex-area="vex-token-compact"][data-state="error"]',
        ),
      ).not.toBeNull();
    });
    expect(container.textContent).toContain("Market data unavailable.");
  });

  it("surfaces the stale marker on a delayed snapshot, and keeps the figure", async () => {
    setMarket(
      vi.fn().mockResolvedValue({ ok: true, data: snapshot({ stale: true }) }),
    );
    const { container } = render(createElement(VexTokenCardCompact), {
      wrapper: makeWrapper(freshClient()),
    });

    await waitFor(() => {
      const card = container.querySelector(
        '[data-vex-area="vex-token-compact"][data-stale="true"]',
      );
      expect(card).not.toBeNull();
      expect(card?.getAttribute("aria-label")).toContain("data delayed");
    });
    expect(
      container.querySelector('[data-vex-area="vex-token-stale"]'),
    ).not.toBeNull();
    // Staleness is carried honestly by the marker; the last known change
    // still reads.
    const delta = container.querySelector('[data-vex-area="vex-token-delta"]');
    expect(delta?.textContent).toContain("+113.00%");
  });

  it("keeps the line token-driven (the spark is the print's white, --vex-alias-on-photo)", async () => {
    setMarket(vi.fn().mockResolvedValue({ ok: true, data: snapshot() }));
    const client = freshClient();
    const { container } = render(
      createElement(
        "div",
        { "data-vex-shell": "true" },
        createElement(
          QueryClientProvider,
          { client },
          createElement(VexTokenCardCompact),
        ),
      ),
    );

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-vex-area="vex-token-compact"][data-state="data"]',
        ),
      ).not.toBeNull();
    });
    // The line carries no raw colour: the spark and its end square read the
    // on-photo token, so a re-tint needs no component change.
    const strokes = [
      ...container.querySelectorAll('[data-vex-area="vex-token-sparkline"] polyline, [data-vex-area="vex-token-sparkline"] path'),
    ].map((el) => el.getAttribute("stroke"));
    expect(strokes).toEqual(["var(--vex-alias-on-photo)", "var(--vex-alias-on-photo)"]);
  });

  it("degrades to a blank sparkline track when there are no closes", async () => {
    setMarket(
      vi.fn().mockResolvedValue({ ok: true, data: snapshot({ sparkline: [] }) }),
    );
    const { container } = render(createElement(VexTokenCardCompact), {
      wrapper: makeWrapper(freshClient()),
    });

    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-vex-area="vex-token-compact"][data-state="data"]',
        ),
      ).not.toBeNull();
    });
    // Empty track present, no <path> drawn.
    const spark = container.querySelector(
      '[data-vex-area="vex-token-sparkline"][data-empty="true"]',
    );
    expect(spark).not.toBeNull();
    expect(spark?.tagName.toLowerCase()).not.toBe("svg");
  });

  /**
   * NO PLATE ON THE PRINT (docs/design/V10-SPREAD.md section 3). The $VEX line
   * sits straight on the left page's dark ground: no glass chip, no stroke,
   * no fill, no radius, in every state. The data line is one link.
   */
  it("sits on the ground without a plate, and the data line is one link", async () => {
    setMarket(vi.fn().mockResolvedValue({ ok: true, data: snapshot() }));
    const { container } = render(createElement(VexTokenCardCompact), {
      wrapper: makeWrapper(freshClient()),
    });
    await waitFor(() => {
      expect(
        container.querySelector('[data-vex-area="vex-token-compact"][data-state="data"]'),
      ).not.toBeNull();
    });
    const plate = container.querySelector('[data-vex-area="vex-token-compact"]');
    expect(plate?.className ?? "").not.toMatch(/vex-glass|rounded|(?:^|\s)border|(?:^|\s)bg-/);
    const link = container.querySelector("a");
    expect(link?.classList.contains("vex-tok--link")).toBe(true);
    expect(link?.className).not.toMatch(/vex-glass|rounded|(?:^|\s)border/);
  });

  it.each([
    ["loading", { ok: true, data: null } satisfies SnapshotResult],
    [
      "error",
      {
        ok: false,
        error: {
          code: "internal.unexpected",
          domain: "market",
          message: "boom",
          retryable: false,
          userActionable: false,
          redacted: true,
          correlationId: "c",
        },
      } satisfies SnapshotResult,
    ],
  ] as const)("the %s state sits on the ground without a plate too", async (state, answer) => {
    setMarket(vi.fn().mockResolvedValue(answer));
    const { container } = render(createElement(VexTokenCardCompact), {
      wrapper: makeWrapper(freshClient()),
    });
    await waitFor(() => {
      expect(
        container.querySelector(
          `[data-vex-area="vex-token-compact"][data-state="${state}"]`,
        ),
      ).not.toBeNull();
    });
    const plate = container.querySelector('[data-vex-area="vex-token-compact"]');
    expect(plate?.className ?? "").not.toMatch(/vex-glass|rounded|(?:^|\s)border|(?:^|\s)bg-/);
  });
});
