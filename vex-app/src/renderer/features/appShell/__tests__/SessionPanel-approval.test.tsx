/**
 * SessionPanel × ApprovalsRegion integration mount-assertion (Codex F3 #5).
 *
 * Directly protects the bug fix: in the active-session branch of `SessionPanel`,
 * a pending approval renders an `ApprovalCard` (the user is no longer soft-locked
 * by the composer's `paused_approval` gate when there is no UI to click).
 *
 * Heavy child components are stubbed so this stays a focused mount test, not a
 * full AppShell integration suite.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import type { Result } from "@shared/ipc/result.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";

// Stub live-sync hooks so SessionPanel doesn't try to wire real subscriptions.
// SessionPanel also reads the transcript query to tell an idle session apart;
// returning `data: undefined` keeps isIdleSession=false so the active tape
// branch (transcript + approvals) renders, which is what this test asserts.
vi.mock("../../../lib/api/messages.js", () => ({
  useTranscriptLiveSync: () => undefined,
  useTranscriptInfinite: () => ({ data: undefined, isLoading: false }),
  flattenTranscriptPages: () => [],
}));
vi.mock("../../../lib/api/usage.js", () => ({
  useUsageLiveSync: () => undefined,
}));
// The engine-error channel mounts a subscriber from SessionPanel for EVERY
// session. These tests never stub `window.vex`, so the hook is mocked out the
// same way the other live-sync hooks above are.
vi.mock("../../../lib/api/engine-errors.js", () => ({
  useEngineErrorLiveSync: () => {},
}));
vi.mock("../../../lib/api/streams.js", () => ({
  useStreamPreviewSync: () => undefined,
}));
// Stub only the live-sync subscription; keep real query/mutation hooks intact.
// Using importActual keeps the mock robust against children adding more runtime
// hooks (the plan/contract review moved to the MISSION RAIL modals, but the
// approvals path here still exercises the real runtime API surface).
vi.mock("../../../lib/api/runtime.js", async (importActual) => {
  const actual = await importActual<
    typeof import("../../../lib/api/runtime.js")
  >();
  return {
    ...actual,
    useControlStateLiveSync: () => undefined,
  };
});
// Same treatment as the control-state spine above: `SessionPanel` also mounts
// the mission-update push subscription, which reaches for `window.vex.engine`.
// Its behaviour is covered by `lib/api/__tests__/mission-update-live-sync.test.ts`.
vi.mock("../../../lib/api/mission.js", async (importActual) => {
  const actual = await importActual<
    typeof import("../../../lib/api/mission.js")
  >();
  return {
    ...actual,
    useMissionUpdateLiveSync: () => undefined,
  };
});

// Provide an active session via useSession; keep other sessions exports intact.
vi.mock("../../../lib/api/sessions.js", async (importActual) => {
  const actual = await importActual<
    typeof import("../../../lib/api/sessions.js")
  >();
  return {
    ...actual,
    useSession: () => ({
      data: {
        ok: true,
        data: {
          id: "00000000-0000-4000-8000-00000000aa01",
          mode: "agent",
        } as unknown as SessionListItem, // test-local cast — render only checks id/mode
      } satisfies Result<SessionListItem>,
      isLoading: false,
    }),
  };
});

// Stub SessionPanel's heavy children so only ApprovalsRegion is real here.
vi.mock("../SessionContext.js", () => ({
  SessionContext: () => <div data-testid="session-context-stub" />,
}));
vi.mock("../SessionTranscript.js", () => ({
  SessionTranscript: () => <div data-testid="transcript-stub" />,
}));
vi.mock("../SessionComposer.js", () => ({
  SessionComposer: () => <div data-testid="composer-stub" />,
}));
vi.mock("../SessionWelcomeHero.js", () => ({
  SessionWelcomeHero: () => null,
}));

// Approval wiring — one pending approval, no-op mutations.
const PENDING_SUMMARY: ApprovalSummaryDto = {
  id: "appr-mount-1",
  sessionId: "00000000-0000-4000-8000-00000000aa01",
  toolCallId: "call-1",
  toolName: "wallet:send",
  status: "pending",
  permissionAtEnqueue: "restricted",
  createdAt: "2026-05-28T10:00:00.000Z",
  resolvedAt: null,
  reasoningPreview: "Send 0.5 ETH for the bridge proposal.",
  actionKind: "user_wallet_broadcast",
  riskLevel: "high",
  preview: {
    toolName: "send",
    namespace: "wallet",
    criticalArgs: { chain: "ethereum", amount: "0.5" },
  },
  expiresAt: null,
  decision: null,
  decisionReason: null,
  executionStatus: null,
};

vi.mock("../../../lib/api/approvals.js", () => ({
  usePendingApprovals: () => ({
    data: {
      ok: true,
      data: [PENDING_SUMMARY] as ReadonlyArray<ApprovalSummaryDto>,
    } satisfies Result<ReadonlyArray<ApprovalSummaryDto>>,
  }),
  useApprove: () => ({ mutate: vi.fn(), isPending: false }),
  useReject: () => ({ mutate: vi.fn(), isPending: false }),
}));

const { SessionPanel } = await import("../SessionPanel.js");
const { useUiStore } = await import("../../../stores/uiStore.js");

afterEach(() => {
  useUiStore.setState({ activeSessionId: null });
  vi.clearAllMocks();
});

describe("SessionPanel — selected-session path mounts the approval card", () => {
  it("renders an ApprovalCard for a pending approval (directly protects F3)", () => {
    useUiStore.setState({
      activeSessionId: "00000000-0000-4000-8000-00000000aa01",
    });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <SessionPanel />
      </QueryClientProvider>,
    );

    // The card must appear in the active-session path.
    expect(screen.getByText(/Approval needed:/)).toBeTruthy();
    expect(screen.getByText("wallet:send")).toBeTruthy();
    // And the stubs prove we rendered the active-session branch.
    expect(screen.getByTestId("transcript-stub")).toBeTruthy();
    expect(screen.getByTestId("composer-stub")).toBeTruthy();
  });
});
