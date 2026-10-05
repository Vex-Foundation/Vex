/**
 * Pure-template tests for the macOS application menu builder.
 * No Electron runtime is required because `menu-template.ts` only uses
 * a type-level import from "electron".
 */

import { describe, expect, it } from "vitest";
import { buildMacMenuTemplate } from "../menu-template.js";

describe("buildMacMenuTemplate", () => {
  it("places Lock Vex and its shortcut in the application menu while retaining platform roles", () => {
    const requestLock = () => undefined;
    const template = buildMacMenuTemplate({ isMac: true, isDev: false, requestLock });
    const submenu = template?.[0]?.submenu;
    if (!Array.isArray(submenu)) throw new Error("expected application submenu");
    expect(submenu.find((item) => item.label === "Lock Vex")).toMatchObject({ accelerator: "CommandOrControl+Shift+L", click: requestLock });
    expect(submenu.filter((item) => item.role).map((item) => item.role)).toEqual(["about", "services", "hide", "hideOthers", "unhide", "quit"]);
  });

  it("keeps the original application role when the feature is disabled", () => {
    expect(buildMacMenuTemplate({ isMac: true, isDev: false, lockEnabled: false })?.[0]).toEqual({ role: "appMenu" });
  });

  it("returns null on non-mac platforms (dev or prod)", () => {
    expect(buildMacMenuTemplate({ isMac: false, isDev: true })).toBeNull();
    expect(buildMacMenuTemplate({ isMac: false, isDev: false })).toBeNull();
  });

  it("returns appMenu + editMenu + viewMenu in mac dev", () => {
    const template = buildMacMenuTemplate({ isMac: true, isDev: true });
    expect(template?.map((t) => t.role)).toEqual([
      "appMenu",
      "editMenu",
      "viewMenu",
    ]);
  });

  it("returns appMenu + editMenu only in mac prod (no viewMenu)", () => {
    const template = buildMacMenuTemplate({ isMac: true, isDev: false });
    expect(template?.map((t) => t.role)).toEqual(["appMenu", "editMenu"]);
  });
});
