/**
 * SessionWelcomeHero - the R3 welcome (docs/design/R3-MINIMAL.md sections 7
 * and 10.1, references d2, d3x-first-welcome and d3x-database-down): Vex on
 * her welcome stage with no state word under her (the owner, 2026-10-17),
 * her token as a toggle ("Hide Vex", aria-pressed, stored as Show avatar:
 * a press closes her into the upright coin, the stage collapses to the coin
 * once she has settled, the next press gives the stage its size back and
 * then opens her; the seat glides, never under reduced motion), the note
 * that docks her into the Vex sidebar, the serif greeting with the honest
 * preview disclosure as its tooltip, and the database-down callout. The
 * retired V10 opening (the date eyebrow, the runtime-mode capsule, the Arena
 * notice) stays gone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import type { K2TokenState } from "../../../components/vex/k2/k2-engine.js";
import { fitFor, tokenBox, type Box } from "../../../components/vex/k2/k2-rig.js";
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

// The still frame and the seat's glide read the reduced-motion preference.
let reduced = false;
vi.mock("../../../lib/motion/reduced-motion.js", () => ({
  prefersReducedMotion: () => reduced,
  useReducedMotion: () => reduced,
  subscribeReducedMotion: () => () => undefined,
}));

// Her canvas is pinned by VexK2's own suite; here the host records what the
// welcome hands her (placement, ground, emotion, the composer she looks at,
// the token toggle) and stands in for the engine: after mount it reports the
// coin's box and the state she starts in, as the engine does after her first
// frame. Each render also notes the stage as the previous commit left it, so
// a case can prove the stage got its size back before she was told to open.
let lastK2: VexK2Props | null = null;
let hostBox: Box | null = null;
const k2Renders: { tokenOnly: boolean; stageBefore: string | null }[] = [];
function MockVexK2(props: VexK2Props) {
  lastK2 = props;
  k2Renders.push({
    tokenOnly: props.tokenOnly === true,
    stageBefore:
      document.querySelector("[data-vex-welcome-vex]")?.getAttribute("data-vex-welcome-vex") ??
      null,
  });
  // the engine reports once, on her first frame; later states come from the case
  const first = useRef(props);
  useEffect(() => {
    const p = first.current;
    if (hostBox !== null) p.onTokenBox?.(hostBox);
    p.onToken?.(p.tokenOnly === true ? "token" : "shown");
  }, []);
  return (
    <div
      aria-hidden="true"
      data-vex-k2={props.placement}
      data-vex-k2-ground={props.ground}
      data-emotion={props.emotion}
      data-token-only={props.tokenOnly === true ? "" : undefined}
      className={props.className}
    />
  );
}
vi.mock("../../../components/vex/k2/VexK2.js", () => ({ VexK2: MockVexK2 }));

/** The engine reports a toggle state (closing, token, opening, shown). */
function report(state: K2TokenState): void {
  act(() => {
    lastK2?.onToken?.(state);
  });
}

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
  hostBox = null;
  k2Renders.length = 0;
  reduced = false;
  takeVexDock();
});

describe("SessionWelcomeHero - Vex on her stage, no state word", () => {
  it("stands Vex on her welcome stage, on day paper", () => {
    const { container } = render(<SessionWelcomeHero />);
    const stage = container.querySelector("[data-vex-welcome-stage]");
    const host = stage?.querySelector("[data-vex-k2]");
    expect(host?.getAttribute("data-vex-k2")).toBe("welcome");
    expect(host?.getAttribute("data-vex-k2-ground")).toBe("paper");
    expect(host?.className).toContain("vex-welcome__vex");
    expect(lastK2?.tokenOnly).toBe(false);
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

  it("leaves the note that docks her into the Vex sidebar on the first message", () => {
    render(<SessionWelcomeHero />);
    expect(vexDockPending()).toBe(true);
  });

  it("shows no state word under Vex: no state line, no swatch, no word (the title bar chip and the Vex sidebar carry it)", () => {
    const { container } = render(<SessionWelcomeHero />);
    expect(container.querySelector("[data-vex-welcome-state]")).toBeNull();
    expect(container.querySelector(".vex-state-word")).toBeNull();
    expect(container.querySelector(".vex-swatch")).toBeNull();
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("no background missions line either, and no ring: a running mission and Concerned show only on her face", () => {
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
    expect(container.querySelector("[data-vex-k2]")?.getAttribute("data-emotion")).toBe(
      "concerned",
    );
  });
});

describe("SessionWelcomeHero - the token toggle", () => {
  const stageOf = (container: HTMLElement) =>
    container.querySelector("[data-vex-welcome-stage]")?.getAttribute("data-vex-welcome-vex");
  const clipOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>("[data-vex-welcome-clip]");
  const token = () => screen.getByRole("button", { name: "Hide Vex" });

  it("the token under her is a real button named Hide Vex, not pressed while she shows, keyboard reachable", () => {
    render(<SessionWelcomeHero />);
    const button = token();
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.className).toContain("vex-welcome__token");
    act(() => {
      button.focus();
    });
    expect(document.activeElement).toBe(button);
  });

  it("stands over the coin's box her host reports, grown to at least 44 px each way", () => {
    hostBox = { left: 130, top: 226, right: 190, bottom: 284 };
    const first = render(<SessionWelcomeHero />);
    expect(token().style.left).toBe("130px");
    expect(token().style.top).toBe("226px");
    expect(token().style.width).toBe("60px");
    expect(token().style.height).toBe("58px");
    first.unmount();
    hostBox = { left: 145, top: 250, right: 175, bottom: 270 };
    render(<SessionWelcomeHero />);
    expect(token().style.left).toBe("138px");
    expect(token().style.top).toBe("238px");
    expect(token().style.width).toBe("44px");
    expect(token().style.height).toBe("44px");
  });

  it("before her host reports, it stands over the coin's box on the full 320 x 284 stage", () => {
    render(<SessionWelcomeHero />);
    const fit = fitFor("welcome", 320, 284);
    if (fit === null) throw new Error("the full stage has no fit");
    const box = tokenBox(fit);
    expect(Number.parseFloat(token().style.left)).toBeCloseTo(box.left, 5);
    expect(Number.parseFloat(token().style.top)).toBeCloseTo(box.top, 5);
  });

  it("a press hides Vex: Show avatar off, the button pressed, her hologram closes into the token", () => {
    render(<SessionWelcomeHero />);
    fireEvent.click(token());
    expect(useUiStore.getState().showAvatar).toBe(false);
    expect(token().getAttribute("aria-pressed")).toBe("true");
    // one name in both states: the state is aria-pressed
    expect(screen.queryByRole("button", { name: "Show Vex" })).toBeNull();
    expect(lastK2?.tokenOnly).toBe(true);
  });

  it("the stage keeps its size while she closes and collapses to the coin's box once she has settled", () => {
    hostBox = { left: 130.5, top: 225.6, right: 189.5, bottom: 284 };
    const { container } = render(<SessionWelcomeHero />);
    expect(stageOf(container)).toBe("portrait");
    fireEvent.click(token());
    // the close is playing: nothing moves yet
    expect(stageOf(container)).toBe("portrait");
    report("closing");
    expect(stageOf(container)).toBe("portrait");
    expect(clipOf(container)?.style.height).toBe("");
    report("token");
    expect(stageOf(container)).toBe("token");
    // the clip is as tall as the coin; her host keeps its size, shifted up by the coin's top
    expect(clipOf(container)?.style.height).toBe("59px");
    expect((clipOf(container)?.firstElementChild as HTMLElement | null)?.style.marginTop).toBe(
      "-225px",
    );
    expect(clipOf(container)?.querySelector("[data-vex-k2]")?.className).toContain(
      "vex-welcome__vex",
    );
    // the button follows the coin up
    expect(Number.parseFloat(token().style.top)).toBeCloseTo(225.6 - 225, 5);
  });

  it("a second press gives the stage its size back first, then she opens (the wake from the token)", () => {
    useUiStore.setState({ showAvatar: false });
    const { container } = render(<SessionWelcomeHero />);
    expect(stageOf(container)).toBe("token");
    expect(token().getAttribute("aria-pressed")).toBe("true");
    k2Renders.length = 0;
    fireEvent.click(token());
    expect(useUiStore.getState().showAvatar).toBe(true);
    expect(stageOf(container)).toBe("portrait");
    expect(lastK2?.tokenOnly).toBe(false);
    expect(token().getAttribute("aria-pressed")).toBe("false");
    // the first render that tells her to open sees a stage that already has its size back
    const opened = k2Renders.find((r) => !r.tokenOnly);
    expect(opened?.stageBefore).toBe("portrait");
    report("opening");
    expect(stageOf(container)).toBe("portrait");
  });

  it("with the avatar off at mount only the coin stands, the stage collapsed, no ring and no word", () => {
    useUiStore.setState({ showAvatar: false });
    const { container } = render(<SessionWelcomeHero />);
    expect(lastK2?.tokenOnly).toBe(true);
    expect(container.querySelector("[data-vex-k2]")?.hasAttribute("data-token-only")).toBe(true);
    expect(stageOf(container)).toBe("token");
    expect(container.querySelector("[data-vex-status]")).toBeNull();
    expect(container.querySelector("[data-vex-welcome-state]")).toBeNull();
    // no hologram here, so nothing to dock into the sidebar
    expect(vexDockPending()).toBe(false);
  });

  it("the avatar switched back on elsewhere (the sidebar, Settings) gives the stage its size back", () => {
    useUiStore.setState({ showAvatar: false });
    const { container } = render(<SessionWelcomeHero />);
    expect(stageOf(container)).toBe("token");
    act(() => {
      useUiStore.setState({ showAvatar: true });
    });
    expect(stageOf(container)).toBe("portrait");
    expect(lastK2?.tokenOnly).toBe(false);
  });

  it("a press while she still closes, before she settled, never collapses the stage", () => {
    const { container } = render(<SessionWelcomeHero />);
    fireEvent.click(token());
    report("closing");
    fireEvent.click(token());
    expect(useUiStore.getState().showAvatar).toBe(true);
    // the engine lets the close settle, then opens her
    report("token");
    expect(stageOf(container)).toBe("portrait");
  });
});

describe("SessionWelcomeHero - the seat glides as the stage changes", () => {
  /** The welcome inside the composer seat, its band reporting `tops` in turn. */
  function renderSeated(tops: number[]) {
    const view = render(
      <div data-vex-composer-seat="">
        <SessionWelcomeHero />
        <div data-vex-composer-dock="" />
      </div>,
    );
    const seat = view.container.querySelector<HTMLElement>("[data-vex-composer-seat]");
    const dock = view.container.querySelector<HTMLElement>("[data-vex-composer-dock]");
    if (seat === null || dock === null) throw new Error("no seat");
    const animate = vi.fn();
    Object.defineProperty(seat, "animate", { value: animate, configurable: true });
    let n = 0;
    vi.spyOn(dock, "getBoundingClientRect").mockImplementation(() => {
      const top = tops[Math.min(n, tops.length - 1)] ?? 0;
      n++;
      return new DOMRect(0, top, 720, 302);
    });
    return { ...view, animate };
  }

  it("when she settles as the coin the seat glides up from where its band was: a transform, 240 ms, the standard curve", () => {
    const { animate } = renderSeated([520, 410]);
    fireEvent.click(screen.getByRole("button", { name: "Hide Vex" }));
    report("token");
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, options] = animate.mock.calls[0] ?? [];
    expect(frames).toEqual([{ transform: "translateY(110px)" }, { transform: "none" }]);
    expect(options).toEqual({ duration: 240, easing: "cubic-bezier(0.4, 0, 0.2, 1)" });
  });

  it("under reduced motion the stage swaps at once and the seat does not glide", () => {
    reduced = true;
    const { animate, container } = renderSeated([520, 410]);
    fireEvent.click(screen.getByRole("button", { name: "Hide Vex" }));
    report("token");
    expect(
      container.querySelector("[data-vex-welcome-stage]")?.getAttribute("data-vex-welcome-vex"),
    ).toBe("token");
    expect(animate).not.toHaveBeenCalled();
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
