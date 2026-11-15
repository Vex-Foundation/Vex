/**
 * Her live model's files (owner decision 2026-11-15): the seam's names (`kimm-assets.ts`), the pins the build check
 * enforces (`scripts/kimm-brand-assets.mjs`, `KIMM_LIVE_FILES`, gate 6b) and the files in `public/art/kimm/live/`
 * agree; the libraries load in Cloud's order; and nothing in them asks the production CSP for more than
 * `script-src 'self'`.
 *
 * Regressions this catches:
 *   - a library out of order (the core and PIXI must be globals before the shim and pixi-live2d-display run);
 *   - a file changed by one byte, missing, or added to the folder without a pin (Cloud's pins, byte for byte);
 *   - the settings naming a file that does not ship, or a shipped model file the settings never name;
 *   - a Cubism Core that compiles WebAssembly (it would need `'wasm-unsafe-eval'`), a PIXI without its shim (it would
 *     need `'unsafe-eval'`), or a CSP widened to let either in;
 *   - the folder named anywhere in the renderer but the seam;
 *   - the notice missing a file it ships.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  KIMM_LIVE_DIR as REGISTRY_LIVE_DIR,
  KIMM_LIVE_FILES,
  kimmLiveFindings,
} from "../../../../../../scripts/kimm-brand-assets.mjs";
import { KIMM_LIVE_DIR, KIMM_LIVE_LIBS, KIMM_LIVE_MODEL_BASE, KIMM_LIVE_MODEL_FILE } from "../kimm-assets.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(here, "..", "..", "..", "..");
const PUBLIC_DIR = path.join(RENDERER, "public");
const LIVE_DIR = path.join(PUBLIC_DIR, KIMM_LIVE_DIR);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function lib(name: string): string {
  return readFileSync(path.join(LIVE_DIR, "lib", name), "utf8");
}

describe("her live model's files", () => {
  it("are named in one folder the registry pins: the libraries in Cloud's order, the model by its settings", () => {
    expect(KIMM_LIVE_DIR).toBe("art/kimm/live");
    expect(REGISTRY_LIVE_DIR).toBe(KIMM_LIVE_DIR);
    expect(KIMM_LIVE_LIBS).toEqual([
      "/art/kimm/live/lib/live2dcubismcore.min.js",
      "/art/kimm/live/lib/pixi.min.js",
      "/art/kimm/live/lib/unsafe-eval.min.js",
      "/art/kimm/live/lib/cubism4.min.js",
    ]);
    expect(KIMM_LIVE_MODEL_BASE).toBe("/art/kimm/live/model/");
    const settings = JSON.parse(readFileSync(path.join(LIVE_DIR, "model", KIMM_LIVE_MODEL_FILE), "utf8")) as {
      readonly FileReferences: {
        readonly Moc: string;
        readonly Textures: readonly string[];
        readonly Physics: string;
        readonly Motions: Readonly<Record<string, ReadonlyArray<{ readonly File: string }>>>;
      };
    };
    const refs = settings.FileReferences;
    const modelFiles = [
      KIMM_LIVE_MODEL_FILE,
      refs.Moc,
      ...refs.Textures,
      refs.Physics,
      ...Object.values(refs.Motions).flatMap((group) => group.map((motion) => motion.File)),
    ].map((file) => `${KIMM_LIVE_DIR}/model/${file}`);
    const libFiles = KIMM_LIVE_LIBS.map((url) => url.slice(1));
    expect(KIMM_LIVE_FILES.map((entry) => entry.file).sort()).toEqual([...libFiles, ...modelFiles].sort());
  });

  it("ship exactly the pinned bytes in public/art/kimm/live/", () => {
    expect(kimmLiveFindings(PUBLIC_DIR)).toEqual([]);
    const total = KIMM_LIVE_FILES.reduce((sum, entry) => sum + entry.bytes, 0);
    expect(total).toBe(15_074_293);
  });

  it("refuse a changed byte, a missing file and a file without a pin", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kimm-live-"));
    temps.push(root);
    const settings = `${KIMM_LIVE_DIR}/model/${KIMM_LIVE_MODEL_FILE}`;
    mkdirSync(path.join(root, KIMM_LIVE_DIR, "model"), { recursive: true });
    copyFileSync(path.join(PUBLIC_DIR, settings), path.join(root, settings));
    expect(kimmLiveFindings(root)).not.toContain(`${settings}: pinned but missing`);
    expect(kimmLiveFindings(root).filter((finding) => finding.startsWith(settings))).toEqual([]);
    const bytes = readFileSync(path.join(root, settings));
    bytes[0] = bytes[0] === 0x7b ? 0x20 : 0x7b;
    writeFileSync(path.join(root, settings), bytes);
    writeFileSync(path.join(root, KIMM_LIVE_DIR, "model", "extra.json"), "{}");
    const findings = kimmLiveFindings(root);
    expect(findings).toContain(`${KIMM_LIVE_DIR}/model/extra.json: ships but is not pinned`);
    expect(findings.some((finding) => finding.startsWith(`${settings}: sha256`))).toBe(true);
    expect(findings).toContain(`${KIMM_LIVE_DIR}/model/kimm.moc.wasm: pinned but missing`);
    expect(findings).toContain(`${KIMM_LIVE_DIR}/lib/pixi.min.js: pinned but missing`);
  });

  it("keep the moc a MOC3 under Cloud's name, not WebAssembly", () => {
    const moc = readFileSync(path.join(LIVE_DIR, "model", "kimm.moc.wasm"));
    expect(moc.subarray(0, 4).toString("latin1")).toBe("MOC3");
    expect(statSync(path.join(LIVE_DIR, "model", "kimm.moc.wasm")).size).toBe(11_488_768);
  });

  it("ask the CSP for nothing more than script-src 'self'", () => {
    // Cubism Core 5.0.0 is wasm2js: it shadows WebAssembly with its own object and compiles nothing.
    const core = lib("live2dcubismcore.min.js");
    expect(core).toContain("var WebAssembly={}");
    expect(core).not.toMatch(/WebAssembly\.(?:compile|instantiate\(|Module\()/);
    // PIXI evaluates code only where the shim replaces it: the shim patches PIXI's ShaderSystem and loads after it.
    expect(lib("pixi.min.js")).toContain("@pixi/unsafe-eval module");
    expect(lib("unsafe-eval.min.js")).toMatch(/^\/\*!\n \* @pixi\/unsafe-eval - v6\.5\.10/);
    expect(lib("unsafe-eval.min.js")).toContain("systemCheck:function(){}");
    for (const name of ["live2dcubismcore.min.js", "unsafe-eval.min.js", "cubism4.min.js"]) {
      expect(lib(name)).not.toMatch(/new Function|\beval\s*\(/);
    }
    // The production CSP stays as strict as it was: script-src exactly 'self'.
    const html = readFileSync(path.join(RENDERER, "index.html"), "utf8");
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
    const scriptSrc = csp
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("script-src "));
    expect(scriptSrc).toBe("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline|wasm-unsafe-eval/);
  });

  it("are named in the renderer only by the seam", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "public" || entry.name === "node_modules") continue;
          walk(full);
        } else if (/\.(tsx?|css)$/.test(entry.name)) {
          if (full === path.join(RENDERER, "components", "vex", "kimm", "kimm-assets.ts")) continue;
          if (readFileSync(full, "utf8").includes("art/kimm/live")) offenders.push(path.relative(RENDERER, full));
        }
      }
    };
    walk(RENDERER);
    expect(offenders).toEqual([]);
  });

  it("are each listed in the notice beside them, with the owner's decision", () => {
    const notice = readFileSync(path.join(PUBLIC_DIR, "art", "kimm", "NOTICE.md"), "utf8");
    expect(notice).toMatch(/15 November 2026/);
    for (const entry of KIMM_LIVE_FILES) expect(notice).toContain(entry.file.slice("art/kimm/".length));
  });
});
