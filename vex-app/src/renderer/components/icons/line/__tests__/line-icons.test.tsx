/**
 * Catalogue contract of the line icons (docs/design/R3-MINIMAL.md section 1.7):
 * the exact set of names, the 16 x 16 frame, the paint rules (currentColor
 * stroke, no fill literal, no colour, no inline style), the drawing of every
 * icon equal to its row in appendix A, and the exports that tie the components,
 * the registry and the by-name component together.
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { JSX } from "react";
import SPEC from "../../../../../../docs/design/R3-MINIMAL.md?raw";
import * as line from "../index.js";
import { LINE_GLYPHS } from "../line-glyphs.js";

const EXPECTED_NAMES = [
  "activity", "archive", "arrow-down", "arrow-up", "arrows", "attach", "back", "bars", "bell",
  "board", "book", "camera", "candles", "chat", "check", "chevron-down", "chevron-left",
  "chevron-right", "chevron-up", "chevrons-up-down", "clock", "close", "copy", "cursor",
  "database", "desktop", "docker", "download", "drop", "edit", "external", "fib", "file",
  "flame", "folder", "gear", "h-line", "home", "inbox", "info", "key", "lighter", "link", "lock",
  "markets", "memory", "menu", "missions", "model", "moon", "more", "new-chat", "panel-left",
  "panel-right", "pause", "percent", "pin", "play", "plus", "portfolio", "preferences",
  "question", "rectangle", "redo", "refresh", "rocket", "ruler", "scan", "search", "send",
  "settings", "shield", "spark", "split-horizontal", "split-vertical", "stop", "strategies",
  "studio", "sun", "swap", "terminal", "trash", "trend-line", "tuning", "undo", "update", "user",
  "users", "vault", "wallet", "warning", "watchlist", "wifi", "wifi-off", "zen",
];

/** The names the navigation, title bar, composer, Vex sidebar and pages draw with. */
const CHROME_NAMES = [
  "chat", "missions", "portfolio", "board", "lighter", "studio", "settings", "new-chat", "search",
  "panel-left", "panel-right", "close", "chevron-up", "chevron-down", "chevron-left",
  "chevron-right", "send", "stop", "attach", "lock", "bell", "more",
];

/**
 * Drawings without an appendix A row. None today: the six derived ones
 * (archive, chevron-left, chevron-up, question, user, warning) have rows.
 */
const DERIVED: string[] = [];

type Glyph = (props: { size?: 14 | 16 | 20; className?: string }) => JSX.Element;
type Name = keyof typeof LINE_GLYPHS;

const pascal = (name: string): string =>
  name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

const namesOf = (): Name[] => Object.keys(LINE_GLYPHS) as Name[];
const exportsByName = line as unknown as Record<string, unknown>;
const glyphOf = (name: string): Glyph => exportsByName["Line" + pascal(name)] as Glyph;

const svgOf = (node: JSX.Element): SVGSVGElement => {
  const svg = render(node).container.querySelector("svg");
  if (svg === null) throw new Error("no svg rendered");
  return svg;
};

const canon = (el: Element): string => {
  const attrs = [...el.attributes]
    .map((a) => `${a.name}="${a.value}"`)
    .sort()
    .join(" ");
  const kids = [...el.children].map(canon).join("");
  return `<${el.localName}${attrs === "" ? "" : " " + attrs}>${kids}</${el.localName}>`;
};
const canonInner = (el: Element): string => [...el.children].map(canon).join("");

const specRows = (): Map<string, string> => {
  const start = SPEC.indexOf("## Appendix A");
  const end = SPEC.indexOf("## Appendix B");
  const rows = new Map<string, string>();
  for (const row of SPEC.slice(start, end).split("\n")) {
    const m = /^\| `([A-Za-z0-9]+)` \| `(.*)` \|$/.exec(row);
    if (m?.[1] !== undefined && m[2] !== undefined) rows.set(m[1], m[2]);
  }
  return rows;
};

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/** Every end and control point of a path, absolute, to check it stays on the grid. */
const points = (d: string): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  for (const m of d.matchAll(/([a-zA-Z])([^a-zA-Z]*)/g)) {
    const cmd = m[1] ?? "";
    const lower = cmd.toLowerCase();
    const rel = cmd === lower;
    const nums = (m[2] ?? "").match(NUMBER)?.map(Number) ?? [];
    const size = ARGS[lower] ?? 0;
    if (lower === "z") {
      x = sx;
      y = sy;
      continue;
    }
    for (let i = 0; i < nums.length; i += size) {
      const a = (k: number): number => nums[i + k] ?? 0;
      const ox = rel ? x : 0;
      const oy = rel ? y : 0;
      if (lower === "h") x = ox + a(0);
      else if (lower === "v") y = oy + a(0);
      else {
        if (lower === "c") out.push([ox + a(0), oy + a(1)], [ox + a(2), oy + a(3)]);
        if (lower === "s" || lower === "q") out.push([ox + a(0), oy + a(1)]);
        x = ox + a(size - 2);
        y = oy + a(size - 1);
      }
      out.push([x, y]);
      if (lower === "m" && i === 0) {
        sx = x;
        sy = y;
      }
    }
  }
  return out;
};

describe("line icon catalogue", () => {
  it("holds exactly the expected names, with no duplicates", () => {
    const names = namesOf();
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...EXPECTED_NAMES].sort());
    expect([...line.LINE_ICON_NAMES]).toEqual(names);
  });

  it("covers every icon the nav, title bar, composer, Vex sidebar and pages use", () => {
    for (const name of CHROME_NAMES) expect(namesOf(), name).toContain(name);
  });

  it("exports one named component per icon, the registry and the by-name component", () => {
    const names = namesOf();
    for (const name of names) {
      const Glyph = glyphOf(name) as unknown as { displayName?: string };
      expect(typeof Glyph, name).toBe("function");
      expect(Glyph.displayName, name).toBe("Line" + pascal(name));
      expect(line.LINE_ICONS[name], name).toBe(Glyph);
    }
    expect(Object.keys(line.LINE_ICONS).sort()).toEqual([...names].sort());
    const lineExports = Object.keys(line).filter((k) => /^Line[A-Z]/.test(k));
    expect(lineExports.sort()).toEqual(
      [...names.map((n) => "Line" + pascal(n)), "LineIcon", "LineSvg"].sort(),
    );
  });

  it("renders every icon on the 16 x 16 grid at 16 px, hidden from assistive tech", () => {
    for (const name of namesOf()) {
      const svg = svgOf(<line.LineIcon name={name} />);
      expect(svg.getAttribute("viewBox"), name).toBe("0 0 16 16");
      expect(svg.getAttribute("width"), name).toBe("16");
      expect(svg.getAttribute("height"), name).toBe("16");
      expect(svg.getAttribute("aria-hidden"), name).toBe("true");
      expect(svg.getAttribute("focusable"), name).toBe("false");
      expect(svg.children.length, name).toBeGreaterThan(0);
    }
  });

  it("takes the three design sizes and a class, on the component and by name", () => {
    expect(line.LINE_SIZES).toEqual([14, 16, 20]);
    for (const size of line.LINE_SIZES) {
      const svg = svgOf(<line.LineChat size={size} className="probe" />);
      expect(svg.getAttribute("width")).toBe(String(size));
      expect(svg.getAttribute("height")).toBe(String(size));
      expect(svg.getAttribute("viewBox")).toBe("0 0 16 16");
      expect(svg.classList.contains("probe")).toBe(true);
    }
    const named = svgOf(<line.LineIcon name="lock" size={20} className="probe" />);
    expect(named.outerHTML).toBe(svgOf(<line.LineLock size={20} className="probe" />).outerHTML);
  });

  it("paints one stroke in currentColor on the root and nothing else", () => {
    for (const name of namesOf()) {
      const svg = svgOf(<line.LineIcon name={name} />);
      expect(svg.getAttribute("fill"), name).toBe("none");
      expect(svg.getAttribute("stroke"), name).toBe("currentColor");
      expect(svg.getAttribute("stroke-width"), name).toBe("1.5");
      expect(svg.getAttribute("stroke-linecap"), name).toBe("square");
      expect(svg.getAttribute("stroke-linejoin"), name).toBe("miter");
      // no fill, stroke or colour literal below the root
      expect(svg.querySelector("[fill], [stroke], [style], [class], [id], [opacity]"), name).toBeNull();
      expect(svg.outerHTML, name).not.toMatch(
        /fill="(?!none")|#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|url\(|style=|<text|<image|<use|<g[ >]/,
      );
    }
  });

  it("keeps the heavier stroke to the three dots of More and uses only line shapes", () => {
    for (const name of namesOf()) {
      const svg = svgOf(<line.LineIcon name={name} />);
      const weighted = [...svg.querySelectorAll("[stroke-width]")];
      if (name === "more") {
        expect(weighted.map((e) => e.getAttribute("stroke-width"))).toEqual(["2.2"]);
      } else {
        expect(weighted, name).toHaveLength(0);
      }
      for (const el of svg.children) {
        expect(["path", "circle", "ellipse"], name).toContain(el.localName);
        const allowed = new Set(["d", "cx", "cy", "r", "rx", "ry", "stroke-width"]);
        for (const attr of el.attributes) expect(allowed.has(attr.name), name + " " + attr.name).toBe(true);
      }
    }
  });

  it("keeps every shape on the 16 x 16 grid and every path well formed", () => {
    for (const name of namesOf()) {
      const svg = svgOf(<line.LineIcon name={name} />);
      for (const path of svg.querySelectorAll("path")) {
        const d = path.getAttribute("d") ?? "";
        expect(d, name).toMatch(/^M[-+.\dA-Za-z\s,]+$/);
        for (const [px, py] of points(d)) {
          expect(px, name + " " + d).toBeGreaterThanOrEqual(0);
          expect(px, name + " " + d).toBeLessThanOrEqual(16);
          expect(py, name + " " + d).toBeGreaterThanOrEqual(0);
          expect(py, name + " " + d).toBeLessThanOrEqual(16);
        }
      }
      for (const shape of svg.querySelectorAll("circle, ellipse")) {
        const num = (a: string): number => Number(shape.getAttribute(a) ?? "NaN");
        const rx = shape.localName === "circle" ? num("r") : num("rx");
        const ry = shape.localName === "circle" ? num("r") : num("ry");
        expect(num("cx") - rx, name).toBeGreaterThanOrEqual(0);
        expect(num("cx") + rx, name).toBeLessThanOrEqual(16);
        expect(num("cy") - ry, name).toBeGreaterThanOrEqual(0);
        expect(num("cy") + ry, name).toBeLessThanOrEqual(16);
      }
    }
  });
});

describe("line icons against the design spec", () => {
  it("reads the appendix", () => {
    expect(specRows().size).toBeGreaterThan(80);
  });

  it("draws every appendix A row exactly, under every name that points at it", () => {
    for (const [id, markup] of specRows()) {
      const holders = namesOf().filter((n) => LINE_GLYPHS[n].spec === id);
      expect(holders.length, "no icon draws spec row " + id).toBeGreaterThan(0);
      const want = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      want.innerHTML = markup;
      for (const name of holders) {
        expect(canonInner(svgOf(<line.LineIcon name={name} />)), name).toBe(canonInner(want));
      }
    }
  });

  it("points every spec id at a real appendix row and lists the derived drawings", () => {
    const rows = specRows();
    for (const name of namesOf()) {
      const { spec } = LINE_GLYPHS[name];
      if (spec !== null) expect(rows.has(spec), name).toBe(true);
    }
    const derived = namesOf().filter((n) => LINE_GLYPHS[n].spec === null);
    expect(derived.sort()).toEqual([...DERIVED].sort());
  });

  it("keeps the send arrow and the up arrow one drawing", () => {
    expect(canonInner(svgOf(<line.LineSend />))).toBe(canonInner(svgOf(<line.LineArrowUp />)));
  });
});
