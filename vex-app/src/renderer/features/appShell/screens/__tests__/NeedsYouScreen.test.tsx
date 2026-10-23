/**
 * NeedsYouScreen: the Needs you page (docs/design/R3-MINIMAL.md section 8.5).
 * It lists the items of `useNeedsYou` grouped by where they were raised and
 * never decides anything by itself. Pins:
 *   - the page, its lead, and the faster 15s inbox poll it asks for;
 *   - the order (newest first), the open decision as the full card, every
 *     other decision as a row (Reject and "Review ..."), one head per group
 *     with its Open key;
 *   - `approvalId` opens THAT decision, Reject first in focus; a Review key
 *     opens another one (and folds the previous card) without deciding;
 *   - a high-risk rejection from a row takes two presses, a low-risk one
 *     takes one; approve lives on the open card only;
 *   - "Open session" and "Open project" navigate (Studio included) and close
 *     the route; a session-less row is a "Background approval" with no key;
 *   - missions that wait are rows with their own key;
 *   - empty, loading and failed reads each say their own words, and a failed
 *     read is never drawn as empty;
 *   - a decision that leaves the inbox leaves the page, and the next one
 *     becomes the open card.
 */

import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";
import type { Result } from "@shared/ipc/result.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { approval, session, testId } from "../../../vex/__tests__/fixtures.js";

const mockApprove = vi.fn();
const mockReject = vi.fn();
const mockRefetch = vi.fn(async () => undefined);
const refetchIntervals: Array<number | undefined> = [];

const reads = vi.hoisted(() => ({
  pending: { data: undefined } as {
    data: Result<ReadonlyArray<ApprovalPendingGlobalDto>> | undefined;
    isError?: boolean;
    isFetching?: boolean;
  },
  sessions: [] as SessionListItem[],
}));

vi.mock("../../../../lib/api/approvals.js", () => ({
  usePendingApprovalsAll: (opts?: { readonly refetchInterval?: number }) => {
    refetchIntervals.push(opts?.refetchInterval);
    return {
      isError: false,
      isFetching: false,
      refetch: mockRefetch,
      ...reads.pending,
    };
  },
  useGlobalApprovalsLiveSync: () => {},
  useApprove: () => ({ mutate: mockApprove, isPending: false }),
  useReject: () => ({ mutate: mockReject, isPending: false }),
}));
// Signed out: the withdrawal check claims nothing and blocks nothing here.
// One stable answer, as the query cache keeps its data's identity between renders.
const SIGNED_OUT = { ok: true, data: { state: "signed_out" } } as const;
const NOTICES_FAILED = { ok: false, error: { code: "internal.unexpected", message: "Vex Inference could not be reached." } } as const;
let noticesData: typeof SIGNED_OUT | typeof NOTICES_FAILED = SIGNED_OUT;
vi.mock("../../../../lib/api/vex-cloud.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/api/vex-cloud.js")>()),
  useVexCloudWithdrawalNotices: () => ({ data: noticesData, isError: false, isFetching: false, refetch: () => Promise.resolve() }),
}));
vi.mock("../../../../lib/api/sessions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../lib/api/sessions.js")>();
  return {
    ...original,
    useSessionsList: () => ({ data: { ok: true, data: reads.sessions } }),
  };
});

const { NeedsYouScreen } = await import("../NeedsYouScreen.js");
const { REVIEW_OPEN_POLL_MS } = await import("../../GlobalApprovals.js");
const { NEEDS_YOU_UNKNOWN_COPY, NEEDS_YOU_WITHDRAWALS_UNKNOWN_COPY } = await import("../../../vex/needs-you.js");
const { useUiStore } = await import("../../../../stores/uiStore.js");

const LEAD = "Review the details before approving an action. Nothing signs until you confirm.";
const EMPTY = "Nothing needs you.";

/** Low risk: the action key fires on one press. */
const LOW = { riskLevel: "info", actionKind: "read" } as const;

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

/** A wallet send: its action key reads "Approve transfer", its row key "Review transfer". */
function send(overrides: Partial<ApprovalPendingGlobalDto> = {}): ApprovalPendingGlobalDto {
  return approval({ toolName: "wallet:send", ...overrides });
}

interface Pair {
  readonly older: ApprovalPendingGlobalDto;
  readonly newer: ApprovalPendingGlobalDto;
}

/** Two approvals in two sessions, the newer one raised an hour later. */
function pair(overrides: Partial<ApprovalPendingGlobalDto> = {}): Pair {
  return {
    older: send({
      id: "appr-older",
      createdAt: "2026-10-17T10:00:00.000Z",
      sessionId: testId(),
      sessionTitle: "Older chat",
      ...overrides,
    }),
    newer: send({
      id: "appr-newer",
      createdAt: "2026-10-17T11:00:00.000Z",
      sessionId: testId(),
      sessionTitle: "Newer chat",
      ...overrides,
    }),
  };
}

function listed(...rows: ApprovalPendingGlobalDto[]): void {
  reads.pending = { data: { ok: true, data: rows } };
}

let client: QueryClient;

function tree(approvalId: string | null, onClose: () => void): ReactElement {
  return (
    <QueryClientProvider client={client}>
      <NeedsYouScreen origin={null} approvalId={approvalId} onClose={onClose} />
    </QueryClientProvider>
  );
}

interface Page {
  /** Render again with the current reads (and, optionally, another `approvalId`). */
  readonly again: (approvalId?: string | null) => void;
}

function renderPage(
  approvalId: string | null = null,
  onClose: () => void = () => undefined,
): Page {
  const view = render(tree(approvalId, onClose));
  return {
    again: (next = approvalId) => {
      view.rerender(tree(next, onClose));
    },
  };
}

function pageEl(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-vex-area='needs-you-page']");
  if (el === null) throw new Error("page missing");
  return el;
}

function cardOf(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-vex-area='needs-you-page'] [data-approval-id='${id}']`,
  );
  if (el === null) throw new Error(`no decision ${id} on the page`);
  return el;
}

function onPage(id: string): boolean {
  return document.querySelector(`[data-approval-id='${id}']`) !== null;
}

function layoutOf(id: string): string | null {
  return cardOf(id).getAttribute("data-vex-approval-layout");
}

function idsIn(layout: "card" | "row"): Array<string | null> {
  return Array.from(
    pageEl().querySelectorAll<HTMLElement>(`[data-vex-approval-layout='${layout}']`),
  ).map((el) => el.getAttribute("data-approval-id"));
}

function rejectOf(id: string): HTMLElement {
  return within(cardOf(id)).getByRole("button", { name: "Reject" });
}

function heads(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-vex-area='needs-you-group-head']"),
  );
}

function headAt(index: number): HTMLElement {
  const el = heads()[index];
  if (el === undefined) throw new Error(`group head ${String(index)} missing`);
  return el;
}

/** The page's group sections, each with the decisions it holds, in reading order. */
function groups(): Array<Array<string | null>> {
  return Array.from(pageEl().querySelectorAll<HTMLElement>(":scope > section[aria-label]")).map(
    (section) =>
      Array.from(section.querySelectorAll<HTMLElement>("[data-approval-id]")).map((el) =>
        el.getAttribute("data-approval-id"),
      ),
  );
}

/** Let the page's own `requestAnimationFrame` (the focus move) run. */
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

function resetStore(): void {
  useUiStore.setState({
    runtimeMode: "agent",
    activeSessionId: null,
    activeProjectId: null,
    shellRoute: { kind: "needsYou", origin: null, approvalId: null },
  });
}

beforeEach(() => {
  mockApprove.mockReset();
  mockReject.mockReset();
  mockRefetch.mockClear();
  refetchIntervals.length = 0;
  reads.pending = { data: undefined };
  reads.sessions = [];
  noticesData = SIGNED_OUT;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  resetStore();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  useUiStore.setState({
    runtimeMode: "agent",
    activeSessionId: null,
    activeProjectId: null,
    shellRoute: { kind: "none" },
  });
});

describe("NeedsYouScreen: the page", () => {
  it("draws the page with its lead inside the Needs you sheet", () => {
    listed(send());
    renderPage();
    expect(screen.getByRole("dialog", { name: "Needs you" })).not.toBeNull();
    expect(pageEl().getAttribute("data-state")).toBe("ready");
    expect(within(pageEl()).getByText(LEAD)).not.toBeNull();
  });

  it("asks the inbox for the faster 15s net while it is open", () => {
    listed(send());
    renderPage();
    expect(REVIEW_OPEN_POLL_MS).toBe(15_000);
    expect(refetchIntervals).toContain(15_000);
  });

  it("lists the newest decision first: the open full card, then the others as rows", () => {
    const { older, newer } = pair();
    // The read hands them over oldest first; the page sorts.
    listed(older, newer);
    renderPage();

    expect(idsIn("card")).toEqual([newer.id]);
    expect(idsIn("row")).toEqual([older.id]);

    const card = cardOf(newer.id);
    expect(within(card).getByRole("button", { name: "Reject" })).not.toBeNull();
    expect(within(card).getByRole("button", { name: "Approve transfer" })).not.toBeNull();

    const row = cardOf(older.id);
    expect(within(row).getByRole("button", { name: "Reject" })).not.toBeNull();
    expect(within(row).getByRole("button", { name: "Review transfer" })).not.toBeNull();
    expect(within(row).queryByRole("button", { name: "Approve transfer" })).toBeNull();
  });

  it("gives each group a head with the session title and its Open session key", () => {
    const { older, newer } = pair();
    listed(older, newer);
    renderPage();

    expect(heads()).toHaveLength(2);
    expect(headAt(0).textContent).toContain("Newer chat");
    expect(headAt(1).textContent).toContain("Older chat");
    for (const head of heads()) {
      expect(within(head).getByRole("button", { name: "Open session" })).not.toBeNull();
    }
  });

  it("mounts the open card as the real-funds card with a page-unique title id", () => {
    const { older, newer } = pair();
    listed(older, newer);
    renderPage();

    const card = cardOf(newer.id);
    expect(card.hasAttribute("data-vex-real-funds")).toBe(true);
    // The same approval can render inline in the session under the page: its
    // title id carries the "global" variant so aria-labelledby stays unique.
    const titleId = `approval-card-${newer.id}-global-title`;
    expect(card.getAttribute("aria-labelledby")).toBe(titleId);
    expect(document.getElementById(titleId)).not.toBeNull();
    expect(cardOf(older.id).hasAttribute("data-vex-real-funds")).toBe(false);
  });

  it("keeps the decisions of one session under one head, newest first", () => {
    const shared = testId();
    const earlier = send({
      id: "appr-earlier",
      sessionId: shared,
      sessionTitle: "Shared chat",
      createdAt: "2026-10-17T09:00:00.000Z",
    });
    const later = send({
      id: "appr-later",
      sessionId: shared,
      sessionTitle: "Shared chat",
      createdAt: "2026-10-17T11:00:00.000Z",
    });
    listed(earlier, later);
    renderPage();

    expect(heads()).toHaveLength(1);
    expect(groups()).toEqual([["appr-later", "appr-earlier"]]);
    expect(idsIn("card")).toEqual(["appr-later"]);
    expect(idsIn("row")).toEqual(["appr-earlier"]);
  });

  it("orders groups by where each first appears and keeps a group's rows together", () => {
    const sessionX = testId();
    const sessionY = testId();
    const x1 = send({
      id: "appr-x1",
      sessionId: sessionX,
      sessionTitle: "Chat X",
      createdAt: "2026-10-17T11:00:00.000Z",
    });
    const y1 = send({
      id: "appr-y1",
      sessionId: sessionY,
      sessionTitle: "Chat Y",
      createdAt: "2026-10-17T10:00:00.000Z",
    });
    const x2 = send({
      id: "appr-x2",
      sessionId: sessionX,
      sessionTitle: "Chat X",
      createdAt: "2026-10-17T09:00:00.000Z",
    });
    listed(x2, y1, x1);
    renderPage();

    expect(groups()).toEqual([["appr-x1", "appr-x2"], ["appr-y1"]]);
    expect(headAt(0).textContent).toContain("Chat X");
    expect(headAt(1).textContent).toContain("Chat Y");
    // The first decision in reading order is the open one.
    expect(idsIn("card")).toEqual(["appr-x1"]);
  });
});

describe("NeedsYouScreen: which decision is open", () => {
  it("opens the decision approvalId names as the card, with Reject in focus", () => {
    const { older, newer } = pair();
    listed(older, newer);
    renderPage(older.id);

    expect(layoutOf(older.id)).toBe("card");
    expect(layoutOf(newer.id)).toBe("row");
    expect(idsIn("card")).toEqual([older.id]);
    // The safer choice first, on mount.
    expect(document.activeElement).toBe(rejectOf(older.id));
  });

  it("opens the first decision, Reject in focus, when no approvalId is given", () => {
    const { older, newer } = pair();
    listed(older, newer);
    renderPage(null);

    expect(layoutOf(newer.id)).toBe("card");
    expect(layoutOf(older.id)).toBe("row");
    expect(document.activeElement).toBe(rejectOf(newer.id));
  });

  it("falls back to the first decision when approvalId is not in the inbox", () => {
    const { older, newer } = pair();
    listed(older, newer);
    renderPage("appr-gone");

    expect(idsIn("card")).toEqual([newer.id]);
    expect(idsIn("row")).toEqual([older.id]);
  });

  it("a new approvalId while the page is open replaces the open decision", async () => {
    const { older, newer } = pair();
    listed(older, newer);
    const page = renderPage(null);
    expect(idsIn("card")).toEqual([newer.id]);

    page.again(older.id);
    expect(idsIn("card")).toEqual([older.id]);
    expect(layoutOf(newer.id)).toBe("row");
    await nextFrame();
    expect(document.activeElement).toBe(rejectOf(older.id));
  });

  it("an inbox that answers after the first paint lands focus on the open card's Reject", async () => {
    const { older, newer } = pair();
    reads.pending = { data: undefined };
    const page = renderPage(null);
    expect(document.querySelector("[data-approval-id]")).toBeNull();

    listed(older, newer);
    page.again();
    expect(idsIn("card")).toEqual([newer.id]);
    await nextFrame();
    expect(document.activeElement).toBe(rejectOf(newer.id));
  });

  it("a row's Review key opens it as the card, folds the previous card, and decides nothing", async () => {
    const { older, newer } = pair(LOW);
    listed(older, newer);
    renderPage();
    expect(idsIn("card")).toEqual([newer.id]);

    fireEvent.click(within(cardOf(older.id)).getByRole("button", { name: "Review transfer" }));

    expect(idsIn("card")).toEqual([older.id]);
    expect(idsIn("row")).toEqual([newer.id]);
    expect(within(cardOf(older.id)).getByRole("button", { name: "Approve transfer" })).not.toBeNull();
    expect(within(cardOf(newer.id)).queryByRole("button", { name: "Approve transfer" })).toBeNull();
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockReject).not.toHaveBeenCalled();

    // The newly opened card takes the focus on its Reject once it has painted.
    await nextFrame();
    expect(document.activeElement).toBe(rejectOf(older.id));
  });

  it("keeps the opened decision when the inbox is read again", () => {
    const { older, newer } = pair();
    listed(older, newer);
    const page = renderPage();
    fireEvent.click(within(cardOf(older.id)).getByRole("button", { name: "Review transfer" }));
    expect(idsIn("card")).toEqual([older.id]);

    // A refetch hands over the same rows as new objects.
    listed({ ...older }, { ...newer });
    page.again();
    expect(idsIn("card")).toEqual([older.id]);
    expect(idsIn("row")).toEqual([newer.id]);
  });
});

describe("NeedsYouScreen: deciding", () => {
  it("a high-risk rejection from a row takes two presses before it fires", () => {
    const { older, newer } = pair();
    listed(older, newer);
    renderPage();
    const row = cardOf(older.id);

    fireEvent.click(within(row).getByRole("button", { name: "Reject" }));
    const armed = within(row).getByRole("button", { name: "Confirm reject" });
    expect(armed.textContent).toBe("Click again to confirm reject");
    expect(mockReject).not.toHaveBeenCalled();
    // The row stays a row and the open card is untouched.
    expect(layoutOf(older.id)).toBe("row");
    expect(within(cardOf(newer.id)).getByRole("button", { name: "Reject" })).not.toBeNull();

    fireEvent.click(armed);
    expect(mockReject).toHaveBeenCalledTimes(1);
    expect(mockReject).toHaveBeenCalledWith({ id: older.id }, expect.any(Object));
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it("a low-risk rejection from a row fires on one press", () => {
    const { older, newer } = pair(LOW);
    listed(older, newer);
    renderPage();

    fireEvent.click(within(cardOf(older.id)).getByRole("button", { name: "Reject" }));
    expect(mockReject).toHaveBeenCalledTimes(1);
    expect(mockReject).toHaveBeenCalledWith({ id: older.id }, expect.any(Object));
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it("rejecting from the open card is the same call with the card's id", () => {
    const { older, newer } = pair(LOW);
    listed(older, newer);
    renderPage();

    fireEvent.click(rejectOf(newer.id));
    expect(mockReject).toHaveBeenCalledTimes(1);
    expect(mockReject).toHaveBeenCalledWith({ id: newer.id }, expect.any(Object));
  });

  it("approve on the open card fires with the id on one click when the risk is low", () => {
    const { older, newer } = pair(LOW);
    listed(older, newer);
    renderPage();

    fireEvent.click(within(cardOf(newer.id)).getByRole("button", { name: "Approve transfer" }));
    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(mockApprove).toHaveBeenCalledWith({ id: newer.id }, expect.any(Object));
    expect(mockReject).not.toHaveBeenCalled();
  });

  it("approve on a high-risk card needs a second press", () => {
    const { older, newer } = pair();
    listed(older, newer);
    renderPage();
    const card = cardOf(newer.id);

    fireEvent.click(within(card).getByRole("button", { name: "Approve transfer" }));
    const armed = within(card).getByRole("button", { name: "Confirm approve" });
    // The key holds its idle and working words in one grid cell, so the text
    // carries both; the armed words are the ones shown.
    expect(armed.textContent).toContain("Click again to confirm approve");
    expect(mockApprove).not.toHaveBeenCalled();

    fireEvent.click(armed);
    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(mockApprove).toHaveBeenCalledWith({ id: newer.id }, expect.any(Object));
  });

  it("nothing on the page approves or rejects by itself", async () => {
    const { older, newer } = pair(LOW);
    listed(older, newer);
    const page = renderPage();
    await nextFrame();
    // Opening another decision, reading again and arming nothing: no decision.
    fireEvent.click(within(cardOf(older.id)).getByRole("button", { name: "Review transfer" }));
    await nextFrame();
    page.again();
    await nextFrame();

    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockReject).not.toHaveBeenCalled();
    // A row has no approve key at all: only the open card can approve.
    expect(within(cardOf(newer.id)).queryByRole("button", { name: /^Approve/ })).toBeNull();
  });
});

describe("NeedsYouScreen: Open session", () => {
  it("moves to the agent mode with that session selected and the route closed", () => {
    const { older, newer } = pair();
    listed(older, newer);
    renderPage();

    fireEvent.click(within(headAt(0)).getByRole("button", { name: "Open session" }));
    const state = useUiStore.getState();
    expect(state.runtimeMode).toBe("agent");
    expect(state.activeSessionId).toBe(newer.sessionId);
    expect(state.shellRoute).toEqual({ kind: "none" });
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockReject).not.toHaveBeenCalled();
  });

  it("opens the session of the group whose head it sits on", () => {
    const { older, newer } = pair();
    listed(older, newer);
    renderPage();

    fireEvent.click(within(headAt(1)).getByRole("button", { name: "Open session" }));
    expect(useUiStore.getState().activeSessionId).toBe(older.sessionId);
  });

  it("from Studio switches to the agent shell with the selection", () => {
    useUiStore.setState({ runtimeMode: "studio" });
    const { older, newer } = pair();
    listed(older, newer);
    renderPage();

    fireEvent.click(within(headAt(0)).getByRole("button", { name: "Open session" }));
    const state = useUiStore.getState();
    expect(state.runtimeMode).toBe("agent");
    expect(state.activeSessionId).toBe(newer.sessionId);
    expect(state.shellRoute).toEqual({ kind: "none" });
  });
});

describe("NeedsYouScreen: Studio projects and background approvals", () => {
  const STUDIO = {
    id: "appr-studio",
    sessionId: null,
    sessionTitle: null,
    origin: "studio_mcp",
    projectName: "Acme Trading",
  } as const;

  it("groups a Studio approval under its project, the name carrying the id", () => {
    const projectId = testId();
    listed(send({ ...STUDIO, projectId }));
    renderPage();

    const tag = within(headAt(0)).getByText("Acme Trading");
    expect(tag.getAttribute("data-vex-area")).toBe("approval-project-tag");
    expect(tag.getAttribute("title")).toContain(projectId);
    expect(tag.getAttribute("title")).toContain("Acme Trading");
    expect(headAt(0).textContent).toContain("Vex Studio project");
    expect(within(headAt(0)).queryByRole("button", { name: "Open session" })).toBeNull();
  });

  it("reads the id when the project has no name", () => {
    const projectId = testId();
    listed(send({ ...STUDIO, projectId, projectName: null }));
    renderPage();

    const tag = headAt(0).querySelector("[data-vex-area='approval-project-tag']");
    expect(tag?.textContent).toBe(projectId);
  });

  it("its key reads Open project and switches to Studio with the project set", () => {
    const projectId = testId();
    listed(send({ ...STUDIO, projectId }));
    renderPage();

    fireEvent.click(within(headAt(0)).getByRole("button", { name: "Open project" }));
    const state = useUiStore.getState();
    expect(state.runtimeMode).toBe("studio");
    expect(state.activeProjectId).toBe(projectId);
    expect(state.shellRoute).toEqual({ kind: "none" });
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockReject).not.toHaveBeenCalled();
  });

  it("a session-less row with no project reads Background approval and offers no Open key", () => {
    listed(send({ id: "appr-background", sessionId: null, sessionTitle: null, projectId: null }));
    renderPage();

    expect(headAt(0).textContent).toContain("Background approval");
    expect(within(headAt(0)).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
    // It is still a decision: the card is there to approve or reject.
    expect(layoutOf("appr-background")).toBe("card");
    expect(rejectOf("appr-background")).not.toBeNull();
  });

  it("session-less rows share one Background approval head", () => {
    listed(
      send({
        id: "appr-bg-1",
        sessionId: null,
        sessionTitle: null,
        createdAt: "2026-10-17T11:00:00.000Z",
      }),
      send({
        id: "appr-bg-2",
        sessionId: null,
        sessionTitle: null,
        createdAt: "2026-10-17T10:00:00.000Z",
      }),
    );
    renderPage();

    expect(heads()).toHaveLength(1);
    expect(groups()).toEqual([["appr-bg-1", "appr-bg-2"]]);
  });
});

describe("NeedsYouScreen: missions that wait", () => {
  it("lists a paused_error mission as a Recover the mission row whose key opens its session", () => {
    const mission = session({ missionStatus: "paused_error", title: "Paused mission" });
    useUiStore.setState({ runtimeMode: "studio" });
    listed();
    reads.sessions = [mission];
    renderPage();

    const row = pageEl().querySelector<HTMLElement>("[data-vex-needs-you-item='recover']");
    if (row === null) throw new Error("mission row missing");
    expect(row.textContent).toContain("Recover the mission");
    expect(row.textContent).toContain("paused on an error");
    expect(headAt(0).textContent).toContain("Paused mission");

    const key = within(row).getByRole("button", { name: "Recover: Recover the mission" });
    expect(key.textContent).toBe("Recover");
    fireEvent.click(key);
    const state = useUiStore.getState();
    expect(state.runtimeMode).toBe("agent");
    expect(state.activeSessionId).toBe(mission.id);
    expect(state.shellRoute).toEqual({ kind: "none" });
  });

  it("names the contract and the form with their own keys", () => {
    listed();
    reads.sessions = [
      session({ missionStatus: "paused_plan_acceptance", title: "Contract mission" }),
      session({ missionStatus: "paused_user_form", title: "Form mission" }),
    ];
    renderPage();

    const contract = pageEl().querySelector<HTMLElement>("[data-vex-needs-you-item='contract']");
    const form = pageEl().querySelector<HTMLElement>("[data-vex-needs-you-item='form']");
    if (contract === null || form === null) throw new Error("mission rows missing");
    expect(contract.textContent).toContain("Accept the contract");
    expect(
      within(contract).getByRole("button", { name: "Review: Accept the contract" }).textContent,
    ).toBe("Review");
    expect(form.textContent).toContain("Fill in the form");
    expect(within(form).getByRole("button", { name: "Open: Fill in the form" }).textContent).toBe(
      "Open",
    );
  });

  it("never lists a user pause or a wake sleep", () => {
    listed();
    reads.sessions = [
      session({ missionStatus: "paused_user" }),
      session({ missionStatus: "paused_wake" }),
      session({ missionStatus: "running" }),
    ];
    renderPage();

    expect(pageEl().querySelector("[data-vex-needs-you-item]")).toBeNull();
    expect(screen.getByText(EMPTY)).not.toBeNull();
  });

  it("joins a mission to the group of an approval raised in the same session", () => {
    const shared = testId();
    listed(send({ id: "appr-shared", sessionId: shared, sessionTitle: "Treasury chat" }));
    reads.sessions = [
      session({ id: shared, missionStatus: "paused_error", title: "Treasury chat" }),
    ];
    renderPage();

    expect(heads()).toHaveLength(1);
    const section = headAt(0).closest("section");
    if (section === null) throw new Error("group section missing");
    expect(section.querySelector("[data-approval-id='appr-shared']")).not.toBeNull();
    expect(section.querySelector("[data-vex-needs-you-item='recover']")).not.toBeNull();
  });

  it("opening a mission never decides an approval", () => {
    const mission = session({ missionStatus: "paused_error" });
    listed(send({ id: "appr-other", sessionTitle: "Other chat" }));
    reads.sessions = [mission];
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Recover: Recover the mission" }));
    expect(useUiStore.getState().activeSessionId).toBe(mission.id);
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockReject).not.toHaveBeenCalled();
  });
});

describe("NeedsYouScreen: empty, checking and failed reads", () => {
  it("says Nothing needs you. after an empty read, with no Retry", () => {
    listed();
    renderPage();

    expect(screen.getByText(EMPTY)).not.toBeNull();
    expect(pageEl().getAttribute("data-state")).toBe("ready");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(document.querySelector("[data-approval-id]")).toBeNull();
    expect(heads()).toHaveLength(0);
  });

  it("says it is checking before the first read, and never claims nothing needs you", () => {
    reads.pending = { data: undefined };
    renderPage();

    expect(pageEl().getAttribute("data-state")).toBe("loading");
    expect(screen.getByText("Checking for pending approvals")).not.toBeNull();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it("a failed read says it could not check, with Retry that reads again, never as empty", () => {
    reads.pending = { data: failed() };
    renderPage();

    expect(pageEl().getAttribute("data-state")).toBe("unknown");
    expect(screen.getByText(NEEDS_YOU_UNKNOWN_COPY)).not.toBeNull();
    expect(screen.queryByText(EMPTY)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockReject).not.toHaveBeenCalled();
  });

  it("says Checking again and offers no key to press twice while the re-read is in flight", () => {
    reads.pending = { data: failed(), isFetching: true };
    renderPage();

    expect(screen.getByText("Checking again")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByText(NEEDS_YOU_UNKNOWN_COPY)).not.toBeNull();
  });

  it("a failed refetch over an earlier empty read is unknown, not empty", () => {
    reads.pending = { data: { ok: true, data: [] }, isError: true };
    renderPage();

    expect(screen.getByText(NEEDS_YOU_UNKNOWN_COPY)).not.toBeNull();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it("a failed withdrawal check over an empty inbox says that check failed, never empty", () => {
    reads.pending = { data: { ok: true, data: [] } };
    noticesData = NOTICES_FAILED;
    renderPage();

    expect(pageEl().getAttribute("data-state")).toBe("unknown");
    expect(screen.getByText(NEEDS_YOU_WITHDRAWALS_UNKNOWN_COPY)).not.toBeNull();
    expect(screen.queryByText(NEEDS_YOU_UNKNOWN_COPY)).toBeNull();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it("a query error before any data is unknown, not empty", () => {
    reads.pending = { data: undefined, isError: true };
    renderPage();

    expect(screen.getByText(NEEDS_YOU_UNKNOWN_COPY)).not.toBeNull();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it("a failed refetch over earlier rows keeps them and says nothing is unknown", () => {
    const { older, newer } = pair();
    reads.pending = { data: { ok: true, data: [older, newer] }, isError: true };
    renderPage();

    expect(pageEl().getAttribute("data-state")).toBe("ready");
    expect(idsIn("card")).toEqual([newer.id]);
    expect(screen.queryByText(NEEDS_YOU_UNKNOWN_COPY)).toBeNull();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it("a failed read still lists the missions that wait, beside the could-not-check copy", () => {
    reads.pending = { data: failed() };
    reads.sessions = [session({ missionStatus: "paused_error", title: "Paused mission" })];
    renderPage();

    expect(screen.getByText(NEEDS_YOU_UNKNOWN_COPY)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Recover: Recover the mission" })).not.toBeNull();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });
});

describe("NeedsYouScreen: a decision leaves the inbox", () => {
  it("the open card leaves the page and the next decision becomes the open card", async () => {
    const { older, newer } = pair();
    listed(older, newer);
    const page = renderPage();
    expect(idsIn("card")).toEqual([newer.id]);

    listed(older);
    page.again();

    expect(onPage(newer.id)).toBe(false);
    expect(idsIn("card")).toEqual([older.id]);
    expect(idsIn("row")).toEqual([]);
    expect(heads()).toHaveLength(1);
    // The next decision's Reject takes the focus once it has painted.
    await nextFrame();
    expect(document.activeElement).toBe(rejectOf(older.id));
  });

  it("a row that leaves goes alone, and the open card stays open", () => {
    const { older, newer } = pair();
    listed(older, newer);
    const page = renderPage();

    listed(newer);
    page.again();

    expect(onPage(older.id)).toBe(false);
    expect(idsIn("card")).toEqual([newer.id]);
    expect(heads()).toHaveLength(1);
    expect(headAt(0).textContent).toContain("Newer chat");
  });

  it("when the decision the user opened leaves, the first of the rest opens", () => {
    const newest = send({
      id: "appr-1",
      sessionId: testId(),
      sessionTitle: "Chat one",
      createdAt: "2026-10-17T12:00:00.000Z",
    });
    const middle = send({
      id: "appr-2",
      sessionId: testId(),
      sessionTitle: "Chat two",
      createdAt: "2026-10-17T11:00:00.000Z",
    });
    const oldest = send({
      id: "appr-3",
      sessionId: testId(),
      sessionTitle: "Chat three",
      createdAt: "2026-10-17T10:00:00.000Z",
    });
    listed(newest, middle, oldest);
    const page = renderPage(oldest.id);
    expect(idsIn("card")).toEqual([oldest.id]);

    listed(newest, middle);
    page.again();

    expect(onPage(oldest.id)).toBe(false);
    expect(idsIn("card")).toEqual([newest.id]);
    expect(idsIn("row")).toEqual([middle.id]);
  });

  it("the last decision leaves and the page says Nothing needs you.", () => {
    listed(send({ id: "appr-last" }));
    const page = renderPage();
    expect(onPage("appr-last")).toBe(true);

    listed();
    page.again();

    expect(onPage("appr-last")).toBe(false);
    expect(heads()).toHaveLength(0);
    expect(screen.getByText(EMPTY)).not.toBeNull();
  });
});

describe("NeedsYouScreen: closing", () => {
  it("draws no close key of its own: the title bar carries it, and an open page decides nothing", () => {
    // R3 (W3-5): pages draw no crumb or close row; the title bar's
    // "Close Needs you" (RunningHead.test.tsx, "the page close key") and
    // Escape (below) are the ways out.
    const onClose = vi.fn();
    listed(send());
    renderPage(null, onClose);

    expect(screen.queryByRole("button", { name: "Close Needs you" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockReject).not.toHaveBeenCalled();
  });

  it("Escape closes the page without deciding", () => {
    const onClose = vi.fn();
    listed(send());
    renderPage(null, onClose);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockReject).not.toHaveBeenCalled();
  });
});
