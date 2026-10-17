/**
 * The frame's column solver (docs/design/R3-MINIMAL.md section 2), pinned at
 * the spec's own widths (1440, 1280, 1024, 1000), at both seams (1180 and
 * 1360) one pixel on each side, and through the concession chain.
 */

import { describe, expect, it } from "vitest";
import {
  CENTER_MIN,
  LEFT_WIDTH,
  LEFT_WIDTH_MD,
  LIGHTER_CHAT_MAX,
  LIGHTER_CHAT_MIN,
  RAIL_WIDTH,
  SHELL_MEDIUM_MIN,
  SHELL_WIDE_MIN,
  VEX_WIDTH,
  VEX_WIDTH_MD,
  VEX_WIDTH_SM,
  clampWidth,
  computeShellColumns,
  isShellNarrow,
  lighterChatDragMax,
  shellTier,
  type ShellLayoutInput,
} from "../shell-columns.js";

/**
 * An agent session with both sidebars asked open. Under the medium tier the
 * shell hands in the narrow override, which starts closed.
 */
function agent(viewport: number, overrides: Partial<ShellLayoutInput> = {}) {
  return computeShellColumns({
    viewport,
    mode: "agent",
    left: !isShellNarrow(viewport),
    vex: true,
    ...overrides,
  });
}

/** Every track adds back up to the window. */
function total(cols: ReturnType<typeof computeShellColumns>): number {
  return cols.left + cols.center + cols.vex;
}

describe("the contract geometry", () => {
  it("states the spec's widths", () => {
    expect([LEFT_WIDTH, LEFT_WIDTH_MD, RAIL_WIDTH]).toEqual([264, 224, 56]);
    expect([VEX_WIDTH, VEX_WIDTH_MD, VEX_WIDTH_SM]).toEqual([256, 240, 224]);
    expect([CENTER_MIN, SHELL_MEDIUM_MIN, SHELL_WIDE_MIN]).toEqual([640, 1180, 1360]);
    expect([LIGHTER_CHAT_MIN, LIGHTER_CHAT_MAX]).toEqual([300, 520]);
  });

  it("clamps into a range and rounds", () => {
    expect(clampWidth(310.4, LIGHTER_CHAT_MIN, LIGHTER_CHAT_MAX)).toBe(310);
    expect(clampWidth(100, LIGHTER_CHAT_MIN, LIGHTER_CHAT_MAX)).toBe(LIGHTER_CHAT_MIN);
    expect(clampWidth(9999, LIGHTER_CHAT_MIN, LIGHTER_CHAT_MAX)).toBe(LIGHTER_CHAT_MAX);
  });
});

describe("a session at the spec's widths", () => {
  it("1440: left 264, centre 920, Vex 256", () => {
    expect(agent(1440)).toEqual({ left: 264, center: 920, vex: 256 });
  });

  it("1280: left 224, centre 816, Vex 240", () => {
    expect(agent(1280)).toEqual({ left: 224, center: 816, vex: 240 });
  });

  it("1024: the rail, centre 744, Vex 224", () => {
    expect(agent(1024)).toEqual({ left: 56, center: 744, vex: 224 });
  });

  it("1000 x 720, the window minimum: the rail, centre 720, Vex 224", () => {
    expect(agent(1000)).toEqual({ left: 56, center: 720, vex: 224 });
  });

  it("never lets the centre under its floor from 1000 up, in any state", () => {
    for (let viewport = 1000; viewport <= 2560; viewport += 7) {
      for (const left of [false, true]) {
        for (const vex of [false, true]) {
          for (const closedVex of [0, 48]) {
            const cols = agent(viewport, { left, vex, closedVex });
            const label = `${String(viewport)} ${String(left)} ${String(vex)} ${String(closedVex)}`;
            expect(cols.center, label).toBeGreaterThanOrEqual(CENTER_MIN);
            expect(total(cols), label).toBe(viewport);
          }
        }
      }
    }
  });
});

describe("the seams", () => {
  it("the wide tier starts at exactly 1360", () => {
    expect(shellTier(SHELL_WIDE_MIN - 1)).toBe("medium");
    expect(shellTier(SHELL_WIDE_MIN)).toBe("wide");
    expect(shellTier(SHELL_WIDE_MIN + 1)).toBe("wide");
    expect(agent(1359)).toEqual({ left: 224, center: 1359 - 224 - 240, vex: 240 });
    expect(agent(1360)).toEqual({ left: 264, center: 1360 - 264 - 256, vex: 256 });
  });

  it("the medium tier starts at exactly 1180; under it the left is the rail", () => {
    expect(shellTier(SHELL_MEDIUM_MIN - 1)).toBe("narrow");
    expect(shellTier(SHELL_MEDIUM_MIN)).toBe("medium");
    expect(isShellNarrow(1179)).toBe(true);
    expect(isShellNarrow(1180)).toBe(false);
    expect(agent(1179)).toEqual({ left: 56, center: 1179 - 56 - 224, vex: 224 });
    expect(agent(1180)).toEqual({ left: 224, center: 1180 - 224 - 240, vex: 240 });
  });
});

describe("the left sidebar", () => {
  it("closed is the 56px rail at every tier", () => {
    expect(agent(1440, { left: false }).left).toBe(RAIL_WIDTH);
    expect(agent(1280, { left: false }).left).toBe(RAIL_WIDTH);
    expect(agent(1000, { left: false }).left).toBe(RAIL_WIDTH);
  });

  it("under 1180 an open Vex keeps it at the rail", () => {
    expect(agent(1024, { left: false, vex: true })).toEqual({ left: 56, center: 744, vex: 224 });
  });

  it("under 1180 a re-opened left is 224 and closes Vex (derived)", () => {
    expect(agent(1024, { left: true, vex: true })).toEqual({ left: 224, center: 800, vex: 0 });
    // A closed Vex keeps what the caller asks for, here the 48px spine.
    expect(agent(1024, { left: true, vex: true, closedVex: 48 })).toEqual({
      left: 224,
      center: 752,
      vex: 48,
    });
    expect(agent(1000, { left: true, vex: false })).toEqual({ left: 224, center: 776, vex: 0 });
  });

  it("from 1180 up both stand open together", () => {
    expect(agent(1180, { left: true, vex: true }).vex).toBe(VEX_WIDTH_MD);
    expect(agent(1180, { left: true, vex: true }).left).toBe(LEFT_WIDTH_MD);
  });
});

describe("the Vex sidebar", () => {
  it("closed is 0 unless the caller asks for a spine", () => {
    expect(agent(1440, { vex: false })).toEqual({ left: 264, center: 1176, vex: 0 });
    expect(agent(1440, { vex: false, closedVex: 48 })).toEqual({
      left: 264,
      center: 1128,
      vex: 48,
    });
  });

  it("the welcome stage has no right sidebar, open or closed", () => {
    expect(agent(1440, { welcome: true })).toEqual({ left: 264, center: 1176, vex: 0 });
    expect(agent(1440, { welcome: true, closedVex: 48 }).vex).toBe(0);
    expect(agent(1024, { welcome: true })).toEqual({ left: 56, center: 968, vex: 0 });
  });
});

describe("Studio", () => {
  const studio = (viewport: number, left: boolean, vex = true) =>
    computeShellColumns({ viewport, mode: "studio", left, vex });

  it("uses the same tiers: projects and explorer live in the left sidebar", () => {
    expect(studio(1440, true)).toEqual({ left: 264, center: 920, vex: 256 });
    expect(studio(1280, true)).toEqual({ left: 224, center: 816, vex: 240 });
    expect(studio(1440, false).left).toBe(RAIL_WIDTH);
    expect(studio(1000, false)).toEqual({ left: 56, center: 720, vex: 224 });
  });
});

describe("Lighter", () => {
  const lighter = (viewport: number, overrides: Partial<ShellLayoutInput> = {}) =>
    computeShellColumns({ viewport, mode: "lighter", left: true, vex: true, ...overrides });

  it("always uses the rail and sizes its chat from its own share", () => {
    expect(lighter(1440, { lighterChat: 400 })).toEqual({ left: 56, center: 984, vex: 400 });
    expect(lighter(1440, { lighterChat: 9999 }).vex).toBe(LIGHTER_CHAT_MAX);
    expect(lighter(1440, { lighterChat: 1 }).vex).toBe(LIGHTER_CHAT_MIN);
  });

  it("a closed chat keeps what the caller asks for", () => {
    expect(lighter(1440, { vex: false, closedVex: 48 })).toEqual({
      left: 56,
      center: 1336,
      vex: 48,
    });
  });

  it("concedes the chat's share toward its floor before the centre", () => {
    // 1000 - 56 - 320 = 624: the chat gives back 16 and keeps 304.
    expect(lighter(1000, { lighterChat: 320 })).toEqual({ left: 56, center: 640, vex: 304 });
  });

  it("closes the chat (derived) when even its floor does not fit", () => {
    expect(lighter(980, { lighterChat: 320, closedVex: 48 })).toEqual({
      left: 56,
      center: 980 - 56 - 48,
      vex: 48,
    });
  });

  it("Zen hands the chart the window", () => {
    expect(lighter(1440, { zen: true, closedVex: 48 })).toEqual({ left: 0, center: 1440, vex: 0 });
  });

  it("drags the chat only into room the centre does not need", () => {
    expect(lighterChatDragMax(lighter(1440), 1440)).toBe(LIGHTER_CHAT_MAX);
    expect(lighterChatDragMax(lighter(1100), 1100)).toBe(1100 - 56 - CENTER_MIN);
    expect(lighterChatDragMax(lighter(980), 980)).toBe(LIGHTER_CHAT_MIN);
  });
});

describe("the concession chain under the window minimum", () => {
  it("Vex closes first, then the left folds to its rail, then the centre gives", () => {
    expect(agent(900, { left: true, vex: false })).toEqual({ left: 224, center: 676, vex: 0 });
    expect(agent(840, { left: true, vex: false })).toEqual({ left: 56, center: 784, vex: 0 });
    expect(agent(800, { left: false, vex: true, closedVex: 48 })).toEqual({
      left: 56,
      center: 800 - 56 - 48,
      vex: 48,
    });
    expect(agent(600, { left: false, vex: false })).toEqual({ left: 56, center: 544, vex: 0 });
  });
});
