/**
 * SettingsPreferences - the Preferences section of the Settings page
 * (docs/design/R3-MINIMAL.md section 9.6): the Appearance choice, Show avatar,
 * Open Vex's sidebar in chats, the Session permission explainer, the
 * Background row, the composer Enter-key row and the two switches.
 *
 * Pins:
 *   - clicking a theme choice writes the persisted preference AND stamps the
 *     resolved theme onto `documentElement[data-vex-theme]`,
 *   - choice selection follows the PREFERENCE, never the resolved theme
 *     ("system" stays pressed while the OS resolves the paint),
 *   - Show avatar round-trips through `showAvatar`, Open Vex's sidebar in
 *     chats through `vexOpenChat` alone (never the table pages' slot),
 *   - the Session permission row explains Restricted and Full access in plain
 *     words and offers no control,
 *   - the Enter-key choice round-trips through the composer submission
 *     policy's public API,
 *   - the notifications row round-trips through the typed uiStore slot,
 *   - Show avatar's help names the chord that shows or hides Vex's sidebar,
 *   - the "Looking at you" preview (the portrait plate in its idle pose, a
 *     title and a text) sits under Show avatar while it is on and is gone
 *     while it is off.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { useUiStore } from "../../../../stores/uiStore.js";
import {
  getSubmitKeyBehavior,
  resetSubmitKeyBehaviorForTest,
} from "../../../../lib/composer-submission-policy.js";
import type { VexK2Props } from "../../../../components/vex/k2/VexK2.js";
import { studioPlatform } from "../../studio/keybindings-labels.js";
import { vexToggleShortcutLabel } from "../../../vex/vex-toggle-shortcut.js";
import { SettingsPreferences } from "../SettingsScreen/SettingsPreferences.js";

// Her canvas is pinned by VexK2's own suite; the plate in the preview only
// needs a host to stand in, so no canvas runs here.
vi.mock("../../../../components/vex/k2/VexK2.js", () => ({
  VexK2: (props: VexK2Props) => (
    <div
      aria-hidden="true"
      data-vex-k2={props.placement}
      data-emotion={props.emotion}
      className={props.className}
    />
  ),
}));

// The Background row (SettingsBackdropRow, its own suite) reads the backdrop
// through TanStack Query on mount; the group therefore renders under a
// QueryClient with the bridge stubbed to "shipped artwork".
const shellBackdropReadMock = vi.fn();

function renderGroup(ui: ReactElement): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(async () => {
  window.localStorage.clear();
  await resetSubmitKeyBehaviorForTest();
  useUiStore.getState().setThemePreference("chronos");
  useUiStore.setState({ showAvatar: true, vexOpenChat: true, vexOpenPages: false });
  shellBackdropReadMock.mockReset();
  shellBackdropReadMock.mockResolvedValue({ ok: true, data: { backdrop: null } });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { shellBackdrop: { read: shellBackdropReadMock } },
  });
});

afterEach(() => {
  cleanup();
  useUiStore.getState().setThemePreference("chronos");
});

function cube(id: string): HTMLButtonElement {
  const el = document.querySelector(`[data-vex-theme-cube="${id}"]`);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`cube ${id} missing`);
  return el;
}

describe("SettingsPreferences", () => {
  it("a theme cube click persists the preference and stamps the resolved theme on the document root", () => {
    renderGroup(<SettingsPreferences />);
    fireEvent.click(cube("celeris"));
    expect(useUiStore.getState().themePreference).toBe("celeris");
    expect(document.documentElement.dataset["vexTheme"]).toBe("celeris");
    fireEvent.click(cube("chronos"));
    expect(document.documentElement.dataset["vexTheme"]).toBe("chronos");
  });

  it("cube selection follows the persisted preference, never the resolved theme", () => {
    renderGroup(<SettingsPreferences />);
    fireEvent.click(cube("system"));
    // jsdom matchMedia is absent -> system resolves to chronos, yet the
    // SYSTEM cube must stay the pressed one.
    expect(useUiStore.getState().theme).toBe("chronos");
    expect(cube("system").getAttribute("aria-pressed")).toBe("true");
    expect(cube("chronos").getAttribute("aria-pressed")).toBe("false");
  });

  it("the Enter-key choice round-trips through the submission policy's public API", () => {
    renderGroup(<SettingsPreferences />);
    const modEnter = screen.getByRole("button", { name: "Ctrl/Cmd+Enter sends" });
    expect(getSubmitKeyBehavior()).toBe("enter");
    fireEvent.click(modEnter);
    expect(getSubmitKeyBehavior()).toBe("mod-enter");
    expect(modEnter.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Enter sends" }));
    expect(getSubmitKeyBehavior()).toBe("enter");
  });

  it("mounts the Background row between Appearance and the Enter key, reading the backdrop once", async () => {
    renderGroup(<SettingsPreferences />);
    const rows = Array.from(
      document.querySelectorAll(
        "[data-vex-settings-appearance], [data-vex-settings-backdrop], [data-vex-settings-enter]",
      ),
    ).map((row) => row.getAttributeNames().find((name) => name.startsWith("data-vex-settings-")));
    expect(rows).toEqual([
      "data-vex-settings-appearance",
      "data-vex-settings-backdrop",
      "data-vex-settings-enter",
    ]);
    expect(screen.getByText(/in the print window of Vex's sidebar/)).not.toBeNull();
    expect(await screen.findByRole("button", { name: "Choose image" })).not.toBeNull();
    expect(shellBackdropReadMock).toHaveBeenCalledTimes(1);
  });

  it("the notifications row reads the typed uiStore slot and a click round-trips through its setter", () => {
    useUiStore.setState({ notificationsEnabled: true });

    renderGroup(<SettingsPreferences />);
    const toggle = screen.getByRole("switch", { name: "Notifications" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(useUiStore.getState().notificationsEnabled).toBe(false);
  });
  it("lets a user re-enable the persisted terminal paste warning after Don't ask again", () => {
    useUiStore.getState().setTerminalPasteWarning(false);
    const view = renderGroup(<SettingsPreferences />);
    const toggle = screen.getByRole("switch", { name: "Multi-line paste warning" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(useUiStore.getState().terminalPasteWarning).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    view.unmount();
    renderGroup(<SettingsPreferences />);
    expect(screen.getByRole("switch", { name: "Multi-line paste warning" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("switch", { name: "Multi-line paste warning" }));
    expect(useUiStore.getState().terminalPasteWarning).toBe(false);
    useUiStore.getState().setTerminalPasteWarning(true);
  });


  it("draws the head and every row in the design's order", () => {
    renderGroup(<SettingsPreferences />);
    expect(screen.getByRole("heading", { level: 2, name: "Preferences" })).not.toBeNull();
    expect(screen.getByText("How Vex looks and behaves on this machine.")).not.toBeNull();
    const titles = Array.from(document.querySelectorAll(".vex-pref__title")).map(
      (title) => title.textContent,
    );
    expect(titles).toEqual([
      "Appearance",
      "Show avatar",
      "Open Vex's sidebar in chats",
      "Session permission",
      "Background",
      "Enter key",
      "Notifications",
      "Price alert notifications",
      "Multi-line paste warning",
    ]);
  });

  it("names the three themes with their words", () => {
    renderGroup(<SettingsPreferences />);
    expect(cube("chronos").textContent).toBe("Chronos \u00b7 Dark");
    expect(cube("celeris").textContent).toBe("Celeris \u00b7 Light");
    expect(cube("system").textContent).toBe("System \u00b7 Match OS");
  });

  it("Show avatar reads showAvatar and a click round-trips through its setter", () => {
    renderGroup(<SettingsPreferences />);
    const toggle = screen.getByRole("switch", { name: "Show avatar" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(useUiStore.getState().showAvatar).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(useUiStore.getState().showAvatar).toBe(true);
  });

  it("Show avatar is the global avatar switch and never writes the welcome token's own key", () => {
    useUiStore.setState({ welcomeVexShown: true });
    renderGroup(<SettingsPreferences />);
    fireEvent.click(screen.getByRole("switch", { name: "Show avatar" }));
    expect(useUiStore.getState().showAvatar).toBe(false);
    expect(useUiStore.getState().welcomeVexShown).toBe(true);
  });

  it("Open Vex's sidebar in chats writes vexOpenChat only, never the table pages' slot", () => {
    useUiStore.setState({ vexOpenPages: false, bookOpen: true });
    renderGroup(<SettingsPreferences />);
    const toggle = screen.getByRole("switch", { name: "Open Vex's sidebar in chats" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    const off = useUiStore.getState();
    expect(off.vexOpenChat).toBe(false);
    expect(off.vexOpenPages).toBe(false);
    expect(off.bookOpen).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(useUiStore.getState().vexOpenChat).toBe(true);
    expect(useUiStore.getState().vexOpenPages).toBe(false);
  });

  it("explains Restricted and Full access in plain words and offers no control", () => {
    renderGroup(<SettingsPreferences />);
    const row = document.querySelector("[data-vex-settings-permission]");
    if (!(row instanceof HTMLElement)) throw new Error("permission row missing");
    expect(row.textContent).toContain(
      "Restricted: funds require approval. Vex asks before every transaction and nothing signs until you approve.",
    );
    expect(row.textContent).toContain(
      "Full access: Vex runs approved tools without asking each time, including moves of funds. Mode and permission are locked once the session is created.",
    );
    expect(row.textContent).toContain("Chosen per session");
    expect(row.querySelector("button, input, [role='switch']")).toBeNull();
    // The word is beside a fill swatch, never a hue alone.
    expect(row.querySelector(".vex-pref__word .vex-swatch")?.getAttribute("data-s")).toBe("awaiting");
  });

  it("Show avatar's help names the chord that shows or hides the sidebar", () => {
    renderGroup(<SettingsPreferences />);
    const chord = vexToggleShortcutLabel(studioPlatform);
    const row = document.querySelector("[data-vex-settings-avatar]");
    if (!(row instanceof HTMLElement)) throw new Error("avatar row missing");
    expect(row.querySelector(".vex-pref__help")?.textContent).toBe(
      `Vex's hologram in the right sidebar. The vx token at the right of the top bar, or ${chord}, shows or hides the sidebar. Off, the token and the state word still show what she is doing.`,
    );
  });

  it("draws the Looking at you preview right under Show avatar while the avatar is on", () => {
    renderGroup(<SettingsPreferences />);
    const preview = document.querySelector("[data-vex-settings-avatar-preview]");
    if (!(preview instanceof HTMLElement)) throw new Error("preview missing");
    expect(preview.previousElementSibling?.hasAttribute("data-vex-settings-avatar")).toBe(true);
    expect(within(preview).getByText("Looking at you")).not.toBeNull();
    expect(
      within(preview).getByText(
        "At rest, after a gesture and when you come back, Vex looks straight at you. Her state word sits in the title bar and in her sidebar, so nothing depends on the picture.",
      ),
    ).not.toBeNull();
    // The plate is the Vex sidebar's own, in her calm look at you, and decorative.
    const plate = preview.querySelector("[data-vex-area='vex-portrait-plate']");
    expect(plate?.getAttribute("aria-hidden")).toBe("true");
    expect(plate?.classList.contains("vex-set-avatar__plate")).toBe(true);
    expect(plate?.querySelector("[data-vex-k2='sidebar']")?.getAttribute("data-emotion")).toBe("idle");
    // The title and the text are ordinary text, never hidden from assistive tech.
    expect(preview.querySelector(".vex-set-avatar__text")?.closest("[aria-hidden='true']")).toBeNull();
  });

  it("the preview goes with the avatar: it leaves when Show avatar turns off and returns when it turns on", () => {
    renderGroup(<SettingsPreferences />);
    const toggle = screen.getByRole("switch", { name: "Show avatar" });
    fireEvent.click(toggle);
    expect(document.querySelector("[data-vex-settings-avatar-preview]")).toBeNull();
    expect(document.querySelector("[data-vex-area='vex-portrait-plate']")).toBeNull();
    expect(screen.queryByText("Looking at you")).toBeNull();
    fireEvent.click(toggle);
    expect(document.querySelector("[data-vex-settings-avatar-preview]")).not.toBeNull();
  });

  it("draws no preview at all when it mounts with the avatar off", () => {
    useUiStore.setState({ showAvatar: false });
    renderGroup(<SettingsPreferences />);
    expect(document.querySelector("[data-vex-settings-avatar-preview]")).toBeNull();
    expect(screen.queryByText("Looking at you")).toBeNull();
  });
});
