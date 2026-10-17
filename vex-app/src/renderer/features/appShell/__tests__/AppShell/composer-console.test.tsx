/**
 * Composer field contract (UIUX rebrand F3, drawn for R3 - docs/design/
 * R3-MINIMAL.md section 7, references d2, d3 and d5). Mounts the real
 * `SessionComposer` with the lib/api hooks mocked and pins:
 *
 *  - the field chrome (a square white field on the rule, NO focus treatment -
 *    the CSS pins scan the raw stylesheet, the jsdom pins the classNames);
 *  - the 36px square send key, and the named stop key that replaces it;
 *  - the approval echo (the ink frame + the "Waiting for approval" tag behind
 *    the target swatch);
 *  - the rotating faux-placeholder overlay;
 *  - the welcome's task rows (visible on welcome, gone while typing, fixed
 *    slot);
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
import { notifications } from "../../../../lib/notifications/index.js";

/**
 * The transient toast is a notification-model entry since B2.2: the store that
 * held one message and forgot it is gone, so the assertions read the model's
 * newest retained item instead of a slot.
 */
function latestToastText(): string | null {
  return notifications.getSnapshot().items[0]?.message ?? null;
}


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
const { LIGHTER_DESK_PLACEHOLDER, WELCOME_PLACEHOLDERS } = await import("../../composer-placeholders.js");

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

afterEach(() => {
  cleanup();
  notifications.reset();
});

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
  it("wraps the composer in the square field card that follows the page column", () => {
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const form = container.querySelector('[data-vex-area="chat-composer"]');
    expect(form).not.toBeNull();
    expect(form?.className).toContain("vex-composer-card");
    expect(form?.className).toContain("w-full");
    // The page column (SessionPanel's dock) owns the width: no cap of its own.
    expect(form?.className).not.toMatch(/max-w-/);
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

  it("raw-CSS contract: a square card on the input border with no shadow, and NO focus treatment anywhere in the chrome", () => {
    expect(CONSOLE_CSS).toContain("border-radius: 0");
    expect(CONSOLE_CSS).not.toMatch(/border-radius:\s*(?!0\b)\d/);
    expect(CONSOLE_CSS).toContain("var(--vex-alias-border-input)");
    expect(CONSOLE_CSS).not.toMatch(/box-shadow|--shadow-lv/);
    // The catalog capsule has no focus ring and no focus border step: no
    // rule block selects on focus (a prose mention in a comment is fine).
    expect(CONSOLE_CSS).not.toContain(":focus-within");
    expect(CONSOLE_CSS).not.toMatch(/:focus[^)]*\{/);
  });

  it("raw-CSS contract: the field runs no motion of its own - the shared swatch is the one state motion", () => {
    // The pulsing pending dot retired with V10: status is shown by fill, and
    // the ongoing swatch (ui-primitives/marks.css) carries the only motion,
    // with its own reduced-motion still.
    expect(CONSOLE_CSS).not.toMatch(/@keyframes|animation:/);
    expect(CONSOLE_CSS).toContain("var(--vex-alias-composer)");
    expect(CONSOLE_CSS).toContain(".vex-composer-chip");
  });

  it("draws the ink frame + the Waiting for approval tag behind the target swatch while an approval waits", () => {
    runStatus = "paused_approval";
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const form = container.querySelector('[data-vex-area="chat-composer"]');
    expect(form?.getAttribute("data-vex-composer-state")).toBe("approval");
    const tag = screen.getByText("Waiting for approval");
    expect(tag).toBeTruthy();
    // The tag sits on the FIELD's top edge, so it rides inside the card.
    expect(form?.contains(tag)).toBe(true);
    expect(tag.querySelector('.vex-swatch[data-s="awaiting"]')).not.toBeNull();
    expect(CONSOLE_CSS).toMatch(
      /\[data-vex-composer-state="approval"\]\s*\{[^}]*border-width:\s*1\.5px;[^}]*var\(--vex-alias-rule-ink\)/,
    );
  });
});

describe("composer capsule - send key", () => {
  it("the send key is the 36px square blue key: a dotted outline while empty, filled once typed", () => {
    render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const send = screen.getByRole("button", {
      name: "Send message",
    }) as HTMLButtonElement;
    expect(send.className).toContain("h-9");
    expect(send.className).toContain("w-9");
    expect(send.className).not.toMatch(/rounded/);
    expect(send.className).toContain("vex-composer-send");
    expect(send.disabled).toBe(true);
    typeDraft("buy the dip");
    expect(send.disabled).toBe(false);
  });

  it("raw-CSS contract: the send key fills blue with text and waits on a dotted blue outline", () => {
    expect(CONSOLE_CSS).toMatch(
      /\.vex-composer-send \{[^}]*background: var\(--vex-alias-button-accent-fill\);/,
    );
    expect(CONSOLE_CSS).toMatch(
      /\.vex-composer-send:disabled \{[^}]*border: 1px dotted var\(--vex-alias-accent-primary\);[^}]*background: transparent;/,
    );
  });

  it("a turn in flight swaps Send for the NAMED ink stop key, with no second state mark beside it", () => {
    mockSubmitChat.isPending = true;
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    // The stop key carries the state in its words; the transcript's live row
    // and the title bar's chip carry the timer.
    expect(container.querySelector("[data-vex-composer-pending]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    const stop = screen.getByRole("button", { name: "Stop agent" });
    expect(stop.textContent).toBe("Stop agent");
    expect(stop.className).toContain("vex-composer-stop");
    expect(stop.querySelector(".vex-composer-stop__mark")).not.toBeNull();
    expect(CONSOLE_CSS).toMatch(
      /\.vex-composer-stop \{[^}]*height: 36px;[^}]*background: var\(--vex-alias-rule-ink\);/,
    );
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

  it("rests on the desk phrase in Lighter mode instead of the swap and bridge orders", () => {
    useUiStore.setState({ runtimeMode: "lighter" });
    try {
      const { container } = render(
        <SessionComposer activeSession={null} activeSessionId={null} />,
      );
      const overlay = container.querySelector("[data-vex-composer-placeholder]");
      expect(overlay?.textContent).toBe(LIGHTER_DESK_PLACEHOLDER);
    } finally {
      useUiStore.setState({ runtimeMode: "agent" });
    }
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

  it("task rows greet the welcome stage inside a fixed-height slot that survives typing", () => {
    const { container } = render(
      <SessionComposer activeSession={null} activeSessionId={null} />,
    );
    const slot = container.querySelector("[data-vex-composer-starters]");
    expect(slot).not.toBeNull();
    expect(slot?.className).toContain("vex-starters");
    expect(screen.getByRole("button", { name: "Check wallet balances" })).toBeTruthy();
    typeDraft("typing now");
    expect(container.querySelector("[data-vex-composer-starters]")).not.toBeNull();
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
    expect(latestToastText()).toBe("Draft cleared.");
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
  it("the permission seat states the session grant as its promise and never offers a toggle", () => {
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const chip = container.querySelector(
      '[data-vex-area="composer-permission-chip"]',
    );
    expect(chip?.textContent).toBe("Funds require approval");
    expect(chip?.getAttribute("aria-label")).toBe("Access mode: Restricted");
    expect(chip?.querySelector("button")).toBeNull();
  });

  it("the welcome states the new session form's preselect (Restricted) before any session exists", () => {
    const { container } = render(
      <SessionComposer activeSession={null} activeSessionId={null} />,
    );
    const chip = container.querySelector(
      '[data-vex-area="composer-permission-chip"]',
    );
    expect(chip?.textContent).toBe("Funds require approval");
    // No session, no context: the label and meter wait for a real reading.
    expect(
      container.querySelector('[data-vex-area="composer-context-ring"]'),
    ).toBeNull();
  });

  it("the context label renders from real usage data and names its percentage", () => {
    contextWindow = { tokensUsed: 45_000, contextLimit: 100_000 };
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const ring = container.querySelector(
      '[data-vex-area="composer-context-ring"]',
    );
    expect(ring?.getAttribute("aria-label")).toBe("Context 45% used");
    expect(ring?.textContent).toBe("Context 45%");
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
