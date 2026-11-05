/**
 * The H3 column solver (docs/design/H3-DESKTOP.md, the layout numbers and
 * tiers), pinned at the parity widths (1000, 1023, 1024, 1280, 1366, 1440,
 * 1920, 2560), each with the chats open and folded and a page's strip on and
 * off; at the band seam one pixel on each side; and through the invariants
 * the grid relies on (integers, nothing negative, the tracks add back up to
 * the frame).
 */

import { describe, expect, it } from "vitest";
import {
  H3_CHATS_WIDTH,
  H3_COLUMNS_MIN,
  H3_FOOT_ROW,
  H3_RAIL_WIDTH,
  H3_VEX_MAX,
  H3_VEX_MIN,
  H3_VEX_NARROW,
  H3_VEX_PERCENT,
  H3_VEX_SHARE_MIN,
  computeH3ShellColumns,
  h3GridTemplateColumns,
  h3ShellLayout,
  H3_BAND_HEIGHT,
  H3_CHAT_MIN,
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

/** The three tracks in the grid's order: chats | Vex | chat. */
function tracks(cols: H3ShellColumns): readonly [number, number, number] {
  return [cols.chats, cols.vex, cols.chat];
}

/** Every track adds back up to the frame. */
function total(cols: H3ShellColumns): number {
  return cols.chats + cols.vex + cols.chat;
}

describe("the H3 geometry", () => {
  it("states the plates' widths and the band seam", () => {
    expect([H3_CHATS_WIDTH, H3_RAIL_WIDTH, H3_VEX_PERCENT]).toEqual([248, 76, 30]);
    expect(H3_COLUMNS_MIN).toBe(1024);
    // Cloud's Vex column (PD-14): clamp(360px, 30vw, 768px) from 1280, 340 under it.
    expect([H3_VEX_MIN, H3_VEX_MAX, H3_VEX_SHARE_MIN, H3_VEX_NARROW]).toEqual([360, 768, 1280, 340]);
  });
});

describe("the proof plates", () => {
  it("1440: chats 248, Vex 432, chat 760, the chat starting at 680", () => {
    expect(h3(1440, true)).toEqual({
      layout: "columns",
      chats: 248,
      vex: 432,
      chat: 760,
      chatsRail: false,
      vexSeat: "column",
      chatLeft: 680,
    });
  });

  it("2560: the chat starts at x 1016", () => {
    expect(h3(2560, true).chatLeft).toBe(1016);
    expect(tracks(h3(2560, true))).toEqual([248, 768, 1544]);
  });
});

/**
 * Each parity width four ways: chats open, chats folded, and the same two with
 * a page's strip. Under 1024 the four are the same band; from 1024 up folding
 * the chats hands the chat 172 and the strip hands it the Vex column.
 */
describe("the parity widths, chats open and folded, strip off and on", () => {
  it("1000 x 720, the window minimum: the band, 76 | 0 | 924 every way", () => {
    expect(tracks(h3(1000, true))).toEqual([76, 0, 924]);
    expect(tracks(h3(1000, false))).toEqual([76, 0, 924]);
    expect(tracks(h3(1000, true, true))).toEqual([76, 0, 924]);
    expect(tracks(h3(1000, false, true))).toEqual([76, 0, 924]);
  });

  it("1023, the last band pixel: 76 | 0 | 947 every way", () => {
    expect(tracks(h3(1023, true))).toEqual([76, 0, 947]);
    expect(tracks(h3(1023, false))).toEqual([76, 0, 947]);
    expect(tracks(h3(1023, true, true))).toEqual([76, 0, 947]);
    expect(tracks(h3(1023, false, true))).toEqual([76, 0, 947]);
  });

  it("1024, the first column pixel: 76 | 340 | 608 whatever the stored choice", () => {
    // Under H3_CHATS_OPEN_MIN the chats are the rail; their key opens the
    // chats panel over Vex's column, never the track. Vex's column is
    // Cloud's fixed 340 here (PD-14), the chat 608 as Cloud measures it.
    expect(tracks(h3(1024, true))).toEqual([76, 340, 608]);
    expect(tracks(h3(1024, false))).toEqual([76, 340, 608]);
    expect(tracks(h3(1024, true, true))).toEqual([76, 0, 948]);
    expect(tracks(h3(1024, false, true))).toEqual([76, 0, 948]);
  });

  it("1280 x 800, the stored default: 248 | 384 | 648", () => {
    expect(tracks(h3(1280, true))).toEqual([248, 384, 648]);
    expect(tracks(h3(1280, false))).toEqual([76, 384, 820]);
    expect(tracks(h3(1280, true, true))).toEqual([248, 0, 1032]);
    expect(tracks(h3(1280, false, true))).toEqual([76, 0, 1204]);
  });

  it("1366 x 768: 248 | 409.8 | 708.2, Cloud's unrounded 30vw", () => {
    expect(tracks(h3(1366, true))).toEqual([248, 409.8, 708.2]);
    expect(tracks(h3(1366, false))).toEqual([76, 409.8, 880.2]);
    expect(tracks(h3(1366, true, true))).toEqual([248, 0, 1118]);
    expect(tracks(h3(1366, false, true))).toEqual([76, 0, 1290]);
  });

  it("1440 x 900, the plate: 248 | 432 | 760", () => {
    expect(tracks(h3(1440, true))).toEqual([248, 432, 760]);
    expect(tracks(h3(1440, false))).toEqual([76, 432, 932]);
    expect(tracks(h3(1440, true, true))).toEqual([248, 0, 1192]);
    expect(tracks(h3(1440, false, true))).toEqual([76, 0, 1364]);
  });

  it("1920 x 1080: 248 | 576 | 1096", () => {
    expect(tracks(h3(1920, true))).toEqual([248, 576, 1096]);
    expect(tracks(h3(1920, false))).toEqual([76, 576, 1268]);
    expect(tracks(h3(1920, true, true))).toEqual([248, 0, 1672]);
    expect(tracks(h3(1920, false, true))).toEqual([76, 0, 1844]);
  });

  it("2560, the second plate: 248 | 768 | 1544", () => {
    expect(tracks(h3(2560, true))).toEqual([248, 768, 1544]);
    expect(tracks(h3(2560, false))).toEqual([76, 768, 1716]);
    expect(tracks(h3(2560, true, true))).toEqual([248, 0, 2312]);
    expect(tracks(h3(2560, false, true))).toEqual([76, 0, 2484]);
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

  it("in the band the chats are the rail whatever the stored choice says", () => {
    expect(h3(1000, true)).toEqual({
      layout: "band",
      chats: 76,
      vex: 0,
      chat: 924,
      chatsRail: true,
      vexSeat: "band",
      chatLeft: 76,
    });
    expect(h3(1000, false)).toEqual(h3(1000, true));
  });

  it("a page's strip wins over the band", () => {
    expect(h3(1000, true, true)).toEqual({
      layout: "band",
      chats: 76,
      vex: 0,
      chat: 924,
      chatsRail: true,
      vexSeat: "strip",
      chatLeft: 76,
    });
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
    expect(seat(h3(1000, true, true))).toEqual(["band", "strip", true]);
  });

  it("the x where the chat starts", () => {
    expect(h3(1280, true).chatLeft).toBe(632);
    expect(h3(1366, true).chatLeft).toBe(657.8);
    expect(h3(1440, false).chatLeft).toBe(508);
    expect(h3(1440, true, true).chatLeft).toBe(248);
    expect(h3(1023, true).chatLeft).toBe(76);
  });

  it("the column template, in H3's order, with the chat as the 1fr track", () => {
    expect(h3GridTemplateColumns(h3(1440, true))).toBe("248px 432px minmax(0, 1fr)");
    expect(h3GridTemplateColumns(h3(1440, false, true))).toBe("76px 0px minmax(0, 1fr)");
    expect(h3GridTemplateColumns(h3(1000, true))).toBe("76px 0px minmax(0, 1fr)");
  });
});

describe("the Vex column", () => {
  it("is Cloud's: 340 from 1024 to 1279, clamp(360px, 30vw, 768px) from 1280, unrounded", () => {
    expect(h3(1024, true).vex).toBe(340);
    expect(h3(1180, true).vex).toBe(340);
    expect(h3(1279, true).vex).toBe(340);
    expect(h3(1280, true).vex).toBe(384);
    // 1366 x 0.3 = 409.8, as Cloud measures it (renders/checks.json).
    expect(h3(1366, true).vex).toBe(409.8);
    expect(h3(1440, true).vex).toBe(432);
    expect(h3(1920, true).vex).toBe(576);
    expect(h3(2560, true).vex).toBe(768);
    // The cap: 30% of 3000 would be 900.
    expect(h3(3000, true).vex).toBe(768);
  });

  it("is a function of the window alone: the chats and her section never reach it", () => {
    for (let viewport = H3_COLUMNS_MIN; viewport <= 3000; viewport += 1) {
      const expected = viewport < 1280 ? 340 : Math.min(768, Math.max(360, (viewport * 30) / 100));
      expect(h3(viewport, true).vex, String(viewport)).toBe(expected);
      expect(h3(viewport, false).vex, String(viewport)).toBe(expected);
    }
  });

  it("keeps its width when the chats fold; the chat gains the difference", () => {
    for (let viewport = H3_CHATS_OPEN_MIN; viewport <= 2560; viewport += 1) {
      const open = h3(viewport, true);
      const folded = h3(viewport, false);
      const label = String(viewport);
      expect(folded.vex, label).toBe(open.vex);
      expect(folded.chat - open.chat, label).toBeCloseTo(H3_CHATS_WIDTH - H3_RAIL_WIDTH, 9);
    }
  });

  it("folds to a page's strip at 0 and hands the chat its whole width", () => {
    for (const viewport of [1024, 1280, 1366, 1440, 1920, 2560]) {
      for (const chats of [false, true]) {
        const column = h3(viewport, chats);
        const strip = h3(viewport, chats, true);
        const label = `${String(viewport)} ${String(chats)}`;
        expect(strip.vex, label).toBe(0);
        expect(strip.chats, label).toBe(column.chats);
        expect(strip.chat, label).toBe(column.chat + column.vex);
      }
    }
  });
});

/**
 * H3 keeps the plate rule rather than R3's 640 centre floor. These pin where
 * that matters, so a change to either is a visible decision.
 */
describe("no centre floor", () => {
  it("under 1268 the chats are the rail whatever the stored choice says, so no track waits on it", () => {
    for (let viewport = 0; viewport < H3_CHATS_OPEN_MIN; viewport += 1) {
      expect(h3(viewport, true), String(viewport)).toEqual(h3(viewport, false));
    }
    expect(h3(1024, true).chat).toBe(608);
    expect(h3(1267, true).chat).toBe(851);
    expect(h3(1268, true).chat).toBe(680);
  });

  it("with the chats folded the columns never take the chat under 608", () => {
    for (let viewport = H3_COLUMNS_MIN; viewport <= 2560; viewport += 1) {
      expect(h3(viewport, false).chat, String(viewport)).toBeGreaterThanOrEqual(608);
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

  it("an integer chats track, nothing negative, and the tracks add back up to the frame", () => {
    for (const viewport of widths) {
      for (const chats of [false, true]) {
        for (const vexStrip of [false, true]) {
          const cols = h3(viewport, chats, vexStrip);
          const label = `${String(viewport)} ${String(chats)} ${String(vexStrip)}`;
          // The Vex track is Cloud's unrounded clamp, so only the chats
          // track is a whole pixel; the chat carries the fraction.
          expect(Number.isInteger(cols.chats), label).toBe(true);
          for (const track of tracks(cols)) expect(track, label).toBeGreaterThanOrEqual(0);
          expect(total(cols), label).toBeCloseTo(Math.round(viewport), 9);
          expect(cols.chatLeft, label).toBe(cols.chats + cols.vex);
          expect(cols.layout, label).toBe(h3ShellLayout(viewport));
          expect(cols.chatsRail, label).toBe(cols.chats !== H3_CHATS_WIDTH);
        }
      }
    }
  });

  it("only the Vex column has a Vex track; the band and the strip are drawn in the chat", () => {
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
    expect(tracks(h3(50, true))).toEqual([50, 0, 0]);
    expect(tracks(h3(0, true))).toEqual([0, 0, 0]);
    expect(tracks(h3(-20, true))).toEqual([0, 0, 0]);
    expect(tracks(h3(Number.NaN, true))).toEqual([0, 0, 0]);
  });
});

describe("the desktop's tiers (H3-DESKTOP.md section 4.12)", () => {
  it("names the band, the medium tier and the wide tier, each seam to the wider side", () => {
    expect(H3_CHATS_OPEN_MIN).toBe(1268);
    expect(H3_CHAT_MIN).toBe(640);
    expect([1000, 1023, 1023.4].map(h3ShellTier)).toEqual(["band", "band", "band"]);
    expect([1023.5, 1024, 1267].map(h3ShellTier)).toEqual(["medium", "medium", "medium"]);
    expect([1268, 1280, 1440, 2560].map(h3ShellTier)).toEqual(["wide", "wide", "wide", "wide"]);
  });

  it("puts the seam where the open chats would first take the chat under 640", () => {
    expect(h3(1268, true).chat).toBe(680);
    expect(h3(1268, true).chatsRail).toBe(false);
    expect(h3(1267, true).chatsRail).toBe(true);
  });

  it("keeps the chat at 608 or more at every width, whatever the stored choice", () => {
    // Cloud's 340 column leaves 608 at 1024 (PD-14), its narrowest.
    for (let width = 1000; width <= 2560; width += 1) {
      for (const chats of [false, true]) {
        expect(h3(width, chats).chat, String(width)).toBeGreaterThanOrEqual(608);
      }
    }
  });
});

describe("the frame per mode", () => {
  it("stands the agent shell and Studio in H3's order: chats | Vex | chat", () => {
    for (const mode of ["agent", "studio"] as const) {
      expect(shellFrameKind(mode)).toBe("h3");
      expect(shellColumnOrder(mode)).toEqual(["chats", "vex", "chat"]);
    }
  });

  it("stands the Lighter desk in H3's rows with its own order: rail | desk | Vex", () => {
    expect(shellFrameKind("lighter")).toBe("desk");
    expect(shellColumnOrder("lighter")).toEqual(["chats", "chat", "vex"]);
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
  it("names each cell's lines, the Vex key between the chats and the chat in H3's order", () => {
    expect(shellHeadTemplateColumns({ chats: 248, vex: 432, vexBetween: true })).toBe(
      "[chats-start] 248px [chats-end vex-start] 432px [vex-end title-start] minmax(0, 1fr) " +
        "[title-end funds-start] auto [funds-end reserve-start] var(--overlay-w) [reserve-end]",
    );
  });

  it("puts the Vex key at the right end, as wide as the key, over R3's right-hand column", () => {
    expect(shellHeadTemplateColumns({ chats: 264, vex: null, vexBetween: false })).toBe(
      "[chats-start] 264px [chats-end title-start] minmax(0, 1fr) [title-end funds-start] auto " +
        "[funds-end vex-start] auto [vex-end reserve-start] var(--overlay-w) [reserve-end]",
    );
  });

  it("on the desk shares the right-hand column between the Vex key and the caption reserve", () => {
    expect(shellHeadTemplateColumns({ chats: 76, vex: 432, vexBetween: false, reserveInVex: true })).toBe(
      "[chats-start] 76px [chats-end title-start] minmax(0, 1fr) [title-end funds-start] auto " +
        "[funds-end vex-start] calc(432px - var(--overlay-w)) [vex-end reserve-start] var(--overlay-w) [reserve-end]",
    );
  });

  it("always ends in the caption reserve, the window's top-right corner", () => {
    for (const vexBetween of [false, true]) {
      for (const vex of [null, 0, 307]) {
        const template = shellHeadTemplateColumns({ chats: 76, vex, vexBetween });
        expect(template.endsWith(" reserve-start] var(--overlay-w) [reserve-end]")).toBe(true);
      }
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

  it("under 1024 puts Vex's band between the header and the body, a fixed 132", () => {
    expect(H3_BAND_HEIGHT).toBe(132);
    expect(shellGridTemplateRows({ head: true, foot: false, band: true })).toBe(
      "var(--head-h) 132px minmax(0, 1fr) 0px",
    );
    expect(shellGridTemplateRows({ head: true, foot: true, band: false })).toBe(
      "var(--head-h) minmax(0, 1fr) var(--vex-h3-bottom-h)",
    );
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
