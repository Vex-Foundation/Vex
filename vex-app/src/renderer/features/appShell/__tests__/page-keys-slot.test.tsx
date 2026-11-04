/**
 * The title bar's page keys (`pageKeysSlot.tsx`, docs/design/R3-MINIMAL.md
 * section 3): a page key lands in the title bar's slot when the title bar
 * stands and stays in place when it does not; only its DOM moves.
 *
 * Portfolio's refresh key no longer uses the slot: H3 moves a page's keys
 * into the page's own tabs row beside "Updated {time}"
 * (docs/design/H3-DESKTOP.md section 4.8), so it stays on the page even
 * while a title bar slot stands, with its outcome line beside it.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let outcome: { status: string; retryAfterMs?: number } = { status: "refreshed" };
vi.mock("../../../lib/api/portfolio.js", () => ({
  usePortfolioRefresh: () => ({ refresh: async () => outcome }),
}));

const { PortfolioRefreshButton } = await import("../book/PortfolioRefreshButton.js");
const { PageKey, setPageKeysSlot } = await import("../pageKeysSlot.js");

afterEach(() => {
  cleanup();
  act(() => setPageKeysSlot(null));
  outcome = { status: "refreshed" };
});

describe("PageKey", () => {
  it("stays in place without a title bar", () => {
    const { container } = render(
      <div data-testid="page">
        <PageKey>{(inBar) => <button type="button">{inBar ? "in bar" : "in page"}</button>}</PageKey>
      </div>,
    );
    expect(container.querySelector('[data-testid="page"] button')?.textContent).toBe("in page");
  });

  it("lands in the title bar's slot while one stands", () => {
    const bar = document.createElement("div");
    document.body.append(bar);
    act(() => setPageKeysSlot(bar));
    const { container } = render(
      <div data-testid="page">
        <PageKey>{(inBar) => <button type="button">{inBar ? "in bar" : "in page"}</button>}</PageKey>
      </div>,
    );
    expect(container.querySelector('[data-testid="page"] button')).toBeNull();
    expect(bar.querySelector("button")?.textContent).toBe("in bar");
    bar.remove();
  });
});

describe("Portfolio's refresh key", () => {
  it("stays on the page beside its outcome line, even while a title bar slot stands", async () => {
    const bar = document.createElement("div");
    document.body.append(bar);
    act(() => setPageKeysSlot(bar));
    outcome = { status: "throttled", retryAfterMs: 30_000 };
    const { container } = render(
      <div data-testid="page">
        <PortfolioRefreshButton />
      </div>,
    );
    const key = screen.getByRole("button", { name: "Refresh portfolio" });
    const page = container.querySelector('[data-testid="page"]');
    expect(page?.contains(key)).toBe(true);
    expect(bar.contains(key)).toBe(false);
    expect(key.className).toBe("vex-pg-key");
    await act(async () => {
      fireEvent.click(key);
    });
    // a sentence, not a hyphen standing in for a dash
    expect(page?.querySelector(".vex-pf-fb")?.textContent).toBe("Just refreshed. Retry in 30s.");
    expect(bar.querySelector(".vex-pf-fb")).toBeNull();
    bar.remove();
  });

  it("says a failed refresh in full sentences", async () => {
    outcome = { status: "unavailable" };
    render(<PortfolioRefreshButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh portfolio" }));
    });
    expect(screen.getByRole("status").textContent).toBe(
      "Could not refresh. Showing last known balances.",
    );
  });

  it("is the tabs row's cell key where no title bar stands too", () => {
    render(<PortfolioRefreshButton />);
    expect(screen.getByRole("button", { name: "Refresh portfolio" }).className).toBe("vex-pg-key");
  });
});
