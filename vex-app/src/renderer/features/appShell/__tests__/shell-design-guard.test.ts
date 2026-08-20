/**
 * Shell design-language guard — the VEX tokens-v2 law (rebrand 2026-08-20)
 * stays locked.
 *
 * The law: components consume SEMANTIC ALIASES ONLY (tokens.css tier 2/3 —
 * the --vex-alias-* vars, their --color-* utility projections, and the
 * shell's --vex-* scope tokens). One accent family rooted at the vx-logo
 * #0000c0 (chronos interactive = blue-400 #7a8cff, celeris = blue-700);
 * the RETIRED cobalt family #1f44ff/#0a23b8 is banned outright, alongside
 * every older legacy hex. Depth is luminance + hairlines (or border+shadow
 * in celeris), never glass or resting glow; no ShinyText gradient chrome.
 * This test turns each law into a red build instead of a review comment:
 *
 *   1. /backdrop-blur(?!-none)/ — no backdrop-filter glass anywhere in the
 *      shell. `backdrop-blur-none` is EXEMPT by the lookahead (the dialog
 *      base itself is blur-free since the rebrand).
 *   2. /ShinyText|vex-shiny-text/ — the shine chrome died in S7 (component
 *      + @keyframes deleted); nothing may re-import it.
 *   3. legacy hex families: the gray-blue set, the Protocol Desk accent
 *      #3275f8, AND the retired cobalt accent pair #1f44ff/#0a23b8. Raw
 *      hexes never appear in shell sources — the static palette lives in
 *      tokens.css only (CSS files are outside this scan by design).
 *   4. /shadow-\[0_0_/ — resting glow. Depth never comes from shadows
 *      (directional shadows and the select-beam's lit-item shadow live in
 *      globals.css, outside this scan by design).
 *
 * Scope: every non-test .ts/.tsx under features/appShell, plus the three
 * shared primitives the shell composes for popover/dialog chrome and the
 * turn island (components/ui/dialog.tsx, components/ui/select-menu.tsx,
 * components/ui/dynamic-island.tsx). Onboarding
 * surfaces are a separate, finished language and are NOT scanned.
 *
 * Sources are read via `import.meta.glob(..., ?raw)` — Vite inlines the
 * file contents at transform time — instead of `node:fs`, so this test
 * typechecks inside the renderer TS project WITHOUT pulling @types/node
 * into the renderer program (the renderer/main type boundary stays clean).
 * A raw text scan (not an AST) is correct here: every banned pattern is a
 * Tailwind class fragment or hex literal that can only appear as text.
 */

import { describe, expect, it } from "vitest";

// ── Scope (glob keys are relative to this __tests__ directory) ────────────
// Transform-time file inlining happens on Vite's side; on slow filesystems
// (WSL drvfs mounts) the IMPORT of this module is the expensive part, not
// the test body — module-level eager globs keep the test itself fast.
const SHELL_SOURCES: Record<string, string> = {
  ...import.meta.glob<string>(["../**/*.ts", "../**/*.tsx", "!../**/__tests__/**"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob<string>(
    [
      "../../../components/ui/dialog.tsx",
      "../../../components/ui/select-menu.tsx",
      // The Turn Island's shell primitive: owned source rendered INSIDE the
      // chat column, so the shell's surface law (solid ink + hairlines, never
      // glass, never a resting glow) binds it exactly like an appShell file.
      // It complies today; scanning it keeps that a red build instead of a
      // review comment.
      "../../../components/ui/dynamic-island.tsx",
    ],
    { query: "?raw", import: "default", eager: true },
  ),
};

/** Normalize a glob key to a stable renderer-relative path. */
function normalizeKey(key: string): string {
  if (key.startsWith("../../../components/ui/")) {
    return `components/ui/${key.slice("../../../components/ui/".length)}`;
  }
  return `features/appShell/${key.replace(/^\.\.\//, "")}`;
}

interface BannedPattern {
  readonly name: string;
  readonly regex: RegExp;
}

// NOTE: no `g` flags — each regex is used via .test() per file, and a
// sticky/global regex would carry lastIndex state across files.
const BANNED: readonly BannedPattern[] = [
  { name: "backdrop-blur (glass)", regex: /backdrop-blur(?!-none)/ },
  { name: "ShinyText chrome", regex: /ShinyText|vex-shiny-text/ },
  {
    name: "legacy gray-blue raw hex",
    regex: /#(?:6f91ff|8da5ff|adc0ff|3758ff|4668ff|9bb2ff|4d72ff|b2a3ff)/i,
  },
  { name: "resting glow shadow", regex: /shadow-\[0_0_/ },
  // Signal Tape foundation (§0.4): the retired indigo/violet accent and the
  // two raw status hexes are now tokens (--vex-pin / --vex-warn-text). Any raw
  // re-introduction in shell sources is a red build.
  { name: "legacy indigo/violet accent", regex: /#(?:6366f1|8b5cf6)/i },
  { name: "raw pin/warn status hex", regex: /#(?:ffd35c|ffce5a|f0a0a0)/i },
  // Landing rebrand: the Protocol Desk accent root retired repo-wide in the
  // shell — components go through var(--vex-accent*).
  { name: "retired Protocol Desk accent (#3275f8)", regex: /#3275f8/i },
  // Tokens v2 (2026-08-20): the cobalt #1f44ff/#0a23b8 family is retired in
  // favour of the #0000c0-rooted blue ramp, which lives ONLY in tokens.css
  // (CSS is out of this scan's scope). Any raw re-introduction in shell
  // sources is a red build — fix the file with var(), never whitelist.
  { name: "retired cobalt accent (#1f44ff/#0a23b8)", regex: /#(?:1f44ff|0a23b8)/i },
];

/**
 * Sanctioned exceptions. Keep this list EMPTY-by-default: fix the source
 * before whitelisting. Each entry exempts ONE (file, pattern) pair.
 */
interface WhitelistEntry {
  /** Path relative to vex-app/src/renderer, posix separators. */
  readonly file: string;
  /** Must equal a BannedPattern.name. */
  readonly pattern: string;
  readonly reason: string;
}

const WHITELIST: readonly WhitelistEntry[] = [
  {
    file: "features/appShell/SessionsList.tsx",
    pattern: "backdrop-blur (glass)",
    reason:
      "User-sanctioned glass rail: the sessions sidebar floats as translucent " +
      "ink (--vex-glass) with backdrop-blur over the current shell photo " +
      "backdrop. " +
      "Glass is allowed ONLY on the two side rails.",
  },
  {
    file: "features/appShell/BookPanel.tsx",
    pattern: "backdrop-blur (glass)",
    reason:
      "User-sanctioned glass rail: the BOOK panel floats as translucent ink " +
      "(--vex-glass) with backdrop-blur over the current shell photo backdrop. " +
      "Glass is allowed ONLY on the two side rails.",
  },
  // REMOVED (composer rebuild, owner decree 2026-07-29): the Signal Console
  // composer and its starter-chips band were the third and seventh sanctioned
  // glass surfaces. Both are now SOLID ink (--vex-surface-1) with a flat
  // --vex-line border, so neither carries backdrop-blur any more and their
  // exemptions were dead entries. The glass roster is back to: the two side
  // rails, the ShellScreen overlays, the profile menu, the Dialog base, and
  // the portfolio cards. The banned list itself is unchanged.
  {
    // Owner decree 2026-07-20, Chronos glass law: every full-app ShellScreen
    // overlay (Memory / Sessions / How Vex works) is a floating glass
    // surface — ink glass + backdrop-blur for legibility over the current
    // shell backdrop,
    // a static grain overlay (.vex-noise) on top. The prior DistortedGlass
    // SVG displacement filter is retired (it warped screen content).
    file: "features/appShell/screens/ShellScreen.tsx",
    pattern: "backdrop-blur (glass)",
    reason:
      "Owner-decreed Chronos glass surface (2026-07-20 law): the full-app " +
      "overlay screens float as translucent ink (--vex-glass-strong) with " +
      "backdrop-blur over the current shell backdrop, carrying a static grain " +
      "overlay. One whitelisted wrapper for every screen.",
  },
  {
    // Owner decree 2026-07-20, Chronos glass law: the profile side-panel
    // menu floats over the rail as the same Chronos glass surface family.
    file: "features/appShell/SidebarProfile.tsx",
    pattern: "backdrop-blur (glass)",
    reason:
      "Owner-decreed Chronos glass surface (2026-07-20 law): the profile " +
      "side-panel menu floats as translucent ink (--vex-glass-strong) with " +
      "backdrop-blur + a static grain overlay, matching the approved " +
      "profile-menu mock.",
  },
  // REMOVED (rebrand phase 1, 2026-08-20): the Dialog base is a solid
  // layer-2 card on tokens v2 - its backdrop-blur exemption became inert
  // when the glass chrome retired, so the entry is deleted rather than
  // kept as a stale sanction.
  {
    // Welcome Portfolio tab (approved harness plan v6, 2026-07-20): the
    // welcome stage's floating card stack (Overview / Wallets / Balances)
    // joins the Chronos glass family. Deliberately scoped to the SINGLE
    // PortfolioCard chrome every card composes (the HvZone precedent) — no
    // other portfolio file may carry backdrop-blur; the round handle button
    // is intentionally blur-free ink.
    file: "features/appShell/book/portfolio/PortfolioCard.tsx",
    pattern: "backdrop-blur (glass)",
    reason:
      "Approved welcome Portfolio tab (plan v6, 2026-07-20): the floating " +
      "portfolio cards wear translucent ink (--vex-rail) with " +
      "backdrop-blur + static grain over the current shell backdrop, via this " +
      "one card chrome that every card composes.",
  },
];

interface Violation {
  readonly file: string;
  readonly pattern: string;
}

function scanSource(file: string, source: string): Violation[] {
  const violations: Violation[] = [];
  for (const banned of BANNED) {
    if (!banned.regex.test(source)) continue;
    const whitelisted = WHITELIST.some(
      (w) => w.file === file && w.pattern === banned.name,
    );
    if (!whitelisted) violations.push({ file, pattern: banned.name });
  }
  return violations;
}

describe("shell design guard (S7)", () => {
  // Explicit I/O budget: importing this module inlines every appShell
  // source file — I/O-bound at transform time, and the default 5s test
  // timeout is not generous on slow filesystems (WSL drvfs mounts). The
  // longer timeout does not weaken the guard; the assertion stays
  // byte-identical.
  it(
    "no shell source file uses glass, shine, legacy hexes, or resting glow",
    { timeout: 60_000 },
    () => {
      const entries = Object.entries(SHELL_SOURCES);
      // Sanity: the globs actually found the appShell tree + both extras.
      expect(entries.length).toBeGreaterThan(10);
      const files = entries.map(([key]) => normalizeKey(key));
      expect(files).toContain("components/ui/dialog.tsx");
      expect(files).toContain("components/ui/select-menu.tsx");

      const violations: Violation[] = [];
      for (const [key, source] of entries) {
        violations.push(...scanSource(normalizeKey(key), source));
      }

      // If this fails: replace the offending chrome with the --vex-* tokens
      // (accent → var(--vex-accent), readable blue text → --vex-accent-text,
      // borders → --vex-accent-border[-strong], fills → --vex-accent-fill-*)
      // — do NOT add a whitelist entry unless the file is a shared primitive
      // whose default is overridden at every shell call site.
      const rendered = violations.map((v) => `${v.file} :: ${v.pattern}`);
      expect(rendered).toEqual([]);

      // Stale-whitelist check: every entry must point at a scanned file.
      for (const entry of WHITELIST) {
        expect(files, `stale whitelist entry: ${entry.file}`).toContain(
          entry.file,
        );
        expect(BANNED.map((b) => b.name)).toContain(entry.pattern);
      }
    },
  );

  // ── Pattern self-tests (mutation coverage for the lookahead subtlety) ──
  const matchNames = (source: string): readonly string[] =>
    BANNED.filter((b) => b.regex.test(source)).map((b) => b.name);

  it("flags real glass but NOT the sanctioned backdrop-blur-none override", () => {
    expect(matchNames("backdrop-blur-2xl")).toContain("backdrop-blur (glass)");
    expect(matchNames("backdrop:backdrop-blur-sm")).toContain(
      "backdrop-blur (glass)",
    );
    expect(matchNames("backdrop:backdrop-blur-none")).toEqual([]);
  });

  it("flags the legacy hex family case-insensitively, not the accent", () => {
    expect(matchNames("text-[#8da5ff]")).toContain("legacy gray-blue raw hex");
    expect(matchNames("bg-[#6F91FF]")).toContain("legacy gray-blue raw hex");
    // The retired Protocol Desk accent is now itself a banned legacy hex.
    expect(matchNames("bg-[#3275F8]")).toContain(
      "retired Protocol Desk accent (#3275f8)",
    );
  });

  it("flags the retired cobalt accent family (tokens v2 law)", () => {
    expect(matchNames("bg-[#1f44ff]")).toContain(
      "retired cobalt accent (#1f44ff/#0a23b8)",
    );
    expect(matchNames("text-[#0A23B8]")).toContain(
      "retired cobalt accent (#1f44ff/#0a23b8)",
    );
    // The new accent is consumed as aliases, never as a raw hex.
    expect(matchNames("text-[var(--color-accent-primary)]")).toEqual([]);
    expect(matchNames("var(--vex-accent)")).toEqual([]);
  });

  it("flags the retired indigo/violet accent and raw pin/warn status hexes", () => {
    expect(matchNames("bg-[#6366f1]")).toContain("legacy indigo/violet accent");
    expect(matchNames("text-[#8B5CF6]")).toContain(
      "legacy indigo/violet accent",
    );
    expect(matchNames("text-[#ffd35c]")).toContain("raw pin/warn status hex");
    expect(matchNames("text-[#ffce5a]")).toContain("raw pin/warn status hex");
    expect(matchNames("text-[#f0a0a0]")).toContain("raw pin/warn status hex");
    // The accent root and the new semantic tokens are NOT raw-hex violations.
    expect(matchNames("text-[var(--vex-pin)]")).toEqual([]);
    expect(matchNames("text-[var(--vex-warn-text)]")).toEqual([]);
  });

  it("flags resting glow and shine chrome", () => {
    expect(matchNames("shadow-[0_0_80px_rgba(22,68,190,0.28)]")).toContain(
      "resting glow shadow",
    );
    expect(matchNames('import { ShinyText } from "x"')).toContain(
      "ShinyText chrome",
    );
    expect(matchNames("vex-shiny-text")).toContain("ShinyText chrome");
    // Directional hover shadows are not resting glow.
    expect(matchNames("shadow-[0_2px_8px]")).toEqual([]);
  });
});
