/**
 * LIGHTER DESK ROW ACTIONS reach the agent through the resident composer,
 * exactly like a board question (`composer-board-ask.test.tsx`): the same
 * dispatch, session-keyed, consumed once. Close / Cancel / Cancel all /
 * Deposit are chat messages; the approval card is the only thing that can
 * execute them.
 */

import type { SessionListItem } from "@shared/schemas/sessions.js";
import { makeSessionRows } from "./AppShell/_appshell-render.js";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, StrictMode, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readQueue, resetComposerQueueForTest } from "../../../lib/composer-queue.js";
import { resetDraftsForTest } from "../../../lib/composer-drafts.js";
import { notifications } from "../../../lib/notifications/index.js";
import { useDeskScopeStore } from "../lighterTrading/desk-scope.js";
import { publishDeskSend, useDeskSendIntentStore } from "../lighterTrading/desk-send-intent.js";

const mockSteer = vi.fn();
const mockMutateAsync = vi.fn();
const mockUseRuntimeState = vi.fn();
let submitPending = false;

vi.mock("../../../lib/api/chat.js", () => ({
  useSubmitChat: () => ({ mutateAsync: mockMutateAsync, stop: vi.fn() }),
  useIsChatSubmitting: (sessionId: string | null) =>
    submitPending && sessionId === SESSION,
}));

vi.mock("../../../lib/api/runtime.js", () => ({
  useRuntimeState: (...a: unknown[]) => mockUseRuntimeState(...a),
  useRequestStop: () => ({ mutateAsync: vi.fn() }),
}));

const { useComposerSubmit } = await import("../composer-submit.js");

const SESSION = "00000000-0000-4000-8000-000000000001";
const OTHER_SESSION = "00000000-0000-4000-8000-000000000002";
const MESSAGE = "Close my entire ETH long on Lighter now; environment=core; marketId=1";

const [SESSION_ROW] = makeSessionRows();
if (SESSION_ROW === undefined) throw new Error("session fixture rows are empty");
const AGENT_SESSION: SessionListItem = { ...SESSION_ROW, id: SESSION, mode: "agent" };

function providers(strict: boolean) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const tree = createElement(QueryClientProvider, { client }, children);
    return strict ? createElement(StrictMode, null, tree) : tree;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  submitPending = false;
  resetComposerQueueForTest();
  resetDraftsForTest();
  mockUseRuntimeState.mockReturnValue({
    data: { ok: true, data: { sessionId: SESSION, status: null, leaseActive: false, stoppable: false } },
  });
  mockMutateAsync.mockResolvedValue({ ok: true, data: { stopReason: "end_turn", toolCallsMade: 0 } });
  mockSteer.mockResolvedValue({ ok: true, data: { outcome: "queued_live" } });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { chat: { steer: mockSteer } },
  });
  useDeskSendIntentStore.setState({ intent: null });
  useDeskScopeStore.setState({ tag: null });
});

afterEach(() => {
  notifications.reset();
  cleanup();
  useDeskSendIntentStore.setState({ intent: null });
  useDeskScopeStore.setState({ tag: null });
  Object.defineProperty(window, "vex", { configurable: true, writable: true, value: undefined });
});

describe("Lighter desk row actions through the resident composer", () => {
  it("idle session: the message is submitted verbatim and the slot is consumed", async () => {
    renderHook(() => useComposerSubmit(SESSION, AGENT_SESSION, false, null), { wrapper: providers(false) });
    await act(async () => {
      publishDeskSend(SESSION, MESSAGE);
    });
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(mockMutateAsync.mock.calls[0]?.[0]).toEqual({ sessionId: SESSION, message: MESSAGE });
    expect(useDeskSendIntentStore.getState().intent).toBeNull();
  });

  it("a turn in flight: the action steers the live turn like a typed message", async () => {
    submitPending = true;
    renderHook(() => useComposerSubmit(SESSION, AGENT_SESSION, false, null), { wrapper: providers(false) });
    await act(async () => {
      publishDeskSend(SESSION, MESSAGE);
    });
    await waitFor(() => {
      expect(mockSteer).toHaveBeenCalledTimes(1);
    });
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("an intent for ANOTHER session is dropped, never sent into this one", async () => {
    renderHook(() => useComposerSubmit(SESSION, AGENT_SESSION, false, null), { wrapper: providers(false) });
    await act(async () => {
      publishDeskSend(OTHER_SESSION, MESSAGE);
    });
    await waitFor(() => {
      expect(useDeskSendIntentStore.getState().intent).toBeNull();
    });
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(mockSteer).not.toHaveBeenCalled();
    expect(readQueue(SESSION)).toHaveLength(0);
  });

  it("StrictMode's double effect sends a close exactly once", async () => {
    renderHook(() => useComposerSubmit(SESSION, AGENT_SESSION, false, null), { wrapper: providers(true) });
    await act(async () => {
      publishDeskSend(SESSION, MESSAGE);
    });
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
  });
});

describe("Lighter desk scope on typed messages", () => {
  const TAG = "Lighter desk scope: environment=core, marketId=1, symbol=BTC, candleInterval=15m.";
  const submitEvent = { preventDefault: () => {} } as unknown as React.FormEvent<HTMLFormElement>;

  it("appends the desk's scope tag to what was typed, and only to what was typed", async () => {
    useDeskScopeStore.setState({ tag: TAG });
    const { result } = renderHook(() => useComposerSubmit(SESSION, AGENT_SESSION, false, null), { wrapper: providers(false) });
    act(() => { result.current.setDraft("should I trim?"); });
    await act(async () => { await result.current.onSubmit(submitEvent); });
    expect(mockMutateAsync.mock.calls[0]?.[0]).toEqual({ sessionId: SESSION, message: `should I trim?\n\n${TAG}` });
    expect(result.current.draft).toBe("");

    // A row action already names its scope: the tag is not appended twice.
    await act(async () => { publishDeskSend(SESSION, MESSAGE); });
    await waitFor(() => { expect(mockMutateAsync).toHaveBeenCalledTimes(2); });
    expect(mockMutateAsync.mock.calls[1]?.[0]).toEqual({ sessionId: SESSION, message: MESSAGE });
  });

  it("outside the desk the typed message goes as is", async () => {
    const { result } = renderHook(() => useComposerSubmit(SESSION, AGENT_SESSION, false, null), { wrapper: providers(false) });
    act(() => { result.current.setDraft("gm vex"); });
    await act(async () => { await result.current.onSubmit(submitEvent); });
    expect(mockMutateAsync.mock.calls[0]?.[0]).toEqual({ sessionId: SESSION, message: "gm vex" });
  });
});
