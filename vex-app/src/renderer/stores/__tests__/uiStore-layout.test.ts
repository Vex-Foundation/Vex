/**
 * Layout width slots: drag clamping, v10 migration seeding, and the
 * every-rehydrate coercion of the user-writable localStorage payload.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../uiStore.js";
import {
  coerceBookWidth,
  coerceSidebarWidth,
} from "../uiStore/layout.js";
import { migrateUiState } from "../uiStore/persistence.js";

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ sidebarWidth: 240, bookWidth: 340 });
});

describe("width setters", () => {
  it("clamps a live sidebar drag into 240-420", () => {
    useUiStore.getState().setSidebarWidth(100);
    expect(useUiStore.getState().sidebarWidth).toBe(240);
    useUiStore.getState().setSidebarWidth(9999);
    expect(useUiStore.getState().sidebarWidth).toBe(420);
    useUiStore.getState().setSidebarWidth(300.6);
    expect(useUiStore.getState().sidebarWidth).toBe(301);
  });

  it("clamps a live BOOK drag into 300-520", () => {
    useUiStore.getState().setBookWidth(0);
    expect(useUiStore.getState().bookWidth).toBe(300);
    useUiStore.getState().setBookWidth(9999);
    expect(useUiStore.getState().bookWidth).toBe(520);
  });
});

describe("rehydrate coercion", () => {
  it("degrades a non-numeric hand-edited width to the default", () => {
    expect(coerceSidebarWidth("wide")).toBe(240);
    expect(coerceSidebarWidth(Number.NaN)).toBe(240);
    expect(coerceSidebarWidth(undefined)).toBe(240);
    expect(coerceBookWidth(null)).toBe(340);
    expect(coerceBookWidth(Number.POSITIVE_INFINITY)).toBe(340);
  });

  it("re-clamps an out-of-range persisted width instead of trusting it", () => {
    expect(coerceSidebarWidth(50)).toBe(240);
    expect(coerceSidebarWidth(5000)).toBe(420);
    expect(coerceBookWidth(10)).toBe(300);
    expect(coerceBookWidth(10_000)).toBe(520);
  });
});

describe("v10 migration", () => {
  it("seeds contract-default widths for a pre-v10 payload", () => {
    const migrated = migrateUiState(
      { themePreference: "chronos", sidebarOpen: true },
      9,
    ) as Record<string, unknown>;
    expect(migrated["sidebarWidth"]).toBe(240);
    expect(migrated["bookWidth"]).toBe(340);
  });

  it("keeps an in-range width already present in an older payload", () => {
    const migrated = migrateUiState({ sidebarWidth: 300, bookWidth: 400 }, 9) as
      Record<string, unknown>;
    expect(migrated["sidebarWidth"]).toBe(300);
    expect(migrated["bookWidth"]).toBe(400);
  });
});

describe("narrow-expand override", () => {
  it("is launch-ephemeral: not part of the persisted payload", () => {
    useUiStore.getState().setSidebarNarrowExpanded(true);
    expect(useUiStore.getState().sidebarNarrowExpanded).toBe(true);
    const raw = window.localStorage.getItem("vex-ui");
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { state: Record<string, unknown> };
      expect(parsed.state["sidebarNarrowExpanded"]).toBeUndefined();
    }
  });
});
