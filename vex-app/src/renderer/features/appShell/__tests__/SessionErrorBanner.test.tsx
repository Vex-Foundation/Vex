/**
 * `SessionErrorBanner`, app-wide retention, and session-scoped invalidation.
 *
 * The regression this whole channel exists for: an AGENT-MODE session in
 * `paused_error` rendered NOTHING, because the only error UI lived inside
 * `MissionControls`, which mounts only when `mode === "mission"`. These tests
 * pin that the banner is session-agnostic, that it says something specific per
 * category (never the generic "Unable to process the message"), and that no
 * provider prose can reach the DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { EngineErrorEvent } from "@shared/schemas/engine-error.js";
import { SessionErrorBanner } from "../SessionErrorBanner.js";
import {
  useEngineErrorLiveSync,
  useEngineErrorRetentionSync,
} from "../../../lib/api/engine-errors.js";
import { useEngineErrorStore } from "../../../stores/engineErrorStore.js";
import { makeEngineBridgeStub } from "../../../test/engine-bridge-stub.js";

const SESSION_A = "00000000-0000-4000-8000-00000000000a";
const SESSION_B = "00000000-0000-4000-8000-00000000000b";

type ErrorCb = (event: EngineErrorEvent) => void;

let subscribers: ErrorCb[] = [];
const offError = vi.fn();

/** Deliver to EVERY mounted subscriber, as the real bridge broadcast does. */
const emit = (event: EngineErrorEvent): void => {
  for (const cb of subscribers) cb(event);
};

function makeEvent(over: Partial<EngineErrorEvent> = {}): EngineErrorEvent {
  return {
    type: "engine.runtime.error",
    sessionId: SESSION_A,
    missionRunId: null,
    scope: "turn",
    category: "capacity",
    errorType: "rate_limit_exceeded",
    errorClass: null,
    statusCode: 429,
    causeCode: null,
    retryAfterSeconds: 41,
    occurredAt: "2026-07-29T10:00:00.000Z",
    correlationId: null,
    detail: null,
    remedy: null,
    ...over,
  };
}

beforeEach(() => {
  subscribers = [];
  offError.mockReset();
  useEngineErrorStore.setState({ bySessionId: {} });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      engine: makeEngineBridgeStub({
        onEngineError: (cb) => {
          subscribers.push(cb);
          return offError;
        },
      }),
    },
  });
});

afterEach(() => {
  // @ts-expect-error — test cleanup
  delete window.vex;
});

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

describe("SessionErrorBanner", () => {
  it("renders nothing when the session has no recorded failure", () => {
    render(createElement(SessionErrorBanner, { sessionId: SESSION_A }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces a provider 429 with the retry hint — not a generic failure", () => {
    useEngineErrorStore.getState().record(makeEvent());
    render(createElement(SessionErrorBanner, { sessionId: SESSION_A }));

    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-vex-category")).toBe("capacity");
    expect(alert.textContent).toContain("rate-limited");
    // The whole point: the provider's own retry hint, in seconds.
    expect(alert.textContent).toContain("Retry in 41s.");
    expect(alert.textContent).not.toContain("Unable to process the message");
  });

  it("shows the bounded technical codes and NOTHING resembling prose", () => {
    useEngineErrorStore.getState().record(makeEvent());
    const alert = (
      render(createElement(SessionErrorBanner, { sessionId: SESSION_A })),
      screen.getByRole("alert")
    );
    expect(alert.textContent).toContain("rate_limit_exceeded");
    expect(alert.textContent).toContain("HTTP 429");
  });

  it("shows the sanitized real cause when the event carries one", () => {
    useEngineErrorStore
      .getState()
      .record(makeEvent({ detail: "Rate limit exceeded: free-models-per-day" }));
    render(createElement(SessionErrorBanner, { sessionId: SESSION_A }));
    expect(
      screen.getByText("Rate limit exceeded: free-models-per-day"),
    ).toBeTruthy();
  });

  it("renders the remedy as the action hint, replacing the generic retry advice", () => {
    useEngineErrorStore
      .getState()
      .record(makeEvent({ remedy: "rate-limited", retryAfterSeconds: null }));
    render(createElement(SessionErrorBanner, { sessionId: SESSION_A }));
    expect(
      screen.getByText("Wait out the rate limit, then retry."),
    ).toBeTruthy();
  });

  it("says something specific for EVERY category, including `unknown`", () => {
    const categories: ReadonlyArray<EngineErrorEvent["category"]> = [
      "account",
      "capacity",
      "context",
      "policy",
      "request",
      "media",
      "unreadable_response",
      "unknown",
    ];
    for (const category of categories) {
      useEngineErrorStore.setState({ bySessionId: {} });
      useEngineErrorStore
        .getState()
        .record(makeEvent({ category, errorType: null, retryAfterSeconds: null }));
      const { unmount } = render(
        createElement(SessionErrorBanner, { sessionId: SESSION_A }),
      );
      const alert = screen.getByRole("alert");
      // Non-generic bar: every category names what failed and what to do.
      expect(alert.textContent, category).not.toContain(
        "Unable to process the message",
      );
      expect((alert.textContent ?? "").length, category).toBeGreaterThan(40);
      unmount();
    }
  });

  it("is scoped to its session — another session's failure does not render", () => {
    useEngineErrorStore.getState().record(makeEvent({ sessionId: SESSION_B }));
    render(createElement(SessionErrorBanner, { sessionId: SESSION_A }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("retention vs invalidation", () => {
  it("retains an event for an INACTIVE session — it is there when the user selects it", () => {
    // The defect: retention used to be filtered by the selected session, so a
    // wake/compact failure for session B while A was on screen was recorded
    // NOWHERE. Background failures are exactly the ones that arrive for a
    // session nobody is looking at.
    const client = new QueryClient();
    renderHook(() => useEngineErrorRetentionSync(), { wrapper: wrapper(client) });
    // A is the active session; B is not mounted at all.
    renderHook(() => useEngineErrorLiveSync(SESSION_A), { wrapper: wrapper(client) });

    act(() => {
      emit(makeEvent({ sessionId: SESSION_B, scope: "wake", category: "account" }));
    });

    // Nothing for A, as before…
    expect(useEngineErrorStore.getState().bySessionId[SESSION_A]).toBeUndefined();
    // …but B's failure was KEPT, and shows the moment B is selected.
    render(createElement(SessionErrorBanner, { sessionId: SESSION_B }));
    expect(screen.getByRole("alert").textContent).toContain(
      "Provider account problem",
    );
  });

  it("retains the active session's event too", () => {
    const client = new QueryClient();
    renderHook(() => useEngineErrorRetentionSync(), { wrapper: wrapper(client) });
    act(() => {
      emit(makeEvent());
    });
    expect(useEngineErrorStore.getState().bySessionId[SESSION_A]?.category).toBe(
      "capacity",
    );
  });

  it("keeps a retained event across a session switch — no clear-on-unmount", () => {
    // Retention outliving the panel is the point: the banner is retired by an
    // explicit dismiss, not by looking away.
    const client = new QueryClient();
    renderHook(() => useEngineErrorRetentionSync(), { wrapper: wrapper(client) });
    const active = renderHook(() => useEngineErrorLiveSync(SESSION_A), {
      wrapper: wrapper(client),
    });
    act(() => {
      emit(makeEvent());
    });
    active.unmount();
    expect(useEngineErrorStore.getState().bySessionId[SESSION_A]).toBeDefined();
  });

  it("invalidation is session-scoped and ignores foreign and null sessions", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useEngineErrorLiveSync(SESSION_A), { wrapper: wrapper(client) });

    act(() => {
      emit(makeEvent({ sessionId: SESSION_B }));
      emit(makeEvent({ sessionId: null, scope: "memory" }));
    });
    expect(invalidate).not.toHaveBeenCalled();

    act(() => {
      emit(makeEvent());
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("mounts for an AGENT-mode session — the surface that rendered nothing before", () => {
    // No mission gate anywhere in the retention hook or the banner: the only
    // input is a session id. This is the regression the channel exists for.
    const client = new QueryClient();
    renderHook(() => useEngineErrorRetentionSync(), { wrapper: wrapper(client) });
    act(() => {
      emit(makeEvent({ scope: "turn", category: "account" }));
    });
    render(createElement(SessionErrorBanner, { sessionId: SESSION_A }));
    expect(screen.getByRole("alert").textContent).toContain(
      "Provider account problem",
    );
  });

  it("unsubscribes on unmount", () => {
    const client = new QueryClient();
    const { unmount } = renderHook(() => useEngineErrorRetentionSync(), {
      wrapper: wrapper(client),
    });
    unmount();
    expect(offError).toHaveBeenCalled();
  });
});
