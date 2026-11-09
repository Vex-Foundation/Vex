/**
 * The bundled H3 faces (docs/design/R3-MINIMAL.md section 1 names the R3
 * register; the H3 plan, section 4.9, the two faces that replace it).
 *
 * The renderer serves `font-src 'self'`, so a face exists only as a local
 * WOFF2 under `public/fonts/` with its licence under `public/fonts/licenses/`
 * (both copied verbatim into dist by publicDir). A face whose file went
 * missing does not throw: the browser silently lays the text out in the next
 * family of the stack. So this suite reads the sheet and the disk together:
 *
 *   1. every `@font-face` for an H3 face names a file that is on disk and IS a
 *      WOFF2 (its magic number), at the weight the file was cut for;
 *   2. each face covers latin, latin-ext or vietnamese, one subset per file,
 *      so Polish and Vietnamese render in the face rather than the fallback,
 *      and each vietnamese face follows its weight's latin-ext face (the
 *      LAST face whose range holds a letter serves it);
 *   3. its licence ships beside the others and NOTICE.txt lists every file;
 *   4. the faces block like every other face (local files load at once, so
 *      blocking avoids the fallback swap);
 *   5. R3's faces are retired (plan row S8-17): Instrument Sans, its metric
 *      twin, Instrument Serif and Inter Tight have no face, no file, no
 *      licence and no NOTICE line, and every WOFF2 left on disk is a face
 *      the sheet declares, so no file ships that nothing names.
 *
 * Tested as text: jsdom loads no font and resolves no cascade.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const FONTS_CSS = readFileSync(path.join(here, "..", "fonts.css"), "utf8");
const PUBLIC_FONTS = path.join(here, "..", "..", "..", "public", "fonts");
const NOTICE = readFileSync(path.join(PUBLIC_FONTS, "licenses", "NOTICE.txt"), "utf8");

/** Every `@font-face` block for one family, comments stripped. */
function facesOf(family: string): string[] {
  const css = FONTS_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/@font-face\s*\{[^}]*\}/g)]
    .map((match) => match[0])
    .filter((face) => face.includes(`font-family: "${family}";`));
}

/** The `/fonts/<file>` a face loads. */
function fileOf(face: string): string {
  const match = /url\("\/fonts\/([^"]+)"\)/.exec(face);
  expect(match, `no /fonts/ url in ${face}`).not.toBeNull();
  return match?.[1] ?? "";
}

const LATIN = "U+0000-00FF";
const LATIN_EXT = "U+0100-02BA";
const VIETNAMESE = "U+0102-0103";

interface BundledFace {
  readonly family: string;
  readonly licence: string;
  /** file -> the static weight it was cut for. */
  readonly files: Readonly<Record<string, string>>;
}

const H3_FACES: readonly BundledFace[] = [
  {
    family: "Be Vietnam Pro",
    licence: "BeVietnamPro-OFL.txt",
    files: {
      "be-vietnam-pro-latin-400-normal.woff2": "400",
      "be-vietnam-pro-latin-ext-400-normal.woff2": "400",
      "be-vietnam-pro-vietnamese-400-normal.woff2": "400",
      "be-vietnam-pro-latin-600-normal.woff2": "600",
      "be-vietnam-pro-latin-ext-600-normal.woff2": "600",
      "be-vietnam-pro-vietnamese-600-normal.woff2": "600",
    },
  },
  {
    // Static 400 for every H3 figure, and 700 for the terminal's bold text.
    family: "Roboto Mono",
    licence: "RobotoMono-OFL.txt",
    files: {
      "roboto-mono-latin-400-normal.woff2": "400",
      "roboto-mono-latin-ext-400-normal.woff2": "400",
      "roboto-mono-vietnamese-400-normal.woff2": "400",
      "roboto-mono-latin-700-normal.woff2": "700",
      "roboto-mono-latin-ext-700-normal.woff2": "700",
    },
  },
];

describe.each(H3_FACES)("the bundled $family", ({ family, licence, files }) => {
  const faces = facesOf(family);

  it("declares one face per bundled file, and no other", () => {
    expect(faces.map(fileOf).sort()).toEqual(Object.keys(files).sort());
  });

  it("loads each file from disk, a real WOFF2, at the weight it was cut for", () => {
    for (const face of faces) {
      const file = fileOf(face);
      const onDisk = path.join(PUBLIC_FONTS, file);
      expect(existsSync(onDisk), `${file} is not in public/fonts`).toBe(true);
      expect(readFileSync(onDisk).subarray(0, 4).toString("latin1"), file).toBe("wOF2");
      expect(face).toMatch(new RegExp(`font-weight:\\s*${files[file] ?? "?"};`));
      expect(face).toContain('format("woff2")');
      expect(face).toContain("font-style: normal;");
    }
  });

  it("covers latin, latin-ext or vietnamese, one subset per file", () => {
    for (const face of faces) {
      const file = fileOf(face);
      const subset = file.includes("-latin-ext-")
        ? LATIN_EXT
        : file.includes("-vietnamese-")
          ? VIETNAMESE
          : LATIN;
      expect(face, file).toMatch(new RegExp(`unicode-range:\\s*${subset.replace("+", "\\+")},`));
    }
  });

  it("puts each vietnamese face after its weight's latin-ext face, so it serves the letters both list", () => {
    const order = faces.map(fileOf);
    for (const file of order.filter((name) => name.includes("-vietnamese-"))) {
      const ext = file.replace("-vietnamese-", "-latin-ext-");
      expect(order.indexOf(file), file).toBeGreaterThan(order.indexOf(ext));
      expect(order.indexOf(ext), ext).toBeGreaterThanOrEqual(0);
    }
  });

  it("blocks like every other bundled face", () => {
    for (const face of faces) expect(face).toContain("font-display: block;");
  });

  it("ships its licence and lists every file in the notice", () => {
    expect(existsSync(path.join(PUBLIC_FONTS, "licenses", licence))).toBe(true);
    expect(readFileSync(path.join(PUBLIC_FONTS, "licenses", licence), "utf8")).toContain(
      "SIL OPEN FONT LICENSE Version 1.1",
    );
    expect(NOTICE).toContain(licence);
    for (const file of Object.keys(files)) expect(NOTICE).toContain(`/fonts/${file}`);
  });
});

describe("R3's retired faces", () => {
  const RETIRED_FAMILIES = [
    "Instrument Sans",
    "Instrument Sans Fallback",
    "Instrument Serif",
    "Inter Tight",
  ];

  it.each(RETIRED_FAMILIES)("declares no %s face", (family) => {
    expect(facesOf(family)).toEqual([]);
  });

  it("ships none of their files, licences or NOTICE lines", () => {
    const files = readdirSync(PUBLIC_FONTS);
    expect(files.filter((file) => /^(instrument-|inter-tight-)/.test(file))).toEqual([]);
    const licences = readdirSync(path.join(PUBLIC_FONTS, "licenses"));
    expect(licences.filter((file) => /instrument|intertight/i.test(file))).toEqual([]);
    expect(NOTICE).not.toMatch(/\/fonts\/(instrument-|inter-tight-)/);
  });

  it("leaves no WOFF2 on disk that no face declares", () => {
    const css = FONTS_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const declared = new Set([...css.matchAll(/url\("\/fonts\/([^"]+)"\)/g)].map((m) => m[1]));
    const onDisk = readdirSync(PUBLIC_FONTS).filter((file) => file.endsWith(".woff2"));
    expect(onDisk.filter((file) => !declared.has(file))).toEqual([]);
    // JetBrains Mono stays: --font-code sets code in it.
    expect(declared.has("jetbrains-mono-latin-wght.woff2")).toBe(true);
  });
});

describe("the metric twins (VEX Cloud's generated numbers)", () => {
  it("rescales a local Arial to Be Vietnam Pro's metrics", () => {
    const [twin] = facesOf("Be Vietnam Pro Fallback");
    expect(twin).toBeDefined();
    expect(twin).toContain('src: local("Arial"), local("ArialMT"), local("Liberation Sans");');
    expect(twin).toMatch(/size-adjust:\s*107\.0523%;/);
    expect(twin).toMatch(/ascent-override:\s*93\.4123%;/);
    expect(twin).toMatch(/descent-override:\s*24\.7543%;/);
    expect(twin).toMatch(/line-gap-override:\s*0%;/);
  });

  it("sets a local Courier New to Roboto Mono's vertical metrics, and the mono stack names it", () => {
    const [twin] = facesOf("Roboto Mono Fallback");
    expect(twin).toBeDefined();
    expect(twin).toContain('src: local("Courier New"), local("CourierNewPSMT"), local("Liberation Mono");');
    expect(twin).toMatch(/size-adjust:\s*100%;/);
    expect(twin).toMatch(/ascent-override:\s*104\.7852%;/);
    expect(twin).toMatch(/descent-override:\s*27\.0996%;/);
    const tokens = readFileSync(path.join(here, "..", "tokens.css"), "utf8");
    expect(tokens).toMatch(/--font-mono:\s*"Roboto Mono", "Roboto Mono Fallback",/);
  });
});
