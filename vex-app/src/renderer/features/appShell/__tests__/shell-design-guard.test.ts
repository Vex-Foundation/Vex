/**
 * Shell design-language guard — THE SIGNAL DESK (landing rebrand) stays
 * locked.
 *
 * The shell's visual law (globals.css `[data-vex-shell]` scope): the
 * projectvex.ai landing DNA on ink surfaces — depth is solid luminance +
 * hairlines, never glass or resting glow; one accent family (the landing
 * cobalt #1f44ff via the --vex-accent tokens) and ZERO raw legacy hexes;
 * no ShinyText gradient chrome. The only sanctioned gradient is the
 * `.vex-select-beam` utility (globals.css) — the landing's selected-item
 * beam. This test turns each law into a red build instead of a review
 * comment:
 *
 *   1. /backdrop-blur(?!-none)/ — no backdrop-filter glass anywhere in the
 *      shell. `backdrop-blur-none` is EXEMPT by the lookahead (the dialog
 *      base itself is blur-free since the rebrand).
 *   2. /ShinyText|vex-shiny-text/ — the shine chrome died in S7 (component
 *      + @keyframes deleted); nothing may re-import it.
 *   3. the legacy gray-blue hex family + the retired Protocol Desk accent
 *      #3275f8 — replaced by --vex-accent tokens rooted at #1f44ff.
 *   4. /shadow-\[0_0_/ — resting glow. Depth never comes from shadows
 *      (directional shadows and the select-beam's lit-item shadow live in
 *      globals.css, outside this scan by design).
 *
 * Scope: every non-test .ts/.tsx under features/appShell, plus the two
 * shared primitives the shell composes for popover/dialog chrome
 * (components/ui/dialog.tsx, components/ui/select-menu.tsx). Onboarding
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
  // shell. The new root #1f44ff lives ONLY in globals.css token definitions
  // (CSS files are out of this scan's scope) — components go through
  // var(--vex-accent*).
  { name: "retired Protocol Desk accent (#3275f8)", regex: /#3275f8/i },
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
      "ink (--vex-glass) with backdrop-blur over the Eclipse photo backdrop. " +
      "Glass is allowed ONLY on the two side rails.",
  },
  {
    file: "features/appShell/BookPanel.tsx",
    pattern: "backdrop-blur (glass)",
    reason:
      "User-sanctioned glass rail: the BOOK panel floats as translucent ink " +
      "(--vex-glass) with backdrop-blur over the Eclipse photo backdrop. " +
      "Glass is allowed ONLY on the two side rails.",
  },
  {
    // Owner-decreed THIRD sanctioned glass surface (Signal Console redesign):
    // the composer floats over the Eclipse backdrop exactly like the two rails, so
    // it wears the same translucent ink (--vex-glass / --vex-glass-strong on
    // focus) + backdrop-blur. This is the ONLY expansion of the glass law —
    // the guard still reddens on backdrop-blur ANYWHERE else in the shell.
    file: "features/appShell/SessionComposer.tsx",
    pattern: "backdrop-blur (glass)",
    reason:
      "Owner-sanctioned glass instrument: the Signal Console composer floats " +
      "as translucent ink (--vex-glass / --vex-glass-strong) with " +
      "backdrop-blur over the Eclipse photo backdrop, like the two rails. " +
      "Glass is allowed on the two side rails AND this composer — nowhere else.",
  },
  {
    // Owner decree 2026-07-20, Chronos glass law: every full-app ShellScreen
    // overlay (Memory / Sessions / How Vex works) is a floating glass
    // surface — ink glass + backdrop-blur for legibility over the Eclipse,
    // a static grain overlay (.vex-noise) on top. The prior DistortedGlass
    // SVG displacement filter is retired (it warped screen content).
    file: "features/appShell/screens/ShellScreen.tsx",
    pattern: "backdrop-blur (glass)",
    reason:
      "Owner-decreed Chronos glass surface (2026-07-20 law): the full-app " +
      "overlay screens float as translucent ink (--vex-glass-strong) with " +
      "backdrop-blur over the Eclipse backdrop, carrying a static grain " +
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
  {
    // Owner decree 2026-07-20, Chronos glass law: the shared Dialog base
    // (a shell primitive also scanned here) wears the same floating glass
    // chrome — every modal is a Chronos glass surface per the approved
    // Personalize mock.
    file: "components/ui/dialog.tsx",
    pattern: "backdrop-blur (glass)",
    reason:
      "Owner-decreed Chronos glass surface (2026-07-20 law): the Dialog " +
      "base is a floating glass panel (translucent ink + backdrop-blur + " +
      "grain, white/10 hairline, rounded-2xl). The ::backdrop dim itself " +
      "stays blur-free (backdrop:backdrop-blur-none).",
  },
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
      "backdrop-blur + static grain over the Eclipse backdrop, via this " +
      "one card chrome that every card composes.",
  },
  {
    // Owner decree 2026-07-21: the starter chips row under the Signal
    // Console needs a legibility assist over the bright regions of the
    // Eclipse sky, so it joins the Chronos glass family as a slim
    // pill-band (lighter furniture than a card) — translucent ink
    // (--vex-rail) + backdrop-blur + a --vex-line hairline, rounded-2xl to
    // harmonize with the console pill above it. Full sanctioned glass
    // roster after this entry: the two side rails, the composer, the
    // ShellScreen overlays, the profile menu, the Dialog base, the
    // portfolio cards, and this quick-actions chip row — nowhere else.
    file: "features/appShell/ComposerQuickActions.tsx",
    pattern: "backdrop-blur (glass)",
    reason:
      "Owner-decreed glass legibility assist (2026-07-21): the starter " +
      "chips row wears translucent ink (--vex-rail) with backdrop-blur + " +
      "a --vex-line hairline as a slim pill-band, so the chips stay " +
      "readable over bright regions of the Eclipse backdrop — matching " +
      "the Chronos glass family used by the console pill and portfolio " +
      "cards.",
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
    // #1f44ff is the accent ROOT — it lives in globals.css token definitions
    // and is not part of this hex ban (CSS is out of scope here).
    expect(matchNames("#1f44ff")).toEqual([]);
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
    expect(matchNames("#1f44ff")).toEqual([]);
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
