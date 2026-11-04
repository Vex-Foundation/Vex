/**
 * ESC NEVER CLOSES HER SECTION (docs/design/H3-DESKTOP.md sections 3.5 and
 * 4.4; plan row S4-13). Esc belongs to the money card and to what it is
 * pressed in (a dialog, a menu, a page, Zen's panels); her section opens and
 * closes only on her three controls: the Vex key, her corner key and Cmd or
 * Ctrl+Shift+B.
 *
 * THE WALK. Every renderer source whose code handles Escape (comments
 * stripped: a rule named in prose is not a handler) is read for a write that
 * could close her: the stored choice set to anything but true (`setVexOpen`,
 * `setBookOpen`, `vexOpenChat:`, `vexOpenPages:`), the flip (`toggleBook`),
 * R3's hide (`requestVexHide`), her section's own `onOpenChange(false)`, or
 * the retired avatar switch. A file that holds both is listed below with the
 * reason its Escape cannot reach the write, and that reason is checked
 * against its code; any other file holding both fails, so a new Escape
 * handler beside a close is a review, not a silent regression.
 *
 * The behaviour, in the real shell (Escape pressed on the body, her corner
 * key, the Vex key's forerunner, the composer and the column's head, with
 * her open and with her closed), is `AppShell/shell-sidebar.test.tsx`; Zen's
 * own Escape is `AppShell.tsx`'s S2-13 test.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.resolve(here, "..", "..", "..", "..");

/** Every renderer source, tests and the dev harnesses aside. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "dev" || name === "node_modules") continue;
      sources(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Code without its comments: block comments and line comments. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** An Escape handler: the key's name as a string, or as a key of a table. */
const ESCAPE = /["'`]Escape["'`]|\bEscape\b\s*:/;

/** A write that could close her section. */
const CLOSES_HER =
  /\bsetVexOpen\(\s*(?!true\b)|\bsetBookOpen\(\s*(?!true\b)|\btoggleBook\(|\bvexOpenChat\s*:(?!\s*true\b)|\bvexOpenPages\s*:(?!\s*true\b)|\brequestVexHide\(|\bonOpenChange\(\s*false\b|\bsetShowAvatar\(/;

/**
 * The files that handle Escape and also hold a write that could close her,
 * each with the check that its Escape cannot reach that write.
 */
const REVIEWED: Readonly<Record<string, (source: string) => void>> = {
  // Zen's Escape closes Zen's own panels, then Zen, and opens her desk chat
  // when Zen's assistant was open (S2-13). The file's two closing writes are
  // her controls, never the Escape handler: the column's own hide key
  // (`onHide`) and the header's Vex toggle (`onToggle`).
  "features/appShell/AppShell.tsx": (source) => {
    const handler = /const onZenKey = \(event: KeyboardEvent\): void => \{([\s\S]*?)\n {4}\};/.exec(
      source,
    );
    expect(handler, "Zen's Escape handler").not.toBeNull();
    const body = handler?.[1] ?? "";
    expect(body).toMatch(/event\.key !== "Escape"/);
    expect(body).not.toMatch(CLOSES_HER);
    expect(body.match(/setVexOpen\([^)]*\)/g)).toEqual(["setVexOpen(true)"]);
    const bare = code(source);
    expect(bare.match(new RegExp(CLOSES_HER.source, "g"))).toEqual(["setVexOpen(", "setVexOpen("]);
    expect(bare).toMatch(
      /onHide=\{\(\) => \{\s*if \(zen\) setZenAssistantOpen\(false\);\s*else setVexOpen\(false\);/,
    );
    expect(bare).toMatch(/onToggle: \(\) => setVexOpen\(!vexEffectiveOpen\)/);
  },
};

describe("Esc never closes her section (S4-13)", () => {
  const files = sources(RENDERER).map((file) => ({
    file: path.relative(RENDERER, file).split(path.sep).join("/"),
    source: readFileSync(file, "utf8"),
  }));
  const handlers = files.filter(({ source }) => ESCAPE.test(code(source)));

  it("walks every Escape handler in the renderer", () => {
    // Sanity: a broken walk cannot pass by finding nothing.
    expect(files.length).toBeGreaterThan(500);
    expect(handlers.length).toBeGreaterThan(20);
    expect(handlers.map((h) => h.file)).toContain("features/appShell/AppShell.tsx");
  });

  it("finds no Escape handler beside a close of hers but the reviewed ones, and checks each reason", () => {
    const both = handlers.filter(({ source }) => CLOSES_HER.test(code(source)));
    expect(both.map((h) => h.file).sort()).toEqual(Object.keys(REVIEWED).sort());
    for (const { file, source } of both) REVIEWED[file]?.(source);
  });

  it("reads a close in every form it takes, and lets an open pass", () => {
    for (const write of [
      "setVexOpen(false)",
      "setVexOpen(!open)",
      "setBookOpen(next)",
      "toggleBook()",
      "useUiStore.setState({ vexOpenChat: false })",
      "requestVexHide(onHide)",
      "onOpenChange(false)",
    ]) {
      expect(CLOSES_HER.test(write), write).toBe(true);
    }
    for (const write of ["setVexOpen(true)", "setBookOpen(true)", "{ vexOpenChat: true }"]) {
      expect(CLOSES_HER.test(write), write).toBe(false);
    }
    expect(ESCAPE.test('if (event.key === "Escape") close();')).toBe(true);
    expect(ESCAPE.test(code("// Escape closes the menu"))).toBe(false);
  });
});
