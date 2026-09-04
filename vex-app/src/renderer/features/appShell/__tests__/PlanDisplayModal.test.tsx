/**
 * PlanDisplayModal — the legacy Plan Mode recovery surface.
 *
 * The API hooks are mocked so the modal's display/accept/resume/disable logic
 * is exercised directly. Pins:
 *   - read-only under suppressAccept (no standalone Accept),
 *   - standalone "Accept plan" echoes the reviewed markdown as expectedPlanMd,
 *   - "Resume mission" when accepted but parked for acceptance,
 *   - "Turn off Plan Mode" — the legacy-recovery exit ramp — renders whenever
 *     `plan.enabled === true` and calls `setEnabled(false)`, never composing
 *     a silent accept; every `plan.setEnabled` outcome (updated /
 *     blocked_pending_acceptance / not_found / failed Result / rejected
 *     mutation) surfaces distinct copy.
 *
 * The native <dialog> modal methods jsdom lacks come from the shared renderer
 * setup (`test/dialog-modal-polyfill.ts`), which also runs the real dialog
 * focusing steps, so no suite installs its own.
 */

import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

type AcceptData = { ok: true; data: { outcome: string } } | undefined;
const mockUseSessionPlan = vi.fn();
const mockAcceptPlan: {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isError: boolean;
  data: AcceptData;
} = { mutate: vi.fn(), isPending: false, isError: false, data: undefined };
const mockRequestResume = { mutate: vi.fn(), isPending: false };

type SetEnabledData =
  | { ok: true; data: { outcome: string } }
  | { ok: false; error: { code: string; message: string; correlationId: string } }
  | undefined;
const mockSetPlanMode: {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isError: boolean;
  data: SetEnabledData;
} = { mutate: vi.fn(), isPending: false, isError: false, data: undefined };

vi.mock("../../../lib/api/sessions.js", () => ({
  useSessionPlan: (...a: unknown[]) => mockUseSessionPlan(...a),
  useAcceptPlan: () => mockAcceptPlan,
  useSetPlanMode: () => mockSetPlanMode,
}));
vi.mock("../../../lib/api/runtime.js", () => ({
  useRequestResume: () => mockRequestResume,
}));
vi.mock("../../../lib/markdown/MarkdownContent.js", () => ({
  MarkdownContent: ({ text }: { text: string }) => (
    <div data-testid="plan-md">{text}</div>
  ),
}));

const { PlanDisplayModal } = await import("../PlanDisplayModal.js");

const SESSION = "00000000-0000-4000-8000-00000000aa02";

type PlanState = { enabled: boolean; planMd: string; accepted: boolean };
function planQuery(over: Partial<PlanState>) {
  return {
    data: {
      ok: true as const,
      data: { enabled: false, planMd: "", accepted: false, ...over },
    },
    isFetching: false,
    refetch: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAcceptPlan.isPending = false;
  mockAcceptPlan.isError = false;
  mockAcceptPlan.data = undefined;
  mockRequestResume.isPending = false;
  mockSetPlanMode.isPending = false;
  mockSetPlanMode.isError = false;
  mockSetPlanMode.data = undefined;
  mockUseSessionPlan.mockReturnValue(planQuery({}));
});

function renderModal(
  props: Partial<{ missionStatus: string | null; suppressAccept: boolean }> = {},
): void {
  render(
    <PlanDisplayModal
      sessionId={SESSION}
      open
      onOpenChange={() => {}}
      {...props}
    />,
  );
}

describe("PlanDisplayModal", () => {
  it("shows a pending plan and accepts it with the exact reviewed content", () => {
    mockUseSessionPlan.mockReturnValue(
      planQuery({ enabled: true, planMd: "# Plan\nstep one", accepted: false }),
    );
    renderModal();
    expect(screen.getByText("Pending your acceptance")).toBeTruthy();
    expect(screen.getByTestId("plan-md").textContent).toContain("step one");
    fireEvent.click(screen.getByText("Accept plan"));
    expect(mockAcceptPlan.mutate).toHaveBeenCalledWith({
      sessionId: SESSION,
      expectedPlanMd: "# Plan\nstep one",
    });
  });

  it("withholds the standalone Accept under suppressAccept (read-only) but keeps Turn off Plan Mode", () => {
    mockUseSessionPlan.mockReturnValue(
      planQuery({ enabled: true, planMd: "# Plan\nstep one", accepted: false }),
    );
    renderModal({ suppressAccept: true });
    // Still renders the plan, but no standalone accept action.
    expect(screen.getByTestId("plan-md")).toBeTruthy();
    expect(screen.queryByText("Accept plan")).toBeNull();
    expect(
      screen.queryByText(/Accept this plan together with the contract/i),
    ).not.toBeNull();
    // The disable exit ramp never conflicts with the unified mission accept,
    // so it stays available even in the suppressed (mission-setup) surface.
    expect(screen.getByText("Turn off Plan Mode")).toBeTruthy();
  });

  it("offers Resume when accepted but the run is still parked", () => {
    mockUseSessionPlan.mockReturnValue(
      planQuery({ enabled: true, planMd: "# Plan", accepted: true }),
    );
    renderModal({ missionStatus: "paused_plan_acceptance" });
    expect(screen.getByText("Accepted")).toBeTruthy();
    expect(screen.queryByText("Accept plan")).toBeNull();
    fireEvent.click(screen.getByText("Resume mission"));
    expect(mockRequestResume.mutate).toHaveBeenCalledWith({
      sessionId: SESSION,
    });
  });

  it("does NOT offer Resume for an accepted plan when the run is not parked", () => {
    mockUseSessionPlan.mockReturnValue(
      planQuery({ enabled: true, planMd: "# Plan", accepted: true }),
    );
    renderModal({ missionStatus: "running" });
    expect(screen.queryByText("Resume mission")).toBeNull();
  });

  it("surfaces a failure notice for each non-success standalone-accept outcome", () => {
    const cases: ReadonlyArray<[string, RegExp]> = [
      ["stale", /Plan changed - review again/i],
      ["no_plan", /No plan authored yet/i],
      ["not_found", /Couldn't accept:.*no longer exists/i],
    ];
    for (const [outcome, copy] of cases) {
      mockUseSessionPlan.mockReturnValue(
        planQuery({ enabled: true, planMd: "# Plan\nstep one", accepted: false }),
      );
      mockAcceptPlan.data = { ok: true, data: { outcome } };
      const { unmount } = render(
        <PlanDisplayModal sessionId={SESSION} open onOpenChange={() => {}} />,
      );
      expect(screen.queryByText(copy)).not.toBeNull();
      unmount();
    }
  });

  it("surfaces a notice when the standalone-accept mutation rejects (transport error)", () => {
    mockUseSessionPlan.mockReturnValue(
      planQuery({ enabled: true, planMd: "# Plan\nstep one", accepted: false }),
    );
    mockAcceptPlan.isError = true;
    renderModal();
    expect(
      screen.queryByText(/Couldn't accept the plan - something went wrong/i),
    ).not.toBeNull();
  });

  it("does NOT surface a standalone-accept notice under suppressAccept", () => {
    mockUseSessionPlan.mockReturnValue(
      planQuery({ enabled: true, planMd: "# Plan\nstep one", accepted: false }),
    );
    // Even if a stale outcome leaked into the cache, the suppressed surface
    // (contract modal owns the unified accept) shows no standalone notice.
    mockAcceptPlan.data = { ok: true, data: { outcome: "stale" } };
    renderModal({ suppressAccept: true });
    expect(screen.queryByText(/Plan changed - review again/i)).toBeNull();
  });
});

describe("PlanDisplayModal - legacy recovery (Turn off Plan Mode)", () => {
  it("shows Turn off Plan Mode whenever a plan is enabled, even with nothing authored yet", () => {
    mockUseSessionPlan.mockReturnValue(planQuery({ enabled: true, planMd: "" }));
    renderModal();
    expect(screen.getByText("Turn off Plan Mode")).toBeTruthy();
  });

  it("never advertises Plan Mode as a supported feature", () => {
    mockUseSessionPlan.mockReturnValue(
      planQuery({ enabled: true, planMd: "# Plan", accepted: false }),
    );
    renderModal();
    expect(screen.getByText(/Plan Mode has been retired/i)).toBeTruthy();
  });

  it("calls setEnabled(false) and never composes a silent accept", () => {
    mockUseSessionPlan.mockReturnValue(
      planQuery({ enabled: true, planMd: "# Plan", accepted: false }),
    );
    renderModal();
    fireEvent.click(screen.getByText("Turn off Plan Mode"));
    expect(mockSetPlanMode.mutate).toHaveBeenCalledWith({
      sessionId: SESSION,
      enabled: false,
    });
    expect(mockAcceptPlan.mutate).not.toHaveBeenCalled();
  });

  it("keeps Accept available alongside Turn off for an unaccepted plan", () => {
    mockUseSessionPlan.mockReturnValue(
      planQuery({ enabled: true, planMd: "# Plan", accepted: false }),
    );
    renderModal();
    expect(screen.getByText("Accept plan")).toBeTruthy();
    expect(screen.getByText("Turn off Plan Mode")).toBeTruthy();
  });

  it("offers Turn off for an accepted plan with no active pause - the otherwise-stranded case", () => {
    mockUseSessionPlan.mockReturnValue(
      planQuery({ enabled: true, planMd: "# Plan", accepted: true }),
    );
    renderModal({ missionStatus: "running" });
    expect(screen.getByText("Turn off Plan Mode")).toBeTruthy();
  });

  it("surfaces the blocked_pending_acceptance guidance and does NOT auto-accept", () => {
    mockUseSessionPlan.mockReturnValue(
      planQuery({ enabled: true, planMd: "# Plan", accepted: false }),
    );
    mockSetPlanMode.data = {
      ok: true,
      data: { outcome: "blocked_pending_acceptance" },
    };
    renderModal();
    expect(screen.getByText(/stop the mission first/i)).toBeTruthy();
    expect(mockAcceptPlan.mutate).not.toHaveBeenCalled();
  });

  it("surfaces a not_found notice", () => {
    mockUseSessionPlan.mockReturnValue(
      planQuery({ enabled: true, planMd: "# Plan", accepted: false }),
    );
    mockSetPlanMode.data = { ok: true, data: { outcome: "not_found" } };
    renderModal();
    expect(screen.getByText(/no longer exists/i)).toBeTruthy();
  });

  it("surfaces a notice for a failed Result envelope (ok:false)", () => {
    mockUseSessionPlan.mockReturnValue(
      planQuery({ enabled: true, planMd: "# Plan", accepted: false }),
    );
    mockSetPlanMode.data = {
      ok: false,
      error: {
        code: "session.plan_write_failed",
        message: "boom",
        correlationId: "t",
      },
    };
    renderModal();
    expect(
      screen.getByText(/Couldn't turn off Plan Mode - something went wrong/i),
    ).toBeTruthy();
  });

  it("surfaces a notice when the disable mutation rejects (transport error)", () => {
    mockUseSessionPlan.mockReturnValue(
      planQuery({ enabled: true, planMd: "# Plan", accepted: false }),
    );
    mockSetPlanMode.isError = true;
    renderModal();
    expect(
      screen.getByText(/Couldn't turn off Plan Mode - something went wrong/i),
    ).toBeTruthy();
  });

  it("shows no disable notice on a successful update", () => {
    mockUseSessionPlan.mockReturnValue(
      planQuery({ enabled: true, planMd: "# Plan", accepted: false }),
    );
    mockSetPlanMode.data = {
      ok: true,
      data: { outcome: "updated" },
    };
    const { container } = render(
      <PlanDisplayModal sessionId={SESSION} open onOpenChange={() => {}} />,
    );
    expect(
      container.querySelector('[data-vex-state="plan-disable-notice"]'),
    ).toBeNull();
  });
});
