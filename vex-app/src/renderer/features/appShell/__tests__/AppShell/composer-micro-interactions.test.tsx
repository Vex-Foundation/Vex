/**
 * Composer micro-interactions (R2-D2, ported from the deepseek InputBar's
 * discipline). Four behaviours, each of which the composer previously got
 * wrong in a way no other suite would catch:
 *
 *  - KEEP FOCUS: pressing the send or stop key moves focus off the draft, so
 *    the caret is lost and the next keystroke goes nowhere. Suppressing the
 *    default at MOUSEDOWN and refocusing is what keeps the composer typeable
 *    straight through a send;
 *  - CLEAR AS COMMIT: the draft clears the instant the message is dispatched.
 *    Sent content is not resurrectable from the field;
 *  - STOP MORPH: the primary key swaps in place while a turn runs, rather than
 *    a second control appearing beside it;
 *  - PLACEHOLDER PRECEDENCE: while a turn runs the field advertises what Send
 *    actually does then (steer, else queue), because the rotating idle
 *    suggestion is actively misleading at that moment.
 *
 * Plus the queue dock's density contract: one row inline, two or more behind
 * a collapse header, with an open editor pinning the list visible. Queue
 * SEMANTICS (order, content, drain) are pinned in `composer-console.test.tsx`
 * and are deliberately untouched here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  MissionRunStatus,
  SessionListItem,
} from "@shared/schemas/sessions.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { resetDraftsForTest } from "../../../../lib/composer-drafts.js";
import { resetComposerQueueForTest } from "../../../../lib/composer-queue.js";
import { resetSubmitKeyBehaviorForTest } from "../../../../lib/composer-submission-policy.js";

const mockChatSteer = vi.fn();

const mockSubmitChat = {
  isPending: false as boolean,
  mutateAsync: vi.fn(),
  stop: vi.fn(),
};
vi.mock("../../../../lib/api/chat.js", () => ({
  useSubmitChat: () => mockSubmitChat,
  // Session-filtered pending: the resident composer reads this, not the
  // hook-wide `isPending`. The fixture drives one session, so the two
  // answers coincide here.
  useIsChatSubmitting: () => mockSubmitChat.isPending,
}));
vi.mock("../../../../lib/api/messages.js", () => ({
  useTranscriptInfinite: () => ({ data: undefined, isSuccess: false }),
  flattenTranscriptPages: () => [],
}));

let runStatus: MissionRunStatus | null = null;
vi.mock("../../../../lib/api/runtime.js", () => ({
  useRuntimeState: () => ({ data: { ok: true, data: { status: runStatus } } }),
  useRequestStop: () => ({ mutateAsync: async () => undefined }),
}));
vi.mock("../../../../lib/api/models.js", () => ({
  useAvailableModels: () => ({ data: undefined }),
}));
vi.mock("../../../../lib/api/usage.js", () => ({
  useContextWindow: () => ({ data: undefined }),
}));
vi.mock("../../../../lib/api/sessions.js", () => ({
  useSessionPlan: () => ({ data: { ok: true, data: null } }),
  useExportSessionMarkdown: () => ({ isPending: false, mutate: vi.fn() }),
}));
// Heavy leaf surfaces: irrelevant to the capsule's interaction contract.
vi.mock("../../PlanDisplayModal.js", () => ({ PlanDisplayModal: () => null }));
vi.mock("../../SessionExportDialog.js", () => ({
  SessionExportDialog: () => null,
}));
vi.mock("../../../wizard/steps/provider/ModelBrandIcon.js", () => ({
  ModelBrandIcon: () => null,
}));

const { SessionComposer, STEER_QUEUE_PLACEHOLDER } = await import(
  "../../SessionComposer.js"
);

const SESSION = "00000000-0000-4000-8000-00000000dd01";

function agentRow(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: SESSION,
    mode: "agent",
    permission: "restricted",
    title: "Console",
    initialGoal: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    missionStatus: null,
    pinnedAt: null,
    ...over,
  };
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockChatSteer.mockResolvedValue({
    ok: true,
    data: { outcome: "no_active_turn" },
  });
  const bridge = (window as unknown as { vex?: { chat?: Record<string, unknown> } })
    .vex;
  if (bridge !== undefined) {
    bridge.chat = { ...(bridge.chat ?? {}), steer: mockChatSteer };
  } else {
    (window as unknown as { vex: unknown }).vex = { chat: { steer: mockChatSteer } };
  }
  mockSubmitChat.isPending = false;
  mockSubmitChat.mutateAsync.mockResolvedValue({
    ok: true,
    data: { stopReason: "completed", treatedAsInitialGoal: false, toolCallsMade: 0 },
  });
  runStatus = null;
  resetDraftsForTest();
  resetComposerQueueForTest();
  window.localStorage.clear();
  resetSubmitKeyBehaviorForTest();
  useUiStore.setState({ createSessionInitialTurn: null });
});

function draftField(): HTMLTextAreaElement {
  return screen.getByLabelText("Session draft") as HTMLTextAreaElement;
}

function typeDraft(value: string): void {
  const field = draftField();
  fireEvent.change(field, { target: { value } });
  field.setSelectionRange(value.length, value.length);
  fireEvent.select(field);
}

describe("composer micro-interactions - keep focus", () => {
  it("a mousedown on the SEND key is defaultPrevented and returns focus to the draft", () => {
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    typeDraft("hello");
    const field = draftField();
    field.blur();
    expect(document.activeElement).not.toBe(field);

    const send = screen.getByRole("button", { name: "Send message" });
    const prevented = !fireEvent.mouseDown(send);
    // Suppressing the default is what stops the browser from moving focus to
    // the button in the first place; the refocus covers engines that already
    // moved it.
    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(field);
  });

  it("a mousedown on the STOP key keeps the draft focused too", () => {
    mockSubmitChat.isPending = true;
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    const field = draftField();
    field.blur();
    const stop = screen.getByRole("button", { name: "Stop generating" });
    const prevented = !fireEvent.mouseDown(stop);
    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(field);
  });
});

describe("composer micro-interactions - clear as commit and the stop morph", () => {
  it("clears the draft on dispatch, with no resurrectable text left in the field", async () => {
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    typeDraft("send this");
    fireEvent.submit(
      container.querySelector('[data-vex-area="chat-composer"]') as HTMLFormElement,
    );
    await waitFor(() => expect(mockSubmitChat.mutateAsync).toHaveBeenCalled());
    expect(draftField().value).toBe("");
  });

  it("morphs the PRIMARY key into Stop rather than adding a second control", () => {
    const idle = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop generating" })).toBeNull();
    idle.unmount();

    mockSubmitChat.isPending = true;
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    // One key in the slot: Stop replaced Send, it did not join it.
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  });
});

describe("composer micro-interactions - placeholder precedence", () => {
  it("the steer/queue hint outranks the rotating default while a turn runs", () => {
    const idle = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const overlay = idle.container.querySelector(
      "[data-vex-composer-placeholder]",
    );
    expect(overlay?.textContent).not.toBe(STEER_QUEUE_PLACEHOLDER);
    idle.unmount();

    mockSubmitChat.isPending = true;
    const busy = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    expect(
      busy.container.querySelector("[data-vex-composer-placeholder]")?.textContent,
    ).toBe(STEER_QUEUE_PLACEHOLDER);
  });

  it("mission copy still outranks the steer hint - the run owns the field", () => {
    mockSubmitChat.isPending = true;
    const { container } = render(
      <SessionComposer
        activeSession={agentRow({ mode: "mission", initialGoal: "Watch gas" })}
        activeSessionId={SESSION}
      />,
    );
    expect(
      container.querySelector("[data-vex-composer-placeholder]")?.textContent,
    ).not.toBe(STEER_QUEUE_PLACEHOLDER);
  });
});

describe("composer queue dock - attached surface density", () => {
  async function queueMessages(
    container: HTMLElement,
    texts: readonly string[],
  ): Promise<void> {
    for (const text of texts) {
      typeDraft(text);
      fireEvent.submit(
        container.querySelector(
          '[data-vex-area="chat-composer"]',
        ) as HTMLFormElement,
      );
      await waitFor(() => expect(draftField().value).toBe(""));
    }
  }

  it("renders ONE pending row inline, with no collapse header", async () => {
    mockSubmitChat.isPending = true;
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    await queueMessages(container, ["only one"]);
    const dock = container.querySelector('[data-vex-area="composer-queue-dock"]');
    expect(dock?.textContent).toContain("only one");
    expect(dock?.querySelector("[aria-expanded]")).toBeNull();
  });

  it("collapses TWO OR MORE rows behind an aria-expanded header, and expands on click", async () => {
    mockSubmitChat.isPending = true;
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    await queueMessages(container, ["first queued", "second queued"]);
    const dock = container.querySelector(
      '[data-vex-area="composer-queue-dock"]',
    ) as HTMLElement;
    const header = dock.querySelector("[aria-expanded]") as HTMLButtonElement;
    expect(header).not.toBeNull();
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.textContent).toContain("2 queued messages");
    expect(dock.getAttribute("data-expanded")).toBe("false");
    // `aria-controls` must name the list it toggles, or the state is
    // announced against nothing.
    const listId = header.getAttribute("aria-controls");
    expect(listId).not.toBeNull();
    // Looked up by attribute rather than by id selector: React's useId emits
    // colons, which are not valid in a bare CSS id selector.
    expect(dock.querySelector(`[id="${listId as string}"]`)).not.toBeNull();

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(dock.getAttribute("data-expanded")).toBe("true");
    expect(dock.textContent).toContain("first queued");
  });

  it("an open editor pins the rows visible even from the collapsed default", async () => {
    mockSubmitChat.isPending = true;
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    await queueMessages(container, ["alpha", "beta"]);
    const dock = container.querySelector(
      '[data-vex-area="composer-queue-dock"]',
    ) as HTMLElement;
    const header = dock.querySelector("[aria-expanded]") as HTMLButtonElement;
    fireEvent.click(header);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Edit queued message" })[0] as HTMLElement,
    );
    // Collapsing while an editor is open must not hide the row being edited.
    fireEvent.click(header);
    expect(dock.getAttribute("data-expanded")).toBe("true");
    // The row under edit is still on screen: the inline editor holds its own
    // text, and the untouched sibling row still shows its content.
    expect(
      screen.getByRole("textbox", { name: "Edit queued message" }),
    ).toBeTruthy();
    expect(dock.textContent).toContain("beta");
  });
});
