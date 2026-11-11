/**
 * SettingsPreferences - the Preferences section of the Settings page
 * (docs/design/R3-MINIMAL.md section 9.6): Show Vex, the Session permission
 * explainer, the composer Enter-key row and the switches. The Background
 * row is retired (owner decision, 2026-11-08).
 *
 * Pins:
 *   - there is no theme choice: H3 is dark only, so the Appearance row and
 *     its three cubes (Chronos, Celeris, System) are gone and nothing on the
 *     page can move the room off dark,
 *   - Show Vex is Kimm's one open or closed choice (plan row S4-14): it
 *     round-trips through `vexOpenChat` alone (never the table pages' slot,
 *     never the retired `showAvatar`), and R3's Show avatar row and its
 *     "Looking at you" preview are gone,
 *   - the Session permission row explains Restricted and Full access in plain
 *     words and offers no control,
 *   - the Enter-key choice round-trips through the composer submission
 *     policy's public API,
 *   - the notifications row round-trips through the typed uiStore slot,
 *   - Show Vex's help names the chord that opens and closes her.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { useUiStore } from "../../../../stores/uiStore.js";
import {
  getSubmitKeyBehavior,
  resetSubmitKeyBehaviorForTest,
} from "../../../../lib/composer-submission-policy.js";
import { studioPlatform } from "../../studio/keybindings-labels.js";
import { vexToggleShortcutLabel } from "../../../vex/vex-toggle-shortcut.js";
import { SettingsPreferences } from "../SettingsScreen/SettingsPreferences.js";

function renderGroup(ui: ReactElement): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(async () => {
  window.localStorage.clear();
  await resetSubmitKeyBehaviorForTest();
  useUiStore.setState({ showAvatar: true, vexOpenChat: true, vexOpenPages: false });
});

afterEach(() => {
  cleanup();
});

describe("SettingsPreferences", () => {
  it("offers no theme choice: no Appearance row, no theme cube, the room stays dark", () => {
    renderGroup(<SettingsPreferences />);
    expect(document.querySelector("[data-vex-settings-appearance]")).toBeNull();
    expect(document.querySelector("[data-vex-theme-cube]")).toBeNull();
    for (const word of ["Appearance", /Chronos/, /Celeris/, /Match OS/]) {
      expect(screen.queryByText(word)).toBeNull();
    }
    expect(useUiStore.getState().theme).toBe("chronos");
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

  it("offers no Background row (owner decision, 2026-11-08)", () => {
    renderGroup(<SettingsPreferences />);
    expect(document.querySelector("[data-vex-settings-backdrop]")).toBeNull();
    expect(screen.queryByText("Background")).toBeNull();
    expect(screen.queryByText(/print window of Vex's sidebar/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose image" })).toBeNull();
    // The permission row is followed straight by the Enter key.
    const rows = Array.from(
      document.querySelectorAll("[data-vex-settings-permission], [data-vex-settings-enter]"),
    ).map((row) => row.getAttributeNames().find((name) => name.startsWith("data-vex-settings-")));
    expect(rows).toEqual(["data-vex-settings-permission", "data-vex-settings-enter"]);
  });

  it("names each switch by its row's label, and a press on the name flips it (Cloud's built row)", () => {
    useUiStore.setState({ notificationsEnabled: true });
    renderGroup(<SettingsPreferences />);
    const toggle = screen.getByRole("switch", { name: "Notifications" });
    const label = document.querySelector(`label[for="${toggle.id}"]`);
    expect(label?.textContent).toBe("Notifications");
    expect(label?.hasAttribute("data-vex-pref-row-press")).toBe(true);
    fireEvent.click(label as HTMLElement);
    expect(useUiStore.getState().notificationsEnabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
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
      "Show Vex",
      "Session permission",
      "Enter key",
      "Notifications",
      "Price alert notifications",
      "Multi-line paste warning",
    ]);
  });

  it("Show Vex writes her one choice, vexOpenChat, never the table pages' slot or the welcome's", () => {
    useUiStore.setState({ vexOpenPages: false, bookOpen: true, welcomeVexShown: true });
    renderGroup(<SettingsPreferences />);
    expect(screen.queryByRole("switch", { name: "Show avatar" })).toBeNull();
    const toggle = screen.getByRole("switch", { name: "Show Vex" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    const off = useUiStore.getState();
    expect(off.vexOpenChat).toBe(false);
    expect(off.vexOpenPages).toBe(false);
    expect(off.bookOpen).toBe(true);
    expect(off.welcomeVexShown).toBe(true);
    expect(off.showAvatar).toBe(true);
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

  it("Show Vex's help names the chord that opens and closes her", () => {
    renderGroup(<SettingsPreferences />);
    const chord = vexToggleShortcutLabel(studioPlatform);
    const row = document.querySelector("[data-vex-settings-vex-open-chat]");
    if (!(row instanceof HTMLElement)) throw new Error("Show Vex row missing");
    expect(row.querySelector(".vex-pref__help")?.textContent).toBe(
      `Kimm's section in Vex's column, in chats, on approvals and in Studio. Off, she folds to her strip; Show Vex in its corner, the Vex key at the top, or ${chord}, opens her again. Her state word still shows what she is doing. Pages keep a choice of their own, closed until you show her there, and in a window under 1024 wide she starts closed on every visit.`,
    );
  });

  it("draws no avatar preview: her figure is in her section, not on this page", () => {
    renderGroup(<SettingsPreferences />);
    expect(document.querySelector("[data-vex-settings-avatar-preview]")).toBeNull();
    expect(document.querySelector("[data-vex-area='vex-portrait-plate']")).toBeNull();
    expect(screen.queryByText("Looking at you")).toBeNull();
  });
});
