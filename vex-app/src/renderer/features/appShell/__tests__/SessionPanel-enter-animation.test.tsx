/**
 * SessionPanel fluid session-enter (owner decree 2026-07-20) — smoke test.
 *
 * Protects the two-part contract: the panel's outer `data-vex-area` wrapper
 * always carries the `.vex-session-enter` one-shot class (globals.css), and
 * the `key={activeSessionId ?? "welcome"}` on that wrapper forces a REAL
 * React remount whenever the active session changes — welcome→session,
 * session→session (a different id), and session→welcome. A mount-effect spy
 * on the (stubbed) composer child is the only reliable jsdom signal for
 * "did this subtree actually remount", since a static class assertion alone
 * cannot distinguish a remount from an in-place re-render.
 *
 * Heavy children are stubbed (same rationale as SessionPanel-approval.test.tsx
 * / SessionPanel-focus-handoff.test.tsx) so this stays a focused smoke test.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, useEffect } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";

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
vi.mock("../../../lib/api/sessions.js", async (importActual) => {
  const actual = await importActual<
    typeof import("../../../lib/api/sessions.js")
  >();
  return {
    ...actual,
    useSession: () => ({
      data: {
        ok: true,
        data: { id: "unused", mode: "agent" } as unknown as SessionListItem, // test-local cast - render only checks wiring
      } satisfies Result<SessionListItem>,
      isLoading: false,
    }),
  };
});
vi.mock("../../../lib/api/approvals.js", () => ({
  usePendingApprovals: () => ({ data: { ok: true, data: [] } }),
  useApprove: () => ({ mutate: vi.fn(), isPending: false }),
  useReject: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../SessionContext.js", () => ({ SessionContext: () => null }));
vi.mock("../SessionTranscript.js", () => ({ SessionTranscript: () => null }));
vi.mock("../SessionWelcomeHero.js", () => ({ SessionWelcomeHero: () => null }));

const composerMountSpy = vi.fn();
vi.mock("../SessionComposer.js", () => ({
  // A real mount-effect (not a plain render count) is the only reliable
  // jsdom signal that the keyed wrapper actually remounted this subtree,
  // rather than just re-rendering it in place.
  SessionComposer: (): null => {
    useEffect(() => {
      composerMountSpy();
    }, []);
    return null;
  },
}));

const { SessionPanel } = await import("../SessionPanel.js");
const { useUiStore } = await import("../../../stores/uiStore.js");

const SESSION_A = "00000000-0000-4000-8000-00000000ab01";
const SESSION_B = "00000000-0000-4000-8000-00000000ab02";

afterEach(() => {
  useUiStore.setState({ activeSessionId: null });
  vi.clearAllMocks();
});

function renderPanel(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SessionPanel />
    </QueryClientProvider>,
  );
}

describe("SessionPanel - keyed session-enter", () => {
  it("carries .vex-session-enter on the welcome stage and the active-session stage", () => {
    useUiStore.setState({ activeSessionId: null });
    const view = renderPanel();
    expect(
      view.container
        .querySelector("[data-vex-area='session-panel']")
        ?.classList.contains("vex-session-enter"),
    ).toBe(true);

    act(() => {
      useUiStore.setState({ activeSessionId: SESSION_A });
    });
    expect(
      view.container
        .querySelector("[data-vex-area='session-panel']")
        ?.classList.contains("vex-session-enter"),
    ).toBe(true);

    // Unmount before the shared afterEach resets `activeSessionId` to null:
    // this panel is still subscribed to the (global, singleton) uiStore, so
    // leaving it mounted lets that reset remount its keyed wrapper (SESSION_A
    // → "welcome") and fire the next test's mount spy early — a cross-test
    // leak, not anything the real single-instance SessionPanel can do.
    view.unmount();
  });

  it("remounts the panel subtree on every activeSessionId change (welcome→session, session→session, session→welcome)", () => {
    useUiStore.setState({ activeSessionId: null });
    renderPanel();
    expect(composerMountSpy).toHaveBeenCalledTimes(1);

    act(() => {
      useUiStore.setState({ activeSessionId: SESSION_A });
    });
    expect(composerMountSpy).toHaveBeenCalledTimes(2);

    act(() => {
      useUiStore.setState({ activeSessionId: SESSION_B });
    });
    expect(composerMountSpy).toHaveBeenCalledTimes(3);

    act(() => {
      useUiStore.setState({ activeSessionId: null });
    });
    expect(composerMountSpy).toHaveBeenCalledTimes(4);
  });
});
