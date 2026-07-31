/**
 * Signal Console chrome (feat/robinhood-launch) — the composer's PILL redesign
 * that replaced the two-layer card + context strip. Mounts the real
 * `SessionComposer` with the lib/api hooks mocked (same isolated harness as
 * composer-reasoning-switch) and pins the new visual contract WITHOUT touching
 * any submit/gating behavior:
 *
 *   - the glass pill: `.vex-console` + the glass token surface +
 *     backdrop-blur + the resting rounded-full Grok radius (owner decree
 *     2026-07-21; jsdom reports scrollHeight 0 so the multiline
 *     rounded-[28px] relax never engages here), and
 *     `data-vex-console-state` echoing input/approval;
 *   - QUIET AT REST (owner correction 2026-07-21 round 2): the resting
 *     ring is ONE flat hairline — the traveling conic arc exists ONLY for
 *     :focus-within and the approval state. jsdom cannot compute pseudo
 *     styles, so the ring contract is pinned against the raw globals.css
 *     source (the shell-design-guard raw-scan idiom);
 *   - a SINGLE row: no context strip, no session-context label row, and a
 *     right cluster of ONLY the round send/stop control — no attach, no
 *     mic, no mode/reasoning chip (the REASON control is renderer-
 *     unmounted; composer-reasoning-switch.test.tsx pins that seam);
 *   - the round send control: ghost hairline circle while empty (accessible
 *     name "Send message"), accent fill with the accent-contrast glyph once
 *     typed — no "Execute" wordmark, no » prompt glyph — at Grok's h-10
 *     round-key geometry;
 *   - the amber "AWAITING SIGNATURE" tag FLOATING above the pill, driven by the
 *     existing `runStatus === "paused_approval"` signal (recoloring the pill's
 *     ring amber via `data-vex-console-state`);
 *   - the starter chips always greet an empty welcome (the "+" toggle was
 *     retired), DISAPPEAR while the user is typing (draft non-empty → row
 *     gone; cleared → row returns), and live inside a fixed-height slot
 *     that persists while typing so the pill can never reflow;
 *   - no PROPOSE → ENFORCE → PROVE flow strip;
 *   - the rotating welcome prompt as an aria-hidden FAUX-PLACEHOLDER
 *     overlay (the native placeholder attribute is gone — it cannot
 *     animate), opening on phrase one and swapping on keyed motion spans.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type { MissionRunStatus, SessionListItem } from "@shared/schemas/sessions.js";
import { useUiStore } from "../../../../stores/uiStore.js";

vi.mock("@hugeicons/react", () => ({
  HugeiconsIcon: () => null,
}));

vi.mock("@hugeicons/core-free-icons", () => ({
  RocketIcon: "RocketIcon",
  Add01Icon: "Add01Icon",
  CheckmarkCircle02Icon: "CheckmarkCircle02Icon",
  Download01Icon: "Download01Icon",
  ArrowDown01Icon: "ArrowDown01Icon",
  ArrowUp01Icon: "ArrowUp01Icon",
  // Welcome Portfolio tab (BookPanel's welcome stage): handle + card icons.
  ArrowRight01Icon: "ArrowRight01Icon",
  Wallet01Icon: "Wallet01Icon",
  MapPinIcon: "MapPinIcon",
  AiBrain05Icon: "AiBrain05Icon",
  StopCircleIcon: "StopCircleIcon",
  FireIcon: "FireIcon",
  ChartLineData01Icon: "ChartLineData01Icon",
  PercentSquareIcon: "PercentSquareIcon",
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
  useRequestStop: () => ({ mutateAsync: async () => undefined }),
}));

vi.mock("../../../../lib/api/models.js", () => ({
  // Capability unknown → the REASON control stays hidden in this suite.
  useAvailableModels: () => ({ data: undefined }),
}));

const { SessionComposer } = await import("../../SessionComposer.js");
const { PLACEHOLDER_ROTATE_MS, WELCOME_PLACEHOLDERS } = await import(
  "../../composer-placeholders.js"
);

// The console ring's rest/focus/approval contract lives in the globals.css
// manifest's partials (styles/global-css/*.css) — pseudo-element rules jsdom
// cannot compute, so pin them against the raw stylesheet source instead (the
// shell-design-guard raw-scan idiom). fs read of the SOURCE files — a vite
// `?raw` glob works for .ts/.tsx (the design-guard idiom) but CSS runs
// through the Tailwind transform, which rewrites/minifies the stylesheet and
// breaks exact-selector scans; and `import.meta.url` is not a file: URL under
// the vitest transform, so the path anchors on the vitest project cwd (the
// vex-app package dir). Concatenating ALL partials in manifest order keeps
// whole-stylesheet assertions (e.g. the vex-console-travel occurrence count)
// as global tripwires across the entire hand-written sheet.
const STYLES_DIR = join(process.cwd(), "src/renderer/styles");
const manifestCss = readFileSync(join(STYLES_DIR, "globals.css"), "utf8");
const partialPaths =
  manifestCss.match(/(?<=@import ")\.\/global-css\/[^"]+\.css(?=";)/g) ?? [];
if (partialPaths.length === 0) {
  throw new Error("globals.css manifest contains no global-css partial imports");
}
const GLOBALS_CSS = partialPaths
  .map((partialPath) => readFileSync(join(STYLES_DIR, partialPath), "utf8"))
  .join("\n");

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
    createSessionInitialTurn: null,
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
    // (guard-whitelisted) backdrop-blur + the resting rounded-full Grok
    // radius (the multiline relax to rounded-[28px] never engages in jsdom).
    expect(form?.className).toContain("vex-console");
    expect(form?.className).toContain("bg-[var(--vex-glass)]");
    expect(form?.className).toContain("backdrop-blur-xl");
    expect(form?.className).toContain("rounded-full");
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

  it("the round send control wears Grok's h-10 round-key geometry", () => {
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    expect(
      screen.getByRole("button", { name: "Send message" }).className,
    ).toContain("h-10");
  });

  it("the pill's right cluster carries ONLY the round send control — no attach, no mic, no mode/reasoning chip", () => {
    const { container } = render(
      <SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />,
    );
    const form = container.querySelector('[data-vex-area="chat-composer"]');
    // Exactly one control lives inside the pill: the send/stop key.
    const buttons = form?.querySelectorAll("button") ?? [];
    expect(
      Array.from(buttons).map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Send message"]);
    expect(
      screen.queryByRole("button", { name: /Reasoning effort/ }),
    ).toBeNull();
  });

  it("renders no Chat/Plan mode control and no Plan Mode copy — the feature is retired from the UI", () => {
    render(<SessionComposer activeSession={agentRow()} activeSessionId={SESSION} />);
    expect(screen.queryByRole("combobox", { name: "Mode" })).toBeNull();
    expect(screen.queryByText("Plan Mode")).toBeNull();
    expect(screen.queryByText("Chat")).toBeNull();
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
      <SessionComposer activeSession={null} activeSessionId={null} />,
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
      screen.queryByRole("button", { name: /hunt trending memecoins/i }),
    ).not.toBeNull();
  });

  it("starter chips disappear while the user is typing and return when the draft clears", async () => {
    render(<SessionComposer activeSession={null} activeSessionId={null} />);
    const chip = (): HTMLElement | null =>
      screen.queryByRole("button", { name: /hunt trending memecoins/i });
    expect(chip()).not.toBeNull();

    // Any draft content counts as typing — the row fades/scales out
    // (AnimatePresence exit → removal is async, hence waitFor).
    fireEvent.change(screen.getByLabelText("Session draft"), {
      target: { value: "b" },
    });
    await waitFor(() => expect(chip()).toBeNull());

    // Clearing the field brings the starters back.
    fireEvent.change(screen.getByLabelText("Session draft"), {
      target: { value: "" },
    });
    await waitFor(() => expect(chip()).not.toBeNull());
  });

  it("keeps the fixed-height chips slot mounted while typing so the pill cannot reflow", async () => {
    const { container } = render(
      <SessionComposer activeSession={null} activeSessionId={null} />,
    );
    const slot = (): Element | null =>
      container.querySelector('[class*="h-[60px]"]');
    expect(slot()).not.toBeNull();

    // Typing removes the chip row but the reserved-height slot persists, so
    // the centered column (and the pill above it) never jumps.
    fireEvent.change(screen.getByLabelText("Session draft"), {
      target: { value: "b" },
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /hunt trending memecoins/i }),
      ).toBeNull(),
    );
    expect(slot()).not.toBeNull();
  });

  it("opens on the first rotating welcome prompt as an aria-hidden overlay — no native placeholder", () => {
    const { container } = render(
      <SessionComposer activeSession={null} activeSessionId={null} />,
    );
    const draft = screen.getByLabelText("Session draft") as HTMLTextAreaElement;
    // The native placeholder attribute is GONE — it cannot animate; the
    // accessible name stays on the aria-label.
    expect(draft.getAttribute("placeholder")).toBeNull();
    const overlay = container.querySelector("[data-vex-composer-placeholder]");
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute("aria-hidden")).toBe("true");
    expect(overlay?.className).toContain("pointer-events-none");
    // Opens on phrase one (jsdom has no matchMedia → not reduced-motion).
    expect(overlay?.textContent).toContain(WELCOME_PLACEHOLDERS[0]);
  });

  it("hides the faux placeholder while the draft holds text, like a native placeholder", () => {
    const { container } = render(
      <SessionComposer activeSession={null} activeSessionId={null} />,
    );
    fireEvent.change(screen.getByLabelText("Session draft"), {
      target: { value: "buy the dip" },
    });
    expect(
      container.querySelector("[data-vex-composer-placeholder]"),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText("Session draft"), {
      target: { value: "" },
    });
    expect(
      container.querySelector("[data-vex-composer-placeholder]"),
    ).not.toBeNull();
  });

  it("swaps the rotating prompt on a fresh keyed overlay span (animated crossfade)", () => {
    // Fake timers drive the rotator's ~6s cadence; the swap mounts the NEXT
    // phrase on its own keyed motion span. The outgoing span may linger
    // mid-exit under AnimatePresence, so pin the arrival, not the departure.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { container } = render(
        <SessionComposer activeSession={null} activeSessionId={null} />,
      );
      const overlay = (): Element | null =>
        container.querySelector("[data-vex-composer-placeholder]");
      expect(overlay()?.textContent).toContain(WELCOME_PLACEHOLDERS[0]);
      act(() => {
        vi.advanceTimersByTime(PLACEHOLDER_ROTATE_MS);
      });
      expect(overlay()?.textContent).toContain(WELCOME_PLACEHOLDERS[1]);
      // Unmount under the same fake-timer regime that scheduled the tick
      // (the composer-placeholders.test idiom).
      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("no placeholder phrase references the retired Plan Mode", () => {
    for (const phrase of WELCOME_PLACEHOLDERS) {
      expect(phrase.toLowerCase()).not.toContain("plan");
    }
  });

  it("renders under a re-tinted theme scope without leaking raw colors (token-only)", () => {
    // jsdom does not resolve CSS vars; the token-only classNames are what
    // guarantee any theme scope recolors. Smoke-mount inside a hypothetical
    // alternate theme scope (the planned `celeris` light theme, see uiStore's
    // `VexTheme` doc) and confirm the round send fill still routes through
    // the accent-contrast token.
    render(
      <div data-vex-shell="true" data-vex-theme="celeris">
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

describe("SessionComposer — console ring states (globals.css contract)", () => {
  /** First rule block for a selector — `indexOf` finds the MAIN rule; the
   * reduced-motion overrides repeat the focus/approval selectors later. */
  function blockFor(selector: string): string {
    const start = GLOBALS_CSS.indexOf(`${selector} {`);
    expect(start, `selector missing from globals.css: ${selector}`).toBeGreaterThan(-1);
    const end = GLOBALS_CSS.indexOf("}", start);
    return GLOBALS_CSS.slice(start, end);
  }

  it("resting ring is ONE flat hairline — no conic arc, no animation (owner correction 2026-07-21 round 2)", () => {
    const rest = blockFor(".vex-console::before");
    expect(rest).toContain("var(--vex-line)");
    expect(rest).not.toContain("conic-gradient");
    expect(rest).not.toContain("animation:");
    expect(rest).not.toContain("--vex-console-angle");
  });

  it("the traveling arc exists ONLY for focus (subtle accent) and approval (amber)", () => {
    const focus = blockFor(".vex-console:focus-within::before");
    expect(focus).toContain("conic-gradient");
    expect(focus).toContain("animation: vex-console-travel");
    expect(focus).toContain("--vex-accent");

    const approval = blockFor(
      '.vex-console[data-vex-console-state="approval"]::before',
    );
    expect(approval).toContain("conic-gradient");
    expect(approval).toContain("animation: vex-console-travel");
    expect(approval).toContain("--vex-pin");

    // No OTHER .vex-console rule animates the ring: exactly the two
    // animation declarations above ride the travel keyframes.
    const travelUses = GLOBALS_CSS.split("animation: vex-console-travel").length - 1;
    expect(travelUses).toBe(2);
  });
});
