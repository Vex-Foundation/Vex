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
import { mergeUiState, migrateUiState, partializeUiState, PERSISTED_UI_KEYS } from "../uiStore/persistence.js";

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

/**
 * THE REMEMBERED CHOICE, SPLIT (docs/design/H3-DESKTOP.md section 3.5; VEX
 * Cloud's PD-12): chats open by default, pages closed by default, both
 * persisted; under 1024 the session's own, closed on every visit and never
 * persisted.
 */
describe("her remembered choice, split three ways", () => {
  it("opens her in chats, keeps her closed on pages and under 1024 on a fresh install", () => {
    const fresh = useUiStore.getInitialState();
    expect(fresh.vexOpenChat).toBe(true);
    expect(fresh.vexOpenPages).toBe(false);
    expect(fresh.vexOpenNarrow).toBe(false);
  });

  it("persists the chats' and the pages' choices, never the session's own under 1024", () => {
    expect(PERSISTED_UI_KEYS).toContain("vexOpenChat");
    expect(PERSISTED_UI_KEYS).toContain("vexOpenPages");
    expect(PERSISTED_UI_KEYS).not.toContain("vexOpenNarrow");
    useUiStore.getState().setVexOpenNarrow(true);
    expect(partializeUiState(useUiStore.getState())).not.toHaveProperty("vexOpenNarrow");
    // A hand-edited payload cannot open the band on the next launch.
    const merged = mergeUiState({ vexOpenNarrow: true }, useUiStore.getInitialState());
    expect(merged.vexOpenNarrow).toBe(false);
    useUiStore.getState().setVexOpenNarrow(false);
  });

  it("writes each choice alone: a page's never closes a chat's, the band's never touches either", () => {
    useUiStore.setState({ runtimeMode: "agent", shellRoute: { kind: "none" }, vexOpenChat: true, vexOpenPages: false });
    useUiStore.getState().setVexOpenNarrow(true);
    expect(useUiStore.getState().vexOpenChat).toBe(true);
    expect(useUiStore.getState().vexOpenPages).toBe(false);
    useUiStore.setState({ shellRoute: { kind: "portfolio", origin: null } });
    useUiStore.getState().setVexOpen(true);
    expect(useUiStore.getState().vexOpenPages).toBe(true);
    useUiStore.getState().setVexOpen(false);
    expect(useUiStore.getState().vexOpenPages).toBe(false);
    expect(useUiStore.getState().vexOpenChat).toBe(true);
    expect(useUiStore.getState().vexOpenNarrow).toBe(true);
    useUiStore.setState({ shellRoute: { kind: "none" }, vexOpenNarrow: false });
  });

  it("keeps every saved choice through the migrations from v21 on", () => {
    const saved = migrateUiState({ vexOpenChat: false, vexOpenPages: true, bookOpen: true }, 21) as Record<
      string,
      unknown
    >;
    expect(saved["vexOpenChat"]).toBe(false);
    expect(saved["vexOpenPages"]).toBe(true);
    expect(saved).not.toHaveProperty("vexOpenNarrow");
    // v24 folds only a hidden avatar into the chats' choice; the pages' stays.
    const folded = migrateUiState({ vexOpenChat: true, vexOpenPages: true, showAvatar: false }, 23) as Record<
      string,
      unknown
    >;
    expect(folded["vexOpenChat"]).toBe(false);
    expect(folded["vexOpenPages"]).toBe(true);
  });
});
