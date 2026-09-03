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
 * bridge. The native <dialog> modal methods jsdom lacks come from the shared
 * renderer setup (`test/dialog-modal-polyfill.ts`), which also runs the real
 * dialog focusing steps, so no suite installs its own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

const { MissionContractModal } = await import("../MissionContractModal.js");
const {
  cancelMissionContractRequest,
  grantMissionContractRequest,
  requestMissionContract,
  resetMissionContractRequests,
} = await import("../mission-contract-request.js");

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
  deployedCapital: null,
  renewedFromMissionId: null,
  missingFields: [],
  canAcceptContract: true,
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
      expect(screen.queryByText(/Plan changed - review again/i)).not.toBeNull();
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
        screen.queryByText(/Couldn't accept the contract - something went wrong/i),
      ).not.toBeNull();
    });
  });

  it("renders the header status marker as a non-interactive chip (no dead focus target)", async () => {
    mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
    mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
    renderModal();
    // Wait for the body to render.
    await screen.findByRole("button", { name: /^Accept contract$/i });
    // The header "Mission" marker must NOT be a focusable button (it would do
    // nothing). Asserted on the HEADER specifically: counting every button in
    // the modal used to stand in for this, but the body legitimately gained the
    // host-authored launch-ceilings control, and a body button says nothing
    // about a dead focus target in the header.
    const header = screen.getByText("Rebalance LP").parentElement;
    expect(header).not.toBeNull();
    expect(header?.querySelectorAll("button")).toHaveLength(0);
    expect(
      document.querySelector('[data-vex-action="accept-contract"]'),
    ).not.toBeNull();
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

  it("a REJECTED plan.get promise (ipc failure) shows the Retry path - never an infinite Loading", async () => {
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

  /**
   * `kind === "setup-needed"` had NO coverage before this, which is how its
   * footer copy stayed wrong: it read "Add a goal, constraints, and stop
   * conditions to enable Accept." - an imperative aimed at the user for fields
   * only the agent can write (`mission.updateDraft` returns `unavailable`).
   */
  describe("incomplete contract (setup-needed)", () => {
    const SETUP_DRAFT = {
      ...SAMPLE_DRAFT,
      status: "draft" as const,
      canAcceptContract: false,
      missingFields: ["goal", "riskProfile", "stopConditions"],
    };

    it("names the AGENT as the actor and enumerates the missing fields, with no Accept offered", async () => {
      mockBridge.getDraft.mockResolvedValue({ ok: true, data: SETUP_DRAFT });
      mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
      renderModal();

      const footerNote = await screen.findByText(/Vex is still writing this contract/i);
      // The actor. This is the regression this test exists to catch: if the
      // copy ever tells the USER to fill the fields again, this fails.
      expect(footerNote.textContent).toMatch(/Vex sets them from your conversation/i);
      expect(footerNote.textContent).toMatch(/cannot be edited here/i);
      expect(
        screen.queryByText(/Add a goal, constraints, and stop conditions/i),
      ).toBeNull();

      // Enumerated, complete, human-labelled.
      const list = document.querySelector(
        '[data-vex-state="mission-missing-fields"][data-vex-surface="contract-modal"]',
      );
      expect(list).not.toBeNull();
      expect(list?.querySelectorAll("li")).toHaveLength(3);
      expect(list?.textContent).toMatch(/Goal/);
      expect(list?.textContent).toMatch(/Risk profile/);
      expect(list?.textContent).toMatch(/Stop conditions/);

      // Accept is still correctly withheld: the engine refuses the START of a
      // `draft`-status contract with `not_ready`, so offering Accept here would
      // only move the dead end downstream.
      expect(screen.queryByRole("button", { name: /Accept contract/i })).toBeNull();
    });

    it("falls back honestly when the contract state is not readable yet", async () => {
      mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
      // No usable diff → contract-loading, which must NOT claim fields are
      // missing (we have not read them), only that the state is being read.
      mockBridge.getDiff.mockResolvedValue({
        ok: true,
        data: { outcome: "not_found" },
      });
      renderModal();

      await screen.findByText(/Reading the current contract state/i);
      expect(
        document.querySelector('[data-vex-state="mission-missing-fields"]'),
      ).toBeNull();
    });
  });

  /**
   * WP3: the request a blocked capability raises. Single-flight, joinable,
   * tri-state, and NEVER resolved ahead of the commit.
   */
  describe("contract request lifecycle", () => {
    afterEach(() => resetMissionContractRequests());

    it("resolves granted ONLY after the acceptance commits", async () => {
      mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
      mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
      let settleAccept!: (v: unknown) => void;
      mockBridge.acceptContract.mockReturnValue(
        new Promise((resolve) => {
          settleAccept = resolve;
        }),
      );
      let outcome: string | null = null;
      void requestMissionContract({
        sessionId: SESSION,
        reason: "start_blocked",
      }).then((o) => {
        outcome = o;
      });
      renderModal();

      fireEvent.click(
        await screen.findByRole("button", { name: /^Accept contract$/i }),
      );
      // In flight: the engine has not committed, so nothing may be reported.
      await Promise.resolve();
      expect(outcome).toBeNull();

      settleAccept({ ok: true, data: { outcome: "accepted" } });
      await waitFor(() => expect(outcome).toBe("granted"));
    });

    it("resolves refused when the engine rejects the acceptance", async () => {
      mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
      mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
      mockBridge.acceptContract.mockResolvedValue({
        ok: true,
        data: { outcome: "hash_mismatch" },
      });
      const pending = requestMissionContract({
        sessionId: SESSION,
        reason: "start_blocked",
      });
      renderModal();
      fireEvent.click(
        await screen.findByRole("button", { name: /^Accept contract$/i }),
      );
      await expect(pending).resolves.toBe("refused");
    });

    it("resolves refused when the accept call itself fails", async () => {
      mockBridge.getDraft.mockResolvedValue({ ok: true, data: SAMPLE_DRAFT });
      mockBridge.getDiff.mockResolvedValue({ ok: true, data: READY_DIFF });
      mockBridge.acceptContract.mockRejectedValue(new Error("transport down"));
      const pending = requestMissionContract({
        sessionId: SESSION,
        reason: "start_blocked",
      });
      renderModal();
      fireEvent.click(
        await screen.findByRole("button", { name: /^Accept contract$/i }),
      );
      await expect(pending).resolves.toBe("refused");
    });

    it("resolves cancelled when the surface is dismissed without a decision", async () => {
      const pending = requestMissionContract({
        sessionId: SESSION,
        reason: "start_blocked",
      });
      cancelMissionContractRequest(SESSION);
      await expect(pending).resolves.toBe("cancelled");
    });

    it("is single-flight and joinable: a second request settles with the first", async () => {
      const a = requestMissionContract({ sessionId: SESSION, reason: "user" });
      const b = requestMissionContract({
        sessionId: SESSION,
        reason: "start_blocked",
      });
      grantMissionContractRequest(SESSION);
      await expect(a).resolves.toBe("granted");
      await expect(b).resolves.toBe("granted");
    });

    it("cancels a stale request when a different session raises one", async () => {
      const OTHER = "00000000-0000-4000-8000-0000000000ff";
      const stale = requestMissionContract({ sessionId: SESSION, reason: "user" });
      const fresh = requestMissionContract({ sessionId: OTHER, reason: "user" });
      await expect(stale).resolves.toBe("cancelled");
      grantMissionContractRequest(OTHER);
      await expect(fresh).resolves.toBe("granted");
    });

    it("ignores a settle aimed at a session that is not the pending one", async () => {
      const pending = requestMissionContract({ sessionId: SESSION, reason: "user" });
      grantMissionContractRequest("00000000-0000-4000-8000-0000000000ee");
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      cancelMissionContractRequest(SESSION);
      await expect(pending).resolves.toBe("cancelled");
    });
  });
});
