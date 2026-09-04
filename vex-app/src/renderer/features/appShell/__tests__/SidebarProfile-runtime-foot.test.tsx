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

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Result } from "@shared/ipc/result.js";
import type { HealthReport } from "@shared/schemas/system.js";

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
  RUNTIME_STATUS_SENTENCES,
  SidebarProfile,
  getRuntimeStatus,
  NIGHT_SHIFT_MESSAGE,
} = await import("../SidebarProfile.js");

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
  it("speaks the hallmark while the runtime is healthy", () => {
    render(<SidebarProfile sidebarOpen />);
    expect(screen.getByText(NIGHT_SHIFT_MESSAGE)).not.toBeNull();
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

  it("keeps the short word where a word is the right size: the trigger name", () => {
    healthMock.mockReturnValue({ isLoading: false, data: health("degraded") });
    render(<SidebarProfile sidebarOpen />);
    expect(
      screen.getByRole("button", { name: "Vex - Degraded. Open menu" }),
    ).not.toBeNull();
  });

  it("gives the collapsed spine the sentence as its tooltip - no subtitle there", () => {
    healthMock.mockReturnValue({ isLoading: false, data: health("degraded") });
    render(<SidebarProfile sidebarOpen={false} />);
    const trigger = screen.getByRole("button", { name: /Open menu/ });
    expect(trigger.getAttribute("title")).toBe(RUNTIME_STATUS_SENTENCES.degraded);
    expect(screen.queryByText(RUNTIME_STATUS_SENTENCES.degraded)).toBeNull();
  });
});
