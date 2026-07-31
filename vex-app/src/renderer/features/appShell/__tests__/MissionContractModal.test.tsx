/**
 * MissionContractModal — the relocated contract review/accept surface.
 *
 * These tests pin the wiring that MUST survive the move out of the inline card:
 *   - Accept dispatches `mission.acceptContract` with the rendered `currentHash`.
 *   - The unified accept echoes the reviewed plan's `updatedAt` as
 *     `planUpdatedAt` when (and only when) an enabled+unaccepted plan exists.
 *   - `plan_stale` / `plan_missing` notices surface in the footer.
 *   - The Accept action lives in the (always-pinned) dialog footer.
 *
 * Setup mirrors `MissionContractCard.test.tsx`: real QueryClient + a window.vex
 * bridge. The native <dialog> is polyfilled (jsdom has no showModal/close).
 *
 * VexIcon is mocked to render nothing so the PremiumBadge header marker
 * (and CardBody/AutoRetry icons) don't pull the ESM icon lib.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

vi.mock("../../../components/icons/VexIcon.js", () => ({
  VexIcon: () => null,
}));

const { MissionContractModal } = await import("../MissionContractModal.js");

const SESSION = "00000000-0000-4000-8000-00000000cccc";
const MISSION = "mission-1";
const HASH = "a".repeat(64);
const PLAN_UPDATED_AT = "2026-05-22T09:15:00.000Z";

const mockBridge = {
  getDraft: vi.fn(),
  getDiff: vi.fn(),
  acceptContract: vi.fn(),
  setAutoRetry: vi.fn(),
};
const mockPlanGet = vi.fn();

const SAMPLE_DRAFT = {
  missionId: MISSION,
  sessionId: SESSION,
  status: "ready" as const,
  title: "Rebalance LP",
  goal: "Move USDC into a tighter range.",
  constraints: { maxSpendUsd: 100 },
  successCriteria: ["TVL up 5%"],
  stopConditions: ["TVL down 10%"],
  riskProfile: "balanced",
  allowedChains: ["ethereum"],
  allowedProtocols: ["uniswap"],
  allowedWallets: ["w1"],
  createdAt: "2026-05-22T08:00:00.000Z",
  updatedAt: "2026-05-22T09:00:00.000Z",
  approvedAt: null,
  acceptance: null,
  renewedFromMissionId: null,
};

const READY_DIFF = {
  outcome: "ready" as const,
  missionId: MISSION,
  sessionId: SESSION,
  currentHash: HASH,
  contractHashVersion: 1,
  acceptedHash: null,
  acceptedAt: null,
  acceptedBy: null,
  acceptedContractHashVersion: null,
  isAccepted: false,
  isDirty: false,
};

const ENABLED_UNACCEPTED_PLAN = {
  enabled: true,
  planMd: "# Action plan\n1. Objective",
  accepted: false,
  acceptedAt: null,
  updatedAt: PLAN_UPDATED_AT,
};

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as {
    showModal?: () => void;
    close?: () => void;
  };
  if (typeof proto.showModal !== "function") {
    proto.showModal = function (this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    };
  }
  if (typeof proto.close !== "function") {
    proto.close = function (this: HTMLDialogElement): void {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPlanGet.mockResolvedValue({ ok: true, data: null });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      mission: mockBridge,
      sessions: { plan: { get: mockPlanGet } },
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "vex");
});

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function Wrapper(client: QueryClient) {
  return function ({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function renderModal(onOpenChange: (next: boolean) => void = () => {}): void {
  render(
    <MissionContractModal
      sessionId={SESSION}
      permission="full"
      open
      onOpenChange={onOpenChange}
    />,
    { wrapper: Wrapper(makeClient()) },
  );
}

describe("MissionContractModal", () => {
  it("renders the contract body + a pinned Accept action when ready", async () => {
    mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
    mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
    renderModal();
    const accept = await screen.findByRole("button", {
      name: /^Accept contract$/i,
    });
    expect((accept as HTMLButtonElement).disabled).toBe(false);
    // Body rendered the goal.
    expect(screen.queryByText(/tighter range/i)).not.toBeNull();
  });

  it("Accept posts the rendered currentHash (round-trip safety)", async () => {
    mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
    mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
    mockBridge.acceptContract.mockResolvedValue({
      ok: true,
      data: { outcome: "accepted" },
    });
    renderModal();
    fireEvent.click(
      await screen.findByRole("button", { name: /^Accept contract$/i }),
    );
    await waitFor(() => {
      expect(mockBridge.acceptContract).toHaveBeenCalledWith({
        sessionId: SESSION,
        missionId: MISSION,
        contractHash: HASH,
      });
    });
  });

  it("closes the modal on a successful accept (Start mission is behind it)", async () => {
    mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
    mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
    mockBridge.acceptContract.mockResolvedValue({
      ok: true,
      data: { outcome: "accepted" },
    });
    const onOpenChange = vi.fn();
    renderModal(onOpenChange);
    fireEvent.click(
      await screen.findByRole("button", { name: /^Accept contract$/i }),
    );
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("keeps the modal open on a non-accepted outcome (notice needs the surface)", async () => {
    mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
    mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
    mockBridge.acceptContract.mockResolvedValue({
      ok: true,
      data: { outcome: "hash_mismatch", providedHash: "a", currentHash: "b" },
    });
    const onOpenChange = vi.fn();
    renderModal(onOpenChange);
    fireEvent.click(
      await screen.findByRole("button", { name: /^Accept contract$/i }),
    );
    await waitFor(() => {
      expect(
        screen.queryByText(/changed since you reviewed/i),
      ).not.toBeNull();
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("unified accept echoes the reviewed plan's updatedAt as planUpdatedAt", async () => {
    mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
    mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
    mockPlanGet.mockResolvedValue({ ok: true, data: ENABLED_UNACCEPTED_PLAN });
    mockBridge.acceptContract.mockResolvedValue({
      ok: true,
      data: { outcome: "accepted" },
    });
    renderModal();
    fireEvent.click(
      await screen.findByRole("button", { name: /Accept contract & plan/i }),
    );
    await waitFor(() => {
      expect(mockBridge.acceptContract).toHaveBeenCalledWith({
        sessionId: SESSION,
        missionId: MISSION,
        contractHash: HASH,
        planUpdatedAt: PLAN_UPDATED_AT,
      });
    });
  });

  it("does NOT send planUpdatedAt when plan-mode is off (no plan content crosses)", async () => {
    mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
    mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
    mockPlanGet.mockResolvedValue({ ok: true, data: null });
    mockBridge.acceptContract.mockResolvedValue({
      ok: true,
      data: { outcome: "accepted" },
    });
    renderModal();
    fireEvent.click(
      await screen.findByRole("button", { name: /^Accept contract$/i }),
    );
    await waitFor(() => {
      expect(mockBridge.acceptContract).toHaveBeenCalledWith({
        sessionId: SESSION,
        missionId: MISSION,
        contractHash: HASH,
      });
    });
    const payload = mockBridge.acceptContract.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect("planUpdatedAt" in payload).toBe(false);
    // Crucially, no plan markdown ever appears in the payload.
    expect("planMd" in payload).toBe(false);
  });

  it("surfaces an in-modal banner on plan_stale and refetches the plan ONCE (no loop)", async () => {
    mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
    mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
    mockPlanGet.mockResolvedValue({ ok: true, data: ENABLED_UNACCEPTED_PLAN });
    mockBridge.acceptContract.mockResolvedValue({
      ok: true,
      data: { outcome: "plan_stale" },
    });
    renderModal();
    const accept = await screen.findByRole("button", {
      name: /Accept contract & plan/i,
    });
    // Let the initial mount fetch settle so the baseline is stable before the
    // stale event (otherwise we'd race the mount fetch).
    await waitFor(() => {
      expect(mockPlanGet.mock.calls.length).toBeGreaterThan(0);
    });
    const callsBeforeAccept = mockPlanGet.mock.calls.length;
    fireEvent.click(accept);
    await waitFor(() => {
      expect(screen.queryByText(/Plan changed — review again/i)).not.toBeNull();
    });
    // Accept button stays in place for re-review.
    expect(
      screen.queryByRole("button", { name: /Accept contract & plan/i }),
    ).not.toBeNull();
    // The stale event triggered exactly ONE refetch (accept mutation does not
    // invalidate the plan query). The previous render-phase refetch looped:
    // every completed refetch re-rendered while the outcome was still
    // `plan_stale`, re-triggering the fetch without bound.
    await waitFor(() => {
      expect(mockPlanGet.mock.calls.length).toBe(callsBeforeAccept + 1);
    });
    // Hold for several macrotasks: a render-phase refetch would keep climbing.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockPlanGet.mock.calls.length).toBe(callsBeforeAccept + 1);
  });

  it("surfaces a generic failure notice for each non-success accept outcome", async () => {
    const cases: ReadonlyArray<[Record<string, unknown>, RegExp]> = [
      [{ outcome: "mission_not_found" }, /Couldn't accept:.*no longer exists/i],
      [
        { outcome: "session_mismatch", expectedSessionId: "x" },
        /Couldn't accept:.*different session/i,
      ],
      [
        { outcome: "hash_mismatch", providedHash: "a", currentHash: "b" },
        /Couldn't accept:.*changed since you reviewed/i,
      ],
      [
        { outcome: "status_blocked", currentStatus: "running" },
        /Couldn't accept:.*current state/i,
      ],
      [
        { outcome: "run_active", missionRunId: "r1", runStatus: "running" },
        /Couldn't accept:.*run is already active/i,
      ],
    ];
    for (const [data, copy] of cases) {
      vi.clearAllMocks();
      mockPlanGet.mockResolvedValue({ ok: true, data: null });
      mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
      mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
      mockBridge.acceptContract.mockResolvedValue({ ok: true, data });
      const { unmount } = render(
        <MissionContractModal
          sessionId={SESSION}
          permission="full"
          open
          onOpenChange={() => {}}
        />,
        { wrapper: Wrapper(makeClient()) },
      );
      fireEvent.click(
        await screen.findByRole("button", { name: /^Accept contract$/i }),
      );
      await waitFor(() => {
        expect(screen.queryByText(copy)).not.toBeNull();
      });
      unmount();
    }
  });

  it("surfaces a notice when the accept mutation rejects (transport error)", async () => {
    mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
    mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
    mockBridge.acceptContract.mockRejectedValue(new Error("ipc down"));
    renderModal();
    fireEvent.click(
      await screen.findByRole("button", { name: /^Accept contract$/i }),
    );
    await waitFor(() => {
      expect(
        screen.queryByText(/Couldn't accept the contract — something went wrong/i),
      ).not.toBeNull();
    });
  });

  it("renders the header status marker as a non-interactive chip (no dead focus target)", async () => {
    mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
    mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
    renderModal();
    // Wait for the body to render.
    await screen.findByRole("button", { name: /^Accept contract$/i });
    // The only button in the open modal is the Accept action — the header
    // "Mission" marker must NOT be a focusable button (it would do nothing).
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect((buttons[0] as HTMLButtonElement).getAttribute("data-vex-action")).toBe(
      "accept-contract",
    );
    // The marker still shows the "Mission" label + a status caption.
    expect(screen.queryByText("Mission")).not.toBeNull();
    // No element carries the rail badge's open-dialog action in the header.
    expect(
      document.querySelector('[data-vex-action="open-mission-detail"]'),
    ).toBeNull();
  });

  it("blocks accept with a plan_missing footer when plan-mode on but empty", async () => {
    mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
    mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
    mockPlanGet.mockResolvedValue({
      ok: true,
      data: { ...ENABLED_UNACCEPTED_PLAN, planMd: "" },
    });
    renderModal();
    await waitFor(() => {
      expect(
        screen.queryByText(/no action plan has been authored yet/i),
      ).not.toBeNull();
    });
    expect(screen.queryByRole("button", { name: /Accept/i })).toBeNull();
  });

  it("suppresses acceptance while the plan read is PENDING and the header badge stays Preparing", async () => {
    mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
    mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
    mockPlanGet.mockImplementation(() => new Promise(() => {})); // never settles
    renderModal();

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.getAttribute("data-vex-state")).toBe("plan-unknown");
    });
    expect(screen.queryByRole("button", { name: /Accept contract/i })).toBeNull();
    // The header must not contradict the blocked footer.
    expect(screen.queryByText(/Mission ready/i)).toBeNull();
    expect(screen.getByText(/Preparing/i)).not.toBeNull();
  });

  it("a FAILED plan read shows the Retry action, keeps the badge Preparing, and recovery re-enables acceptance", async () => {
    mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
    mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
    mockPlanGet.mockResolvedValueOnce({
      ok: false as const,
      error: { code: "session.plan_read_failed", message: "boom", correlationId: "t" },
    });
    // The retry resolves a healthy plan-mode-off read.
    mockPlanGet.mockResolvedValue({ ok: true, data: null });
    renderModal();

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.getAttribute("data-vex-state")).toBe("plan-failed");
    });
    expect(screen.queryByRole("button", { name: /Accept contract/i })).toBeNull();
    expect(screen.queryByText(/Mission ready/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));

    // Recovery: the read succeeds, acceptance becomes available again.
    expect(
      await screen.findByRole("button", { name: /Accept contract/i }),
    ).not.toBeNull();
  });

  it("a REJECTED plan.get promise (ipc failure) shows the Retry path — never an infinite Loading", async () => {
    mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
    mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
    mockPlanGet.mockRejectedValueOnce(new Error("ipc channel died"));
    mockPlanGet.mockResolvedValue({ ok: true, data: null }); // retry succeeds
    renderModal();

    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-vex-state")).toBe("plan-failed");
    expect(screen.queryByRole("button", { name: /Accept contract/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(
      await screen.findByRole("button", { name: /Accept contract/i }),
    ).not.toBeNull();
  });

  it("an EMPTY enabled plan keeps the header badge Preparing (matches the blocked footer)", async () => {
    mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
    mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
    mockPlanGet.mockResolvedValue({
      ok: true,
      data: { enabled: true, accepted: false, planMd: "", updatedAt: PLAN_UPDATED_AT },
    });
    renderModal();

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.getAttribute("data-vex-state")).toBe("plan-missing");
    });
    expect(screen.queryByText(/Mission ready/i)).toBeNull();
    expect(screen.getByText(/Preparing/i)).not.toBeNull();
  });
});
