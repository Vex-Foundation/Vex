/**
 * Engine failures on the notification model, and the null-session routing
 * contract that outlived the retired `GlobalErrorBanner` pill.
 *
 * The load-bearing rules, asserted from both directions:
 *  - a SESSION-LESS failure must reach the app-wide surface and NEVER a
 *    session card (it would tell the user their conversation broke when it did
 *    not);
 *  - a SESSION-SCOPED failure must reach that session's card and never be
 *    duplicated as a second global signal.
 *
 * What the migration ADDED, and what the retired pill could not do:
 *  - every failure is ANNOUNCED. The pill rendered a badge in the header flank
 *    with no live region at all, so a memory job could die and nobody was
 *    told;
 *  - retention is bounded by the model with the eviction COUNTED, instead of a
 *    silent five-entry list;
 *  - the card and the notification are bound, so the same failure cannot be
 *    live in one surface and dismissed in the other.
 *
 * Everything rendered is a bounded code turned into fixed copy from the same
 * classifier every other error surface uses. No provider prose exists at any
 * layer of this channel, so none can reach the DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { EngineErrorEvent } from "@shared/schemas/engine-error.js";
import { SessionErrorBanner } from "../SessionErrorBanner.js";
import { NotificationCenter } from "../NotificationCenter.js";
import { NotificationAnnouncer } from "../../../components/ui/notification-announcer.js";
import {
  useEngineErrorLiveSync,
  useEngineErrorRetentionSync,
} from "../../../lib/api/engine-errors.js";
import { useEngineErrorStore } from "../../../stores/engineErrorStore.js";
import { sessionNotificationId } from "../../../stores/engine-error-notice.js";
import { notifications, HISTORY_CAP } from "../../../lib/notifications/index.js";
import { makeEngineBridgeStub } from "../../../test/engine-bridge-stub.js";

const SESSION_A = "00000000-0000-4000-8000-00000000000a";

type ErrorCb = (event: EngineErrorEvent) => void;
let subscribers: ErrorCb[] = [];
const offError = vi.fn();

function memoryFailure(over: Partial<EngineErrorEvent> = {}): EngineErrorEvent {
  return {
    type: "engine.runtime.error",
    sessionId: null,
    missionRunId: null,
    scope: "memory",
    category: "capacity",
    errorType: "rate_limit_exceeded",
    errorClass: null,
    statusCode: 429,
    causeCode: null,
    retryAfterSeconds: null,
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
  notifications.reset();
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
  cleanup();
  notifications.reset();
  // @ts-expect-error - test cleanup
  delete window.vex;
});

const emit = (event: EngineErrorEvent): void => {
  act(() => {
    for (const cb of subscribers) cb(event);
  });
};

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

/** Mount app-wide retention, as the shell does. */
function mountRetention(): void {
  renderHook(() => useEngineErrorRetentionSync(), {
    wrapper: wrapper(new QueryClient()),
  });
}

function messages(): readonly string[] {
  return notifications.getSnapshot().items.map((item) => item.message);
}

function cardOrNull(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-vex-area="session-error-banner"]');
}

describe("session-less failures become notifications", () => {
  it("carries system framing, the classifier copy and the bounded codes into one row", () => {
    mountRetention();
    render(createElement(NotificationCenter));
    emit(memoryFailure({ detail: "upstream returned 429 for embeddings" }));

    const item = notifications.getSnapshot().items[0];
    expect({
      title: item?.title,
      source: item?.source,
      severity: item?.severity,
      scope: item?.scope,
    }).toEqual({
      title: "Memory maintenance - Provider rate-limited or unavailable",
      source: "engine",
      severity: "error",
      scope: { kind: "global" },
    });
    // Same classifier + copy table as every other surface, plus the sanitized
    // detail and the technical trailer a user quotes in a bug report.
    expect(item?.message).toContain("upstream returned 429 for embeddings");
    expect(item?.message).toContain("rate_limit_exceeded");
    expect(item?.message).toContain("HTTP 429");
    // Never session framing.
    expect(item?.message).not.toContain("this turn");
  });

  it("ANNOUNCES the failure, which the retired header pill never did", () => {
    mountRetention();
    render(createElement(NotificationAnnouncer));
    emit(memoryFailure());

    const region = document.querySelector("[data-vex-live-region]");
    expect(region?.textContent).toContain("Memory maintenance");
  });

  it("keeps independent jobs independent: two failures are two rows, dismissed one at a time", () => {
    mountRetention();
    render(createElement(NotificationCenter));
    emit(memoryFailure({ errorType: "rate_limit_exceeded" }));
    emit(memoryFailure({ errorType: "server" }));
    expect(messages()).toHaveLength(2);

    const first = notifications.getSnapshot().items[0];
    if (first === undefined) throw new Error("expected a notification");
    notifications.close(first.id, "user");

    // Independent jobs, not one story retold - the second must survive.
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain("rate_limit_exceeded");
  });

  it("bounds a burst and REPORTS what it evicted, instead of dropping silently", () => {
    mountRetention();
    render(createElement(NotificationCenter));
    for (let index = 0; index < HISTORY_CAP + 3; index += 1) {
      emit(memoryFailure({ occurredAt: `2026-07-29T10:00:${String(index).padStart(2, "0")}.000Z` }));
    }

    act(() => {
      screen.getByRole("button", { name: /notifications/ }).click();
    });
    const snapshot = notifications.getSnapshot();
    expect({
      retained: snapshot.items.length,
      dropped: snapshot.droppedFromHistory,
      stated: screen.getByText(/dropped by the retention cap/).textContent,
    }).toEqual({
      retained: HISTORY_CAP,
      dropped: 3,
      stated: "3 older notifications dropped by the retention cap",
    });
  });
});

describe("session-scoped failures: card and notification, bound", () => {
  it("raises ONE notification per session and replaces it on the next failure", () => {
    mountRetention();
    renderHook(() => useEngineErrorLiveSync(SESSION_A), {
      wrapper: wrapper(new QueryClient()),
    });
    emit(memoryFailure({ sessionId: SESSION_A, scope: "turn" }));
    emit(memoryFailure({ sessionId: SESSION_A, scope: "turn", category: "context" }));

    const items = notifications.getSnapshot().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(sessionNotificationId(SESSION_A));
    expect(items[0]?.scope).toEqual({ kind: "session", sessionId: SESSION_A });
    // A burst is one story retold; the newest is what the user acts on, and
    // the replacement must not be mistaken for the user dismissing the card.
    expect(useEngineErrorStore.getState().bySessionId[SESSION_A]).toBeDefined();
  });

  it("dismissing the CARD closes the notification", () => {
    mountRetention();
    render(createElement(SessionErrorBanner, { sessionId: SESSION_A }));
    emit(memoryFailure({ sessionId: SESSION_A, scope: "turn" }));
    expect(notifications.getSnapshot().items).toHaveLength(1);

    act(() => {
      screen.getByLabelText("Dismiss error").click();
    });
    expect(notifications.getSnapshot().items).toHaveLength(0);
    expect(cardOrNull()).toBeNull();
  });

  it("dismissing the NOTIFICATION clears the card", () => {
    mountRetention();
    render(createElement(SessionErrorBanner, { sessionId: SESSION_A }));
    emit(memoryFailure({ sessionId: SESSION_A, scope: "turn" }));
    expect(cardOrNull()).not.toBeNull();

    act(() => {
      notifications.close(sessionNotificationId(SESSION_A), "user");
    });
    expect(cardOrNull()).toBeNull();
    expect(useEngineErrorStore.getState().bySessionId[SESSION_A]).toBeUndefined();
  });
});

describe("null-session routing - both directions", () => {
  it("a session-less failure NEVER reaches a session card", () => {
    mountRetention();
    renderHook(() => useEngineErrorLiveSync(SESSION_A), {
      wrapper: wrapper(new QueryClient()),
    });
    emit(memoryFailure());

    expect(useEngineErrorStore.getState().bySessionId[SESSION_A]).toBeUndefined();
    render(createElement(SessionErrorBanner, { sessionId: SESSION_A }));
    expect(cardOrNull()).toBeNull();
    // ...and the app-wide surface must have taken it, scoped globally.
    expect(notifications.getSnapshot().items[0]?.scope).toEqual({ kind: "global" });
  });

  it("a session-scoped failure is never scoped globally", () => {
    mountRetention();
    renderHook(() => useEngineErrorLiveSync(SESSION_A), {
      wrapper: wrapper(new QueryClient()),
    });
    emit(memoryFailure({ sessionId: SESSION_A, scope: "turn" }));

    expect(
      notifications.getSnapshot().items.map((item) => item.scope),
    ).toEqual([{ kind: "session", sessionId: SESSION_A }]);
    expect(useEngineErrorStore.getState().bySessionId[SESSION_A]).toBeDefined();
  });

  it("the store never keys a null session into bySessionId", () => {
    // Guards the routing at its source: a `null` stringified into a key would
    // create a phantom "null" session that no panel could ever clear.
    act(() => {
      useEngineErrorStore.getState().record(memoryFailure());
    });
    expect(Object.keys(useEngineErrorStore.getState().bySessionId)).toEqual([]);
  });
});
