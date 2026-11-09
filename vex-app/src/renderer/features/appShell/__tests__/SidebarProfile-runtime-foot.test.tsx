/**
 * THE RAIL FOOT'S RUNTIME LINE - a sentence, not a status word.
 *
 * The UX after-audit photographed the defect in every walk shot: under the
 * profile name the foot printed a bare uppercase `DEGRADED`, which tells a user
 * nothing about what is not working, why, or whether it is their move (rule 08
 * error UX). The fix takes the shape the Studio host status card already uses -
 * one sentence per state in a table total over the states
 * (`STUDIO_HOST_CAUSE_SENTENCES` in `studio/studio-copy.ts`).
 *
 * What is pinned here: the derivation from the health read to the state, the
 * table being total over that union, and the foot rendering the SENTENCE while
 * the menu's provenance row keeps the short word (a word is the right size in a
 * row that is a provenance stamp, and `shell-sidebar.test.tsx` pins it there).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Result } from "@shared/ipc/result.js";
import type { HealthReport } from "@shared/schemas/system.js";

const feature = vi.hoisted(() => ({ enabled: true }));
vi.mock("@shared/lock-button.js", () => ({ get LOCK_BUTTON() { return feature.enabled; } }));

const healthMock = vi.fn();
const profileMock = vi.fn();

vi.mock("../../../lib/api/system.js", () => ({
  useSystemHealth: () => healthMock(),
}));
vi.mock("../../../lib/api/user-profile.js", () => ({
  useUserProfile: () => profileMock(),
}));
vi.mock("../../../lib/api/capabilities.js", () => ({
  useMemoryFeatureEnabled: () => true,
}));
vi.mock("../VexSetupDialog.js", () => ({ VexSetupDialog: () => null }));
vi.mock("@thesvg/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@thesvg/react")>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, () => null]));
});

const {
  ACCOUNT_CELL_LINE,
  RUNTIME_STATUS_SENTENCES,
  SidebarProfile,
  getRuntimeStatus,
  NIGHT_SHIFT_MESSAGE,
} = await import("../SidebarProfile.js");
const lineIcons = await import("../../../components/icons/line/index.js");

function health(overall: HealthReport["overall"]): Result<HealthReport> {
  return {
    ok: true,
    data: {
      os: {
        platform: "linux",
        arch: "x64",
        release: "test",
        distro: null,
        homedir: "/home/test",
        userDataDir: "/home/test/.vex",
        appVersion: "0.0.0-test",
        electronVersion: "0.0.0",
        nodeVersion: "0.0.0",
      },
      network: { online: overall !== "not_ready", latencyMs: 1, probedAt: new Date().toISOString() },
      translocated: false,
      setupComplete: overall === "ok",
      overall,
    },
  };
}

beforeEach(() => {
  feature.enabled = true;
  healthMock.mockReturnValue({ isLoading: false, data: health("ok") });
  profileMock.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { ok: true, data: { displayName: "Kuba" } },
  });
});

describe("getRuntimeStatus", () => {
  it("maps every reachable health outcome to a state, a word and its sentence", () => {
    const cases = [
      { input: { loading: true, result: undefined }, state: "connecting", label: "Connecting", live: false },
      { input: { loading: false, result: undefined }, state: "connecting", label: "Connecting", live: false },
      {
        input: { loading: false, result: { ok: false, error: { message: "n/a" } } as Result<HealthReport> },
        state: "unavailable",
        label: "Unavailable",
        live: false,
      },
      { input: { loading: false, result: health("ok") }, state: "connected", label: "Connected", live: true },
      { input: { loading: false, result: health("degraded") }, state: "degraded", label: "Degraded", live: false },
      { input: { loading: false, result: health("not_ready") }, state: "not_ready", label: "Not ready", live: false },
    ] as const;

    for (const testCase of cases) {
      const status = getRuntimeStatus(testCase.input);
      expect({
        state: status.state,
        label: status.label,
        live: status.live,
        sentence: status.sentence,
      }).toEqual({
        state: testCase.state,
        label: testCase.label,
        live: testCase.live,
        sentence: RUNTIME_STATUS_SENTENCES[testCase.state],
      });
    }
  });

  it("gives every state a real sentence: ends in a full stop, never the bare word", () => {
    for (const [state, sentence] of Object.entries(RUNTIME_STATUS_SENTENCES)) {
      expect(sentence.endsWith(".")).toBe(true);
      expect(sentence.split(" ").length).toBeGreaterThan(3);
      expect(sentence.toUpperCase()).not.toBe(sentence);
      expect(state.length).toBeGreaterThan(0);
    }
  });
});

describe("SidebarProfile foot", () => {
  it("makes Lock Vex findable in expanded and collapsed profile menus", () => {
    const expanded = render(<SidebarProfile sidebarOpen />);
    fireEvent.click(screen.getByRole("button", { name: /account and settings/i }));
    expect(screen.getByRole("menuitem", { name: /Lock Vex.*Require your password to return/ })).not.toBeNull();
    expanded.unmount();
    render(<SidebarProfile sidebarOpen={false} menuSide="bottom" />);
    fireEvent.click(screen.getByRole("button", { name: /account and settings/i }));
    expect(screen.getByRole("menuitem", { name: /Lock Vex/ })).not.toBeNull();
  });

  it("shows Lock Vex's chord from the one constant the Settings Vault row shares", async () => {
    const { LOCK_VEX_SHORTCUT } = await import("../LockVexControl.js");
    render(<SidebarProfile sidebarOpen />);
    fireEvent.click(screen.getByRole("button", { name: /account and settings/i }));
    const lock = screen.getByRole("menuitem", { name: /Lock Vex/ });
    expect(lock.querySelector(".vex-menu-shortcut")?.textContent).toBe(LOCK_VEX_SHORTCUT);
  });

  it("hides Lock Vex when its rollback flag is off", () => {
    feature.enabled = false;
    render(<SidebarProfile sidebarOpen />);
    fireEvent.click(screen.getByRole("button", { name: /account and settings/i }));
    expect(screen.queryByRole("menuitem", { name: /Lock Vex/ })).toBeNull();
  });

  it("says Account and settings while the runtime is healthy, or still being checked", () => {
    // docs/design/H3-DESKTOP.md Appendix A.2: H3's line under the name. The
    // hallmark stays the healthy state's sentence, but the cell says H3's.
    const healthy = render(<SidebarProfile sidebarOpen />);
    expect(screen.getByText(ACCOUNT_CELL_LINE)).not.toBeNull();
    expect(screen.queryByText(NIGHT_SHIFT_MESSAGE)).toBeNull();
    healthy.unmount();

    healthMock.mockReturnValue({ isLoading: true, data: undefined });
    render(<SidebarProfile sidebarOpen />);
    expect(screen.getByText(ACCOUNT_CELL_LINE)).not.toBeNull();
    expect(screen.queryByText(RUNTIME_STATUS_SENTENCES.connecting)).toBeNull();
  });

  it("draws the cell as H3 does: the disc, the name, the line and the up chevron", () => {
    const { container } = render(<SidebarProfile sidebarOpen />);
    const trigger = screen.getByRole("button", { name: /account and settings/i });
    expect(trigger.querySelector("[data-vex-account-disc] circle.vex-prof__disc")).not.toBeNull();
    expect(trigger.querySelector(".vex-prof__n")?.textContent).toBe("Kuba");
    expect(trigger.querySelector(".vex-prof__s")?.textContent).toBe(ACCOUNT_CELL_LINE);
    // The chevron points up, the way the menu opens.
    const { LineChevronUp } = lineIcons;
    const up = render(<LineChevronUp />).container.querySelector("svg")?.innerHTML;
    expect(trigger.querySelector(".vex-prof__chev")?.innerHTML).toBe(up);
    expect(container.querySelector("[data-vex-home-mark]")).toBeNull();
  });

  it("speaks the DEGRADED cause as a sentence, and never the bare word", () => {
    // The exact regression: revert the foot to `runtime.label` and this goes
    // red on both halves - the sentence is absent and "Degraded" is back.
    healthMock.mockReturnValue({ isLoading: false, data: health("degraded") });
    render(<SidebarProfile sidebarOpen />);
    expect(screen.getByText(RUNTIME_STATUS_SENTENCES.degraded)).not.toBeNull();
    expect(screen.queryByText("Degraded")).toBeNull();
  });

  it("speaks the offline and unreadable states as sentences too", () => {
    healthMock.mockReturnValue({ isLoading: false, data: health("not_ready") });
    const view = render(<SidebarProfile sidebarOpen />);
    expect(screen.getByText(RUNTIME_STATUS_SENTENCES.not_ready)).not.toBeNull();
    view.unmount();

    healthMock.mockReturnValue({
      isLoading: false,
      data: { ok: false, error: { message: "n/a" } },
    });
    render(<SidebarProfile sidebarOpen />);
    expect(screen.getByText(RUNTIME_STATUS_SENTENCES.unavailable)).not.toBeNull();
  });

  it("keeps the short word where a word is the right size: the key's description", () => {
    healthMock.mockReturnValue({ isLoading: false, data: health("degraded") });
    render(<SidebarProfile sidebarOpen />);
    expect(
      screen.getByRole("button", {
        name: "Kuba, account and settings",
        description: "Runtime: Degraded",
      }),
    ).not.toBeNull();
  });

  it("names the account row by the name it shows, then what it opens (Cloud's launcher name)", () => {
    // The row shows "Kuba"; its accessible name must lead with that name and
    // not with the product ("Vex - Connected. Open menu" was the defect).
    render(<SidebarProfile sidebarOpen />);
    const trigger = screen.getByRole("button", {
      name: "Kuba, account and settings",
      description: "Runtime: Connected",
    });
    expect(trigger.getAttribute("aria-label")).toBe("Kuba, account and settings");
    expect(trigger.textContent).toContain("Kuba");
    expect(screen.queryByRole("button", { name: /^Vex - / })).toBeNull();
    expect(screen.queryByRole("button", { name: /Open menu/ })).toBeNull();
  });

  it("names the collapsed rail's box Account and settings, as Cloud's rail does", () => {
    render(<SidebarProfile sidebarOpen={false} />);
    expect(
      screen.getByRole("button", { name: "Account and settings", description: "Runtime: Connected" }),
    ).not.toBeNull();
  });

  it("says You while there is no name, and moves the ask to the menu's Personalize row", () => {
    // docs/design/H3-DESKTOP.md Appendix A.2: "You" or the person's name.
    profileMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { ok: true, data: { displayName: null } },
    });
    const asking = render(<SidebarProfile sidebarOpen />);
    expect(screen.queryByText("What should Vex call you?")).toBeNull();
    const trigger = screen.getByRole("button", { name: "You, account and settings" });
    expect(trigger.querySelector(".vex-prof__n")?.textContent).toBe("You");
    fireEvent.click(trigger);
    const personalize = screen.getByRole("menuitem", { name: /Personalize/ });
    expect(personalize.textContent).toContain("You didn't set up your name");
    expect(personalize.querySelector("[data-vex-attention-dot]")).not.toBeNull();
    asking.unmount();

    // Loading, and a name of only spaces, read "You" too, and loading never asks.
    profileMock.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    const loading = render(<SidebarProfile sidebarOpen />);
    expect(
      screen.getByRole("button", { name: "You, account and settings" }),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /account and settings/i }));
    expect(
      screen.getByRole("menuitem", { name: /Personalize/ }).querySelector("[data-vex-attention-dot]"),
    ).toBeNull();
    loading.unmount();

    profileMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { ok: true, data: { displayName: "   " } },
    });
    render(<SidebarProfile sidebarOpen />);
    expect(
      screen.getByRole("button", { name: "You, account and settings" }),
    ).not.toBeNull();
  });

  it("sets the person's disc as the picture, drawn, never an image or the vx", () => {
    // docs/design/H3-DESKTOP.md section 1.4: the avatar disc, the transcript's
    // own drawing; the R3 vx box and the left page's print are gone.
    const { container } = render(<SidebarProfile sidebarOpen />);
    const root = container.querySelector("[data-vex-area='sidebar-profile']");
    expect(root).not.toBeNull();
    expect(root?.hasAttribute("data-ground")).toBe(false);
    const disc = container.querySelector(".vex-prof__av svg");
    // Cloud's built avatar, 34 across (`.vx-lc-me`).
    expect(disc?.getAttribute("width")).toBe("34");
    expect(disc?.querySelector("circle.vex-prof__disc")?.getAttribute("r")).toBe("17.5");
    expect(disc?.querySelector(".vex-prof__glyph path")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("opens upward as the flat profile panel, with the runtime row's fill and word", () => {
    render(<SidebarProfile sidebarOpen />);
    fireEvent.click(screen.getByRole("button", { name: /account and settings/i }));
    const menu = screen.getByRole("menu");
    expect(menu.classList.contains("vex-profile-menu")).toBe(true);
    expect(menu.classList.contains("vex-profile-menu--panel")).toBe(true);
    // The runtime row: a solid fill beside "Runtime" and the short word.
    const runtime = screen.getByRole("menuitem", { name: /Runtime/ });
    expect(runtime.hasAttribute("disabled")).toBe(true);
    expect(runtime.querySelector(".vex-swatch")?.getAttribute("data-s")).toBe("done");
    expect(runtime.textContent).toContain("Connected");
    // Lock Vex shows its chord at the right.
    const lock = screen.getByRole("menuitem", { name: /Lock Vex/ });
    expect(lock.querySelector(".vex-menu-shortcut")?.textContent).toMatch(/L$/);
  });

  it("keeps the standard card when it opens downward from a top bar", () => {
    render(<SidebarProfile sidebarOpen={false} menuSide="bottom" />);
    fireEvent.click(screen.getByRole("button", { name: /account and settings/i }));
    expect(screen.getByRole("menu").classList.contains("vex-profile-menu--panel")).toBe(false);
  });

  it("gives the collapsed rail the shared tooltip: the sentence in trouble, no subtitle there", () => {
    healthMock.mockReturnValue({ isLoading: false, data: health("degraded") });
    const degraded = render(<SidebarProfile sidebarOpen={false} />);
    const trigger = screen.getByRole("button", { name: /account and settings/i });
    // The shared tooltip, never the native title.
    expect(trigger.hasAttribute("title")).toBe(false);
    expect(screen.queryByText(RUNTIME_STATUS_SENTENCES.degraded)).toBeNull();
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("tooltip").textContent).toBe(RUNTIME_STATUS_SENTENCES.degraded);
    fireEvent.mouseLeave(trigger);
    // The rail is the disc alone.
    expect(trigger.querySelector(".vex-prof__n")).toBeNull();
    expect(trigger.querySelector("[data-vex-account-disc]")).not.toBeNull();
    degraded.unmount();

    // Healthy, the tooltip is the name, Cloud's label.
    healthMock.mockReturnValue({ isLoading: false, data: health("ok") });
    render(<SidebarProfile sidebarOpen={false} />);
    const healthy = screen.getByRole("button", { name: /account and settings/i });
    fireEvent.mouseEnter(healthy);
    expect(screen.getByRole("tooltip").textContent).toBe("Kuba");
    // It stays down while the menu is open.
    fireEvent.click(healthy);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("turns the muted chevron while the menu is open, on Cloud's grid and open wash", () => {
    const css = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "styles", "global-css", "profile-menu.css"),
      "utf8",
    );
    const block = (selector: string): string => {
      const at = css.indexOf(`${selector} {`);
      expect(at, `${selector} has a rule`).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf("}", at));
    };
    const cell = block(".vex-prof");
    expect(cell).toMatch(/grid-template-columns: 34px minmax\(0, 1fr\) 16px;/);
    expect(cell).toMatch(/column-gap: 12px;/);
    // Open: the chosen row's wash over the rail's ground.
    expect(cell).toMatch(/--prof-sel: var\(--vex-alias-row-selected\), var\(--vex-alias-sidebar-fill\);/);
    // Hover: Cloud's cell hover, white at 5%.
    expect(block(".vex-prof:hover")).toMatch(/color-mix\(in srgb, var\(--color-white\) 5%, transparent\)/);
    expect(block(".vex-prof__chev")).toMatch(/color: var\(--vex-alias-label-tertiary\);/);
    expect(block('.vex-prof[aria-expanded="true"] .vex-prof__chev')).toMatch(/transform: rotate\(180deg\);/);
    // From 1920 the name steps up to 15 with the column's words.
    const wide = css.slice(css.indexOf("@media (min-width: 1920px) {"));
    expect(wide).toMatch(/^@media \(min-width: 1920px\) \{\s*\.vex-prof__n \{\s*font-size: 15px;/);

    render(<SidebarProfile sidebarOpen />);
    const trigger = screen.getByRole("button", { name: /account and settings/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the panel with its foot on the cell's top edge, from the column's left", () => {
    render(<SidebarProfile sidebarOpen />);
    const trigger = screen.getByRole("button", { name: /account and settings/i });
    trigger.getBoundingClientRect = () =>
      ({ x: 0, y: 828, left: 0, top: 828, right: 248, bottom: 900, width: 248, height: 72, toJSON: () => ({}) }) as DOMRect;
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    expect(menu.classList.contains("vex-profile-menu--panel")).toBe(true);
    // jsdom lays nothing out (the list measures 0 high), so the list's top is
    // where its foot lands: the cell's top edge, at the trigger's left.
    expect(menu.style.top).toBe("828px");
    expect(menu.style.left).toBe("0px");
    // Every item the menu had stays (the shell suite walks each one).
    for (const entry of ["Personalize", "Memory", "Sessions", "Agent Scan", "How Vex works", "Settings", "Lock Vex"]) {
      expect(screen.getByRole("menuitem", { name: new RegExp(entry) })).not.toBeNull();
    }
  });
});
