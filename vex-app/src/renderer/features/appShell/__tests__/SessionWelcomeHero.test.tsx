/**
 * SessionWelcomeHero - the welcome (docs/design/R3-MINIMAL.md sections 7 and
 * 10.1 for its words; docs/design/H3-DESKTOP.md section 1.7 for its place,
 * references d3x-first-welcome and d3x-database-down): the greeting with the
 * honest preview disclosure as its tooltip, the database-down callout and
 * the Vex Inference notice. Vex is not drawn here: H3's welcome keeps her
 * column beside it (S2-10), so the welcome has no stage, no token toggle and
 * no note handing her to the column, and no state word (the owner,
 * 2026-10-17). The retired V10 opening (the date eyebrow, the runtime-mode
 * capsule, the Arena notice) stays gone.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { greetingPoolForHour } from "../../../lib/greeting.js";
import { useUiStore } from "../../../stores/uiStore.js";
import {
  NO_BACKGROUND_WORK,
  backgroundWorkOf,
} from "../../vex/background-work.js";
import { NEEDS_YOU_UNKNOWN_COPY, NEEDS_YOU_WITHDRAWALS_UNKNOWN_COPY } from "../../vex/needs-you.js";
import type { VexPresence } from "../../vex/useVexPresence.js";
import { session } from "../../vex/__tests__/fixtures.js";

// The hero reads the Vex-setup displayName through the SAME profile hook the
// account row uses; stubbed per case so both headline forms are provable
// without a query provider.
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

// Her canvas would be K2's; the welcome must not mount it at all.
const k2Mounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../../components/vex/k2/VexK2.js", () => ({
  VexK2: () => {
    k2Mounts.count += 1;
    return <div data-vex-k2="" />;
  },
}));

const { SessionWelcomeHero } = await import("../SessionWelcomeHero.js");

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
  k2Mounts.count = 0;
});

describe("SessionWelcomeHero - Vex stands in her column, not on the welcome", () => {
  it("draws no Vex of its own: no stage, no hologram, no token key", () => {
    const { container } = render(<SessionWelcomeHero />);
    expect(container.querySelector("[data-vex-welcome-stage]")).toBeNull();
    expect(container.querySelector("[data-vex-k2]")).toBeNull();
    expect(k2Mounts.count).toBe(0);
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

describe("SessionWelcomeHero - the greeting", () => {
  it("is set in the accent as type, which H3 sets in ink: the blue is never type on the ground", () => {
    const css = readFileSync(
      join(process.cwd(), "src/renderer/styles/global-css/composer.css"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /\.vex-welcome__greeting\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/color:\s*var\(--vex-alias-accent-primary\);/);
    const tokens = readFileSync(
      join(process.cwd(), "src/renderer/styles/global-css/tokens.css"),
      "utf8",
    );
    // The token it reads: the ink (docs/design/H3-DESKTOP.md section 2.1).
    expect(tokens).toContain("--vex-alias-accent-primary: var(--color-h3-ink);");
    expect(tokens).toContain("--color-h3-ink: #f3f5f9;");
  });

  it("sets the greeting in the serif title and keeps the honest preview disclosure as its tooltip", () => {
    render(<SessionWelcomeHero />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.className).toContain("vex-welcome__greeting");
    expect(heading.getAttribute("title")).toContain("Preview build (v0.0.0-test)");
    expect(heading.getAttribute("title")).toContain("Self-custodial");
  });

  it("draws the headline from the current bucket's NAMELESS pool while no displayName is set", () => {
    render(<SessionWelcomeHero />);
    const heading = screen.getByRole("heading", { level: 1 });
    const nameless = greetingPoolForHour(new Date().getHours())
      .filter((variant) => !variant.withName)
      .map((variant) => variant.text);
    expect(nameless).toContain(heading.textContent);
  });

  it("with a set displayName the whole bucket is eligible and {name} is substituted", () => {
    profileWithName("desu");
    render(<SessionWelcomeHero />);
    const heading = screen.getByRole("heading", { level: 1 });
    const eligible = greetingPoolForHour(new Date().getHours()).map((variant) =>
      variant.text.replace("{name}", "desu"),
    );
    expect(eligible).toContain(heading.textContent);
    expect(heading.textContent).not.toContain("{name}");
  });

  it("fails closed to the nameless draw while the profile read is unresolved or failed", () => {
    useUserProfileMock.mockReturnValue({ data: undefined });
    render(<SessionWelcomeHero />);
    const heading = screen.getByRole("heading", { level: 1 });
    const nameless = greetingPoolForHour(new Date().getHours())
      .filter((variant) => !variant.withName)
      .map((variant) => variant.text);
    expect(nameless).toContain(heading.textContent);
  });

  it("freezes the draw per mount - re-rendering never changes the headline", () => {
    const randSpy = vi.spyOn(Math, "random");
    const view = render(<SessionWelcomeHero />);
    const first = screen.getByRole("heading", { level: 1 }).textContent;
    view.rerender(<SessionWelcomeHero />);
    view.rerender(<SessionWelcomeHero />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(first);
    // One draw for the whole mount, not one per render.
    expect(randSpy.mock.calls.length).toBeLessThanOrEqual(1);
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
    // Under the greeting, above the composer the panel seats next.
    expect(container.querySelector("h1")?.nextElementSibling).toBe(alert);
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

  it("seats the notice under the greeting, last in the opening, while OpenRouter is active", () => {
    envData = openRouterEnv();
    const { container } = render(<SessionWelcomeHero />);
    const notice = screen.getByRole("region", { name: "AI is now paid in VEX" });
    expect(container.querySelector("h1")?.nextElementSibling).toBe(notice);
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
