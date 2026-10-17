/**
 * SessionWelcomeHero - the R3 welcome (docs/design/R3-MINIMAL.md sections 7
 * and 10.1, references d2, d3x-first-welcome and d3x-database-down): Vex on
 * her welcome stage (or the flat token in its state ring with the avatar
 * off, and the note that docks her into the Vex sidebar), the state line
 * under her from the presence model ("Ready · 1 mission running", no scope),
 * the serif greeting with the honest preview disclosure as its tooltip, and
 * the database-down callout. The retired V10 opening (the date eyebrow, the
 * runtime-mode capsule, the Arena notice) stays gone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { VexK2Props } from "../../../components/vex/k2/VexK2.js";
import { greetingPoolForHour } from "../../../lib/greeting.js";
import { useUiStore } from "../../../stores/uiStore.js";
import {
  NO_BACKGROUND_WORK,
  backgroundWorkOf,
} from "../../vex/background-work.js";
import { NEEDS_YOU_UNKNOWN_COPY } from "../../vex/needs-you.js";
import { takeVexDock, vexDockPending } from "../../vex/vex-dock.js";
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
  useSessionsList: () => ({ data: sessionsData, refetch: refetchSessions }),
}));

// The presence model is pinned by its own suites; here it is the input.
const retryNeedsYou = vi.fn();
let presence: VexPresence;
vi.mock("../../vex/useVexPresence.js", () => ({
  useVexPresence: () => presence,
}));

// Her canvas is pinned by VexK2's own suite; here the host records what the
// welcome hands her (placement, ground, emotion, the composer she looks at).
let lastK2: VexK2Props | null = null;
vi.mock("../../../components/vex/k2/VexK2.js", () => ({
  VexK2: (props: VexK2Props) => {
    lastK2 = props;
    return (
      <div
        aria-hidden="true"
        data-vex-k2={props.placement}
        data-vex-k2-ground={props.ground}
        data-emotion={props.emotion}
        className={props.className}
      />
    );
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
    narration: null,
    background: NO_BACKGROUND_WORK,
    needsYou: {
      status: "ready",
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
    theme: "celeris",
  });
  profileWithName(null);
  sessionsData = { ok: true, data: [] };
  presence = readyPresence();
  lastK2 = null;
  takeVexDock();
});

describe("SessionWelcomeHero - Vex and the state line", () => {
  it("stands Vex on her welcome stage, on day paper", () => {
    const { container } = render(<SessionWelcomeHero />);
    const stage = container.querySelector("[data-vex-welcome-stage]");
    const host = stage?.querySelector("[data-vex-k2]");
    expect(host?.getAttribute("data-vex-k2")).toBe("welcome");
    expect(host?.getAttribute("data-vex-k2-ground")).toBe("paper");
    expect(host?.className).toContain("vex-welcome__vex");
  });

  it("her face echoes the presence state: idle when Ready, the raised palm while an approval waits", () => {
    const { container, unmount } = render(<SessionWelcomeHero />);
    expect(container.querySelector("[data-vex-k2]")?.getAttribute("data-emotion")).toBe("idle");
    unmount();
    presence = readyPresence({
      state: "awaiting",
      word: "Waiting for approval",
      fill: "awaiting",
    });
    const second = render(<SessionWelcomeHero />);
    expect(
      second.container.querySelector("[data-vex-k2]")?.getAttribute("data-emotion"),
    ).toBe("approval");
  });

  it("listens while the user types, her eyes on the composer under her", () => {
    presence = readyPresence({ state: "listening", word: "Listening", fill: "listening" });
    const composer = document.createElement("div");
    composer.setAttribute("data-vex-composer-stage", "hero");
    document.body.append(composer);
    try {
      const { container } = render(<SessionWelcomeHero />);
      expect(container.querySelector("[data-vex-k2]")?.getAttribute("data-emotion")).toBe(
        "listening",
      );
      expect(lastK2?.composer?.()).toBe(composer);
    } finally {
      composer.remove();
    }
  });

  it("stands her on night paper in Chronos", () => {
    useUiStore.setState({ theme: "chronos" });
    const { container } = render(<SessionWelcomeHero />);
    expect(
      container.querySelector("[data-vex-k2]")?.getAttribute("data-vex-k2-ground"),
    ).toBe("night");
  });

  it("with the avatar off shows the flat token alone, no hologram", () => {
    useUiStore.setState({ showAvatar: false });
    const { container } = render(<SessionWelcomeHero />);
    expect(container.querySelector("[data-vex-k2]")).toBeNull();
    expect(container.querySelector(".vex-vx-token")).not.toBeNull();
    // The token in its state ring, over the state line, which stays.
    const status = container.querySelector("[data-vex-status]");
    expect(status?.getAttribute("data-vex-status-layout")).toBe("stack");
    expect(status?.querySelector("[data-vex-status-ring]")?.getAttribute("data-vex-status-ring")).toBe(
      "ready",
    );
    expect(status?.querySelector("[data-vex-welcome-state]")?.textContent).toBe("Ready");
    // No hologram here, so nothing to dock into the sidebar.
    expect(vexDockPending()).toBe(false);
  });

  it("leaves the note that docks her into the Vex sidebar on the first message", () => {
    render(<SessionWelcomeHero />);
    expect(vexDockPending()).toBe(true);
  });

  it("says Ready with its outline fill and no scope", () => {
    const { container } = render(<SessionWelcomeHero />);
    const line = container.querySelector("[data-vex-welcome-state]");
    expect(line?.textContent).toBe("Ready");
    expect(line?.querySelector('.vex-swatch[data-s="idle"]')).not.toBeNull();
    expect(line?.textContent).not.toContain("This chat:");
  });

  it("adds the background missions after a dot: Ready · 1 mission running", () => {
    presence = readyPresence({
      background: backgroundWorkOf(
        [session({ title: "Weekly rebalance", missionStatus: "running" })],
        null,
      ),
    });
    const { container } = render(<SessionWelcomeHero />);
    const line = container.querySelector("[data-vex-welcome-state]");
    expect(line?.textContent).toBe("Ready·1 mission running");
    const words = line?.querySelectorAll(".vex-state-word");
    expect(words).toHaveLength(2);
    expect(words?.[1]?.querySelector('.vex-swatch[data-s="done"]')).not.toBeNull();
  });

  it("speaks the presence word and fill when Vex is not ready (offline: Concerned)", () => {
    presence = readyPresence({ state: "concerned", word: "Concerned", fill: "concerned" });
    const { container } = render(<SessionWelcomeHero />);
    const line = container.querySelector("[data-vex-welcome-state]");
    expect(line?.textContent).toBe("Concerned");
    expect(line?.querySelector('.vex-swatch[data-s="concerned"]')).not.toBeNull();
  });
});

describe("SessionWelcomeHero - the greeting", () => {
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

  it("leaves the approvals line out while the approvals read is fine", () => {
    sessionsData = {
      ok: false,
      error: { code: "DB_UNAVAILABLE", message: "Database unavailable." },
    };
    render(<SessionWelcomeHero />);
    expect(screen.getByRole("alert").textContent).not.toContain(NEEDS_YOU_UNKNOWN_COPY);
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
