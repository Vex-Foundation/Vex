/**
 * LongMemorySection render tests (memory-system S9 rewire).
 *
 * Verifies: the status filter pills drive the query, client-side search
 * narrows rows, the section stays READ-ONLY (no Archive/Invalidate buttons
 * on any row regardless of status), and loading/error/empty states render.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const { LongMemorySection } = await import("../LongMemorySection.js");

const ISO = "2026-05-21T10:00:00.000Z";

function ok<T>(data: T) {
  return { ok: true as const, data };
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    kind: "risk_rule",
    title: "Avoid X",
    summary: "Keep slippage low",
    tags: [],
    confidence: null,
    status: "active",
    source: "observed",
    maturityState: "established",
    pinned: false,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

const longMemoryListMock = vi.fn();

function setVex(): void {
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { longMemory: { list: longMemoryListMock } },
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
  vi.clearAllMocks();
  // @ts-expect-error — test cleanup
  delete window.vex;
});

describe("LongMemorySection", () => {
  it("lists entries and never shows mutation buttons - even on active rows", async () => {
    longMemoryListMock.mockResolvedValue(
      ok([entry({ id: 1, status: "active", title: "Active row" })]),
    );
    setVex();
    const { container } = render(createElement(LongMemorySection), {
      wrapper: makeWrapper(freshClient()),
    });

    await waitFor(() => {
      expect(screen.getByText("Active row")).not.toBeNull();
    });
    // The only buttons in the section are the status-filter pills — a row
    // must never carry an action button (Archive/Invalidate died with S9).
    expect(container.querySelectorAll("li button")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Archive Active row" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invalidate Active row" })).toBeNull();
  });

  it("status filter pills re-query with the chosen status", async () => {
    longMemoryListMock.mockResolvedValue(ok([]));
    setVex();
    render(createElement(LongMemorySection), {
      wrapper: makeWrapper(freshClient()),
    });

    await waitFor(() => {
      expect(longMemoryListMock).toHaveBeenCalledWith({ limit: 100 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    await waitFor(() => {
      expect(longMemoryListMock).toHaveBeenCalledWith({
        status: "archived",
        limit: 100,
      });
    });
  });

  it("client-side search narrows by title/summary/kind", async () => {
    longMemoryListMock.mockResolvedValue(
      ok([
        entry({ id: 1, title: "Kyber timeout lesson" }),
        entry({ id: 2, title: "Other note", summary: "unrelated", kind: "memo" }),
      ]),
    );
    setVex();
    render(createElement(LongMemorySection), {
      wrapper: makeWrapper(freshClient()),
    });

    await waitFor(() => {
      expect(screen.getByText("Kyber timeout lesson")).not.toBeNull();
    });
    fireEvent.change(screen.getByLabelText("Search long-term memory"), {
      target: { value: "kyber" },
    });
    expect(screen.queryByText("Other note")).toBeNull();
    expect(screen.getByText("Kyber timeout lesson")).not.toBeNull();
  });

  it("shows the empty state when nothing matches", async () => {
    longMemoryListMock.mockResolvedValue(ok([]));
    setVex();
    render(createElement(LongMemorySection), {
      wrapper: makeWrapper(freshClient()),
    });

    await waitFor(() => {
      expect(screen.getByText(/No memory entries match/i)).not.toBeNull();
    });
  });

  it("surfaces a list error", async () => {
    longMemoryListMock.mockResolvedValue({
      ok: false as const,
      error: {
        code: "internal.unexpected",
        domain: "memory",
        message: "Unable to load memory.",
        retryable: true,
        userActionable: false,
        redacted: true,
      },
    });
    setVex();
    render(createElement(LongMemorySection), {
      wrapper: makeWrapper(freshClient()),
    });

    await waitFor(() => {
      expect(screen.getByText("Unable to load memory.")).not.toBeNull();
    });
  });
});
