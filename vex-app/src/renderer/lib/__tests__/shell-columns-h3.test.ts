/**
 * The shell's column solver, D2 (docs/design/H3-DESKTOP.md section 6; owner
 * decisions 2026-11-09 and 2026-11-10): chats | chat, the chat to the
 * window's right edge, and Vex's panel a fixed 280 box over the chat's top
 * right whose room the reading column clears. Pinned at the parity widths
 * (1000, 1023, 1024, 1279, 1280, 1366, 1440, 1920, 2560), each with the
 * chats open and folded and a page's strip on and off; at the band seam one
 * pixel on each side; and through the invariants the grid relies on
 * (integers, nothing negative, the tracks add back up to the frame, the room
 * is the chat less the panel, and the panel never depends on the chats).
 */

import { describe, expect, it } from "vitest";
import {
  D2_VEX_WIDTH,
  H3_CHATS_WIDTH,
  H3_COLUMNS_MIN,
  H3_FOOT_ROW,
  H3_ZOOMED_FOOT_ROW,
  H3_RAIL_WIDTH,
  computeH3ShellColumns,
  h3GridTemplateColumns,
  h3ShellLayout,
  H3_CONSOLE_LINE_HEIGHT,
  H3_CHATS_OPEN_MIN,
  LIGHTER_CHAT_MAX,
  LIGHTER_CHAT_MIN,
  computeDeskColumns,
  deskChatDragMax,
  deskGridTemplateColumns,
  deskVexWidth,
  h3ShellTier,
  shellColumnOrder,
  shellFrameKind,
  shellGridTemplateRows,
  shellHeadTemplateColumns,
  type H3ShellColumns,
} from "../shell-columns.js";

/** One frame, as the shell will ask: the stored chats choice and a page's strip. */
function h3(viewport: number, chats: boolean, vexStrip = false): H3ShellColumns {
  return computeH3ShellColumns({ viewport, chats, vexStrip });
}

/** The two tracks, chats | chat, then her panel over the chat and the room it leaves. */
function parts(cols: H3ShellColumns): readonly [number, number, number, number] {
  return [cols.chats, cols.chat, cols.vex, cols.room];
}

describe("the D2 geometry", () => {
  it("states the plates' widths and the band seam", () => {
    expect([H3_CHATS_WIDTH, H3_RAIL_WIDTH, D2_VEX_WIDTH]).toEqual([248, 76, 280]);
    expect(H3_COLUMNS_MIN).toBe(1024);
  });
});

describe("the owner's D2 plates, with her panel (2026-11-10)", () => {
  it("1440: chats 248, the chat 1192 to the right edge, her panel 280 over it, a room of 912", () => {
    expect(h3(1440, true)).toEqual({
      layout: "columns",
      chats: 248,
      chat: 1192,
      vex: 280,
      room: 912,
      chatsRail: false,
      vexSeat: "column",
      chatLeft: 248,
    });
  });
});

/**
 * Each parity width four ways: chats open, chats folded, and the same two with
 * a page's strip. Under 1024 the four are the same band; from 1024 up folding
 * the chats hands the chat 172 and the strip hands the room her panel's 280.
 */
describe("the parity widths, chats open and folded, strip off and on", () => {
  it("1000 x 720, the window minimum: the band, 76 | 924, no panel, every way", () => {
    expect(parts(h3(1000, true))).toEqual([76, 924, 0, 924]);
    expect(parts(h3(1000, false))).toEqual([76, 924, 0, 924]);
    expect(parts(h3(1000, true, true))).toEqual([76, 924, 0, 924]);
    expect(parts(h3(1000, false, true))).toEqual([76, 924, 0, 924]);
  });

  it("1023, the last band pixel: 76 | 947, no panel, every way", () => {
    expect(parts(h3(1023, true))).toEqual([76, 947, 0, 947]);
    expect(parts(h3(1023, false))).toEqual([76, 947, 0, 947]);
    expect(parts(h3(1023, true, true))).toEqual([76, 947, 0, 947]);
    expect(parts(h3(1023, false, true))).toEqual([76, 947, 0, 947]);
  });

  it("1024, the first panel pixel: 76 | 948, her 280, a room of 668, whatever the stored choice", () => {
    // Under H3_CHATS_OPEN_MIN the chats are the rail; their key opens the
    // chats panel over the chat, never the track.
    expect(parts(h3(1024, true))).toEqual([76, 948, 280, 668]);
    expect(parts(h3(1024, false))).toEqual([76, 948, 280, 668]);
    expect(parts(h3(1024, true, true))).toEqual([76, 948, 0, 948]);
    expect(parts(h3(1024, false, true))).toEqual([76, 948, 0, 948]);
  });

  it("1279, the last rail pixel: 76 | 1203, her 280, a room of 923", () => {
    expect(parts(h3(1279, true))).toEqual([76, 1203, 280, 923]);
    expect(parts(h3(1279, false))).toEqual([76, 1203, 280, 923]);
  });

  it("1280 x 800, the stored default: 248 | 1032, her 280, a room of 752", () => {
    expect(parts(h3(1280, true))).toEqual([248, 1032, 280, 752]);
    expect(parts(h3(1280, false))).toEqual([76, 1204, 280, 924]);
    expect(parts(h3(1280, true, true))).toEqual([248, 1032, 0, 1032]);
    expect(parts(h3(1280, false, true))).toEqual([76, 1204, 0, 1204]);
  });

  it("1366 x 768: 248 | 1118, a room of 838", () => {
    expect(parts(h3(1366, true))).toEqual([248, 1118, 280, 838]);
    expect(parts(h3(1366, false))).toEqual([76, 1290, 280, 1010]);
    expect(parts(h3(1366, true, true))).toEqual([248, 1118, 0, 1118]);
    expect(parts(h3(1366, false, true))).toEqual([76, 1290, 0, 1290]);
  });

  it("1440 x 900, the plate: 248 | 1192, a room of 912", () => {
    expect(parts(h3(1440, true))).toEqual([248, 1192, 280, 912]);
    expect(parts(h3(1440, false))).toEqual([76, 1364, 280, 1084]);
    expect(parts(h3(1440, true, true))).toEqual([248, 1192, 0, 1192]);
    expect(parts(h3(1440, false, true))).toEqual([76, 1364, 0, 1364]);
  });

  it("1920 x 1080: 248 | 1672, a room of 1392", () => {
    expect(parts(h3(1920, true))).toEqual([248, 1672, 280, 1392]);
    expect(parts(h3(1920, false))).toEqual([76, 1844, 280, 1564]);
    expect(parts(h3(1920, true, true))).toEqual([248, 1672, 0, 1672]);
    expect(parts(h3(1920, false, true))).toEqual([76, 1844, 0, 1844]);
  });

  it("2560: 248 | 2312, a room of 2032", () => {
    expect(parts(h3(2560, true))).toEqual([248, 2312, 280, 2032]);
    expect(parts(h3(2560, false))).toEqual([76, 2484, 280, 2204]);
    expect(parts(h3(2560, true, true))).toEqual([248, 2312, 0, 2312]);
    expect(parts(h3(2560, false, true))).toEqual([76, 2484, 0, 2484]);
  });
});

describe("the band seam", () => {
  it("is exact and belongs to the wider side: 1024 is columns, 1023 the band", () => {
    expect(h3ShellLayout(H3_COLUMNS_MIN - 1)).toBe("band");
    expect(h3ShellLayout(H3_COLUMNS_MIN)).toBe("columns");
    expect(h3ShellLayout(H3_COLUMNS_MIN + 1)).toBe("columns");
    expect(h3ShellLayout(1000)).toBe("band");
  });

  it("rounds a fractional frame first, as the solver does", () => {
    expect(h3ShellLayout(1023.4)).toBe("band");
    expect(h3ShellLayout(1023.5)).toBe("columns");
    expect(h3(1023.5, true).layout).toBe("columns");
  });

  it("in the band the chats are the rail whatever the stored choice says, and she has no panel", () => {
    expect(h3(1000, true)).toEqual({
      layout: "band",
      chats: 76,
      chat: 924,
      vex: 0,
      room: 924,
      chatsRail: true,
      vexSeat: "band",
      chatLeft: 76,
    });
    expect(h3(1000, false)).toEqual(h3(1000, true));
  });

  it("the band wins over a page's strip: under 1024 a page has the console line and her band", () => {
    expect(h3(1000, true, true)).toEqual(h3(1000, true));
  });
});

describe("what the grid reads", () => {
  it("the layout, where Vex is drawn and whether the chats are the rail", () => {
    const seat = (cols: H3ShellColumns) => [cols.layout, cols.vexSeat, cols.chatsRail] as const;
    expect(seat(h3(1440, true))).toEqual(["columns", "column", false]);
    expect(seat(h3(1440, false))).toEqual(["columns", "column", true]);
    expect(seat(h3(1440, true, true))).toEqual(["columns", "strip", false]);
    expect(seat(h3(1440, false, true))).toEqual(["columns", "strip", true]);
    expect(seat(h3(1000, true))).toEqual(["band", "band", true]);
    expect(seat(h3(1000, true, true))).toEqual(["band", "band", true]);
  });

  it("the x where the chat starts: the chats track, whatever Vex shows", () => {
    expect(h3(1280, true).chatLeft).toBe(248);
    expect(h3(1366, true).chatLeft).toBe(248);
    expect(h3(1440, false).chatLeft).toBe(76);
    expect(h3(1440, true, true).chatLeft).toBe(248);
    expect(h3(1023, true).chatLeft).toBe(76);
  });

  it("the column template: two tracks, the chat the 1fr one to the right edge, no track for her", () => {
    expect(h3GridTemplateColumns(h3(1440, true))).toBe("248px minmax(0, 1fr)");
    expect(h3GridTemplateColumns(h3(1440, false, true))).toBe("76px minmax(0, 1fr)");
    expect(h3GridTemplateColumns(h3(1000, true))).toBe("76px minmax(0, 1fr)");
    expect(h3GridTemplateColumns(h3(1440, true))).not.toContain(String(D2_VEX_WIDTH));
  });
});

describe("her panel", () => {
  it("is a fixed 280 at every width from 1024 up, and keeps that room in the chat", () => {
    for (let viewport = H3_COLUMNS_MIN; viewport <= 3000; viewport += 1) {
      for (const chats of [false, true]) {
        const cols = h3(viewport, chats);
        expect(cols.vex, String(viewport)).toBe(D2_VEX_WIDTH);
        expect(cols.room, String(viewport)).toBe(cols.chat - D2_VEX_WIDTH);
      }
    }
  });

  it("keeps its width when the chats fold; the chat and the room gain the difference", () => {
    for (let viewport = H3_CHATS_OPEN_MIN; viewport <= 2560; viewport += 1) {
      const open = h3(viewport, true);
      const folded = h3(viewport, false);
      const label = String(viewport);
      expect(folded.vex, label).toBe(open.vex);
      expect(folded.chat - open.chat, label).toBe(H3_CHATS_WIDTH - H3_RAIL_WIDTH);
      expect(folded.room - open.room, label).toBe(H3_CHATS_WIDTH - H3_RAIL_WIDTH);
    }
  });

  it("the chat runs to the window's right edge whatever she is: her panel never takes a track", () => {
    for (const viewport of [1024, 1280, 1366, 1440, 1920, 2560]) {
      for (const chats of [false, true]) {
        const panel = h3(viewport, chats);
        const strip = h3(viewport, chats, true);
        const label = `${String(viewport)} ${String(chats)}`;
        expect(panel.chats + panel.chat, label).toBe(viewport);
        // A page's strip folds her panel and its room to 0: the page takes the chat.
        expect(strip.vex, label).toBe(0);
        expect(strip.chat, label).toBe(panel.chat);
        expect(strip.room, label).toBe(panel.chat);
      }
    }
  });

  it("has no input for her shown or hidden choice: neither the chat nor its room can follow it", () => {
    // The money rule's first leg (section 3.6): the solve reads the window,
    // the chats choice and a page's strip, nothing else.
    expect(Object.keys({ viewport: 0, chats: true, vexStrip: false } satisfies Parameters<typeof computeH3ShellColumns>[0]))
      .toEqual(["viewport", "chats", "vexStrip"]);
  });
});

/**
 * D2 keeps H3's rule against R3's 640 centre floor. These pin where that
 * matters, so a change to either is a visible decision.
 */
describe("no centre floor", () => {
  it("under 1280 the chats are the rail whatever the stored choice says, so no track waits on it", () => {
    for (let viewport = 0; viewport < H3_CHATS_OPEN_MIN; viewport += 1) {
      expect(h3(viewport, true), String(viewport)).toEqual(h3(viewport, false));
    }
    expect(h3(1024, true).room).toBe(668);
    expect(h3(1279, true).room).toBe(923);
    expect(h3(1280, true).room).toBe(752);
  });

  it("her panel never takes the room under 668", () => {
    for (let viewport = H3_COLUMNS_MIN; viewport <= 2560; viewport += 1) {
      for (const chats of [false, true]) {
        expect(h3(viewport, chats).room, String(viewport)).toBeGreaterThanOrEqual(668);
      }
    }
  });

  it("the band never takes the chat under 924 from the window minimum up", () => {
    for (let viewport = 1000; viewport < H3_COLUMNS_MIN; viewport += 1) {
      expect(h3(viewport, true).chat, String(viewport)).toBeGreaterThanOrEqual(924);
    }
  });
});

describe("invariants", () => {
  const widths = [
    ...Array.from({ length: 3001 }, (_, i) => i),
    1000.4,
    1023.4,
    1023.5,
    1365.6,
    1439.5,
  ];

  it("integers, nothing negative, the two tracks add back up to the frame, the room is the chat less her", () => {
    for (const viewport of widths) {
      for (const chats of [false, true]) {
        for (const vexStrip of [false, true]) {
          const cols = h3(viewport, chats, vexStrip);
          const label = `${String(viewport)} ${String(chats)} ${String(vexStrip)}`;
          for (const part of parts(cols)) {
            expect(Number.isInteger(part), label).toBe(true);
            expect(part, label).toBeGreaterThanOrEqual(0);
          }
          expect(cols.chats + cols.chat, label).toBe(Math.round(Math.max(0, viewport)) || 0);
          expect(cols.room, label).toBe(cols.chat - cols.vex);
          expect(cols.vex, label).toBeLessThanOrEqual(cols.chat);
          expect(cols.chatLeft, label).toBe(cols.chats);
          expect(cols.layout, label).toBe(h3ShellLayout(viewport));
          expect(cols.chatsRail, label).toBe(cols.chats !== H3_CHATS_WIDTH);
        }
      }
    }
  });

  it("only her panel seat keeps a room; the band and the strip are drawn in the chat", () => {
    for (const viewport of widths) {
      for (const chats of [false, true]) {
        for (const vexStrip of [false, true]) {
          const cols = h3(viewport, chats, vexStrip);
          const label = `${String(viewport)} ${String(chats)} ${String(vexStrip)}`;
          expect(cols.vex > 0, label).toBe(cols.vexSeat === "column");
        }
      }
    }
  });

  it("a frame narrower than the rail is all rail; a width that is not one solves as 0", () => {
    expect(parts(h3(50, true))).toEqual([50, 0, 0, 0]);
    expect(parts(h3(200, true))).toEqual([76, 124, 0, 124]);
    expect(parts(h3(0, true))).toEqual([0, 0, 0, 0]);
    expect(parts(h3(-20, true))).toEqual([0, 0, 0, 0]);
    expect(parts(h3(Number.NaN, true))).toEqual([0, 0, 0, 0]);
  });
});

describe("the desktop's tiers (H3-DESKTOP.md section 4.12)", () => {
  it("names the band, the medium tier and the wide tier, each seam to the wider side", () => {
    // Cloud's fold point (PD-14): the chats open from 1280, the rail under it.
    expect(H3_CHATS_OPEN_MIN).toBe(1280);
    expect([1000, 1023, 1023.4].map(h3ShellTier)).toEqual(["band", "band", "band"]);
    expect([1023.5, 1024, 1279].map(h3ShellTier)).toEqual(["medium", "medium", "medium"]);
    expect([1279.5, 1280, 1440, 2560].map(h3ShellTier)).toEqual(["wide", "wide", "wide", "wide"]);
  });

  it("folds the chats at Cloud's 1280; her panel stays 280 on both sides", () => {
    expect(h3(1280, true).chatsRail).toBe(false);
    expect(h3(1279, true).chatsRail).toBe(true);
    expect(parts(h3(1279, true))).toEqual([76, 1203, 280, 923]);
    expect(parts(h3(1280, true))).toEqual([248, 1032, 280, 752]);
  });
});

describe("the frame per mode", () => {
  it("stands the agent shell and Studio in D2's order: chats | chat | her panel", () => {
    for (const mode of ["agent", "studio"] as const) {
      expect(shellFrameKind(mode)).toBe("h3");
      expect(shellColumnOrder(mode)).toEqual(["chats", "chat", "vex"]);
    }
  });

  it("under 1024 puts her console line before the chat it stands over", () => {
    for (const mode of ["agent", "studio"] as const) {
      expect(shellColumnOrder(mode, true)).toEqual(["chats", "vex", "chat"]);
    }
  });

  it("stands the Lighter desk in H3's rows with its own order: rail | desk | Vex, with no band", () => {
    expect(shellFrameKind("lighter")).toBe("desk");
    expect(shellColumnOrder("lighter")).toEqual(["chats", "chat", "vex"]);
    expect(shellColumnOrder("lighter", true)).toEqual(["chats", "chat", "vex"]);
  });
});

describe("the Lighter desk's tracks (H3-DESKTOP.md section 4.9)", () => {
  const desk = (viewport: number, share = 0.3, chatsExpanded = false) =>
    computeDeskColumns({ viewport, share, chatsExpanded });

  it("keeps the chats column on the 76 rail at every width, Expand opening the 248 from 1024 up", () => {
    for (const width of [1000, 1023, 1024, 1280, 1440, 1920]) {
      expect(desk(width).chats, String(width)).toBe(H3_RAIL_WIDTH);
      expect(desk(width).chatsRail).toBe(true);
    }
    expect(desk(1440, 0.3, true)).toMatchObject({ chats: H3_CHATS_WIDTH, chatsRail: false, expandable: true });
    expect(desk(1023, 0.3, true)).toMatchObject({ chats: H3_RAIL_WIDTH, chatsRail: true, expandable: false });
  });

  it("sizes the desk chat at its share of the window, 300 to 520, and the desk takes the rest", () => {
    expect(desk(1440)).toMatchObject({ chats: 76, vex: 432, desk: 932 });
    expect(desk(1280)).toMatchObject({ vex: 384, desk: 820 });
    expect(desk(1000)).toMatchObject({ vex: 300, desk: 624 });
    expect(desk(1920).vex).toBe(LIGHTER_CHAT_MAX);
    expect(desk(1440, 0.01).vex).toBe(LIGHTER_CHAT_MIN);
    for (const width of [1000, 1024, 1366, 1440, 2560]) {
      const cols = desk(width, 0.36);
      expect(cols.chats + cols.desk + cols.vex, String(width)).toBe(width);
    }
    expect(deskGridTemplateColumns(desk(1440))).toBe("76px minmax(0, 1fr) 432px");
  });

  it("gives back toward its floor where the share would leave the desk under 640 beside the rail", () => {
    expect(deskVexWidth(1100, 0.4)).toBe(1100 - H3_RAIL_WIDTH - 640);
    expect(deskVexWidth(1000, 0.5)).toBe(LIGHTER_CHAT_MIN);
    expect(deskChatDragMax(1440)).toBe(LIGHTER_CHAT_MAX);
    expect(deskChatDragMax(1100)).toBe(1100 - H3_RAIL_WIDTH - 640);
    expect(deskChatDragMax(1000)).toBe(LIGHTER_CHAT_MIN);
  });

  it("never moves her column when the rail's Expand opens: the desk alone gives the room", () => {
    for (const width of [1024, 1280, 1440, 1920]) {
      const folded = desk(width, 0.3, false);
      const open = desk(width, 0.3, true);
      expect(open.vex, String(width)).toBe(folded.vex);
      expect(open.desk, String(width)).toBe(folded.desk - (H3_CHATS_WIDTH - H3_RAIL_WIDTH));
    }
  });

  it("hands Zen the window: no rail and no column", () => {
    expect(computeDeskColumns({ viewport: 1440, share: 0.3, chatsExpanded: true, zen: true })).toEqual({
      chats: 0,
      desk: 1440,
      vex: 0,
      chatsRail: true,
      expandable: false,
    });
  });
});

describe("the header's cells", () => {
  it("names each cell's lines, the VEX cell over Vex's column at the right beside the reserve", () => {
    expect(shellHeadTemplateColumns({ chats: 248, vex: 280 })).toBe(
      "[chats-start] 248px [chats-end title-start] minmax(0, 1fr) [title-end needs-start] auto " +
        "[needs-end funds-start] auto [funds-end vex-start] calc(280px - var(--overlay-w)) " +
        "[vex-end reserve-start] var(--overlay-w) [reserve-end]",
    );
  });

  it("sizes the VEX cell to what it holds where no column stands under it", () => {
    expect(shellHeadTemplateColumns({ chats: 76, vex: null })).toBe(
      "[chats-start] 76px [chats-end title-start] minmax(0, 1fr) [title-end needs-start] auto " +
        "[needs-end funds-start] auto [funds-end vex-start] auto [vex-end reserve-start] var(--overlay-w) [reserve-end]",
    );
  });

  it("always ends in the caption reserve, the window's top-right corner", () => {
    for (const vex of [null, 280, 432]) {
      const template = shellHeadTemplateColumns({ chats: 76, vex });
      expect(template.endsWith(" reserve-start] var(--overlay-w) [reserve-end]")).toBe(true);
    }
  });
});

describe("the frame's rows", () => {
  it("is head | body | foot, a row the frame does not draw being 0", () => {
    expect(shellGridTemplateRows({ head: false, foot: false })).toBe("0px minmax(0, 1fr) 0px");
    expect(shellGridTemplateRows({ head: true, foot: false })).toBe("var(--head-h) minmax(0, 1fr) 0px");
    expect(shellGridTemplateRows({ head: true, foot: true })).toBe(
      "var(--head-h) minmax(0, 1fr) var(--vex-h3-bottom-h)",
    );
  });

  it("under 1024 puts the console line between the header and the body, a fixed 48", () => {
    // Her band is a box over the chat under it (`--vex-band-h`), never a row.
    expect(H3_CONSOLE_LINE_HEIGHT).toBe(48);
    expect(shellGridTemplateRows({ head: true, foot: false, band: true })).toBe(
      "var(--head-h) 48px minmax(0, 1fr) 0px",
    );
    expect(shellGridTemplateRows({ head: true, foot: true, band: false })).toBe(
      "var(--head-h) minmax(0, 1fr) var(--vex-h3-bottom-h)",
    );
  });

  it("in H3's own frame the foot row is the zoomed foot line, 72 x zoom and its rule", () => {
    // docs/design/H3-DESKTOP.md section 1.11: `--vex-h3-foot` in tokens.css,
    // Cloud's `--foot`. The Lighter desk keeps the 72 token.
    expect(H3_ZOOMED_FOOT_ROW).toBe("var(--vex-h3-foot)");
    expect(shellGridTemplateRows({ head: true, foot: true, zoomFoot: true })).toBe(
      "var(--head-h) minmax(0, 1fr) var(--vex-h3-foot)",
    );
    expect(shellGridTemplateRows({ head: false, foot: false, zoomFoot: true })).toBe("0px minmax(0, 1fr) 0px");
  });

  it("reads the bottom row from its H3 size token (72), and no row is auto", () => {
    // The token's 72 is pinned by shell-geometry-tokens.test.ts.
    expect(H3_FOOT_ROW).toBe("var(--vex-h3-bottom-h)");
    for (const head of [false, true]) {
      for (const foot of [false, true]) {
        expect(shellGridTemplateRows({ head, foot })).not.toContain("auto");
      }
    }
  });
});
