/**
 * Kimm's asset seam (`kimm-assets.ts`) and her entries in the build check's
 * brand asset registry (`scripts/kimm-brand-assets.mjs`): six moods in the
 * plate's order; every mood maps to a portrait cell of the key's sprite and a
 * section, beside the one strip; the registry pins exactly the files the seam
 * expects, each with its byte budget; a piece is `missing` exactly while its
 * file is absent from `public/art/kimm/`, so neither side can claim art the
 * other does not have; the seam never reaches the harness's stand-ins; and an
 * awaited registry entry is skipped while absent, checked once present, and
 * refused while it arrives unpinned.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  KIMM_FILES,
  KIMM_MOODS,
  KIMM_SHIPPED_ART,
  type KimmArt,
  type KimmArtSet,
  type KimmPortraitCell,
} from "../kimm-assets.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "..", "..", "..", "..", "public");
const SEAM_SOURCE = path.join(here, "..", "kimm-assets.ts");

/** Every file the seam names, once each. */
function seamFiles(): string[] {
  return [KIMM_FILES.keyMoods, ...KIMM_MOODS.map((mood) => KIMM_FILES.sections[mood]), KIMM_FILES.strip];
}

/** Every piece of a set with the file it is drawn from. */
function piecesOf(set: KimmArtSet): ReadonlyArray<{ readonly file: string; readonly art: KimmArt<object> }> {
  return [
    ...KIMM_MOODS.map((mood) => ({ file: KIMM_FILES.keyMoods, art: set.portraits[mood] })),
    ...KIMM_MOODS.map((mood) => ({ file: KIMM_FILES.sections[mood], art: set.sections[mood] })),
    { file: KIMM_FILES.strip, art: set.strip },
  ];
}

describe("Kimm's moods", () => {
  it("are the plate's six, in its order, and the registry's", () => {
    expect([...KIMM_MOODS]).toEqual(["hi", "think", "offer", "held", "refused", "rest"]);
    expect([...REGISTRY_MOODS]).toEqual([...KIMM_MOODS]);
  });
});

describe("the mood-to-file map", () => {
  it("gives every mood a portrait cell of the one sprite and a section of its own, beside one strip", () => {
    for (const mood of KIMM_MOODS) {
      expect(KIMM_SHIPPED_ART.portraits[mood]).toBeDefined();
      expect(KIMM_SHIPPED_ART.sections[mood]).toBeDefined();
      expect(KIMM_FILES.sections[mood]).toBe(`art/kimm/section-${mood}.webp`);
    }
    expect(KIMM_FILES.keyMoods).toBe("art/kimm/key-moods.webp");
    expect(KIMM_FILES.strip).toBe("art/kimm/strip.webp");
    expect(new Set(seamFiles()).size).toBe(seamFiles().length);
  });

  it("keeps every file under public/art/kimm/, served at /art/kimm/", () => {
    expect(KIMM_ART_DIR).toBe("art/kimm");
    expect(KIMM_ART).toBe("/art/kimm/");
    for (const file of seamFiles()) expect(file.startsWith(`${KIMM_ART_DIR}/`)).toBe(true);
  });
});

describe("the brand asset registry", () => {
  it("pins exactly the files the seam expects", () => {
    expect(KIMM_BRAND_ASSETS.map((entry) => entry.file).sort()).toEqual(seamFiles().sort());
  });

  it("gives each its byte budget: the sprite 30 KB, each section 400 KB, the strip 64 KB", () => {
    expect(KIMM_BUDGETS).toEqual({ keyMoods: 30_720, section: 409_600, strip: 65_536 });
    const budget = new Map(KIMM_BRAND_ASSETS.map((entry) => [entry.file, entry.maxBytes]));
    expect(budget.get(KIMM_FILES.keyMoods)).toBe(30_720);
    for (const mood of KIMM_MOODS) expect(budget.get(KIMM_FILES.sections[mood])).toBe(409_600);
    expect(budget.get(KIMM_FILES.strip)).toBe(65_536);
  });

  it("registers them as WebP, awaited, with no size pinned before the art exists", () => {
    for (const entry of KIMM_BRAND_ASSETS) {
      expect(entry.format).toBe("webp");
      expect(entry.awaited).toBe(true);
      if (!existsSync(path.join(PUBLIC_DIR, entry.file))) {
        expect(entry.width).toBeNull();
        expect(entry.height).toBeNull();
      }
    }
  });
});

describe("what ships", () => {
  it("is missing exactly while its file is absent from public/art/kimm/, and names that file", () => {
    for (const { file, art } of piecesOf(KIMM_SHIPPED_ART)) {
      const present = existsSync(path.join(PUBLIC_DIR, file));
      expect({ file, state: art.state }).toEqual({ file, state: present ? "ready" : "missing" });
      if (art.state === "missing") expect(art.file).toBe(file);
    }
  });

  it("draws a ready piece from its own file on the app's origin", () => {
    for (const mood of KIMM_MOODS) {
      const portrait = KIMM_SHIPPED_ART.portraits[mood];
      if (isKimmArtReady(portrait)) expect(portrait.sheet.src).toBe(`/${KIMM_FILES.keyMoods}`);
      const section = KIMM_SHIPPED_ART.sections[mood];
      if (isKimmArtReady(section)) expect(section.src).toBe(`/${KIMM_FILES.sections[mood]}`);
    }
    const strip = KIMM_SHIPPED_ART.strip;
    if (isKimmArtReady(strip)) expect(strip.src).toBe(`/${KIMM_FILES.strip}`);
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
    const missing: KimmArt = { state: "missing", file: KIMM_FILES.sections.think };
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

  const entry = { file: "art/kimm/strip.webp", format: "webp", width: null, height: null, maxBytes: 65_536, awaited: true };

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
