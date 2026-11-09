/**
 * Composer field contract (UIUX rebrand F3, drawn for H3 - docs/design/
 * H3-DESKTOP.md section 1.8 and Appendix A.5). Mounts the real
 * `SessionComposer` with the lib/api hooks mocked and pins:
 *
 *  - the composer row: the model cell, the field cell and the send cell, the
 *    cells' rules, NO focus treatment on the field (the CSS pins scan the raw
 *    stylesheet, the jsdom pins the classNames);
 *  - the blue send cell, and the stop that replaces it, named by its target;
 *  - the approval echo (the ink frame + the "Waiting for approval" tag behind
 *    the target swatch);
 *  - the faux-placeholder overlay, resting on "Ask Vex...";
 *  - the welcome's suggestions (visible on welcome, gone while typing);
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
  act,
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
import { COMPOSER_COMMANDS } from "../../commands/directory.js";

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
  useSessionModel: () => ({ data: undefined }),
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
const { COMPOSER_REST_PLACEHOLDER } = await import("../../SessionComposer.js");
const { APPROVAL_WAIT_PLACEHOLDER, LIGHTER_DESK_PLACEHOLDER, PLACEHOLDER_ROTATE_MS, WELCOME_PLACEHOLDERS } =
  await import("../../composer-placeholders.js");

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
  it("wraps the composer in the card that follows the chat column", () => {
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

  it("lays the row out as H3's cells: the model cell, the field cell, the send cell", () => {
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const row = container.querySelector('[data-vex-area="composer-row"]') as HTMLElement;
    expect(row.className).toBe("vex-composer-row");
    const cells = Array.from(row.children).filter((el) => !el.classList.contains("vex-composer-tag"));
    expect(cells).toHaveLength(3);
    const model = cells[0];
    expect(
      model?.matches(".vex-composer-model") === true || model?.querySelector(".vex-composer-model") != null,
    ).toBe(true);
    expect(cells[1]?.className).toBe("vex-composer-field");
    expect(cells[1]?.contains(draftField())).toBe(true);
    expect(cells[2]?.getAttribute("aria-label")).toBe("Send message");
    // No image key: attachments are not supported (section 4.1). The row's
    // keys are the model cell's (once the model resolves) and the send cell.
    expect(row.querySelectorAll("button").length).toBeLessThanOrEqual(2);
    expect(
      Array.from(row.querySelectorAll("button")).map((button) => button.getAttribute("aria-label") ?? ""),
    ).not.toContainEqual(expect.stringMatching(/image|attach/i));
    expect(row.textContent).not.toMatch(/image|attach/i);
  });

  it("raw-CSS contract: the row is 72 under its rule, bottom aligned, so a growing field rises", () => {
    expect(CONSOLE_CSS).toMatch(/\.vex-composer-row \{[^}]*align-items: flex-end;/);
    expect(CONSOLE_CSS).toMatch(
      /\.vex-composer-model \{[^}]*width: 75px;[^}]*height: calc\(var\(--vex-h3-bottom-h\) \+ 1px\);[^}]*border-top: 1px solid var\(--vex-alias-rule\);[^}]*border-right: 1px solid var\(--vex-alias-rule\);[^}]*background: var\(--vex-alias-bg-layer-3\);/,
    );
    expect(CONSOLE_CSS).toMatch(
      /\.vex-composer-field \{[^}]*min-height: calc\(var\(--vex-h3-bottom-h\) \+ 1px\);[^}]*padding: 24px;[^}]*border-top: 1px solid var\(--vex-alias-rule\);/,
    );
    const tokens = readFileSync(
      join(process.cwd(), "src/renderer/styles/global-css/tokens.css"),
      "utf8",
    );
    expect(tokens).toContain("--vex-h3-bottom-h: 72px;");
  });

  it("the textarea rests on one line, caps at the 336px catalog height, carries the accent caret, and wears NO focus ring", () => {
    render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const field = draftField();
    expect(field.className).toContain("min-h-6");
    expect(field.className).not.toContain("min-h-12");
    expect(field.className).toContain("max-h-[336px]");
    expect(field.className).toContain("caret-accent-primary");
    expect(field.className).not.toMatch(/focus-visible|ring/);
  });

  it("raw-CSS contract: square cells on the rule with no shadow, and NO focus treatment anywhere in the chrome", () => {
    expect(CONSOLE_CSS).toContain("border-radius: 0");
    expect(CONSOLE_CSS).not.toMatch(/border-radius:\s*(?!0\b)\d/);
    expect(CONSOLE_CSS).toContain("var(--vex-alias-rule)");
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
    const words = screen.getByText("Waiting for approval");
    const tag = words.closest('[data-vex-console-status="approval"]') as HTMLElement;
    expect(tag.className).toBe("vex-composer-tag");
    // The tag stands in the status strip's state cell, H3's empty cell over
    // the row, so it rides inside the card; the strip says it holds a state.
    expect(form?.contains(tag)).toBe(true);
    expect(tag.parentElement?.className).toContain("vex-composer-strip__state");
    expect(tag.closest('[data-vex-strip-state="approval"]')).not.toBeNull();
    expect(tag.querySelector('.vex-swatch[data-s="awaiting"]')).not.toBeNull();
    // Its words truncate before they push a neighbour out.
    expect(words.className).toContain("truncate");
    // The ink frame is drawn inside the composer's box, so nothing moves;
    // 1px, as every rule is (H3-DESKTOP.md section 2.4).
    expect(CONSOLE_CSS).toMatch(
      /\[data-vex-composer-state="approval"\]\s*\{[^}]*outline:\s*1px solid var\(--vex-alias-rule-ink\);[^}]*outline-offset:\s*-1px;/,
    );
  });
});

describe("composer capsule - a pending approval in an agent chat", () => {
  it("draws the ink frame and the Waiting for approval tag from the session's pending approvals, with no mission run parked", () => {
    runStatus = null;
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} pendingApproval />,
    );
    const form = container.querySelector('[data-vex-area="chat-composer"]');
    expect(form?.getAttribute("data-vex-composer-state")).toBe("approval");
    expect(form?.contains(screen.getByText("Waiting for approval"))).toBe(true);
  });

  it("rests on one phrase and never rotates an example order while the approval waits", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} pendingApproval />,
      );
      const overlay = (): string | null | undefined =>
        container.querySelector("[data-vex-composer-placeholder]")?.textContent;
      expect(overlay()).toBe(APPROVAL_WAIT_PLACEHOLDER);
      act(() => {
        vi.advanceTimersByTime(PLACEHOLDER_ROTATE_MS * 3);
      });
      expect(overlay()).toBe(APPROVAL_WAIT_PLACEHOLDER);
      expect(WELCOME_PLACEHOLDERS).not.toContain(overlay());
    } finally {
      vi.useRealTimers();
    }
  });

  it("without a pending approval the agent chat keeps the plain field and rests on Ask Vex", () => {
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const form = container.querySelector('[data-vex-area="chat-composer"]');
    expect(form?.getAttribute("data-vex-composer-state")).toBe("input");
    expect(screen.queryByText("Waiting for approval")).toBeNull();
    expect(container.querySelector("[data-vex-composer-placeholder]")?.textContent).toBe(
      "Ask Vex…",
    );
  });
});

describe("composer capsule - send cell", () => {
  it("the send cell is the blue key with the dot glyph and SEND, held while there is nothing to send", () => {
    render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const send = screen.getByRole("button", {
      name: "Send message",
    }) as HTMLButtonElement;
    expect(send.className).toContain("vex-composer-key");
    expect(send.className).toContain("vex-composer-send");
    expect(send.className).not.toMatch(/rounded/);
    expect(send.getAttribute("type")).toBe("submit");
    // The word in sentence case (the sheet sets the caps) beside the
    // three-by-three dot glyph, 20 square, which is decoration.
    expect(send.querySelector(".vex-composer-key__word")?.textContent).toBe("Send");
    const glyph = send.querySelector("svg");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    expect(glyph?.getAttribute("width")).toBe("20");
    expect(glyph?.querySelectorAll("circle")).toHaveLength(9);
    // Held, not disabled (VEX Cloud's SubmitButton, dock contract section
    // 3): the key keeps its place in the tab order and focus through a send.
    expect(send.disabled).toBe(false);
    expect(send.getAttribute("aria-disabled")).toBe("true");
    typeDraft("buy the dip");
    expect(send.hasAttribute("aria-disabled")).toBe(false);
  });

  it("a held SEND keeps focus, says why it is held, and its press sends nothing", () => {
    render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
    send.focus();
    expect(document.activeElement).toBe(send);
    expect(send.tabIndex).toBe(0);
    const reason = document.getElementById(send.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe("Write a message to send");
    expect(send.getAttribute("aria-keyshortcuts")).toBe("Enter");
    const submitted = vi.fn((event: Event) => event.preventDefault());
    send.form?.addEventListener("submit", submitted);
    fireEvent.click(send);
    expect(submitted).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(send);
    typeDraft("buy the dip");
    expect(send.hasAttribute("aria-describedby")).toBe(false);
  });

  it("raw-CSS contract: the send cell is 138 wide and the row's 72, the one blue fill, white caps 13", () => {
    expect(CONSOLE_CSS).toMatch(
      /\.vex-composer-key \{[^}]*width: 138px;[^}]*height: calc\(var\(--vex-h3-bottom-h\) \+ 1px\);[^}]*padding: 0 30px 0 32px;[^}]*font-size: 13px;[^}]*letter-spacing: var\(--tracking-label\);[^}]*text-transform: uppercase;/,
    );
    expect(CONSOLE_CSS).toMatch(
      /\.vex-composer-send,\s*\.vex-composer-stop \{[^}]*background-color: var\(--vex-alias-button-accent-fill\);[^}]*color: var\(--vex-alias-button-accent-ink\);/,
    );
    // The blue hover rises from the key's foot (VEX Cloud's
    // --vx-blue-fill-hover): a layer scaled up from 0, never a swap of the
    // key's own fill.
    expect(CONSOLE_CSS).toMatch(
      /\.vex-composer-send::before,\s*\.vex-composer-stop::before \{[^}]*background: var\(--vex-alias-button-accent-hover\);[^}]*transform: scaleY\(0\);[^}]*transform-origin: bottom;[^}]*transition: transform var\(--vex-duration-key-fill\)/,
    );
    expect(CONSOLE_CSS).toMatch(
      /\.vex-composer-send:hover:not\(:disabled, \[aria-disabled="true"\]\)::before,\s*\.vex-composer-stop:hover:not\(:disabled\)::before \{\s*transform: scaleY\(1\);/,
    );
    expect(CONSOLE_CSS).not.toMatch(
      /\.vex-composer-send:hover:not\(:disabled\),\s*\.vex-composer-stop:hover:not\(:disabled\) \{[^}]*background-color/,
    );
    // EC-04: an empty draft holds SEND. The held look is the cell fill with a
    // muted word, never the blue: a blue key that does nothing is a trust
    // regression. No dotted outline, no transparent key.
    expect(CONSOLE_CSS).toMatch(
      /\.vex-composer-send:is\(:disabled, \[aria-disabled="true"\]\),\s*\.vex-composer-stop:disabled \{[^}]*background-color: var\(--vex-alias-bg-layer-3\);[^}]*color: var\(--vex-alias-label-tertiary\);/,
    );
    expect(CONSOLE_CSS).not.toMatch(/dotted/);
    // The dots are faint at rest and white under the pointer.
    expect(CONSOLE_CSS).toMatch(
      /\.vex-composer-key__glyph \{[^}]*color: var\(--vex-alias-label-faint\);/,
    );
    expect(CONSOLE_CSS).toMatch(
      /\.vex-composer-key:hover:not\(:disabled, \[aria-disabled="true"\]\) \.vex-composer-key__glyph \{[^}]*color: var\(--vex-alias-button-accent-ink\);/,
    );
  });

  it("a turn in flight swaps Send for STOP in the same cell, named by what it stops, with no second state mark beside it", () => {
    mockSubmitChat.isPending = true;
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    // The stop key carries the state in its words; the transcript's live row
    // and the title bar's chip carry the timer.
    expect(container.querySelector("[data-vex-composer-pending]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    const stop = screen.getByRole("button", { name: "Stop agent" });
    expect(stop.textContent).toBe("Stop");
    expect(stop.className).toContain("vex-composer-key");
    expect(stop.className).toContain("vex-composer-stop");
    expect(stop.querySelector(".vex-composer-stop__mark")).not.toBeNull();
    // STOP's square is 14 (VEX Cloud's `.vx-cmp-stop`).
    expect(CONSOLE_CSS).toMatch(/\.vex-composer-stop__mark \{[^}]*width: 14px;[^}]*height: 14px;/);
    // A stop being acknowledged is the disabled key: the cell fill, muted.
    expect(CONSOLE_CSS).toMatch(
      /\.vex-composer-stop:disabled \{[^}]*background-color: var\(--vex-alias-bg-layer-3\);[^}]*color: var\(--vex-alias-label-tertiary\);/,
    );
  });
});

describe("composer capsule - the status strip's cells", () => {
  it("raw-CSS contract: a cell's words 24 in and 16 from its rule; the context key 16 in, 24 from the edge, reaching 12 up", () => {
    // VEX Cloud's `.vx-cmp-cell` (0 16 0 24), its budget cell at the strip's
    // end (0 24 0 16), and a key cell's 44 target on the 32 strip.
    expect(CONSOLE_CSS).toMatch(/\.vex-composer-strip__cell \{[^}]*padding: 0 16px 0 24px;/);
    expect(CONSOLE_CSS).toMatch(/\.vex-composer-context \{[^}]*position: relative;[^}]*padding: 0 24px 0 16px;/);
    expect(CONSOLE_CSS).toMatch(/\.vex-composer-context::before \{[^}]*position: absolute;[^}]*inset: -12px 0 0;/);
  });
});

describe("composer capsule - placeholder + starter chips", () => {
  it("rests on H3's Ask Vex as an aria-hidden overlay - no native placeholder, no rotating orders", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        <SessionComposer activeSession={null} activeSessionId={null} />,
      );
      expect(draftField().getAttribute("placeholder")).toBeNull();
      const overlay = (): Element | null =>
        container.querySelector("[data-vex-composer-placeholder]");
      expect(overlay()?.getAttribute("aria-hidden")).toBe("true");
      expect(overlay()?.textContent).toBe("Ask Vex…");
      expect(COMPOSER_REST_PLACEHOLDER).toBe("Ask Vex…");
      act(() => {
        vi.advanceTimersByTime(PLACEHOLDER_ROTATE_MS * 3);
      });
      expect(overlay()?.textContent).toBe("Ask Vex…");
      expect(WELCOME_PLACEHOLDERS).not.toContain(overlay()?.textContent);
    } finally {
      vi.useRealTimers();
    }
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

  it("the suggestions greet the welcome stage over the field, in a slot that survives typing", () => {
    const { container } = render(
      <SessionComposer activeSession={null} activeSessionId={null} />,
    );
    const slot = container.querySelector("[data-vex-composer-starters]");
    expect(slot).not.toBeNull();
    expect(slot?.className).toContain("vex-starters");
    expect(screen.getByRole("button", { name: "Check wallet balances" })).toBeTruthy();
    // Over the composer (docs/design/H3-DESKTOP.md section 1.7), so they come
    // before the field in reading and focus order too.
    const field = screen.getByLabelText("Session draft");
    expect(
      slot !== null && slot.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
    // Four since /theme retired with the light room (the app is dark only).
    expect(listbox.querySelectorAll('[role="option"]').length).toBe(COMPOSER_COMMANDS.length);
    expect(COMPOSER_COMMANDS).toHaveLength(4);
    expect(document.activeElement).toBe(field);
  });

  it("draws Cloud's / menu: the column's width on the composer's top, the Commands head, the 148 grid", () => {
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    typeDraft("/");
    const menu = container.querySelector("[data-vex-composer-command-menu]");
    expect(menu?.className).toBe("vex-slash");
    expect(menu?.querySelector(".vex-slash__head")?.textContent).toBe("Commands");
    expect(menu?.querySelector(".vex-slash__head")?.getAttribute("aria-hidden")).toBe("true");
    const option = screen.getAllByRole("option")[0];
    expect(option?.className).toBe("vex-slash__row");
    expect(option?.querySelector(".vex-slash__name")?.textContent).toBe(COMPOSER_COMMANDS[0]?.label);
    const css = readFileSync(
      join(process.cwd(), "src/renderer/styles/global-css/composer.css"),
      "utf8",
    );
    expect(css).toMatch(/\.vex-slash \{[^}]*right: 0;[^}]*bottom: 100%;[^}]*left: 0;[^}]*border-top: 1px solid var\(--vex-alias-rule-chosen\);[^}]*background: var\(--vex-alias-card\);/);
    expect(css).toMatch(/\.vex-slash__head \{[^}]*height: 32px;/);
    expect(css).toMatch(/\.vex-slash__row \{[^}]*grid-template-columns: 148px minmax\(0, 1fr\);/);
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
    expect(ring?.textContent).toBe("Context45%");
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
