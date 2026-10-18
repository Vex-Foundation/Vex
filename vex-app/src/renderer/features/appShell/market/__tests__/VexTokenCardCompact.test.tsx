/**
 * The $VEX line on the Portfolio page (docs/design/R3-MINIMAL.md section 9.1:
 * "A '$VEX' line replaces the old price card"), render-state tests.
 *
 * It is ONE LINE (`.vex-pf-vex`): "$VEX", the price, the 24 hour change with
 * its arrow, "24h", a "delayed" marker when the feed is stale, and ONE link to
 * the DexScreener pair. There is no sparkline and no stat grid any more.
 *
 * Every state must resolve to something visible so the page is never blank:
 * "Loading…", "Market data unavailable.", or the data line. Data flows through
 * the mocked `window.vex.market` bridge; the live-sync effect's `onVexUpdate`
 * is a no-op unsubscribe unless a test drives it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { Result } from "@shared/ipc/result.js";
import type { VexMarketSnapshot } from "@shared/schemas/market.js";
import { VexTokenCardCompact } from "../VexTokenCardCompact.js";

type SnapshotResult = Result<VexMarketSnapshot | null>;

const PAIR_URL =
  "https://dexscreener.com/robinhood/0x817f16f5d8da83d1b089b082c0172af3923618da";

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

const ERROR_RESULT = {
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
} satisfies SnapshotResult;

function setMarket(
  getVexSnapshot: () => Promise<SnapshotResult>,
  onVexUpdate: (listener: (next: VexMarketSnapshot) => void) => () => void = () => () => {},
): void {
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      market: {
        getVexSnapshot,
        onVexUpdate,
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

function renderLine() {
  return render(createElement(VexTokenCardCompact), {
    wrapper: makeWrapper(freshClient()),
  });
}

/** The line in one state, once it has settled there. */
async function lineIn(
  container: HTMLElement,
  state: "loading" | "error" | "data",
): Promise<HTMLElement> {
  const selector = `[data-vex-area="vex-token-compact"][data-state="${state}"]`;
  await waitFor(() => {
    expect(container.querySelector(selector)).not.toBeNull();
  });
  const line = container.querySelector<HTMLElement>(selector);
  if (line === null) throw new Error(`the $VEX line never reached ${state}`);
  return line;
}

/** The line's parts, in order, as text. */
function parts(line: HTMLElement): readonly (string | null)[] {
  return Array.from(line.children).map((child) => child.textContent);
}

async function dataLine(overrides: Partial<VexMarketSnapshot> = {}) {
  setMarket(vi.fn().mockResolvedValue({ ok: true, data: snapshot(overrides) }));
  const rendered = renderLine();
  const line = await lineIn(rendered.container, "data");
  return { ...rendered, line };
}

afterEach(() => {
  Reflect.deleteProperty(window, "vex");
});

describe("VexTokenCardCompact - the data line", () => {
  it("is one line: $VEX, the price, the change with its arrow, 24h, and the DexScreener link", async () => {
    const { line } = await dataLine();
    expect(line.className).toContain("vex-pf-vex");
    expect(line.getAttribute("aria-label")).toBe(
      "VEX token price $0.0005430, 24 hour change +113.00%",
    );
    expect(parts(line)).toEqual(["$VEX", "$0.0005430", "↑ +113.00%", "24h", "DexScreener"]);
    // One line means inline parts only: no block, list or table inside it.
    for (const child of Array.from(line.children)) {
      expect(["SPAN", "A"]).toContain(child.tagName);
    }
    expect(line.querySelector("div, ul, ol, table, p")).toBeNull();
  });

  it("reads fresh: not stale, and no delayed marker", async () => {
    const { line, container } = await dataLine();
    expect(line.getAttribute("data-stale")).toBe("false");
    expect(container.querySelector('[data-vex-area="vex-token-stale"]')).toBeNull();
    expect(line.getAttribute("aria-label")).not.toContain("delayed");
  });

  it("has NO stat grid", async () => {
    const { container } = await dataLine();
    const text = container.textContent ?? "";
    for (const retired of ["MCAP", "LIQ", "24H VOL", "HOLDERS"]) {
      expect(text).not.toContain(retired);
    }
  });

  it("has NO sparkline, even when the snapshot carries closes", async () => {
    const { container } = await dataLine();
    expect(container.querySelector('[data-vex-area="vex-token-sparkline"]')).toBeNull();
    expect(container.querySelector("polyline")).toBeNull();
    expect(container.querySelector("path[stroke]")).toBeNull();
  });

  it("keeps the change as one ink on the ground: its direction is the arrow and the sign", async () => {
    const { container } = await dataLine();
    const delta = container.querySelector('[data-vex-area="vex-token-delta"]');
    expect(delta).not.toBeNull();
    expect(delta?.getAttribute("data-direction")).toBe("up");
    expect(delta?.textContent).toBe("↑ +113.00%");
    expect(delta?.className).not.toMatch(/text-(success|warning|danger)/);
    expect(delta?.className).not.toContain("shimmer");
    expect(delta?.className).not.toContain("border");
  });

  it.each([
    ["up", 113, "up", "up", "↑ +113.00%"],
    ["down", -1.73, "down", "down", "↓ -1.73%"],
  ] as const)(
    "a %s change takes the trading colour of its direction, and the arrow says it too",
    async (_name, h24, direction, trade, text) => {
      const { container } = await dataLine({ priceChange: { h1: null, h24 } });
      const delta = container.querySelector('[data-vex-area="vex-token-delta"]');
      expect(delta?.getAttribute("data-direction")).toBe(direction);
      expect(delta?.getAttribute("data-trade")).toBe(trade);
      expect(delta?.textContent).toBe(text);
      // The arrow is decoration for the eye; the sign carries it for a reader.
      expect(delta?.querySelector("[aria-hidden]")?.textContent).toBe(direction === "up" ? "↑ " : "↓ ");
    },
  );

  it("a flat change takes NO trading colour and carries no arrow", async () => {
    const { container } = await dataLine({ priceChange: { h1: null, h24: 0 } });
    const delta = container.querySelector('[data-vex-area="vex-token-delta"]');
    expect(delta?.getAttribute("data-direction")).toBe("flat");
    expect(delta?.hasAttribute("data-trade")).toBe(false);
    expect(delta?.textContent).toBe("0.00%");
    expect(delta?.querySelector("[aria-hidden]")).toBeNull();
  });

  it("links the whole line out through ONE link, to the $VEX DexScreener pair", async () => {
    const { container } = await dataLine();
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    const link = links[0];
    expect(link?.getAttribute("href")).toBe(PAIR_URL);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link?.getAttribute("aria-label")).toBe("Open $VEX on DexScreener");
    expect(link?.textContent).toBe("DexScreener");
    expect(link?.className).toContain("vex-pf-vex__link");
  });
});

describe("VexTokenCardCompact - a delayed feed", () => {
  it("surfaces the delayed marker beside 24h, and keeps the last known figures", async () => {
    const { line, container } = await dataLine({ stale: true });
    expect(line.getAttribute("data-stale")).toBe("true");
    expect(line.getAttribute("aria-label")).toBe(
      "VEX token price $0.0005430, 24 hour change +113.00%, data delayed",
    );
    const marker = container.querySelector('[data-vex-area="vex-token-stale"]');
    expect(marker?.textContent).toBe("delayed");
    expect(marker?.getAttribute("title")).toMatch(/last known price/i);
    // Staleness is carried honestly by the marker; the figures still read.
    expect(parts(line)).toEqual([
      "$VEX",
      "$0.0005430",
      "↑ +113.00%",
      "24h",
      "delayed",
      "DexScreener",
    ]);
  });

  it("still links out while delayed", async () => {
    const { container } = await dataLine({ stale: true });
    expect(container.querySelectorAll("a")).toHaveLength(1);
  });
});

describe("VexTokenCardCompact - a figure the feed does not carry", () => {
  it("a missing price says Not available, never a zero or a dash", async () => {
    const { line, container } = await dataLine({ priceUsd: null });
    expect(container.querySelector(".vex-pf-vex__p")?.textContent).toBe("Not available");
    expect(line.getAttribute("aria-label")).toBe(
      "VEX token price Not available, 24 hour change +113.00%",
    );
    expect(container.textContent).not.toContain("$0.00");
  });

  it("a missing change says Not available and reads flat", async () => {
    const { line, container } = await dataLine({ priceChange: { h1: -1.73, h24: null } });
    const delta = container.querySelector('[data-vex-area="vex-token-delta"]');
    expect(delta?.textContent).toBe("Not available");
    expect(delta?.getAttribute("data-direction")).toBe("flat");
    expect(delta?.hasAttribute("data-trade")).toBe(false);
    expect(line.getAttribute("aria-label")).toBe(
      "VEX token price $0.0005430, 24 hour change Not available",
    );
  });

  it("a feed with neither still shows the line, with both words", async () => {
    const { line } = await dataLine({ priceUsd: null, priceChange: { h1: null, h24: null } });
    expect(parts(line)).toEqual(["$VEX", "Not available", "Not available", "24h", "DexScreener"]);
  });
});

describe("VexTokenCardCompact - loading", () => {
  it("shows the label and Loading… before the first snapshot arrives (ok(null))", async () => {
    setMarket(vi.fn().mockResolvedValue({ ok: true, data: null }));
    const { container } = renderLine();
    const line = await lineIn(container, "loading");
    expect(line.className).toContain("vex-pf-vex");
    expect(line.getAttribute("aria-label")).toBe("Loading VEX price");
    // Never blank: the $VEX label is always present.
    expect(parts(line)).toEqual(["$VEX", "Loading…"]);
    // Only the data line links out; the loading state stays inert.
    expect(container.querySelector("a")).toBeNull();
  });

  it("reads the same while the first read is still out", async () => {
    setMarket(vi.fn(() => new Promise<SnapshotResult>(() => undefined)));
    const { container } = renderLine();
    const line = await lineIn(container, "loading");
    expect(parts(line)).toEqual(["$VEX", "Loading…"]);
  });
});

describe("VexTokenCardCompact - an error", () => {
  it("shows the label and a line when the bridge returns an error", async () => {
    setMarket(vi.fn().mockResolvedValue(ERROR_RESULT));
    const { container } = renderLine();
    const line = await lineIn(container, "error");
    expect(line.className).toContain("vex-pf-vex");
    expect(line.getAttribute("aria-label")).toBe("VEX market data unavailable");
    expect(parts(line)).toEqual(["$VEX", "Market data unavailable."]);
    // The error state stays inert.
    expect(container.querySelector("a")).toBeNull();
  });

  it("reads the same when the read itself throws", async () => {
    setMarket(vi.fn().mockRejectedValue(new Error("ipc channel closed")));
    const { container } = renderLine();
    const line = await lineIn(container, "error");
    expect(parts(line)).toEqual(["$VEX", "Market data unavailable."]);
  });
});

describe("VexTokenCardCompact - live updates", () => {
  it("replaces the line's figures when main pushes a new snapshot", async () => {
    const live = { push: (_next: VexMarketSnapshot): void => undefined };
    setMarket(vi.fn().mockResolvedValue({ ok: true, data: snapshot() }), (listener) => {
      live.push = listener;
      return () => {};
    });
    const { container } = renderLine();
    const line = await lineIn(container, "data");
    expect(parts(line)).toContain("$0.0005430");

    act(() => {
      live.push(snapshot({ priceUsd: 2, priceChange: { h1: null, h24: -4 }, stale: true }));
    });
    await waitFor(() => {
      expect(parts(line)).toEqual(["$VEX", "$2.00", "↓ -4.00%", "24h", "delayed", "DexScreener"]);
    });
    expect(line.getAttribute("data-stale")).toBe("true");
  });
});

/**
 * NO PLATE ON THE PAGE (docs/design/R3-MINIMAL.md section 9.1). The $VEX line
 * sits straight on the paper: no glass chip, no stroke, no fill, no radius, in
 * every state. The data line is one link.
 */
describe("VexTokenCardCompact - no plate", () => {
  const PLATE = /vex-glass|rounded|(?:^|\s)border|(?:^|\s)bg-/;

  it("sits on the paper without a plate, and its link wears no box either", async () => {
    const { container, line } = await dataLine();
    expect(line.className).not.toMatch(PLATE);
    const link = container.querySelector("a");
    expect(link?.className).not.toMatch(/vex-glass|rounded|(?:^|\s)border/);
  });

  it.each([
    ["loading", { ok: true, data: null } satisfies SnapshotResult],
    ["error", ERROR_RESULT],
  ] as const)("the %s state sits on the paper without a plate too", async (state, answer) => {
    setMarket(vi.fn().mockResolvedValue(answer));
    const { container } = renderLine();
    const line = await lineIn(container, state);
    expect(line.className).not.toMatch(PLATE);
  });
});
