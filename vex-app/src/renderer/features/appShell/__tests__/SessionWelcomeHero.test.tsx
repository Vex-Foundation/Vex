/**
 * SessionWelcomeHero - the welcome (docs/design/H3-DESKTOP.md section 1.7
 * and Appendix A.4; references d3x-first-welcome and d3x-database-down): the
 * greeting bubble, "Ready when you are.", with the honest preview disclosure
 * as its tooltip, its two notes worded to what desktop does, the
 * database-down callout and the Vex Inference notice. Vex is not drawn here:
 * H3's welcome keeps her column beside it (S2-10), so the welcome has no
 * stage, no token toggle and no note handing her to the column, and no state
 * word (the owner, 2026-10-17). The retired V10 opening (the date eyebrow,
 * the runtime-mode capsule, the Arena notice) stays gone, and so do R3's
 * time-of-day greeting pools.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useUiStore } from "../../../stores/uiStore.js";
import {
  NO_BACKGROUND_WORK,
  backgroundWorkOf,
} from "../../vex/background-work.js";
import { NEEDS_YOU_UNKNOWN_COPY, NEEDS_YOU_WITHDRAWALS_UNKNOWN_COPY } from "../../vex/needs-you.js";
import type { VexPresence } from "../../vex/useVexPresence.js";
import { session } from "../../vex/__tests__/fixtures.js";

// R3's headline read the Vex-setup displayName through the account row's
// profile hook; H3's greeting is one fixed line, so the hook is stubbed only
// to prove the welcome no longer reads it.
const useUserProfileMock = vi.fn();
vi.mock("../../../lib/api/user-profile.js", () => ({
  useUserProfile: () => useUserProfileMock(),
}));

// The sessions read the sidebar already holds; its failure is the database
// down.
const refetchSessions = vi.fn();
let sessionsData: unknown = { ok: true, data: [] };
vi.mock("../../../lib/api/sessions.js", () => ({
  useSessionModel: () => ({ data: undefined }),
  useSessionsList: () => ({ data: sessionsData, refetch: refetchSessions }),
}));

// The env read behind the Vex Inference notice: unknown by default, so the
// notice stays out of every case that does not ask for it (its own suite is
// `VexInferenceNotice.test.tsx`).
let envData: unknown = undefined;
vi.mock("../../../lib/api/onboarding.js", () => ({
  useEnvState: () => ({ data: envData }),
}));

// The presence model is pinned by its own suites; here it is the input.
const retryNeedsYou = vi.fn();
let presence: VexPresence;
vi.mock("../../vex/useVexPresence.js", () => ({
  useVexPresence: () => presence,
}));

const { SessionWelcomeHero, WELCOME_GREETING, WELCOME_NOTES } = await import(
  "../SessionWelcomeHero.js"
);

function profileWithName(displayName: string | null): void {
  useUserProfileMock.mockReturnValue({
    data: { ok: true, data: { displayName } },
  });
}

function readyPresence(over: Partial<VexPresence> = {}): VexPresence {
  return {
    state: "ready",
    word: "Ready",
    fill: "idle",
    scope: null,
    timerStartedAt: null,
    live: false,
    narration: null,
    background: NO_BACKGROUND_WORK,
    needsYou: {
      status: "ready",
      unknownCopy: null,
      count: 0,
      items: [],
      retry: retryNeedsYou,
      retrying: false,
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({
    runtimeMode: "agent",
    activeSessionId: null,
    showAvatar: true,
    welcomeVexShown: true,
    theme: "chronos",
  });
  profileWithName(null);
  sessionsData = { ok: true, data: [] };
  envData = undefined;
  useUiStore.setState({ vexInferenceNoticeDismissed: false });
  presence = readyPresence();
});

describe("SessionWelcomeHero - Vex stands in her column, not on the welcome", () => {
  it("draws no Vex of its own: no stage, no figure, no token key", () => {
    const { container } = render(<SessionWelcomeHero />);
    expect(container.querySelector("[data-vex-welcome-stage]")).toBeNull();
    expect(container.querySelector("[data-vex-area='kimm-section'], canvas")).toBeNull();
    expect(screen.queryByRole("button", { name: /Hide Vex|Show Vex/ })).toBeNull();
  });

  it("opens on the greeting: the opening's first child is the headline", () => {
    const { container } = render(<SessionWelcomeHero />);
    const opening = container.querySelector("[data-vex-area='welcome-opening']");
    expect(opening?.firstElementChild?.tagName).toBe("H1");
  });

  it("writes no Vex choice: neither the welcome key nor Show avatar", () => {
    useUiStore.setState({ welcomeVexShown: false, showAvatar: false });
    render(<SessionWelcomeHero />);
    expect(useUiStore.getState().welcomeVexShown).toBe(false);
    expect(useUiStore.getState().showAvatar).toBe(false);
  });

  it("shows no state word: no state line, no swatch, no word (the header's Vex key and her column carry it)", () => {
    const { container } = render(<SessionWelcomeHero />);
    expect(container.querySelector("[data-vex-welcome-state]")).toBeNull();
    expect(container.querySelector(".vex-state-word")).toBeNull();
    expect(container.querySelector(".vex-swatch")).toBeNull();
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("no background missions line either, and no ring: a running mission and Concerned stay in her column", () => {
    presence = readyPresence({
      state: "concerned",
      word: "Concerned",
      fill: "concerned",
      background: backgroundWorkOf(
        [session({ title: "Weekly rebalance", missionStatus: "running" })],
        null,
      ),
    });
    const { container } = render(<SessionWelcomeHero />);
    expect(screen.queryByText(/mission running/)).toBeNull();
    expect(screen.queryByText("Concerned")).toBeNull();
    expect(container.querySelector("[data-vex-status]")).toBeNull();
  });
});

/** The welcome's sheet as text, comments stripped (jsdom has no cascade). */
const COMPOSER_CSS = readFileSync(
  join(process.cwd(), "src/renderer/styles/global-css/composer.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(COMPOSER_CSS)?.[1] ?? "";
}

describe("SessionWelcomeHero - the greeting bubble", () => {
  it("says H3's one line, \"Ready when you are.\", whatever the hour or the name", () => {
    profileWithName("desu");
    const randSpy = vi.spyOn(Math, "random");
    const view = render(<SessionWelcomeHero />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Ready when you are.");
    expect(heading.textContent).toBe(WELCOME_GREETING);
    view.rerender(<SessionWelcomeHero />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Ready when you are.");
    // No draw from the retired time-of-day pools, and no name read.
    expect(randSpy).not.toHaveBeenCalled();
    expect(useUserProfileMock).not.toHaveBeenCalled();
  });

  it("keeps the honest preview disclosure as its tooltip", () => {
    render(<SessionWelcomeHero />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.className).toContain("vex-welcome__greeting");
    expect(heading.getAttribute("title")).toContain("Preview build (v0.0.0-test)");
    expect(heading.getAttribute("title")).toContain("Self-custodial");
  });

  it("is a bubble: sans 18 in ink on the raised 2 fill, square, set from the left", () => {
    const rule = cssRule(".vex-welcome__greeting");
    expect(rule).toMatch(/font-size:\s*18px;/);
    expect(rule).toMatch(/font-weight:\s*400;/);
    expect(rule).toMatch(/font-family:\s*var\(--font-sans\);/);
    expect(rule).toMatch(/background:\s*var\(--vex-alias-bg-overlay\);/);
    expect(rule).toMatch(/padding:\s*12px 16px;/);
    expect(rule).not.toMatch(/text-align:\s*center/);
    expect(rule).not.toMatch(/border-radius/);
    // The ink as type (docs/design/H3-DESKTOP.md section 2.1): the blue is
    // never type on the ground.
    expect(rule).toMatch(/color:\s*var\(--vex-alias-accent-primary\);/);
    const tokens = readFileSync(
      join(process.cwd(), "src/renderer/styles/global-css/tokens.css"),
      "utf8",
    );
    expect(tokens).toContain("--vex-alias-accent-primary: var(--color-h3-ink);");
    expect(tokens).toContain("--vex-alias-bg-overlay: var(--color-h3-raised-2);");
  });

  it("stands at the column's top, 24 in and 28 under the header, the composer at the foot", () => {
    const opening = cssRule(".vex-welcome");
    expect(opening).toMatch(/align-items:\s*flex-start;/);
    expect(opening).toMatch(/margin-bottom:\s*auto;/);
    expect(opening).toMatch(/padding:\s*28px 24px/);
    const seat = cssRule(
      '[data-vex-area="session-panel"][data-phase="hero"] [data-vex-composer-seat]',
    );
    expect(seat).toMatch(/flex:\s*1 0 auto;/);
    expect(seat).not.toMatch(/margin-block:\s*auto/);
  });
});

describe("SessionWelcomeHero - the notes", () => {
  it("are the two notes, worded to what desktop does, right under the greeting", () => {
    const { container } = render(<SessionWelcomeHero />);
    const notes = container.querySelector("[data-vex-welcome-notes]");
    expect(container.querySelector("h1")?.nextElementSibling).toBe(notes);
    expect(notes?.tagName).toBe("UL");
    expect(Array.from(notes?.querySelectorAll("li") ?? []).map((li) => li.textContent)).toEqual([
      "Vex can trade for you",
      "Your keys stay on this computer",
    ]);
    expect(WELCOME_NOTES).toEqual(["Vex can trade for you", "Your keys stay on this computer"]);
  });

  it("promise nothing desktop lacks: no limits, no pauses, no policy check", () => {
    for (const note of WELCOME_NOTES) {
      expect(note).not.toMatch(/limit|pause|policy|budget|strateg/i);
    }
  });

  it("are written in sentence case and set in tracked caps, each behind a small ink square", () => {
    for (const note of WELCOME_NOTES) expect(note).not.toBe(note.toUpperCase());
    const line = cssRule(".vex-welcome__note");
    expect(line).toMatch(/text-transform:\s*uppercase;/);
    expect(line).toMatch(/letter-spacing:\s*var\(--tracking-label\);/);
    expect(line).toMatch(/font-size:\s*12px;/);
    expect(line).toMatch(/color:\s*var\(--vex-alias-label-tertiary\);/);
    const square = cssRule(".vex-welcome__note::before");
    expect(square).toMatch(/width:\s*6px;/);
    expect(square).toMatch(/height:\s*6px;/);
    expect(square).toMatch(/background:\s*var\(--vex-alias-label-primary\);/);
  });
});

describe("SessionWelcomeHero - the database down", () => {
  it("shows no callout while the sessions read is fine", () => {
    const { container } = render(<SessionWelcomeHero />);
    expect(container.querySelector("[data-vex-welcome-alert]")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("heads the ink callout with the read's own message, adds the approvals line, and retries both", () => {
    sessionsData = {
      ok: false,
      error: {
        code: "DB_UNAVAILABLE",
        message: "Database unavailable. Verify services are running and retry.",
      },
    };
    presence = readyPresence({
      needsYou: {
        status: "unknown",
        unknownCopy: NEEDS_YOU_UNKNOWN_COPY,
        count: null,
        items: [],
        retry: retryNeedsYou,
        retrying: false,
      },
    });
    const { container } = render(<SessionWelcomeHero />);
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-vex-welcome-alert")).not.toBeNull();
    expect(alert.className).toContain("vex-callout");
    expect(alert.textContent).toContain(
      "Database unavailable. Verify services are running and retry.",
    );
    expect(alert.textContent).toContain(NEEDS_YOU_UNKNOWN_COPY);
    expect(alert.querySelector("[data-vex-open-logs]")).not.toBeNull();
    // Under the greeting's notes, above the composer the panel seats next.
    expect(container.querySelector("[data-vex-welcome-notes]")?.nextElementSibling).toBe(alert);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetchSessions).toHaveBeenCalledTimes(1);
    expect(retryNeedsYou).toHaveBeenCalledTimes(1);
  });

  it("says the withdrawal check failed when that is the read Needs you could not make", () => {
    sessionsData = {
      ok: false,
      error: { code: "DB_UNAVAILABLE", message: "Database unavailable." },
    };
    presence = readyPresence({
      needsYou: {
        status: "unknown",
        unknownCopy: NEEDS_YOU_WITHDRAWALS_UNKNOWN_COPY,
        count: null,
        items: [],
        retry: vi.fn(),
        retrying: false,
      },
    });
    render(<SessionWelcomeHero />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(NEEDS_YOU_WITHDRAWALS_UNKNOWN_COPY);
    expect(alert.textContent).not.toContain(NEEDS_YOU_UNKNOWN_COPY);
  });

  it("leaves the approvals line out while the approvals read is fine", () => {
    sessionsData = {
      ok: false,
      error: { code: "DB_UNAVAILABLE", message: "Database unavailable." },
    };
    render(<SessionWelcomeHero />);
    expect(screen.getByRole("alert").textContent).not.toContain(NEEDS_YOU_UNKNOWN_COPY);
  });
});

describe("SessionWelcomeHero - the Vex Inference notice", () => {
  function openRouterEnv(): unknown {
    return {
      ok: true,
      data: { provider: { configured: true, name: "openrouter", modelLabel: "a/b", endpointTag: null } },
    };
  }

  it("seats the notice under the greeting's notes, last in the opening, while OpenRouter is active", () => {
    envData = openRouterEnv();
    const { container } = render(<SessionWelcomeHero />);
    const notice = screen.getByRole("region", { name: "AI is now paid in VEX" });
    expect(container.querySelector("[data-vex-welcome-notes]")?.nextElementSibling).toBe(notice);
    expect(container.querySelector('[data-vex-area="welcome-opening"]')?.lastElementChild).toBe(notice);
  });

  it("sits under the database-down callout when both show", () => {
    envData = openRouterEnv();
    sessionsData = { ok: false, error: { code: "DB_UNAVAILABLE", message: "Database unavailable." } };
    render(<SessionWelcomeHero />);
    expect(screen.getByRole("alert").nextElementSibling).toBe(
      screen.getByRole("region", { name: "AI is now paid in VEX" }),
    );
  });

  it("stays out while the env read is unknown", () => {
    render(<SessionWelcomeHero />);
    expect(screen.queryByRole("region", { name: "AI is now paid in VEX" })).toBeNull();
  });
});

describe("SessionWelcomeHero - the retired V10 opening stays gone", () => {
  it("mounts no runtime-mode capsule, no date eyebrow and no Arena notice", () => {
    const { container } = render(<SessionWelcomeHero />);
    expect(screen.queryByRole("radiogroup", { name: "Runtime mode" })).toBeNull();
    expect(container.querySelector(".vex-micro-label")).toBeNull();
    expect(container.querySelector('[data-vex-area="arena-campaign-notice"]')).toBeNull();
    expect(screen.queryByText(/Perps Trading Arena/i)).toBeNull();
  });

  it("retired compositions stay dead: quips, PREVIEW wordmark, sigil, BACKED BY band", () => {
    const { container } = render(<SessionWelcomeHero />);
    for (const quip of [
      "Signed. Sealed. Executed.",
      "Your rules. My moves.",
      "Propose. Enforce. Prove.",
      "The desk is open.",
      "VEX is listening.",
    ]) {
      expect(screen.queryByText(quip)).toBeNull();
    }
    expect(screen.queryByText(/^PREVIEW · v/)).toBeNull();
    expect(container.querySelector("[data-vex-sigil]")).toBeNull();
    expect(screen.queryByText(/Backed by/i)).toBeNull();
  });
});
