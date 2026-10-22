/**
 * "Needs you · N" in the title bar (docs/design/R3-MINIMAL.md sections 3 and
 * 5). Pins:
 *   - four honest states: checking and nothing (0) draw no control, something
 *     (N, an ink frame) and a FAILED read ("?" with Retry) do, never a failed
 *     read drawn as 0; a failed refetch keeps an earlier non-empty count but
 *     never an earlier empty one; a count over 99 reads "99+";
 *   - missions that need a decision count with the approvals;
 *   - the panel lists the shared items newest first, stays open saying
 *     "Nothing needs you." when the last item clears under it, closes on
 *     Escape (focus back on the control) and on an outside press;
 *   - Review opens the thing and never decides: the Needs you page on the
 *     approval's full card (in place, in Studio too), or the inline card when
 *     it is on screen, or a mission's session.
 */

import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";
import type { Result } from "@shared/ipc/result.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import type { VexCloudWithdrawalNotice, VexCloudWithdrawalNoticesResult } from "@shared/schemas/vex-cloud-funding.js";
import { approval, session } from "./fixtures.js";

const mockApprove = vi.fn();
const mockReject = vi.fn();
const mockRefetch = vi.fn(async () => undefined);
const mockRefetchNotices = vi.fn(async () => undefined);

const reads = vi.hoisted(() => ({
  pending: { data: undefined } as {
    data: Result<ReadonlyArray<ApprovalPendingGlobalDto>> | undefined;
    isError?: boolean;
    isFetching?: boolean;
  },
  sessions: [] as SessionListItem[],
  // Signed out by default: the withdrawal check claims nothing and blocks nothing.
  notices: { data: { ok: true, data: { state: "signed_out" } } } as {
    data: Result<VexCloudWithdrawalNoticesResult> | undefined;
    isError?: boolean;
    isFetching?: boolean;
  },
}));

vi.mock("../../../lib/api/approvals.js", () => ({
  usePendingApprovalsAll: () => ({
    isError: false,
    isFetching: false,
    refetch: mockRefetch,
    ...reads.pending,
  }),
  useGlobalApprovalsLiveSync: () => {},
  useApprove: () => ({ mutate: mockApprove, isPending: false }),
  useReject: () => ({ mutate: mockReject, isPending: false }),
}));
vi.mock("../../../lib/api/vex-cloud.js", () => ({
  useVexCloudWithdrawalNotices: () => ({
    isError: false,
    isFetching: false,
    refetch: mockRefetchNotices,
    ...reads.notices,
  }),
}));
vi.mock("../../../lib/api/sessions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../lib/api/sessions.js")>();
  return {
    ...original,
    useSessionsList: () => ({ data: { ok: true, data: reads.sessions } }),
  };
});

const { NeedsYouControl, needsYouCountLabel } = await import("../NeedsYouControl.js");
const { useUiStore } = await import("../../../stores/uiStore.js");

function failed(): Result<ReadonlyArray<ApprovalPendingGlobalDto>> {
  return {
    ok: false,
    error: {
      code: "internal.unexpected",
      domain: "approvals",
      message: "Unable to load approvals.",
      retryable: true,
      userActionable: false,
      redacted: true,
      correlationId: "req-x",
    },
  };
}

function renderControl(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NeedsYouControl />
    </QueryClientProvider>,
  );
}

function control(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-vex-area='needs-you-control']");
  if (el === null) throw new Error("control missing");
  return el;
}

function frame(): HTMLElement {
  const el = control().parentElement;
  if (el === null) throw new Error("frame missing");
  return el;
}

function swatchFill(): string | null | undefined {
  return control().querySelector(".vex-swatch")?.getAttribute("data-s");
}

function openPanel(): HTMLElement {
  fireEvent.click(control());
  return screen.getByRole("dialog", { name: "Needs you" });
}

beforeEach(() => {
  mockApprove.mockReset();
  mockReject.mockReset();
  mockRefetch.mockClear();
  mockRefetchNotices.mockClear();
  reads.pending = { data: undefined };
  reads.notices = { data: { ok: true, data: { state: "signed_out" } } };
  reads.sessions = [];
  useUiStore.setState({
    runtimeMode: "agent",
    activeSessionId: null,
    shellRoute: { kind: "none" },
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const FOREIGN: VexCloudWithdrawalNotice = {
  withdrawalId: "wd_foreign",
  amountWei: "6000000000000000000000",
  destination: "0x2222222222222222222222222222222222222222",
  releaseAt: "2026-10-18T00:30:00.000Z",
  cancellable: true,
  createdAt: "2026-10-17T12:30:00.000Z",
};

function signedIn(notices: VexCloudWithdrawalNotice[], complete = true): Result<VexCloudWithdrawalNoticesResult> {
  return { ok: true, data: { state: "signed_in", notices, complete, checkedAt: "2026-10-17T12:30:00.000Z" } };
}

function noticesFailed(): Result<VexCloudWithdrawalNoticesResult> {
  return {
    ok: false,
    error: {
      code: "internal.unexpected",
      domain: "vexCloud",
      message: "Vex Inference could not be reached.",
      retryable: true,
      userActionable: false,
      redacted: true,
      correlationId: "req-w",
    },
  };
}

describe("NeedsYouControl: the withdrawal check", () => {
  it("a failed withdrawal check over an empty inbox is '?' with Retry, never a clear; Retry re-reads both", () => {
    reads.pending = { data: { ok: true, data: [] } };
    reads.notices = { data: noticesFailed() };
    renderControl();
    expect(control().textContent).toBe("Needs you · ?");
    expect(screen.getByRole("status").textContent).toContain("Couldn't check for withdrawals you did not start");
    fireEvent.click(screen.getByRole("button", { name: "Retry checking what needs you" }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(mockRefetchNotices).toHaveBeenCalledTimes(1);
  });

  it("an incomplete scan is '?', never 'Nothing needs you'", () => {
    reads.pending = { data: { ok: true, data: [] } };
    reads.notices = { data: signedIn([], false) };
    renderControl();
    expect(control().textContent).toBe("Needs you · ?");
    expect(screen.getByRole("status").textContent).toContain("Couldn't check every withdrawal");
  });

  it("a notice shown once stays listed when the next read fails", () => {
    reads.pending = { data: { ok: true, data: [] } };
    reads.notices = { data: signedIn([FOREIGN]) };
    const view = renderControl();
    expect(control().textContent).toBe("Needs you · 1");
    reads.notices = { data: noticesFailed() };
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <NeedsYouControl />
      </QueryClientProvider>,
    );
    expect(control().textContent).toBe("Needs you · ?");
    const panel = openPanel();
    expect(within(panel).getByText("Check a withdrawal you did not start")).toBeTruthy();
  });

  it("signed out claims nothing: an empty inbox draws no control", () => {
    reads.pending = { data: { ok: true, data: [] } };
    const { container } = renderControl();
    expect(container.textContent).toBe("");
  });
});

describe("NeedsYouControl: the four states", () => {
  it("CHECKING: no control until the read answers", () => {
    const { container } = renderControl();
    expect(document.querySelector("[data-vex-area='needs-you-control']")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("NOTHING: a successful empty read draws no control, no 'Needs you · 0'", () => {
    reads.pending = { data: { ok: true, data: [] } };
    const { container } = renderControl();
    expect(document.querySelector("[data-vex-area='needs-you-control']")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("SOMETHING: the count, the target fill and the ink frame", () => {
    reads.pending = { data: { ok: true, data: [approval(), approval()] } };
    renderControl();
    expect(control().textContent).toBe("Needs you · 2");
    expect(swatchFill()).toBe("awaiting");
    expect(frame().hasAttribute("data-pending")).toBe(true);
  });

  it("FAILED: '?' with Retry, never a clear; Retry re-reads and decides nothing", () => {
    reads.pending = { data: failed() };
    renderControl();
    expect(control().textContent).toBe("Needs you · ?");
    expect(swatchFill()).toBe("concerned");
    expect(screen.getByRole("status").textContent).toContain(
      "Couldn't check for pending approvals",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry checking what needs you" }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(mockRefetchNotices).toHaveBeenCalledTimes(1);
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockReject).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("FAILED: Retry is disabled while the re-read is in flight", () => {
    reads.pending = { data: failed(), isFetching: true };
    renderControl();
    const retry = screen.getByRole("button", { name: "Checking again" });
    expect(retry.hasAttribute("disabled")).toBe(true);
  });

  it("a query error before any data is unknown, never 0", () => {
    reads.pending = { data: undefined, isError: true };
    renderControl();
    expect(control().textContent).toBe("Needs you · ?");
  });

  it("a failed refetch over an earlier EMPTY read is unknown, not 0", () => {
    reads.pending = { data: { ok: true, data: [] }, isError: true };
    renderControl();
    expect(control().textContent).toBe("Needs you · ?");
  });

  it("a failed refetch over an earlier non-empty read keeps the last known count", () => {
    reads.pending = { data: { ok: true, data: [approval()] }, isError: true };
    renderControl();
    expect(control().textContent).toBe("Needs you · 1");
  });

  it("collapses a count over 99 to '99+'", () => {
    expect(needsYouCountLabel("ready", 100)).toBe("99+");
    expect(needsYouCountLabel("ready", 99)).toBe("99");
    expect(needsYouCountLabel("unknown", null)).toBe("?");
    expect(needsYouCountLabel("loading", null)).toBeNull();
    reads.pending = {
      data: { ok: true, data: Array.from({ length: 100 }, () => approval()) },
    };
    renderControl();
    expect(control().textContent).toBe("Needs you · 99+");
  });

  it("counts a mission that needs a decision with the approvals", () => {
    reads.pending = { data: { ok: true, data: [approval()] } };
    reads.sessions = [
      session({ missionStatus: "paused_error" }),
      session({ missionStatus: "paused_user" }),
    ];
    renderControl();
    expect(control().textContent).toBe("Needs you · 2");
  });
});

describe("NeedsYouControl: the panel", () => {
  it("lists the items newest first under its count", () => {
    reads.pending = {
      data: {
        ok: true,
        data: [
          approval({ createdAt: "2026-10-17T10:00:00.000Z", sessionTitle: "Older chat" }),
          approval({ createdAt: "2026-10-17T11:00:00.000Z", sessionTitle: "Newer chat" }),
        ],
      },
    };
    renderControl();
    const panel = openPanel();
    expect(control().getAttribute("aria-expanded")).toBe("true");
    expect(panel.textContent).toContain("Needs you · 2");
    const rows = panel.querySelectorAll("[data-vex-needs-you-item]");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Newer chat");
    expect(rows[1]?.textContent).toContain("Older chat");
  });

  it("stays open saying 'Nothing needs you.' when the last item clears, then goes on close", () => {
    reads.pending = { data: { ok: true, data: [approval()] } };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (): JSX.Element => (
      <QueryClientProvider client={client}>
        <NeedsYouControl />
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    openPanel();
    reads.pending = { data: { ok: true, data: [] } };
    rerender(tree());
    expect(screen.getByRole("dialog", { name: "Needs you" }).textContent).toContain("Nothing needs you.");
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Needs you" }), { key: "Escape" });
    expect(document.querySelector("[data-vex-area='needs-you-control']")).toBeNull();
  });

  it("Escape closes it and returns focus to the control", () => {
    reads.pending = { data: { ok: true, data: [approval()] } };
    renderControl();
    const panel = openPanel();
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Needs you" })).toBeNull();
    expect(document.activeElement).toBe(control());
  });

  it("an outside press closes it", () => {
    reads.pending = { data: { ok: true, data: [approval()] } };
    renderControl();
    openPanel();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Needs you" })).toBeNull();
  });
});

describe("NeedsYouControl: Review opens, never decides", () => {
  it("opens the Needs you page on the approval's card, deciding nothing", () => {
    const row = approval({ riskLevel: "info", actionKind: "read" });
    reads.pending = { data: { ok: true, data: [row] } };
    renderControl();
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole("button", { name: /^Review:/ }));
    expect(screen.queryByRole("dialog", { name: "Needs you" })).toBeNull();
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "needsYou",
      origin: null,
      approvalId: row.id,
    });
    // No card dialog over the window any more: the page holds the card.
    expect(document.querySelector("[data-vex-area='global-approvals-panel']")).toBeNull();
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockReject).not.toHaveBeenCalled();
  });

  it("opens the page in place in Studio, without leaving Studio", () => {
    useUiStore.setState({ runtimeMode: "studio" });
    const row = approval({ riskLevel: "info", actionKind: "read" });
    reads.pending = { data: { ok: true, data: [row] } };
    renderControl();
    fireEvent.click(within(openPanel()).getByRole("button", { name: /^Review:/ }));
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "needsYou",
      origin: null,
      approvalId: row.id,
    });
    expect(useUiStore.getState().runtimeMode).toBe("studio");
  });

  it("points at the inline card when it is already on screen", () => {
    const row = approval();
    useUiStore.setState({ runtimeMode: "agent", activeSessionId: row.sessionId });
    reads.pending = { data: { ok: true, data: [row] } };
    const region = document.createElement("div");
    region.setAttribute("data-vex-area", "approvals-region");
    const card = document.createElement("div");
    card.setAttribute("data-approval-id", row.id);
    const reject = document.createElement("button");
    reject.setAttribute("autofocus", "");
    reject.textContent = "Reject";
    card.append(reject);
    region.append(card);
    document.body.append(region);

    renderControl();
    fireEvent.click(within(openPanel()).getByRole("button", { name: /^Review:/ }));
    // The card is right here: no page opens over it.
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
    expect(document.activeElement).toBe(reject);
  });

  it("opens the Needs you page when a page covers the inline card", () => {
    const row = approval({ riskLevel: "info", actionKind: "read" });
    useUiStore.setState({
      runtimeMode: "agent",
      activeSessionId: row.sessionId,
      shellRoute: { kind: "memory", origin: null },
    });
    reads.pending = { data: { ok: true, data: [row] } };
    renderControl();
    fireEvent.click(within(openPanel()).getByRole("button", { name: /^Review:/ }));
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "needsYou",
      origin: null,
      approvalId: row.id,
    });
  });

  it("opens a mission's session, in the agent shell, with no page over it", () => {
    const mission = session({ missionStatus: "paused_error" });
    useUiStore.setState({ runtimeMode: "studio", shellRoute: { kind: "memory", origin: null } });
    reads.pending = { data: { ok: true, data: [] } };
    reads.sessions = [mission];
    renderControl();
    fireEvent.click(within(openPanel()).getByRole("button", { name: /^Recover:/ }));
    const state = useUiStore.getState();
    expect(state.runtimeMode).toBe("agent");
    expect(state.activeSessionId).toBe(mission.id);
    expect(state.shellRoute).toEqual({ kind: "none" });
  });
});
