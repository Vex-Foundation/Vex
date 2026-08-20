/**
 * Composer capsule contract (UIUX rebrand F3). Mounts the real
 * `SessionComposer` with the lib/api hooks mocked and pins:
 *
 *  - the capsule chrome (r22 card, catalog geometry, NO focus treatment -
 *    the CSS pins scan the raw stylesheet, the jsdom pins the classNames);
 *  - the 34px round accent send key and its pending-dot state;
 *  - the approval echo (amber border + floating AWAITING SIGNATURE tag);
 *  - the rotating faux-placeholder overlay;
 *  - the starter chips (visible on welcome, gone while typing, fixed slot);
 *  - the slash-command combobox (opens on "/", keyboard drive with focus
 *    held in the textarea, command execution -> toast/draft effects);
 *  - the submission policy (Enter vs Cmd/Ctrl+Enter via the persisted
 *    preference) and the queue-on-busy submit path with its dock;
 *  - the seats (permission chip, context ring, plan chip) and per-session
 *    draft persistence.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type {
  MissionRunStatus,
  SessionListItem,
} from "@shared/schemas/sessions.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { resetDraftsForTest } from "../../../../lib/composer-drafts.js";
import { resetComposerQueueForTest } from "../../../../lib/composer-queue.js";
import {
  resetSubmitKeyBehaviorForTest,
  setSubmitKeyBehavior,
} from "../../../../lib/composer-submission-policy.js";
import { getToastSnapshot } from "../../../../lib/toast.js";

const mockChatSteer = vi.fn();

const mockSubmitChat = {
  isPending: false as boolean,
  mutateAsync: vi.fn(),
  stop: vi.fn(),
};
vi.mock("../../../../lib/api/chat.js", () => ({
  useSubmitChat: () => mockSubmitChat,
}));
vi.mock("../../../../lib/api/messages.js", () => ({
  useTranscriptInfinite: () => ({ data: undefined, isSuccess: false }),
  flattenTranscriptPages: () => [],
}));

// Runtime status is reconfigurable so the approval-echo test can drive
// `paused_approval` while every other test stays on the free (null) state.
let runStatus: MissionRunStatus | null = null;
vi.mock("../../../../lib/api/runtime.js", () => ({
  useRuntimeState: () => ({ data: { ok: true, data: { status: runStatus } } }),
  useRequestStop: () => ({ mutateAsync: async () => undefined }),
}));

vi.mock("../../../../lib/api/models.js", () => ({
  // Capability unknown → the REASON control stays a quiet placeholder.
  useAvailableModels: () => ({ data: undefined }),
}));

// Context window is reconfigurable so the ring tests can drive a limit.
let contextWindow: {
  tokensUsed: number;
  contextLimit: number | null;
  pressureWarningFraction?: number;
  pressureCriticalFraction?: number;
} | null = null;
vi.mock("../../../../lib/api/usage.js", () => ({
  useContextWindow: () => ({
    data: contextWindow === null ? undefined : { ok: true, data: contextWindow },
  }),
}));

let sessionPlan: { enabled: boolean; accepted: boolean } | null = null;
vi.mock("../../../../lib/api/sessions.js", () => ({
  useSessionPlan: () => ({ data: { ok: true, data: sessionPlan } }),
  useExportSessionMarkdown: () => ({ isPending: false, mutate: vi.fn() }),
}));

// Heavy leaf surfaces: the modal renders markdown and the brand icon pulls
// the @thesvg registry - both irrelevant to the capsule contract.
vi.mock("../../PlanDisplayModal.js", () => ({
  PlanDisplayModal: () => null,
}));
vi.mock("../../SessionExportDialog.js", () => ({
  SessionExportDialog: () => null,
}));
vi.mock("../../../wizard/steps/provider/ModelBrandIcon.js", () => ({
  ModelBrandIcon: () => null,
}));

const { SessionComposer } = await import("../../SessionComposer.js");
const { WELCOME_PLACEHOLDERS } = await import("../../composer-placeholders.js");

// The capsule's chrome (border/shadow/pending dot) lives in console.css -
// pseudo/keyframe rules jsdom cannot compute, so pin them against the raw
// stylesheet source (the shell-design-guard raw-scan idiom).
const CONSOLE_CSS = readFileSync(
  join(process.cwd(), "src/renderer/styles/global-css/console.css"),
  "utf8",
);

const SESSION = "00000000-0000-4000-8000-00000000cc01";

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
  // A33: the busy-branch steers before queueing; default to "no live turn"
  // so pre-steering scenarios keep their queue semantics.
  mockChatSteer.mockResolvedValue({ ok: true, data: { outcome: "no_active_turn" } });
  const bridge = (window as unknown as { vex?: { chat?: Record<string, unknown> } }).vex;
  if (bridge !== undefined) {
    bridge.chat = { ...(bridge.chat ?? {}), steer: mockChatSteer };
  } else {
    (window as unknown as { vex: unknown }).vex = { chat: { steer: mockChatSteer } };
  }
  mockSubmitChat.isPending = false;
  mockSubmitChat.mutateAsync.mockResolvedValue({
    ok: true,
    data: {
      stopReason: "completed",
      treatedAsInitialGoal: false,
      toolCallsMade: 0,
    },
  });
  runStatus = null;
  contextWindow = null;
  sessionPlan = null;
  resetDraftsForTest();
  resetComposerQueueForTest();
  window.localStorage.clear();
  resetSubmitKeyBehaviorForTest();
  useUiStore.setState({ createSessionInitialTurn: null });
});

function draftField(): HTMLTextAreaElement {
  return screen.getByLabelText("Session draft") as HTMLTextAreaElement;
}

/** Type into the field with the caret reported at the end (onSelect). */
function typeDraft(value: string): void {
  const field = draftField();
  fireEvent.change(field, { target: { value } });
  field.setSelectionRange(value.length, value.length);
  fireEvent.select(field);
}

describe("composer capsule - chrome", () => {
  it("wraps the composer in the r22 capsule card at the 780px catalog width", () => {
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const form = container.querySelector('[data-vex-area="chat-composer"]');
    expect(form).not.toBeNull();
    expect(form?.className).toContain("vex-composer-card");
    expect(form?.className).toContain("max-w-[780px]");
    expect(form?.getAttribute("data-vex-composer-state")).toBe("input");
  });

  it("the textarea caps at the 336px catalog height, carries the accent caret, and wears NO focus ring", () => {
    render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const field = draftField();
    expect(field.className).toContain("max-h-[336px]");
    expect(field.className).toContain("caret-accent-primary");
    expect(field.className).not.toMatch(/focus-visible|ring/);
  });

  it("raw-CSS contract: r22 card on the input border + lv2 shadow, and NO focus treatment anywhere in the chrome", () => {
    expect(CONSOLE_CSS).toContain("border-radius: 22px");
    expect(CONSOLE_CSS).toContain("var(--vex-alias-border-input)");
    expect(CONSOLE_CSS).toContain("var(--shadow-lv2)");
    // The catalog capsule has no focus ring and no focus border step: no
    // rule block selects on focus (a prose mention in a comment is fine).
    expect(CONSOLE_CSS).not.toContain(":focus-within");
    expect(CONSOLE_CSS).not.toMatch(/:focus[^)]*\{/);
  });

  it("raw-CSS contract: the pending dot runs 1s ease-in-out infinite alternate with a reduced-motion still", () => {
    expect(CONSOLE_CSS).toContain(
      "animation: vex-composer-pending 1s ease-in-out infinite alternate",
    );
    expect(CONSOLE_CSS).toContain("prefers-reduced-motion: reduce");
  });

  it("recolors the capsule amber + floats the AWAITING SIGNATURE tag while awaiting a signature", () => {
    runStatus = "paused_approval";
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const form = container.querySelector('[data-vex-area="chat-composer"]');
    expect(form?.getAttribute("data-vex-composer-state")).toBe("approval");
    expect(screen.getByText("AWAITING SIGNATURE")).toBeTruthy();
  });
});

describe("composer capsule - send key", () => {
  it("the send key is the 34px round accent control: disabled while empty, armed once typed", () => {
    render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const send = screen.getByRole("button", {
      name: "Send message",
    }) as HTMLButtonElement;
    expect(send.className).toContain("h-[34px]");
    expect(send.className).toContain("w-[34px]");
    expect(send.className).toContain("rounded-full");
    expect(send.className).toContain("bg-accent-primary");
    expect(send.disabled).toBe(true);
    typeDraft("buy the dip");
    expect(send.disabled).toBe(false);
  });

  it("a turn in flight shows the pending dot beside the key and swaps Send for Stop", () => {
    mockSubmitChat.isPending = true;
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const pending = container.querySelector("[data-vex-composer-pending]");
    expect(pending).not.toBeNull();
    expect(pending?.querySelector(".vex-composer-pending-dot")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy();
  });
});

describe("composer capsule - placeholder + starter chips", () => {
  it("opens on the first rotating welcome prompt as an aria-hidden overlay - no native placeholder", () => {
    const { container } = render(
      <SessionComposer activeSession={null} activeSessionId={null} />,
    );
    expect(draftField().getAttribute("placeholder")).toBeNull();
    const overlay = container.querySelector("[data-vex-composer-placeholder]");
    expect(overlay?.getAttribute("aria-hidden")).toBe("true");
    expect(overlay?.textContent).toBe(WELCOME_PLACEHOLDERS[0]);
  });

  it("hides the faux placeholder while the draft holds text, like a native placeholder", () => {
    const { container } = render(
      <SessionComposer activeSession={null} activeSessionId={null} />,
    );
    typeDraft("typed");
    expect(
      container.querySelector("[data-vex-composer-placeholder]"),
    ).toBeNull();
  });

  it("starter chips greet the welcome stage inside a fixed-height slot that survives typing", () => {
    const { container } = render(
      <SessionComposer activeSession={null} activeSessionId={null} />,
    );
    const slot = container.querySelector(".h-\\[60px\\]");
    expect(slot).not.toBeNull();
    typeDraft("typing now");
    expect(container.querySelector(".h-\\[60px\\]")).not.toBeNull();
  });
});

describe("composer capsule - slash commands (combobox)", () => {
  it('typing "/" opens the command listbox with the full roster while focus stays in the textarea', () => {
    render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const field = draftField();
    field.focus();
    typeDraft("/");
    const listbox = screen.getByRole("listbox", { name: "Composer commands" });
    expect(listbox.querySelectorAll('[role="option"]').length).toBe(5);
    expect(document.activeElement).toBe(field);
  });

  it("ArrowDown moves the highlight via aria-activedescendant - the options never take focus", () => {
    render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const field = draftField();
    typeDraft("/");
    const first = field.getAttribute("aria-activedescendant");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    const second = field.getAttribute("aria-activedescendant");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(document.activeElement).not.toBeInstanceOf(HTMLButtonElement);
  });

  it("Escape dismisses the menu for the current token", () => {
    render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    typeDraft("/");
    fireEvent.keyDown(draftField(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Enter picks the highlighted command: /clear-draft empties the field and confirms with a toast", () => {
    render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const field = draftField();
    typeDraft("/clear");
    expect(
      screen.getByRole("listbox").querySelectorAll('[role="option"]').length,
    ).toBe(1);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field.value).toBe("");
    expect(getToastSnapshot()?.text).toBe("Draft cleared.");
    // The command consumed the Enter - no chat submit fired.
    expect(mockSubmitChat.mutateAsync).not.toHaveBeenCalled();
  });

  it("a slash glued to a word opens nothing - '3/4' types through silently", () => {
    render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    typeDraft("3/4");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("composer capsule - submission policy (B13)", () => {
  it("plain Enter submits under the default policy", async () => {
    render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    typeDraft("send this");
    fireEvent.keyDown(draftField(), { key: "Enter" });
    await waitFor(() =>
      expect(mockSubmitChat.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: SESSION, message: "send this" }),
      ),
    );
  });

  it("under mod-enter, plain Enter stays a newline and Ctrl+Enter submits", async () => {
    setSubmitKeyBehavior("mod-enter");
    render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    typeDraft("multi line thought");
    fireEvent.keyDown(draftField(), { key: "Enter" });
    expect(mockSubmitChat.mutateAsync).not.toHaveBeenCalled();
    fireEvent.keyDown(draftField(), { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(mockSubmitChat.mutateAsync).toHaveBeenCalledTimes(1),
    );
  });
});

describe("composer capsule - queue on busy (A27)", () => {
  it("a submit while a turn is in flight queues the message into the visible dock instead of dropping it", async () => {
    // A33 changed this path's first resort: a mid-turn submit STEERS the
    // live turn, and the A27 queue is the fallback. This test pins the
    // fallback: steering refused (no_active_turn) -> the dock gets the row.
    mockChatSteer.mockResolvedValue({ ok: true, data: { outcome: "no_active_turn" } });
    mockSubmitChat.isPending = true;
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    typeDraft("follow-up while busy");
    fireEvent.submit(
      container.querySelector(
        '[data-vex-area="chat-composer"]',
      ) as HTMLFormElement,
    );
    expect(mockSubmitChat.mutateAsync).not.toHaveBeenCalled();
    await waitFor(() => {
      const dock = container.querySelector(
        '[data-vex-area="composer-queue-dock"]',
      );
      expect(dock?.textContent).toContain("follow-up while busy");
    });
    // The field cleared - the message lives in the queue now.
    expect(draftField().value).toBe("");
  });

  it("removing a queued row deletes it from the dock", async () => {
    mockChatSteer.mockResolvedValue({ ok: true, data: { outcome: "no_active_turn" } });
    mockSubmitChat.isPending = true;
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    typeDraft("disposable");
    fireEvent.submit(
      container.querySelector(
        '[data-vex-area="chat-composer"]',
      ) as HTMLFormElement,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove queued message" }),
    );
    expect(
      container.querySelector('[data-vex-area="composer-queue-dock"]'),
    ).toBeNull();
  });
});

describe("composer capsule - seats", () => {
  it("the permission chip names the session grant and never offers a toggle", () => {
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const chip = container.querySelector(
      '[data-vex-area="composer-permission-chip"]',
    );
    expect(chip?.textContent).toBe("Restricted");
    expect(chip?.querySelector("button")).toBeNull();
  });

  it("the context ring renders from real usage data and names its percentage", () => {
    contextWindow = { tokensUsed: 45_000, contextLimit: 100_000 };
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const ring = container.querySelector(
      '[data-vex-area="composer-context-ring"]',
    );
    expect(ring?.getAttribute("aria-label")).toBe("Context 45% used");
  });

  it("no limit reported → no ring; no fabricated denominator", () => {
    contextWindow = { tokensUsed: 45_000, contextLimit: null };
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    expect(
      container.querySelector('[data-vex-area="composer-context-ring"]'),
    ).toBeNull();
  });

  it("the plan chip appears only for a session still carrying an enabled legacy plan", () => {
    sessionPlan = { enabled: true, accepted: false };
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    expect(
      container.querySelector('[data-vex-area="composer-plan-chip"]')
        ?.textContent,
    ).toContain("Plan");
  });
});

describe("composer capsule - per-session drafts (B1)", () => {
  it("a draft survives switching sessions and returns verbatim on switch-back", () => {
    const OTHER = "00000000-0000-4000-8000-00000000cc02";
    const { rerender } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    typeDraft("half-typed order");
    rerender(
      <SessionComposer
        activeSession={agentRow({ id: OTHER })}
        activeSessionId={OTHER}
      />,
    );
    expect(draftField().value).toBe("");
    rerender(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    expect(draftField().value).toBe("half-typed order");
  });
});
