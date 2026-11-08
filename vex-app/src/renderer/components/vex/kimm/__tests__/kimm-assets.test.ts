/**
 * Kimm's asset seam (`kimm-assets.ts`) and her entries in the build check's
 * brand asset registry (`scripts/kimm-brand-assets.mjs`): the plate's moods
 * in its order with Cloud's signed; held drawn from offer's art (the sheet
 * dims it), every other mood from a chip and a section still of its own,
 * beside the field's two baked frames; the registry pins exactly the files
 * the seam expects, each with its size and byte budget, and every file is in
 * `public/art/kimm/` at that size and within that budget, with no metadata;
 * a piece is `missing` exactly while its file is absent, so neither side can
 * claim art the other does not have; the art carries its notice; the seam
 * never reaches the harness's stand-ins; and an awaited registry entry is
 * skipped while absent, checked once present, and refused while it arrives
 * unpinned.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  brandAssetPlan,
  KIMM_BRAND_ASSETS,
  KIMM_BUDGETS,
  KIMM_MOODS as REGISTRY_MOODS,
} from "../../../../../../scripts/kimm-brand-assets.mjs";
import {
  isKimmArtReady,
  KIMM_ART,
  KIMM_ART_DIR,
  KIMM_ART_MOOD,
  KIMM_DRAWN_MOODS,
  KIMM_FILES,
  KIMM_MOODS,
  KIMM_SHIPPED_ART,
  type KimmArt,
  type KimmImage,
  type KimmPortraitCell,
} from "../kimm-assets.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "..", "..", "..", "..", "public");
const SEAM_SOURCE = path.join(here, "..", "kimm-assets.ts");
const KIMM_CSS = readFileSync(path.join(here, "..", "..", "..", "..", "styles", "global-css", "kimm.css"), "utf8");

/** Every file the seam names, once each. */
function seamFiles(): string[] {
  return [
    ...KIMM_DRAWN_MOODS.map((mood) => KIMM_FILES.chips[mood]),
    ...KIMM_DRAWN_MOODS.map((mood) => KIMM_FILES.stills[mood]),
    KIMM_FILES.field.still,
    KIMM_FILES.field.wide,
  ];
}

/** Every piece of the shipped set with the file it is drawn from. */
function shippedPieces(): ReadonlyArray<{ readonly file: string; readonly art: KimmArt<object> }> {
  return [
    ...KIMM_MOODS.map((mood) => ({ file: KIMM_FILES.chips[KIMM_ART_MOOD[mood]], art: KIMM_SHIPPED_ART.portraits[mood] })),
    ...KIMM_MOODS.map((mood) => ({ file: KIMM_FILES.stills[KIMM_ART_MOOD[mood]], art: KIMM_SHIPPED_ART.sections[mood] })),
    { file: KIMM_FILES.field.still, art: KIMM_SHIPPED_ART.field.still },
    { file: KIMM_FILES.field.wide, art: KIMM_SHIPPED_ART.field.wide },
  ];
}

describe("Kimm's moods", () => {
  it("are the plate's six in its order, with Cloud's signed before refused", () => {
    expect([...KIMM_MOODS]).toEqual(["hi", "think", "offer", "held", "signed", "refused", "rest"]);
  });

  it("draws every mood but held from art of its own, and the registry lists exactly those", () => {
    expect([...KIMM_DRAWN_MOODS]).toEqual(KIMM_MOODS.filter((mood) => mood !== "held"));
    expect([...REGISTRY_MOODS]).toEqual([...KIMM_DRAWN_MOODS]);
  });
});

describe("held is offer, dimmed", () => {
  it("draws held from offer's art, every other mood from its own", () => {
    for (const mood of KIMM_MOODS) expect(KIMM_ART_MOOD[mood]).toBe(mood === "held" ? "offer" : mood);
    expect(KIMM_SHIPPED_ART.sections.held).toEqual(KIMM_SHIPPED_ART.sections.offer);
    expect(KIMM_SHIPPED_ART.portraits.held).toEqual(KIMM_SHIPPED_ART.portraits.offer);
    expect(Object.keys(KIMM_FILES.chips)).not.toContain("held");
    expect(Object.keys(KIMM_FILES.stills)).not.toContain("held");
  });

  it("dims held's figure and portrait to half their light in the sheet, and nothing else", () => {
    const css = KIMM_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /([^{}]+)\{\s*opacity:\s*0\.5;\s*\}/.exec(css);
    expect(rule).not.toBeNull();
    const selectors = (rule?.[1] ?? "").split(",").map((selector) => selector.trim());
    expect(selectors).toEqual([
      '.vex-kimm-key[data-kimm-mood="held"] .vex-kimm-key__sheet',
      '.vex-kimm[data-kimm-mood="held"] .vex-kimm__figure',
    ]);
  });
});

describe("the mood-to-file map", () => {
  it("gives every drawn mood a chip and a section still, beside the field's two frames", () => {
    for (const mood of KIMM_DRAWN_MOODS) {
      expect(KIMM_FILES.chips[mood]).toBe(`art/kimm/chip-${mood}.webp`);
      expect(KIMM_FILES.stills[mood]).toBe(`art/kimm/still-${mood}.webp`);
    }
    expect(KIMM_FILES.field).toEqual({ still: "art/kimm/field-still.webp", wide: "art/kimm/field-still-wide.webp" });
    expect(new Set(seamFiles()).size).toBe(seamFiles().length);
  });

  it("keeps every file under public/art/kimm/, served at /art/kimm/", () => {
    expect(KIMM_ART_DIR).toBe("art/kimm");
    expect(KIMM_ART).toBe("/art/kimm/");
    for (const file of seamFiles()) expect(file.startsWith(`${KIMM_ART_DIR}/`)).toBe(true);
  });

  it("takes no phone still, no mood sprite and no strip file", () => {
    const files = readdirSync(path.join(PUBLIC_DIR, KIMM_ART_DIR)).filter((name) => name.endsWith(".webp"));
    expect(files.sort()).toEqual(seamFiles().map((file) => path.basename(file)).sort());
  });
});

describe("the brand asset registry", () => {
  it("pins exactly the files the seam expects", () => {
    expect(KIMM_BRAND_ASSETS.map((entry) => entry.file).sort()).toEqual(seamFiles().sort());
  });

  it("gives each its byte budget: a chip 8 KB, a still 96 KB, the field's frames 24 KB and 52 KB", () => {
    expect(KIMM_BUDGETS).toEqual({ chip: 8_192, still: 98_304, fieldStill: 24_576, fieldStillWide: 53_248 });
    const budget = new Map(KIMM_BRAND_ASSETS.map((entry) => [entry.file, entry.maxBytes]));
    for (const mood of KIMM_DRAWN_MOODS) {
      expect(budget.get(KIMM_FILES.chips[mood])).toBe(8_192);
      expect(budget.get(KIMM_FILES.stills[mood])).toBe(98_304);
    }
    expect(budget.get(KIMM_FILES.field.still)).toBe(24_576);
    expect(budget.get(KIMM_FILES.field.wide)).toBe(53_248);
  });

  it("registers them as WebP, none awaited, at the sizes the seam draws them at", () => {
    for (const { file, art } of shippedPieces()) {
      const entry = KIMM_BRAND_ASSETS.find((candidate) => candidate.file === file);
      expect(entry?.format).toBe("webp");
      expect(entry?.awaited).toBeUndefined();
      const piece = art as unknown as Partial<KimmPortraitCell & KimmImage>;
      const size = !isKimmArtReady(art) ? null : (piece.sheet ?? piece);
      expect({ file, width: size?.width, height: size?.height }).toEqual({
        file,
        width: entry?.width,
        height: entry?.height,
      });
    }
  });

  it("finds every file in public/art/kimm/ at its pinned size, within budget, with no metadata", async () => {
    for (const entry of KIMM_BRAND_ASSETS) {
      const full = path.join(PUBLIC_DIR, entry.file);
      expect(existsSync(full), entry.file).toBe(true);
      expect(statSync(full).size, entry.file).toBeLessThanOrEqual(entry.maxBytes);
      const meta = await sharp(full).metadata();
      expect({ file: entry.file, format: meta.format, width: meta.width, height: meta.height }).toEqual({
        file: entry.file,
        format: "webp",
        width: entry.width,
        height: entry.height,
      });
      expect(meta.exif ?? meta.iptc ?? meta.xmp, entry.file).toBeUndefined();
    }
  });

  it("carries the notice of where the art came from beside it", () => {
    const notice = readFileSync(path.join(PUBLIC_DIR, KIMM_ART_DIR, "NOTICE.md"), "utf8");
    expect(notice).toMatch(/VEX Cloud/);
    for (const file of seamFiles()) expect(notice).toContain(path.basename(file));
  });
});

describe("what ships", () => {
  it("is missing exactly while its file is absent from public/art/kimm/, and names that file", () => {
    for (const { file, art } of shippedPieces()) {
      const present = existsSync(path.join(PUBLIC_DIR, file));
      expect({ file, state: art.state }).toEqual({ file, state: present ? "ready" : "missing" });
      if (art.state === "missing") expect(art.file).toBe(file);
    }
  });

  it("draws every piece from its own file on the app's origin", () => {
    for (const mood of KIMM_MOODS) {
      const portrait = KIMM_SHIPPED_ART.portraits[mood];
      expect(isKimmArtReady(portrait) ? portrait.sheet.src : null).toBe(`/${KIMM_FILES.chips[KIMM_ART_MOOD[mood]]}`);
      // Her chip is a sheet whose one cell is the whole file.
      expect(isKimmArtReady(portrait) ? portrait.cell : null).toEqual([0, 0, 150, 150]);
      const section = KIMM_SHIPPED_ART.sections[mood];
      expect(isKimmArtReady(section) ? section.src : null).toBe(`/${KIMM_FILES.stills[KIMM_ART_MOOD[mood]]}`);
    }
    const { still, wide } = KIMM_SHIPPED_ART.field;
    expect(isKimmArtReady(still) ? still.src : null).toBe(`/${KIMM_FILES.field.still}`);
    expect(isKimmArtReady(wide) ? wide.src : null).toBe(`/${KIMM_FILES.field.wide}`);
  });

  it("never reaches the harness's stand-ins", () => {
    const source = readFileSync(SEAM_SOURCE, "utf8");
    const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|new\s+URL\(\s*)["'`]([^"'`]+)["'`]/g)].map(
      (match) => match[1],
    );
    expect(specifiers.filter((spec) => /h3-shell|standin/.test(spec ?? ""))).toEqual([]);
    expect(source).not.toMatch(/kimm-standin-/);
  });
});

describe("a set the harness injects", () => {
  it("draws a ready piece and leaves a missing one empty", () => {
    const ready: KimmArt = { state: "ready", src: "/dev/section.webp", width: 478, height: 625 };
    const missing: KimmArt = { state: "missing", file: KIMM_FILES.stills.think };
    expect(isKimmArtReady(ready)).toBe(true);
    expect(isKimmArtReady(missing)).toBe(false);
    const cell: KimmArt<KimmPortraitCell> = {
      state: "ready",
      sheet: { src: "/dev/hi.webp", width: 83, height: 83 },
      cell: [0, 0, 83, 83],
    };
    expect(isKimmArtReady(cell) ? cell.cell : null).toEqual([0, 0, 83, 83]);
  });
});

describe("brandAssetPlan", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function publicWith(file: string | null): string {
    dir = mkdtempSync(path.join(tmpdir(), "kimm-brand-assets-"));
    if (file !== null) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), "not an image");
    }
    return dir;
  }

  const entry = { file: "art/kimm/awaited.webp", format: "webp", width: null, height: null, maxBytes: 65_536, awaited: true };

  it("skips an awaited file while it is absent from the source", () => {
    expect(brandAssetPlan(entry, publicWith(null))).toBe("awaiting");
  });

  it("refuses an awaited file that arrived with no size pinned", () => {
    expect(brandAssetPlan(entry, publicWith(entry.file))).toBe("unpinned");
  });

  it("checks an awaited file in full once it has arrived and is pinned", () => {
    expect(brandAssetPlan({ ...entry, width: 864, height: 112 }, publicWith(entry.file))).toBe("check");
  });

  it("always checks an ordinary entry, present or not", () => {
    expect(brandAssetPlan({ ...entry, awaited: false, width: 1, height: 1 }, publicWith(null))).toBe("check");
  });
});
