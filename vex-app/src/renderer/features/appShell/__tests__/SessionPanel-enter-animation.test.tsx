/**
 * THE RESIDENT SHELL — phase transitions and composer residency (R2-D2).
 *
 * This suite replaces the pre-residency "keyed session-enter" contract, which
 * asserted the opposite of what the panel now guarantees. The old panel keyed
 * its ROOT on `activeSessionId`, so welcome→session remounted the entire
 * instrument, composer included. The resident shell inverts that:
 *
 *  - the panel root is NOT keyed and carries `data-phase`
 *    (hero / settling / active);
 *  - the composer seat and everything in it live OUTSIDE the keyed region, so
 *    the textarea DOM NODE and its caret survive every phase change and every
 *    session change — asserted here as element IDENTITY, not as a class;
 *  - `.vex-session-enter` moved onto the keyed SESSION CONTENT wrapper, which
 *    is the part that genuinely swaps, so the resolve-in animation still plays
 *    on a session change without remounting the composer.
 *
 * A mount-effect spy on the stubbed composer is the only reliable jsdom signal
 * for "did this subtree remount"; a class assertion alone cannot tell a
 * remount from an in-place re-render.
 *
 * Heavy children are stubbed (same rationale as SessionPanel-approval.test.tsx)
 * so this stays a focused structural test.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, useEffect } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";

/** Drives the phase derivation: `isLoading` → settling, `[]` pages → hero. */
const transcriptState: { isLoading: boolean; pages: unknown[] | undefined } = {
  isLoading: false,
  pages: undefined,
};

vi.mock("../../../lib/api/messages.js", () => ({
  useTranscriptLiveSync: () => undefined,
  useTranscriptInfinite: () => ({
    data:
      transcriptState.pages === undefined
        ? undefined
        : { pages: transcriptState.pages },
    isLoading: transcriptState.isLoading,
    isSuccess: !transcriptState.isLoading,
  }),
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
vi.mock("../SessionWelcomeHero.js", () => ({
  SessionWelcomeHero: () => <div data-testid="welcome-hero" />,
}));

const composerMountSpy = vi.fn();
vi.mock("../SessionComposer.js", () => ({
  // Renders a real DOM node so residency can be asserted as element IDENTITY,
  // and a real mount effect so a remount is distinguishable from a re-render.
  SessionComposer: (): React.JSX.Element => {
    useEffect(() => {
      composerMountSpy();
    }, []);
    return <textarea data-testid="composer-field" />;
  },
}));

const { SessionPanel } = await import("../SessionPanel.js");
const { useUiStore } = await import("../../../stores/uiStore.js");

const SESSION_A = "00000000-0000-4000-8000-00000000ab01";
const SESSION_B = "00000000-0000-4000-8000-00000000ab02";

afterEach(() => {
  useUiStore.setState({ activeSessionId: null });
  transcriptState.isLoading = false;
  transcriptState.pages = undefined;
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

function phaseOf(container: HTMLElement): string | null {
  return (
    container
      .querySelector("[data-vex-area='session-panel']")
      ?.getAttribute("data-phase") ?? null
  );
}

describe("SessionPanel - the resident shell", () => {
  it("walks hero → settling → active on one persistent tree", () => {
    useUiStore.setState({ activeSessionId: null });
    transcriptState.pages = [];
    const view = renderPanel();
    expect(phaseOf(view.container)).toBe("hero");
    // The hero chrome renders INSIDE the seat, so the whole stack centres as
    // one unit; the transcript region is absent entirely.
    expect(view.queryByTestId("welcome-hero")).not.toBeNull();
    expect(
      view.container.querySelector("[data-vex-session-content]"),
    ).toBeNull();

    // A session is picked and its history has not landed: hero-vs-docked is
    // unknowable, so the seat stays mounted and the CSS hides it.
    act(() => {
      transcriptState.isLoading = true;
      transcriptState.pages = undefined;
      useUiStore.setState({ activeSessionId: SESSION_A });
    });
    expect(phaseOf(view.container)).toBe("settling");
    expect(view.queryByTestId("composer-field")).not.toBeNull();

    // History lands and is non-empty: the seat docks.
    act(() => {
      transcriptState.isLoading = false;
      transcriptState.pages = undefined;
      view.rerender(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <SessionPanel />
        </QueryClientProvider>,
      );
    });
    expect(phaseOf(view.container)).toBe("active");
    expect(
      view.container.querySelector("[data-vex-session-content]"),
    ).not.toBeNull();
    view.unmount();
  });

  it("keeps the SAME composer element across hero → active and across session changes", () => {
    useUiStore.setState({ activeSessionId: null });
    transcriptState.pages = [];
    const view = renderPanel();
    expect(phaseOf(view.container)).toBe("hero");
    const heroField = view.getByTestId("composer-field");
    expect(composerMountSpy).toHaveBeenCalledTimes(1);

    // welcome → session (the create handoff). Under the old keyed root this
    // remounted the instrument and the in-flight first message survived only
    // through composer-submit's replay effect.
    act(() => {
      transcriptState.pages = undefined;
      useUiStore.setState({ activeSessionId: SESSION_A });
    });
    expect(phaseOf(view.container)).toBe("active");
    expect(view.getByTestId("composer-field")).toBe(heroField);

    // session → session, and back to welcome.
    act(() => {
      useUiStore.setState({ activeSessionId: SESSION_B });
    });
    expect(view.getByTestId("composer-field")).toBe(heroField);
    act(() => {
      transcriptState.pages = [];
      useUiStore.setState({ activeSessionId: null });
    });
    expect(phaseOf(view.container)).toBe("hero");
    expect(view.getByTestId("composer-field")).toBe(heroField);

    // ONE mount for the whole walk: the seat never remounted.
    expect(composerMountSpy).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("keeps .vex-session-enter on the keyed session content, and remounts only that", () => {
    useUiStore.setState({ activeSessionId: SESSION_A });
    const view = renderPanel();
    const content = view.container.querySelector("[data-vex-session-content]");
    expect(content?.classList.contains("vex-session-enter")).toBe(true);
    // The panel root is resident: it must NOT carry the one-shot, or the whole
    // shell would replay the animation on every session change.
    expect(
      view.container
        .querySelector("[data-vex-area='session-panel']")
        ?.classList.contains("vex-session-enter"),
    ).toBe(false);

    // A different session swaps the content node (a real remount replays the
    // animation) while the composer below it stays put.
    const field = view.getByTestId("composer-field");
    act(() => {
      useUiStore.setState({ activeSessionId: SESSION_B });
    });
    expect(view.container.querySelector("[data-vex-session-content]")).not.toBe(
      content,
    );
    expect(view.getByTestId("composer-field")).toBe(field);
    view.unmount();
  });

  it("marks the scrollport and the seat the scroll model binds to", () => {
    // The follow model resolves `[data-vex-conversation-scroll]` as the
    // scrollport and observes `[data-vex-composer-seat]` to republish
    // `--vex-composer-height`. Losing either marker silently degrades the
    // model to the transcript-local fallback with no error anywhere.
    useUiStore.setState({ activeSessionId: SESSION_A });
    const view = renderPanel();
    const scrollport = view.container.querySelector(
      "[data-vex-conversation-scroll]",
    );
    const seat = view.container.querySelector("[data-vex-composer-seat]");
    expect(scrollport).not.toBeNull();
    expect(seat).not.toBeNull();
    // The seat must be INSIDE the scrollport, or `position: sticky` on it
    // resolves against the wrong box and the composer stops docking.
    expect(scrollport?.contains(seat as Node)).toBe(true);
    expect(seat?.contains(view.getByTestId("composer-field"))).toBe(true);
    view.unmount();
  });
});
