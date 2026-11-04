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
 *   2. each face covers latin and latin-ext and nothing else, so Polish still
 *      renders in the face rather than in the fallback;
 *   3. its licence ships beside the others and NOTICE.txt lists every file;
 *   4. the faces block like every other face (local files load at once, so
 *      blocking avoids the fallback swap).
 *
 * Tested as text: jsdom loads no font and resolves no cascade.
 */

import { existsSync, readFileSync } from "node:fs";
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
      "be-vietnam-pro-latin-600-normal.woff2": "600",
      "be-vietnam-pro-latin-ext-600-normal.woff2": "600",
    },
  },
  {
    // Static 400 only: H3 sets every figure at 400.
    family: "Roboto Mono",
    licence: "RobotoMono-OFL.txt",
    files: {
      "roboto-mono-latin-400-normal.woff2": "400",
      "roboto-mono-latin-ext-400-normal.woff2": "400",
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

  it("covers latin and latin-ext, one subset per file", () => {
    for (const face of faces) {
      const file = fileOf(face);
      const subset = file.includes("-latin-ext-") ? LATIN_EXT : LATIN;
      expect(face, file).toMatch(new RegExp(`unicode-range:\\s*${subset.replace("+", "\\+")},`));
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

describe("the metric twin", () => {
  it("rescales a local Arial to Be Vietnam Pro's metrics", () => {
    const [twin] = facesOf("Be Vietnam Pro Fallback");
    expect(twin).toBeDefined();
    expect(twin).toContain('src: local("Arial"), local("ArialMT"), local("Liberation Sans");');
    expect(twin).toMatch(/size-adjust:\s*110\.36%;/);
    expect(twin).toMatch(/ascent-override:\s*90\.61%;/);
    expect(twin).toMatch(/descent-override:\s*24\.01%;/);
    expect(twin).toMatch(/line-gap-override:\s*0%;/);
  });
});
