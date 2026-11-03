/**
 * Paper 2 at night (docs/design/R3-MINIMAL.md section 1.1): #221A17, the
 * same step as the field. The surfaces that paint paper 2 through the layer 3
 * and overlay aliases (the code and signed-fields wells, the connection
 * banner) must read it, as the transcript's wells and the token chip do. The
 * day room's paper 2 (#E8EAF2) retired with Celeris: no well keeps a day
 * override. Tested as CSS text.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(path.join(here, "..", "tokens.css"), "utf8");

function block(selector: string): string {
  const at = tokensCss.indexOf(`${selector} {`);
  expect(at, `selector "${selector}" not found`).toBeGreaterThanOrEqual(0);
  return tokensCss.slice(at, tokensCss.indexOf("\n}", at));
}

function value(body: string, name: string): string | undefined {
  return new RegExp(`${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim();
}

describe("paper 2", () => {
  it("is #221A17 at night: the static night 1 step", () => {
    expect(value(tokensCss, "--color-night-1")).toBe("#221a17");
  });

  it("the night room's layer 3 and overlay surfaces read it, the field's own step", () => {
    // The Chronos alias tier is the default :root block under its heading.
    const at = tokensCss.indexOf("--vex-alias-bg-layer-3", tokensCss.indexOf("Alias tier - CHRONOS"));
    expect(at).toBeGreaterThan(0);
    const chronos = tokensCss.slice(tokensCss.lastIndexOf(":root {", at), tokensCss.indexOf("\n}", at));
    expect(value(chronos, "--vex-alias-bg-layer-3")).toBe("var(--color-night-1)");
    expect(value(chronos, "--vex-alias-bg-overlay")).toBe("var(--color-night-1)");
    expect(value(chronos, "--vex-alias-field")).toBe("var(--color-night-1)");
  });

  it("keeps no day paper 2: the primitive and its day block are gone", () => {
    expect(tokensCss).not.toContain("--color-paper-2:");
    expect(tokensCss).not.toContain('[data-vex-theme="celeris"] {');
  });
});
