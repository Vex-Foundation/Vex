/**
 * MissionRail — the DESK RULE header's mission/plan badge cluster (formerly a
 * fixed right rail between chat and BOOK).
 *
 * Pins the three behaviours the cluster owns:
 *   1. Render gate — renders only for an active session that is mission-mode OR
 *      plan-enabled; a plain agent session with plan-mode off renders NOTHING
 *      (not a broken empty frame).
 *   2. Badge state derivation — the Mission badge mirrors the contract diff
 *      state machine with the "ready requires plan ready" cross-cut; the Plan
 *      badge mirrors the plan state.
 *   3. Single-modal mutual exclusion — opening one badge's dialog closes the
 *      other (two dialogs never stack).
 *
 * The API hooks are mocked (no IPC) and the heavy review modals are stubbed to
 * a marker that echoes its `open` prop, so the cluster's own logic is exercised
 * in isolation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Result } from "@shared/ipc/result.js";
import type {
  MissionDraftDto,
  MissionGetDiffResult,
} from "@shared/schemas/mission.js";
import type { PlanGetResult } from "@shared/schemas/session-plan.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";

const mockUseSession = vi.fn();
const mockUseMissionDraft = vi.fn();
const mockUseMissionDiff = vi.fn();
const mockUseSessionPlan = vi.fn();
const mockUseRenewableMissionSource = vi.fn();
const mockUseRuntimeState = vi.fn();

vi.mock("../../../lib/api/sessions.js", () => ({
  useSession: (...a: unknown[]) => mockUseSession(...a),
  useSessionPlan: (...a: unknown[]) => mockUseSessionPlan(...a),
}));
vi.mock("../../../lib/api/mission.js", () => ({
  useMissionDraft: (...a: unknown[]) => mockUseMissionDraft(...a),
  useMissionDiff: (...a: unknown[]) => mockUseMissionDiff(...a),
  useRenewableMissionSource: (...a: unknown[]) =>
    mockUseRenewableMissionSource(...a),
}));
vi.mock("../../../lib/api/runtime.js", () => ({
  useRuntimeState: (...a: unknown[]) => mockUseRuntimeState(...a),
}));

// Stub the modals to a marker that reports whether it's open + which one it is,
// so the mutual-exclusion test can assert exactly one open at a time.
vi.mock("../MissionContractModal.js", () => ({
  MissionContractModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="mission-modal-open" /> : null,
}));
vi.mock("../PlanDisplayModal.js", () => ({
  PlanDisplayModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="plan-modal-open" /> : null,
}));

const { MissionRail } = await import("../MissionRail.js");
const { useUiStore } = await import("../../../stores/uiStore.js");

const SESSION = "00000000-0000-4000-8000-00000000dd01";
const MISSION = "mission-1";
const HASH = "a".repeat(64);

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

function sessionRow(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: SESSION,
    mode: "agent",
    permission: "restricted",
    title: "Rail session",
    initialGoal: null,
    startedAt: "2026-05-26T10:00:00.000Z",
    endedAt: null,
    missionStatus: null,
    pinnedAt: null,
    ...over,
  };
}

const READY_DRAFT: MissionDraftDto = {
  missionId: MISSION,
  sessionId: SESSION,
  status: "ready",
  title: "Rebalance LP",
  goal: "Move USDC.",
  constraints: {},
  successCriteria: [],
  stopConditions: [],
  riskProfile: "balanced",
  allowedChains: [],
  allowedProtocols: [],
  allowedWallets: [],
  createdAt: "2026-05-22T08:00:00.000Z",
  updatedAt: "2026-05-22T09:00:00.000Z",
  approvedAt: null,
  acceptance: null,
  renewedFromMissionId: null,
} as unknown as MissionDraftDto;

function diff(over: Partial<Extract<MissionGetDiffResult, { outcome: "ready" }>> = {}) {
  return {
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
    ...over,
  };
}

function plan(over: Partial<PlanGetResult> = {}): PlanGetResult {
  return {
    enabled: false,
    planMd: "",
    accepted: false,
    acceptedAt: null,
    updatedAt: "2026-05-22T09:15:00.000Z",
    ...over,
  } as PlanGetResult;
}

// Minimal runtime Result — the rail reads `hasActiveRun` and `status`.
// Defaults to no active run, no status (agent-mode shape); pass
// `hasActiveRun: true` for a running mission and `status` for a specific
// mission-run state (e.g. "paused_error" for the badge-override test).
function runtime(hasActiveRun = false, status: string | null = null) {
  return ok({
    sessionId: SESSION,
    hasActiveRun,
    missionRunId: null,
    status,
    stopReason: null,
    lastCheckpointAt: null,
    startedAt: null,
    iterationCount: null,
    leaseActive: false,
    leaseExpiresAt: null,
    pendingControlKind: null,
  });
}

// Renewable-source Result — `{ missionId } | null`. Default null (no terminal
// accepted mission); pass a missionId for a completed/failed/cancelled run.
function renewable(missionId: string | null = null) {
  return ok(missionId === null ? null : { missionId });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The open-dialog state now lives in uiStore (`reviewModal`), shared across
  // components — reset it so no test leaks its open/closed dialog into the
  // next one.
  useUiStore.setState({ reviewModal: "none" });
  // Sensible defaults: no draft/diff/plan; tests override per case.
  mockUseSession.mockReturnValue({ data: ok(sessionRow()) });
  mockUseMissionDraft.mockReturnValue({ data: ok(null) });
  mockUseMissionDiff.mockReturnValue({ data: undefined });
  mockUseSessionPlan.mockReturnValue({ data: ok(plan()) });
  // No active run / no renewable source by default, so existing badge cases
  // (preparing / ready / accepted-via-diff) keep their expectations.
  mockUseRuntimeState.mockReturnValue({ data: runtime(false) });
  mockUseRenewableMissionSource.mockReturnValue({ data: renewable(null) });
});

function rail(activeSessionId: string | null = SESSION) {
  return render(<MissionRail activeSessionId={activeSessionId} />);
}

describe("MissionRail render gate", () => {
  it("renders nothing when no session is active", () => {
    mockUseSession.mockReturnValue({ data: undefined });
    const { container } = rail(null);
    expect(container.querySelector('[data-vex-area="mission-rail"]')).toBeNull();
  });

  it("renders nothing for a plain agent session with plan-mode off", () => {
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "agent" })) });
    mockUseSessionPlan.mockReturnValue({ data: ok(plan({ enabled: false })) });
    const { container } = rail();
    expect(container.querySelector('[data-vex-area="mission-rail"]')).toBeNull();
  });

  it("renders for a mission session", () => {
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "mission" })) });
    const { container } = rail();
    expect(
      container.querySelector('[data-vex-area="mission-rail"]'),
    ).not.toBeNull();
    // Header-cluster a11y contract: a named group (no longer an <aside>
    // landmark — the cluster lives inside the DESK RULE <header>).
    expect(
      screen.getByRole("group", { name: "Mission and plan status" }),
    ).not.toBeNull();
    // Mission badge present.
    expect(screen.getByText("Mission")).not.toBeNull();
    // No legacy-plan recovery badge when the session never carries a plan.
    expect(screen.queryByText("Legacy plan")).toBeNull();
  });

  it("renders for an agent session with plan-mode on (Legacy plan badge only)", () => {
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "agent" })) });
    mockUseSessionPlan.mockReturnValue({
      data: ok(plan({ enabled: true, planMd: "# Plan" })),
    });
    rail();
    expect(screen.getByText("Legacy plan")).not.toBeNull();
    expect(screen.queryByText("Mission")).toBeNull();
  });

  it("renders the Legacy plan chip for an ACCEPTED, still-enabled plan - the only exit ramp left for that session", () => {
    // Plan Mode can never be re-enabled, so an accepted plan that stays
    // `enabled: true` would otherwise strand the session with no visible
    // way to turn it off. The condition is exactly `plan.enabled === true`,
    // not the accept/pending sub-state.
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "agent" })) });
    mockUseSessionPlan.mockReturnValue({
      data: ok(plan({ enabled: true, planMd: "# Plan", accepted: true })),
    });
    rail();
    const btn = screen.getByRole("button", { name: /Legacy plan/i });
    expect(btn.getAttribute("data-vex-state")).toBe("accepted");
  });

  it("renders no Legacy plan chip once the plan is disabled (agent session, plan-mode off)", () => {
    // Post-disable state: `plan.enabled` false → `derivePlanBadge` returns
    // null → the chip disappears, matching PlanDisplayModal's "Turn off"
    // outcome after the invalidated query resolves.
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "agent" })) });
    mockUseSessionPlan.mockReturnValue({
      data: ok(plan({ enabled: false })),
    });
    rail();
    expect(screen.queryByText("Legacy plan")).toBeNull();
  });
});

describe("MissionRail badge derivation", () => {
  it("Mission badge is Preparing while the draft is not ready", () => {
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "mission" })) });
    mockUseMissionDraft.mockReturnValue({
      data: ok({ ...READY_DRAFT, status: "draft" }),
    });
    rail();
    expect(screen.getByText("Preparing")).not.toBeNull();
  });

  it("Mission badge is Ready (shimmer) when awaiting acceptance and no plan blocks it", () => {
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "mission" })) });
    mockUseMissionDraft.mockReturnValue({ data: ok(READY_DRAFT) });
    mockUseMissionDiff.mockReturnValue({ data: ok(diff()) });
    rail();
    expect(screen.getByText("Ready")).not.toBeNull();
    const btn = screen.getByRole("button", { name: /Mission ready/i });
    expect(btn.classList.contains("vex-badge--shimmer")).toBe(true);
  });

  it("Mission badge stays Preparing while the plan read is PENDING - unknown plan state never flashes Ready", () => {
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "mission" })) });
    mockUseMissionDraft.mockReturnValue({ data: ok(READY_DRAFT) });
    mockUseMissionDiff.mockReturnValue({ data: ok(diff()) });
    mockUseSessionPlan.mockReturnValue({ data: undefined }); // query still pending
    rail();
    expect(screen.getByText("Preparing")).not.toBeNull();
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("Mission badge stays Preparing after a FAILED plan read", () => {
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "mission" })) });
    mockUseMissionDraft.mockReturnValue({ data: ok(READY_DRAFT) });
    mockUseMissionDiff.mockReturnValue({ data: ok(diff()) });
    mockUseSessionPlan.mockReturnValue({
      data: { ok: false as const, error: { code: "session.plan_read_failed", message: "boom", correlationId: "t" } },
    });
    rail();
    expect(screen.getByText("Preparing")).not.toBeNull();
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("Mission badge stays Preparing when plan-mode on but plan is missing", () => {
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "mission" })) });
    mockUseMissionDraft.mockReturnValue({ data: ok(READY_DRAFT) });
    mockUseMissionDiff.mockReturnValue({ data: ok(diff()) });
    mockUseSessionPlan.mockReturnValue({
      data: ok(plan({ enabled: true, planMd: "" })),
    });
    rail();
    // Two badges; the Mission one must not be Ready.
    const missionBtn = screen.getByRole("button", { name: /Mission/i });
    expect(missionBtn.getAttribute("data-vex-state")).toBe("preparing");
  });

  it("Mission badge is Accepted when the contract is accepted and clean", () => {
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "mission" })) });
    mockUseMissionDraft.mockReturnValue({ data: ok(READY_DRAFT) });
    mockUseMissionDiff.mockReturnValue({
      data: ok(diff({ isAccepted: true, isDirty: false })),
    });
    rail();
    expect(
      screen.getByRole("button", { name: /Mission/i }).getAttribute("data-vex-state"),
    ).toBe("accepted");
  });

  it("Mission badge is Accepted (not Preparing) when the draft is gone but a run is active", () => {
    // Accepted → running → draft drops out of getDraftForSession (draft null).
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "mission" })) });
    mockUseMissionDraft.mockReturnValue({ data: ok(null) });
    mockUseRuntimeState.mockReturnValue({ data: runtime(true) });
    rail();
    expect(
      screen.getByRole("button", { name: /Mission/i }).getAttribute("data-vex-state"),
    ).toBe("accepted");
    expect(screen.queryByText("Preparing")).toBeNull();
  });

  it("Mission badge is Accepted (not Preparing) for a terminal mission via a renewable source", () => {
    // Completed/failed/cancelled: no active run, but a non-null renewable
    // source proves the contract was accepted.
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "mission" })) });
    mockUseMissionDraft.mockReturnValue({ data: ok(null) });
    mockUseRuntimeState.mockReturnValue({ data: runtime(false) });
    mockUseRenewableMissionSource.mockReturnValue({ data: renewable(MISSION) });
    rail();
    expect(
      screen.getByRole("button", { name: /Mission/i }).getAttribute("data-vex-state"),
    ).toBe("accepted");
    expect(screen.queryByText("Preparing")).toBeNull();
  });

  it("Mission badge is Preparing (not masked Accepted) for a fresh renewal draft over a renewable source", () => {
    // mission.renew/edit inserts a NEW status='draft' mission under the same
    // root_session_id while the OLD terminal accepted mission still matches
    // getRenewableSourceForSession (hasRenewable stays true). The fresh draft
    // must derive normally, NOT be masked "accepted" by the stale source.
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "mission" })) });
    mockUseMissionDraft.mockReturnValue({
      data: ok({ ...READY_DRAFT, status: "draft" }),
    });
    mockUseRuntimeState.mockReturnValue({ data: runtime(false) });
    mockUseRenewableMissionSource.mockReturnValue({ data: renewable(MISSION) });
    rail();
    const missionBtn = screen.getByRole("button", { name: /Mission/i });
    expect(missionBtn.getAttribute("data-vex-state")).toBe("preparing");
    expect(missionBtn.getAttribute("data-vex-state")).not.toBe("accepted");
  });

  it("Mission badge stays Stale (not masked Accepted) for a dirty accepted contract over a renewable source", () => {
    // An accepted-but-dirty contract on the current draft is "stale". A stale
    // renewable source from a prior terminal run must not mask that to
    // "accepted" — the dirty current draft owns the badge.
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "mission" })) });
    mockUseMissionDraft.mockReturnValue({ data: ok(READY_DRAFT) });
    mockUseMissionDiff.mockReturnValue({
      data: ok(diff({ isAccepted: true, isDirty: true })),
    });
    mockUseRuntimeState.mockReturnValue({ data: runtime(false) });
    mockUseRenewableMissionSource.mockReturnValue({ data: renewable(MISSION) });
    rail();
    const missionBtn = screen.getByRole("button", { name: /Mission/i });
    expect(missionBtn.getAttribute("data-vex-state")).toBe("stale");
    expect(missionBtn.getAttribute("data-vex-state")).not.toBe("accepted");
  });

  it("Mission badge is Accepted (not a shimmering Ready) for a paused plan-acceptance run", () => {
    mockUseSession.mockReturnValue({
      data: ok(
        sessionRow({ mode: "mission", missionStatus: "paused_plan_acceptance" }),
      ),
    });
    mockUseMissionDraft.mockReturnValue({ data: ok(null) });
    mockUseRuntimeState.mockReturnValue({ data: runtime(true) });
    rail();
    const missionBtn = screen.getByRole("button", { name: /Mission/i });
    expect(missionBtn.getAttribute("data-vex-state")).toBe("accepted");
    expect(missionBtn.classList.contains("vex-badge--shimmer")).toBe(false);
  });

  it("Plan badge is Ready (shimmer) when a plan is pending acceptance", () => {
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "agent" })) });
    mockUseSessionPlan.mockReturnValue({
      data: ok(plan({ enabled: true, planMd: "# Plan", accepted: false })),
    });
    rail();
    const btn = screen.getByRole("button", { name: /Plan ready/i });
    expect(btn.getAttribute("data-vex-state")).toBe("ready");
    expect(btn.classList.contains("vex-badge--shimmer")).toBe(true);
  });

  it("Mission badge is Error when an active run's status is paused_error (issue #42)", () => {
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "mission" })) });
    mockUseMissionDraft.mockReturnValue({ data: ok(null) });
    mockUseRuntimeState.mockReturnValue({
      data: runtime(true, "paused_error"),
    });
    rail();
    expect(
      screen.getByRole("button", { name: /Mission/i }).getAttribute("data-vex-state"),
    ).toBe("error");
  });

  it("Mission badge is NOT Error when status is paused_error but hasActiveRun is false (defensive inconsistent state)", () => {
    // Guards against overriding on status alone: a stale/inconsistent
    // status without a confirmed active run must not paint the badge red.
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "mission" })) });
    mockUseMissionDraft.mockReturnValue({ data: ok(READY_DRAFT) });
    mockUseMissionDiff.mockReturnValue({ data: ok(diff()) });
    mockUseRuntimeState.mockReturnValue({
      data: runtime(false, "paused_error"),
    });
    rail();
    expect(
      screen.getByRole("button", { name: /Mission/i }).getAttribute("data-vex-state"),
    ).not.toBe("error");
  });
});

describe("MissionRail single-modal mutual exclusion", () => {
  it("opening the Plan badge closes the Mission dialog (and vice versa)", () => {
    // Mission + plan both enabled so both badges + both modals mount.
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "mission" })) });
    mockUseMissionDraft.mockReturnValue({ data: ok(READY_DRAFT) });
    mockUseMissionDiff.mockReturnValue({ data: ok(diff()) });
    mockUseSessionPlan.mockReturnValue({
      data: ok(plan({ enabled: true, planMd: "# Plan", accepted: false })),
    });
    rail();

    // Nothing open initially.
    expect(screen.queryByTestId("mission-modal-open")).toBeNull();
    expect(screen.queryByTestId("plan-modal-open")).toBeNull();

    // Open Mission.
    fireEvent.click(screen.getByRole("button", { name: /Mission/i }));
    expect(screen.getByTestId("mission-modal-open")).not.toBeNull();
    expect(screen.queryByTestId("plan-modal-open")).toBeNull();

    // Open Plan → Mission closes.
    fireEvent.click(screen.getByRole("button", { name: /Plan/i }));
    expect(screen.queryByTestId("mission-modal-open")).toBeNull();
    expect(screen.getByTestId("plan-modal-open")).not.toBeNull();

    // Clicking Plan again toggles it closed.
    fireEvent.click(screen.getByRole("button", { name: /Plan/i }));
    expect(screen.queryByTestId("plan-modal-open")).toBeNull();
  });

  it("opens the mission dialog from an EXTERNAL uiStore write (MissionControls' review bar), not just its own badge click", () => {
    // MissionControls lives in a different tree branch and can only reach
    // this dialog through uiStore.reviewModal — pin that the rail reacts to
    // the store regardless of who wrote it.
    mockUseSession.mockReturnValue({ data: ok(sessionRow({ mode: "mission" })) });
    mockUseMissionDraft.mockReturnValue({ data: ok(READY_DRAFT) });
    mockUseMissionDiff.mockReturnValue({ data: ok(diff()) });
    rail();

    expect(screen.queryByTestId("mission-modal-open")).toBeNull();
    act(() => {
      useUiStore.getState().setReviewModal("mission");
    });
    expect(screen.getByTestId("mission-modal-open")).not.toBeNull();
  });
});
