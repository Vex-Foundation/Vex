/**
 * CHART DATA-NOTES DISCLOSURE CONTRACT.
 *
 * What these tests protect:
 *
 *  - the status line stays SHORT and always visible: resolution and bar count
 *    are what the chart is, and they never move behind a disclosure;
 *  - every caveat sentence, and the hydration provenance, is still present in
 *    the DOM when the region is open - relocating a disclosure is allowed,
 *    shortening one is not (owner decree on silent content cutting);
 *  - the trigger is a real button carrying `aria-expanded` and
 *    `aria-controls`, so it is operable from the keyboard without a handler
 *    of our own and a screen reader is told what it controls;
 *  - a closed region is out of the accessibility tree AND the tab order, so
 *    the sentences are hidden rather than merely invisible.
 *
 * `ExpandRegion` keeps its children mounted once opened, so "closed" here is
 * asserted through `aria-hidden`/`inert` on the region, which is exactly the
 * mechanism a browser and a screen reader act on.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { ChartCaveats, buildChartDataNotes } from "../ChartCaveats.js";

afterEach(() => {
  cleanup();
});

const PROVENANCE = {
  transport: "http",
  sourceObservation: "dexscreener pairs batch read at 2026-08-26T10:00:00Z",
} as const;

const CHART_FETCHED_AT = Date.UTC(2026, 7, 26, 9, 30, 0);

function renderCaveats(fetchedAtMs: number | null = CHART_FETCHED_AT): void {
  render(
    createElement(ChartCaveats, {
      resolution: "1h" as const,
      drawn: 200,
      hiddenOlder: 42,
      whitespaceCount: 3,
      incoherentCount: 8,
      lastBarPartial: true,
      truncated: true,
      provenance: PROVENANCE,
      fetchedAtMs,
    }),
  );
}

/** The region the trigger points at, or a named throw. */
function regionFor(trigger: HTMLElement): HTMLElement {
  const id = trigger.getAttribute("aria-controls");
  if (id === null) throw new Error("trigger carries no aria-controls");
  const region = document.getElementById(id);
  if (region === null) throw new Error(`no region with id ${id}`);
  return region;
}

describe("ChartCaveats status line", () => {
  it("keeps the resolution and the bar count always visible", () => {
    renderCaveats();
    expect(screen.getByText("1h")).toBeTruthy();
    expect(screen.getByText("200 bars")).toBeTruthy();
  });

  it("renders no trigger when there is nothing to disclose", () => {
    render(
      createElement(ChartCaveats, {
        resolution: "5m" as const,
        drawn: 1,
        hiddenOlder: 0,
        whitespaceCount: 0,
        incoherentCount: 0,
        lastBarPartial: false,
        truncated: false,
        provenance: null,
        fetchedAtMs: null,
      }),
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("1 bar")).toBeTruthy();
  });

  it("does not put diagnostic prose in the always-visible line", () => {
    renderCaveats();
    const line = screen.getByRole("button").parentElement;
    if (line === null) throw new Error("status line missing");
    // The always-visible register holds exactly three facts and the
    // disclosure: what the chart IS (resolution), how much of it is drawn, and
    // WHEN it was read. The clock joined this line in the live arc, when the
    // cards above it gained the ability to move and the chart did not; it is a
    // fact about the drawing, not the diagnostic prose this case exists to keep
    // out. The time itself is locale-formatted, so it is matched by shape.
    expect(line.textContent).toMatch(
      /^1h200 barschart as of [\d:\s APM.\u202f\u00a0]+Data notes \(6\)$/,
    );
  });
});

describe("ChartCaveats disclosure", () => {
  it("is a keyboard-reachable button with a correct aria contract", () => {
    renderCaveats();
    const trigger = screen.getByRole("button", { name: /data notes/i });
    // A real <button>: in the tab order and operated by Enter and Space by the
    // browser itself, which is why this component adds no key handler.
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("type")).toBe("button");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-controls")).toBe(
      regionFor(trigger).id,
    );

    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });

  it("hides the notes from assistive tech and the tab order while closed", () => {
    renderCaveats();
    const region = regionFor(screen.getByRole("button"));
    expect(region.getAttribute("aria-hidden")).toBe("true");
    expect(region.hasAttribute("inert")).toBe(true);
    expect(region.getAttribute("data-open")).toBe("false");
  });

  it("opens and closes from the trigger, flipping aria-expanded", () => {
    renderCaveats();
    const trigger = screen.getByRole("button");
    const region = regionFor(trigger);

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(region.getAttribute("data-open")).toBe("true");
    expect(region.getAttribute("aria-hidden")).toBeNull();
    expect(region.hasAttribute("inert")).toBe(false);

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(region.getAttribute("data-open")).toBe("false");
    expect(region.hasAttribute("inert")).toBe(true);
  });

  it("returns focus to the trigger when a close blurs the open region", () => {
    renderCaveats();
    const trigger = screen.getByRole("button");
    fireEvent.click(trigger);
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(trigger);
  });

  it("carries every caveat sentence WHOLE, plus the provenance", () => {
    renderCaveats();
    const trigger = screen.getByRole("button");
    fireEvent.click(trigger);
    const region = within(regionFor(trigger));

    const expected = buildChartDataNotes({
      hiddenOlder: 42,
      whitespaceCount: 3,
      incoherentCount: 8,
      lastBarPartial: true,
      truncated: true,
      provenance: PROVENANCE,
    });
    expect(expected).toHaveLength(6);
    for (const note of expected) {
      // getByText with an exact string: a sentence cut anywhere would fail.
      expect(region.getByText(note.text)).toBeTruthy();
    }
  });

  it("names the counts and the provenance the board persisted", () => {
    renderCaveats();
    fireEvent.click(screen.getByRole("button"));
    const text = document.body.textContent ?? "";
    expect(text).toContain("42 older bars");
    expect(text).toContain("3 buckets");
    expect(text).toContain("8 bars have an open or close outside");
    expect(text).toContain("newest bar is still forming");
    expect(text).toContain("provider bounded the range");
    expect(text).toContain(PROVENANCE.sourceObservation);
    expect(text).toContain("Read over http");
  });
});

describe("buildChartDataNotes", () => {
  it("emits nothing when the chart owes no disclosure", () => {
    expect(
      buildChartDataNotes({
        hiddenOlder: 0,
        whitespaceCount: 0,
        incoherentCount: 0,
        lastBarPartial: false,
        truncated: false,
        provenance: null,
      }),
    ).toStrictEqual([]);
  });

  it("keeps singular and plural honest", () => {
    const notes = buildChartDataNotes({
      hiddenOlder: 1,
      whitespaceCount: 1,
      incoherentCount: 1,
      lastBarPartial: false,
      truncated: false,
      provenance: null,
    });
    expect(notes.map((note) => note.key)).toStrictEqual([
      "hidden-older",
      "whitespace",
      "incoherent",
    ]);
    expect(notes[0]?.text).toContain("1 older bar exists");
    expect(notes[1]?.text).toContain("1 bucket reported");
    expect(notes[2]?.text).toContain("1 bar has an open or close");
  });
});

describe("ChartCaveats chart clock", () => {
  it("states when the candles were read, in the always-visible register", () => {
    renderCaveats();
    const asOf = document.querySelector('[data-vex-area="board-chart-asof"]');
    // The chart is a SNAPSHOT in this arc, and it carries its own clock so it
    // never inherits a freshness from live cards beside it that it does not
    // have. Live candles are a declared future gate.
    expect(asOf?.textContent).toContain("chart as of");
    expect(asOf?.textContent).toMatch(/\d/);
  });

  it("says nothing rather than inventing a clock it does not have", () => {
    renderCaveats(null);
    expect(
      document.querySelector('[data-vex-area="board-chart-asof"]'),
    ).toBeNull();
  });
});
