/**
 * `GlobalErrorBanner` + the null-session routing contract.
 *
 * The load-bearing rule, asserted from both directions:
 *  - a SESSION-LESS failure must reach the global surface and NEVER a session
 *    banner (it would tell the user their conversation broke when it did not);
 *  - a SESSION-SCOPED failure must reach that session's banner and NEVER be
 *    duplicated globally.
 *
 * Everything rendered is a bounded code turned into fixed copy from the same
 * classifier every other error surface uses. No provider prose exists at any
 * layer of this channel, so none can reach the DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, act, fireEvent, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { EngineErrorEvent } from "@shared/schemas/engine-error.js";
import { GlobalErrorBanner } from "../GlobalErrorBanner.js";
import { SessionErrorBanner } from "../SessionErrorBanner.js";
import {
  useEngineErrorLiveSync,
  useEngineErrorRetentionSync,
} from "../../../lib/api/engine-errors.js";
import {
  useEngineErrorStore,
  GLOBAL_ENGINE_ERROR_CAP,
} from "../../../stores/engineErrorStore.js";
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
  useEngineErrorStore.setState({ bySessionId: {}, global: [] });
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

describe("GlobalErrorBanner", () => {
  it("renders nothing when there is no system failure", () => {
    mountRetention();
    render(createElement(GlobalErrorBanner));
    // Flank stays empty when idle, like the approvals badge.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("surfaces a memory permanent failure with system framing and codes", () => {
    mountRetention();
    render(createElement(GlobalErrorBanner));
    emit(memoryFailure());

    fireEvent.click(screen.getByRole("button", { name: /system/i }));
    const dialog = screen.getByRole("dialog", { name: "System errors" });
    expect(dialog.textContent).toContain("Memory maintenance");
    // Same classifier + copy table as every other surface.
    expect(dialog.textContent).toContain("rate-limited");
    // Bounded technical trailer for a bug report.
    expect(dialog.textContent).toContain("rate_limit_exceeded");
    expect(dialog.textContent).toContain("HTTP 429");
    // Never session framing.
    expect(dialog.textContent).not.toContain("this turn");
  });

  it("dismisses ONE failure without touching the others", () => {
    mountRetention();
    render(createElement(GlobalErrorBanner));
    emit(memoryFailure({ errorType: "rate_limit_exceeded" }));
    emit(memoryFailure({ errorType: "server", category: "capacity" }));

    fireEvent.click(screen.getByRole("button", { name: /system 2/i }));
    const rows = screen.getAllByLabelText("Dismiss system error");
    expect(rows).toHaveLength(2);

    fireEvent.click(rows[0]!);
    expect(screen.getAllByLabelText("Dismiss system error")).toHaveLength(1);
    // Independent jobs, not one story retold — the second must survive.
    expect(screen.getByRole("dialog").textContent).toContain("rate_limit_exceeded");
  });

  it("disappears entirely once the last failure is dismissed", () => {
    mountRetention();
    render(createElement(GlobalErrorBanner));
    emit(memoryFailure());
    fireEvent.click(screen.getByRole("button", { name: /system/i }));
    fireEvent.click(screen.getByLabelText("Dismiss system error"));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /system/i })).toBeNull();
  });

  it("caps retained failures so a burst cannot grow without bound", () => {
    mountRetention();
    render(createElement(GlobalErrorBanner));
    for (let i = 0; i < GLOBAL_ENGINE_ERROR_CAP + 3; i += 1) {
      emit(memoryFailure({ occurredAt: `2026-07-29T10:00:0${i}.000Z` }));
    }
    expect(useEngineErrorStore.getState().global).toHaveLength(
      GLOBAL_ENGINE_ERROR_CAP,
    );
  });
});

describe("null-session routing - both directions", () => {
  it("a session-less failure NEVER reaches a session banner", () => {
    const client = new QueryClient();
    mountRetention();
    renderHook(() => useEngineErrorLiveSync(SESSION_A), {
      wrapper: wrapper(client),
    });
    render(createElement(GlobalErrorBanner));

    emit(memoryFailure());

    // The session hook must have ignored it outright.
    expect(useEngineErrorStore.getState().bySessionId[SESSION_A]).toBeUndefined();
    render(createElement(SessionErrorBanner, { sessionId: SESSION_A }));
    expect(screen.queryByRole("alert")).toBeNull();
    // …and the global surface must have taken it.
    expect(useEngineErrorStore.getState().global).toHaveLength(1);
  });

  it("a session-scoped failure NEVER reaches the global surface", () => {
    const client = new QueryClient();
    mountRetention();
    renderHook(() => useEngineErrorLiveSync(SESSION_A), {
      wrapper: wrapper(client),
    });
    render(createElement(GlobalErrorBanner));

    emit(memoryFailure({ sessionId: SESSION_A, scope: "turn" }));

    expect(useEngineErrorStore.getState().global).toHaveLength(0);
    expect(useEngineErrorStore.getState().bySessionId[SESSION_A]).toBeDefined();
    // No global badge — it would double-report a failure the session already owns.
    expect(screen.queryByRole("button", { name: /system/i })).toBeNull();
  });

  it("the store never keys a null session into bySessionId", () => {
    // Guards the routing at its source: a `null` stringified into a key would
    // create a phantom "null" session that no panel could ever clear.
    useEngineErrorStore.getState().record(memoryFailure());
    expect(Object.keys(useEngineErrorStore.getState().bySessionId)).toEqual([]);
  });
});
