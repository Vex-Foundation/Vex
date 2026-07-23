/**
 * JobsSection render tests (memory-system S10).
 *
 * Verifies: the six status counters (Agent Scan plan §11.3 added `retired`
 * for the reconcile-job retirement) render from countsByStatus, recent job
 * rows render kind/status/attempts/item-progress/wake-pending, injected raw
 * `last_error` / lock columns never reach the DOM, the section stays
 * READ-ONLY (no buttons at all — not even filters), and empty/error states
 * render.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const { JobsSection } = await import("../JobsSection.js");

const ISO = "2026-05-21T10:00:00.000Z";

function ok<T>(data: T) {
  return { ok: true as const, data };
}

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 3,
    jobKind: "consolidate",
    status: "running",
    attemptCount: 1,
    maxAttempts: 3,
    wakePending: false,
    nextAttemptAt: ISO,
    itemsDone: 2,
    itemsFailed: 1,
    itemsTotal: 5,
    costUsd: 0.02,
    llmCallCount: 1,
    createdAt: ISO,
    startedAt: ISO,
    completedAt: null,
    ...overrides,
  };
}

function summary(jobs: ReadonlyArray<Record<string, unknown>>) {
  return {
    countsByStatus: {
      pending: 4,
      running: 1,
      completed: 9,
      failed: 2,
      permanently_failed: 0,
      retired: 3,
    },
    recentJobs: jobs,
  };
}

const jobsSummaryMock = vi.fn();

function setVex(): void {
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { memoryInspector: { jobsSummary: jobsSummaryMock } },
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

describe("JobsSection", () => {
  it("renders the six status counters and a sanitized job row, with zero buttons", async () => {
    jobsSummaryMock.mockResolvedValue(
      ok(
        summary([
          job({
            // Injected raw worker columns the panel must NEVER render.
            last_error: "SECRET_PROVIDER_ERROR",
            locked_by: "SECRET_WORKER_ID",
          }),
        ]),
      ),
    );
    setVex();
    const { container } = render(createElement(JobsSection), {
      wrapper: makeWrapper(freshClient()),
    });

    await waitFor(() => {
      expect(jobsSummaryMock).toHaveBeenCalledWith({ recentLimit: 20 });
    });
    await waitFor(() => {
      expect(screen.getByText("pending 4")).not.toBeNull();
    });
    // All six counters.
    expect(screen.getByText("running 1")).not.toBeNull();
    expect(screen.getByText("completed 9")).not.toBeNull();
    expect(screen.getByText("failed 2")).not.toBeNull();
    expect(screen.getByText("perm-failed 0")).not.toBeNull();
    expect(screen.getByText("retired 3")).not.toBeNull();
    // Job row fields.
    expect(screen.getByText("#3")).not.toBeNull();
    expect(screen.getByText("consolidate")).not.toBeNull();
    expect(screen.getByText("running")).not.toBeNull();
    expect(screen.getByText("attempts 1/3")).not.toBeNull();
    expect(
      screen.getByText(/items 2 done \/ 1 failed \/ 5 total/),
    ).not.toBeNull();
    // Raw worker internals must never reach the DOM.
    expect(screen.queryByText("SECRET_PROVIDER_ERROR")).toBeNull();
    expect(screen.queryByText("SECRET_WORKER_ID")).toBeNull();
    // READ-ONLY: the jobs section has no buttons at all (no retry/reset).
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("marks a wake-pending reconcile job", async () => {
    jobsSummaryMock.mockResolvedValue(
      ok(summary([job({ jobKind: "reconcile", wakePending: true })])),
    );
    setVex();
    const { container } = render(createElement(JobsSection), {
      wrapper: makeWrapper(freshClient()),
    });

    await waitFor(() => {
      expect(screen.getByText("wake pending")).not.toBeNull();
    });
    expect(
      container.querySelector("[data-vex-job-wake-pending]"),
    ).not.toBeNull();
  });

  it("shows the empty state when there are no jobs", async () => {
    jobsSummaryMock.mockResolvedValue(ok(summary([])));
    setVex();
    render(createElement(JobsSection), {
      wrapper: makeWrapper(freshClient()),
    });

    await waitFor(() => {
      expect(screen.getByText(/No memory jobs yet/i)).not.toBeNull();
    });
  });

  it("surfaces a summary error", async () => {
    jobsSummaryMock.mockResolvedValue({
      ok: false as const,
      error: {
        code: "internal.unexpected",
        domain: "memory",
        message: "Database unavailable. Verify services are running and retry.",
        retryable: true,
        userActionable: true,
        redacted: true,
      },
    });
    setVex();
    render(createElement(JobsSection), {
      wrapper: makeWrapper(freshClient()),
    });

    await waitFor(() => {
      expect(screen.getByText(/Database unavailable/i)).not.toBeNull();
    });
  });
});
