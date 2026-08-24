/**
 * `CompactionApplyButton` — the state table and the authority boundary.
 *
 * The load-bearing test is the last one: clicking calls `requestApply` exactly
 * once and NO other compaction bridge method. That is the structural form of
 * "the button never performs a cutover".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CompactionPreparationDto,
  CompactionPreparationStatusDto,
} from "@shared/schemas/compaction-preparation.js";
import type { SessionPermission } from "@shared/schemas/sessions.js";
import { CompactionApplyButton } from "../CompactionApplyButton.js";

const SESSION = "00000000-0000-4000-8000-0000000000ab";
const ISO = "2026-07-29T10:00:00.000Z";

const requestApply = vi.fn();
const getPreparation = vi.fn();
const getStatus = vi.fn();
const listHistory = vi.fn();
const retry = vi.fn();

function prep(
  status: CompactionPreparationStatusDto,
): CompactionPreparationDto {
  return {
    sessionId: SESSION,
    status,
    summaryStatus: status === "preparing" ? "running" : "succeeded",
    chunksStatus: "pending",
    summaryAttemptCount: 1,
    summaryMaxAttempts: 3,
    chunksAttemptCount: 0,
    chunksMaxAttempts: 3,
    hasSummary: status !== "preparing",
    applySource: null,
    applyRequestedAt: null,
    appliedAt: null,
    createdAt: ISO,
    completedAt: null,
  };
}

function renderButton(
  preparation: CompactionPreparationDto | null,
  permission: SessionPermission | null = "restricted",
) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const tree = (p: CompactionPreparationDto | null) => (
    <QueryClientProvider client={client}>
      <CompactionApplyButton
        sessionId={SESSION}
        preparation={p}
        permission={permission}
        stack={false}
      />
    </QueryClientProvider>
  );
  const view = render(tree(preparation));
  // Advance the ROW state while keeping the component instance — the
  // `no_live_runner` distinction lives in local state from the request, not in
  // the DTO, so a remount would silently lose the thing under test.
  return {
    ...view,
    advance: (next: CompactionPreparationDto) => view.rerender(tree(next)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      compaction: {
        requestApply,
        getPreparation,
        getStatus,
        listHistory,
        retry,
      },
    },
  });
});

afterEach(() => {
  cleanup();
  // @ts-expect-error — test cleanup
  delete window.vex;
});

describe("CompactionApplyButton - state table", () => {
  it("renders nothing without a preparation", () => {
    const { container } = renderButton(null);
    expect(container.innerHTML).toBe("");
  });

  it.each(["applied", "superseded"] as const)(
    "renders nothing at %s",
    (status) => {
      const { container } = renderButton(prep(status));
      expect(container.innerHTML).toBe("");
    },
  );

  it("preparing → disabled, no shimmer", () => {
    renderButton(prep("preparing"));
    const button = screen.getByRole("button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toContain("Preparing memory");
    expect(button.className).not.toContain("vex-badge--shimmer");
  });

  it("summary_ready → enabled, shimmering, with the consequence in the label", () => {
    renderButton(prep("summary_ready"));
    const button = screen.getByRole("button");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.textContent).toBe("Compact now");
    expect(button.className).toContain("vex-badge--shimmer");
    expect(button.getAttribute("aria-label")).toContain(
      "replaces older messages with a summary",
    );
  });

  it("summary_ready at permission full → still shown, and says auto-apply exists", () => {
    renderButton(prep("summary_ready"), "full");
    const button = screen.getByRole("button");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("title")).toBe("Runs automatically when safe");
  });

  it("summary_ready at permission restricted → no auto-apply title", () => {
    renderButton(prep("summary_ready"), "restricted");
    expect(screen.getByRole("button").getAttribute("title")).toBeNull();
  });

  it("apply_requested → disabled, and defaults to the truthful generic copy", () => {
    renderButton(prep("apply_requested"));
    const button = screen.getByRole("button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toBe(
      "Queued - will apply when the agent next runs",
    );
  });

  it("applying → disabled", () => {
    renderButton(prep("applying"));
    const button = screen.getByRole("button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toContain("Compacting");
  });

  it("failed → a status line, and NO retry button (retry is runtime-owned)", () => {
    renderButton(prep("failed"));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Preparation failed");
  });

  it("no shimmer in any state other than summary_ready", () => {
    for (const status of [
      "preparing",
      "apply_requested",
      "applying",
    ] as const) {
      const { container, unmount } = renderButton(prep(status));
      expect(container.innerHTML).not.toContain("vex-badge--shimmer");
      unmount();
    }
  });
});

describe("CompactionApplyButton - the one call", () => {
  it("clicking calls requestApply EXACTLY once and no other bridge method", async () => {
    requestApply.mockResolvedValue({
      ok: true,
      data: { outcome: "queued", status: "apply_requested" },
    });
    renderButton(prep("summary_ready"));

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(requestApply).toHaveBeenCalledTimes(1));
    expect(requestApply).toHaveBeenCalledWith({ sessionId: SESSION });
    // Never a cutover, never a Track-2 action.
    expect(getPreparation).not.toHaveBeenCalled();
    expect(getStatus).not.toHaveBeenCalled();
    expect(listHistory).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("a no_live_runner outcome renders the honest copy and leaves the control disabled", async () => {
    requestApply.mockResolvedValue({
      ok: true,
      data: { outcome: "no_live_runner", status: "apply_requested" },
    });
    const { advance } = renderButton(prep("summary_ready"));
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(requestApply).toHaveBeenCalled());

    advance(prep("apply_requested"));

    const button = screen.getByRole("button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toBe(
      "Queued - will apply when the agent next runs",
    );
  });

  it("a queued outcome (a live runner exists) renders the stronger copy", async () => {
    requestApply.mockResolvedValue({
      ok: true,
      data: { outcome: "queued", status: "apply_requested" },
    });
    const { advance } = renderButton(prep("summary_ready"));
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(requestApply).toHaveBeenCalled());

    advance(prep("apply_requested"));

    expect(screen.getByRole("button").textContent).toBe(
      "Queued - applies at the next step",
    );
  });
});
