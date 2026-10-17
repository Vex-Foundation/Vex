/**
 * MemoryScreen: the Memory page (docs/design/R3-MINIMAL.md sections 9.6 and 12).
 *
 * Pinned here: the serif page head is the page's h1; the lead says the register
 * is read-only; the advisory-only guarantee is its own card with the solid
 * fill; the longer explainer is one click away in a native disclosure (closed
 * by default, so the register starts under the card) and keeps every
 * explanation it had; the register below is the read-only MemoryPanel, and no
 * sentence on the page claims a trade outcome re-check (that job is retired).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { useUiStore } from "../../../../stores/uiStore.js";
import { MemoryScreen } from "../MemoryScreen.js";
import {
  MEMORY_ADVISORY_TEXT,
  MEMORY_ADVISORY_TITLE,
  MEMORY_LEAD,
  MEMORY_MORE_TITLE,
} from "../memory-explainer.js";

function ok<T>(data: T) {
  return Promise.resolve({ ok: true as const, data });
}

beforeEach(() => {
  useUiStore.setState({ shellRoute: { kind: "none" }, activeSessionId: null });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      longMemory: { list: vi.fn(() => ok([])) },
      memoryInspector: {
        listCandidates: vi.fn(() => ok([])),
        listDecisions: vi.fn(() => ok([])),
        jobsSummary: vi.fn(() =>
          ok({
            countsByStatus: {
              pending: 0,
              running: 0,
              completed: 0,
              failed: 0,
              permanently_failed: 0,
              retired: 0,
            },
            recentJobs: [],
          }),
        ),
      },
      memory: { listSession: vi.fn(() => ok([])), getStats: vi.fn(() => ok(null)) },
      compaction: { listHistory: vi.fn(() => ok([])) },
      models: {
        listAvailable: vi.fn(() => ok({ source: "unconfigured", models: [], fetchedAt: null })),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  // @ts-expect-error - test cleanup
  delete window.vex;
});

function renderScreen() {
  return render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(MemoryScreen, { origin: null, onClose: () => undefined }),
    ),
  );
}

describe("MemoryScreen", () => {
  it("heads the page with the serif title, the lead and the advisory card", () => {
    const { container } = renderScreen();
    expect(screen.getByRole("heading", { level: 1, name: "Memory" })).not.toBeNull();
    expect(container.querySelector(".vex-mem-lead")?.textContent).toBe(MEMORY_LEAD);
    expect(MEMORY_LEAD).toContain("read-only");
    const card = container.querySelector(".vex-mem-card");
    expect(card?.querySelector("h2")?.textContent).toBe(MEMORY_ADVISORY_TITLE);
    expect(card?.querySelector('[data-s="done"]')).not.toBeNull();
    expect(card?.querySelector(".vex-mem-card__text")?.textContent).toBe(MEMORY_ADVISORY_TEXT);
  });

  it("keeps the longer explainer one click away, closed, and whole", () => {
    const { container } = renderScreen();
    const more = container.querySelector("details.vex-mem-more");
    expect(more).not.toBeNull();
    expect((more as HTMLDetailsElement).open).toBe(false);
    expect(more?.querySelector("summary")?.textContent).toBe(MEMORY_MORE_TITLE);
    const body = more?.textContent ?? "";
    for (const lead of ["How memories form.", "How memories age.", "Trades and memory."]) {
      expect(body).toContain(lead);
    }
    expect(body).toContain("never paste seed phrases or private keys into chat");
  });

  it("states what the code does with trades: no re-check, never a promise", () => {
    const { container } = renderScreen();
    const text = container.textContent ?? "";
    expect(text).toContain("Lessons are not re-checked when a trade closes");
    expect(text).not.toMatch(/suppressed or flipped/i);
    expect(text).not.toMatch(/trades keep memory honest/i);
    expect(text).not.toMatch(/prove them right/i);
  });

  it("puts the read-only register under the card, all seven sections in order", () => {
    const { container } = renderScreen();
    const register = container.querySelector('[data-vex-screen="memory"]');
    expect(register).not.toBeNull();
    const titles = [...(register?.querySelectorAll("section h2") ?? [])].map(
      (node) => node.textContent,
    );
    expect(titles).toEqual([
      "Long-term memory",
      "Memory candidates",
      "Manager decisions",
      "Memory jobs",
      "Session memory",
      "Compaction history",
      "Memory & privacy",
    ]);
    // The card comes before the register in the page.
    const card = container.querySelector(".vex-mem-card");
    expect(
      card !== null &&
        register !== null &&
        (card.compareDocumentPosition(register) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true);
  });

  it("has no em dash, en dash or caps label in its own words", () => {
    const { container } = renderScreen();
    const dashes = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
    expect(container.textContent).not.toMatch(dashes);
    expect(container.querySelector(".uppercase, .vex-eyebrow, .vex-micro-label")).toBeNull();
  });
});
