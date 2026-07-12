/**
 * Signal Console chrome (feat/robinhood-launch) — the composer's PILL redesign
 * that replaced the two-layer card + context strip. Mounts the real
 * `SessionComposer` with the lib/api hooks mocked (same isolated harness as
 * composer-plan-switch) and pins the new visual contract WITHOUT touching any
 * submit/gating behavior:
 *
 *   - the glass pill: `.vex-console` (which owns the traveling border shimmer)
 *     + the glass token surface + backdrop-blur + the rounded-[24px] pill
 *     radius, and `data-vex-console-state` echoing input/approval;
 *   - a SINGLE row: no context strip, no session-context label row;
 *   - the round send control: ghost hairline circle while empty (accessible
 *     name "Send message"), accent fill with the accent-contrast glyph once
 *     typed — no "Execute" wordmark, no » prompt glyph;
 *   - the amber "AWAITING SIGNATURE" tag FLOATING above the pill, driven by the
 *     existing `runStatus === "paused_approval"` signal (recoloring the pill's
 *     ring amber via `data-vex-console-state`);
 *   - the starter chips always render on the welcome stage (the "+" toggle
 *     was retired);
 *   - no PROPOSE → ENFORCE → PROVE flow strip;
 *   - the rotating crypto-utility welcome placeholder (opens on phrase one).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { MissionRunStatus, SessionListItem } from "@shared/schemas/sessions.js";
import { useUiStore } from "../../../../stores/uiStore.js";

vi.mock("@hugeicons/react", () => ({
  HugeiconsIcon: () => null,
}));

vi.mock("@hugeicons/core-free-icons", () => ({
  Add01Icon: "Add01Icon",
  ArrowDown01Icon: "ArrowDown01Icon",
  ArrowUp01Icon: "ArrowUp01Icon",
  MapPinIcon: "MapPinIcon",
  AiBrain05Icon: "AiBrain05Icon",
  StopCircleIcon: "StopCircleIcon",
  Exchange01Icon: "Exchange01Icon",
  Fuel01Icon: "Fuel01Icon",
  Wallet01Icon: "Wallet01Icon",
}));

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
}));

vi.mock("../../../../lib/api/sessions.js", () => ({
  useSessionPlan: () => ({
    data: { ok: true, data: { enabled: false, planMd: "", accepted: false } },
  }),
  useSetPlanMode: () => ({ mutate: vi.fn(), isPending: false }),
  // Capability unknown → the REASON control stays hidden in this suite.
  useSessionModel: () => ({ data: undefined }),
}));

const { SessionComposer } = await import("../../SessionComposer.js");

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

beforeEach(() => {
  vi.clearAllMocks();
  mockSubmitChat.isPending = false;
  runStatus = null;
  useUiStore.setState({
    pendingFirstMessage: null,
    createSessionInitialMessage: null,
  });
});

describe("SessionComposer — Signal Console chrome", () => {
  it("wraps the composer in the .vex-console glass pill (single row, no context strip)", () => {
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const form = container.querySelector('[data-vex-area="chat-composer"]');
    expect(form).not.toBeNull();
    // Glass pill: the .vex-console class (which owns the traveling border
    // shimmer in globals.css) + the glass token surface + the
    // (guard-whitelisted) backdrop-blur + the pill radius.
    expect(form?.className).toContain("vex-console");
    expect(form?.className).toContain("bg-[var(--vex-glass)]");
    expect(form?.className).toContain("backdrop-blur-xl");
    expect(form?.className).toContain("rounded-[24px]");
    expect(form?.getAttribute("data-vex-console-state")).toBe("input");
    // The two-layer card is gone: no context strip and no session-context
    // label live inside the pill anymore.
    expect(container.querySelector("[data-vex-console-strip]")).toBeNull();
    expect(container.querySelector("[data-vex-console-context]")).toBeNull();
  });

  it("round send control is a ghost circle while empty and accent-filled once typed", () => {
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    const send = screen.getByRole("button", {
      name: "Send message",
    }) as HTMLButtonElement;
    // No "Execute" wordmark, no » glyph — just the round icon control.
    expect(send.textContent).not.toContain("Execute");
    expect(send.textContent ?? "").not.toContain("»");
    // Disabled ghost hairline circle: no accent fill, no accent-contrast glyph.
    expect(send.disabled).toBe(true);
    expect(send.className).not.toContain("var(--vex-accent-contrast)");

    fireEvent.change(screen.getByLabelText("Session draft"), {
      target: { value: "buy the dip" },
    });
    expect(send.disabled).toBe(false);
    // Enabled: solid accent fill + accent-contrast glyph (white on cobalt /
    // ink on lime).
    expect(send.className).toContain("bg-[var(--vex-accent)]");
    expect(send.className).toContain("var(--vex-accent-contrast)");
  });

  it("shares one control-bank height (h-9) across the Mode picker and the round send", () => {
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    expect(
      screen.getByRole("combobox", { name: "Mode" }).className,
    ).toContain("h-9");
    expect(
      screen.getByRole("button", { name: "Send message" }).className,
    ).toContain("h-9");
  });

  it("carries no session-context label anywhere (the context strip is gone)", () => {
    const { container, rerender } = render(
      <SessionComposer activeSession={null} activeSessionId={null} />,
    );
    // The retired NEW MISSION / AGENT INPUT / PLAN MODE label row is gone in
    // both the welcome and an open-session render.
    expect(container.querySelector("[data-vex-console-context]")).toBeNull();
    expect(container.textContent).not.toContain("NEW MISSION");

    rerender(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    expect(container.querySelector("[data-vex-console-context]")).toBeNull();
    expect(container.textContent).not.toContain("AGENT INPUT");
  });

  it("recolors the pill amber + floats the AWAITING SIGNATURE tag while awaiting a signature", () => {
    runStatus = "paused_approval";
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const form = container.querySelector('[data-vex-area="chat-composer"]');
    // The state attribute drives the amber ring recolor in globals.css.
    expect(form?.getAttribute("data-vex-console-state")).toBe("approval");
    // The transient signal survives as a tag floating ABOVE the pill.
    const status = container.querySelector('[data-vex-console-status="approval"]');
    expect(status?.textContent).toBe("AWAITING SIGNATURE");
    expect(status?.className).toContain("text-[var(--vex-pin)]");
    expect(form?.contains(status)).toBe(false);
  });

  it("does not add a WORKING label above the composer while a turn is pending", () => {
    mockSubmitChat.isPending = true;
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );

    expect(
      container.querySelector('[data-vex-console-status="working"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("Working…");
    expect(
      container.querySelector('[data-vex-console-status="stopping"]'),
    ).toBeNull();
  });

  it("has no PROPOSE → ENFORCE → PROVE flow strip on the welcome stage", () => {
    const { container } = render(
      <SessionComposer activeSession={null} activeSessionId={null} stage />,
    );
    expect(container.querySelector("[data-vex-ticket-flow]")).toBeNull();
    expect(container.textContent).not.toContain("Propose");
    expect(container.textContent).not.toContain("Enforce");
    expect(container.textContent).not.toContain("Prove");
  });

  it("always renders the detached starter chips on the welcome stage (no + toggle)", () => {
    render(<SessionComposer activeSession={null} activeSessionId={null} />);
    // The "+" quick-prompts toggle was retired entirely.
    expect(
      screen.queryByRole("button", { name: /quick prompts/i }),
    ).toBeNull();
    // Starter chips greet an empty welcome by default (the previous shown state).
    expect(
      screen.queryByRole("button", { name: /wallet balances/i }),
    ).not.toBeNull();
  });

  it("opens on the first rotating crypto-utility welcome placeholder", () => {
    render(<SessionComposer activeSession={null} activeSessionId={null} />);
    const draft = screen.getByLabelText("Session draft") as HTMLTextAreaElement;
    // The static plain-English line is gone; the rotator opens on phrase one
    // (jsdom has no matchMedia → not reduced-motion → index starts at 0).
    expect(draft.placeholder).toBe("Swap 0.5 ETH to USDG — best route first.");
  });

  it("renders under the Robinhood theme without leaking raw colors (token-only)", () => {
    // jsdom does not resolve CSS vars; the token-only classNames are what
    // guarantee both themes recolor. Smoke-mount inside the theme scope and
    // confirm the round send fill still routes through the accent-contrast token.
    render(
      <div data-vex-shell="true" data-vex-theme="robinhood">
        <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />
      </div>,
    );
    fireEvent.change(screen.getByLabelText("Session draft"), {
      target: { value: "go" },
    });
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send.className).toContain("var(--vex-accent-contrast)");
  });
});
