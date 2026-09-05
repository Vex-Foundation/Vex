/**
 * v17: THE LAST STUDIO LOCATION becomes persisted state.
 *
 * The welcome's own copy promises "Studio is where you left it when you come
 * back". It was not: a relaunch showed the Agent welcome, because
 * `runtimeMode` and `activeProjectId` were deliberately outside the persisted
 * whitelist. This suite pins the hop and the two properties that make storing
 * them safe - the payload is expanded, never rewritten, and a reader from
 * before the hop is unaffected because it whitelists neither key.
 *
 * The COERCION of both values is pinned next door in
 * `uiStore-persist-hardening.test.ts`, and their EXISTENCE check (an id the
 * project list does not contain opens nothing) in `StudioCenter.test.tsx`.
 */

import { describe, expect, it } from "vitest";
import {
  migrateUiState,
  PERSISTED_UI_KEYS,
} from "../uiStore/persistence.js";

describe("uiStore v17 - the last Studio location", () => {
  it("seeds a pre-v17 payload with the values a fresh install has", () => {
    const before = { themePreference: "system", bookOpen: true };
    const after = migrateUiState(before, 16) as Record<string, unknown>;

    expect(after["runtimeMode"]).toBe("agent");
    expect(after["activeProjectId"]).toBeNull();
    // EXPAND-ONLY: every key the old payload carried is still there, unchanged.
    expect(after["themePreference"]).toBe("system");
    expect(after["bookOpen"]).toBe(true);
  });

  it("never overwrites a location a current-version payload already carries", () => {
    const stored = {
      runtimeMode: "studio",
      activeProjectId: "9c1b0e8e-0000-4000-8000-000000000000",
    };
    const after = migrateUiState(stored, 17) as Record<string, unknown>;

    expect(after["runtimeMode"]).toBe("studio");
    expect(after["activeProjectId"]).toBe("9c1b0e8e-0000-4000-8000-000000000000");
  });

  it("leaves a payload that is not an object alone", () => {
    expect(migrateUiState(null, 1)).toBeNull();
    expect(migrateUiState("vex-ui", 1)).toBe("vex-ui");
  });

  it("puts both keys on the whitelist, which is what makes them persist", () => {
    expect(PERSISTED_UI_KEYS).toContain("runtimeMode");
    expect(PERSISTED_UI_KEYS).toContain("activeProjectId");
  });
});
