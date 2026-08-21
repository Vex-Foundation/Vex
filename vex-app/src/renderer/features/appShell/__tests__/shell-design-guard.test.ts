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
 *   5. theme-blind `white`/`black` utilities (round 2, owner QA 2026-08-21).
 *      A `bg-white/[0.04]` hover or a `text-white` glyph describes a colour,
 *      not a role, so it can only be right in ONE theme. Every such site in
 *      the shell was migrated to the alias families, so the whitelist for
 *      this pair is intentionally EMPTY.
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
  // UIUX round 2 (owner QA 2026-08-21): a `white`/`black` Tailwind colour is
  // theme-BLIND - it says nothing about the surface under it, so a
  // `hover:bg-white/[0.05]` hover or a `bg-white/[0.02]` plate that reads on
  // chronos is invisible on celeris, and a `text-white` glyph on the chronos
  // accent (light blue-400) lands near 2:1. The theme-aware families are
  // `interactive-hover`/`interactive-active` (washes), `surface-*` (plates),
  // `line-*` (strokes) and `ink-on-accent`/`ink-on-primary`/`ink-on-chrome`
  // (text painted on a known fill). The alpha forms are covered by the same
  // pattern: `bg-white/[0.05]` matches on the utility, not the value.
  {
    name: "theme-blind white literal",
    regex:
      /(?<![\w-])(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|caret|decoration|placeholder|accent|shadow)-white(?![\w-])/,
  },
  {
    name: "theme-blind black literal",
    regex:
      /(?<![\w-])(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|caret|decoration|placeholder|accent|shadow)-black(?![\w-])/,
  },
  // R2-C Doto register (2026-08-21): `.vex-doto-label` in landing-motifs.css is
  // now the ONLY sanctioned way to set Doto in the shell. It owns the measured
  // floor (12px / weight 600 / tracking <= 0.16em / tabular-nums) that ~70
  // ad-hoc `font-doto` call sites had drifted below (8-11px at weight 400),
  // which the owner's QA read as invisible in both themes. The raw Tailwind
  // utility carries no floor, so re-introducing it is a red build - migrate the
  // call site to the class instead of whitelisting.
  { name: "bare font-doto utility (use .vex-doto-label)", regex: /\bfont-doto\b/ },
  // The class sets no color on purpose (this sheet is unlayered and would beat
  // the call site's `text-*` utility), so the floor TIER is enforced here:
  // Doto's dot glyphs discard roughly half a solid face's ink coverage, which
  // puts `text-ink-tertiary` and `text-ink-caption` below the readable
  // threshold for this face. `text-ink-secondary` is the floor. Variant-
  // prefixed tiers (`disabled:text-ink-tertiary`, `hover:...`) are EXEMPT by
  // the lookbehind - a receding disabled state is the correct use of tertiary.
  // Limitation: the scan is per class string, so it catches the common
  // single-literal case, not a tier assembled across a conditional expression.
  {
    name: "Doto label below the ink-secondary floor tier",
    regex:
      /vex-doto-label[^"'`]*(?<![:-])text-ink-(?:tertiary|caption)|(?<![:-])text-ink-(?:tertiary|caption)[^"'`]*vex-doto-label/,
  },
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
  // ── TEMPORARY, wave-scoped (R2-C, 2026-08-21) ──────────────────────────
  // The Doto register migrated ~70 shell call sites to `.vex-doto-label`. The
  // composer's two remaining sites are the ONE set this lane must not touch:
  // the conversation rework (wave 2) rebuilds those files wholesale, and an
  // edit here would collide with it. The class contract is published on the
  // round-2 board for that lane.
  // OWNER: wave-2 builder D1. REMOVAL CONDITION: delete both entries the
  // moment D1 lands the composer Doto sites on `.vex-doto-label` - the guard
  // then holds the register with no exemptions at all. These are the only two
  // sanctioned bare `font-doto` occurrences in the shell; do not add a third.
  {
    file: "features/appShell/SessionComposer.tsx",
    pattern: "bare font-doto utility (use .vex-doto-label)",
    reason:
      "Wave-2 handoff: the queue/steering badges (9px Doto) migrate with the " +
      "conversation rework, which owns this file. Temporary - remove with D1.",
  },
  {
    file: "features/appShell/SessionComposer/ComposerMissionStrip.tsx",
    pattern: "bare font-doto utility (use .vex-doto-label)",
    reason:
      "Wave-2 handoff: the mission strip label migrates with the conversation " +
      "rework, which owns the composer tree. Temporary - remove with D1.",
  },
  // REMOVED (rebrand phase 1, 2026-08-20): the Dialog base is a solid
  // layer-2 card on tokens v2 - its backdrop-blur exemption became inert
  // when the glass chrome retired, so the entry is deleted rather than
  // kept as a stale sanction.
  // REMOVED (rebrand phase 3, 2026-08-20): PortfolioCard is a solid
  // layer-1 card on tokens v2 (border + lv1 shadow) — its backdrop-blur
  // exemption became inert when the glass chrome retired, so the entry is
  // deleted rather than kept as a stale sanction. Glass remains sanctioned
  // ONLY on the two side rails, the ShellScreen overlays, and the profile
  // menu.
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

  it("flags theme-blind white/black utilities, in every alpha and variant form", () => {
    expect(matchNames("text-white")).toContain("theme-blind white literal");
    expect(matchNames("hover:bg-white/[0.05]")).toContain(
      "theme-blind white literal",
    );
    expect(matchNames("border-white/[0.08]")).toContain(
      "theme-blind white literal",
    );
    expect(matchNames("bg-black/70")).toContain("theme-blind black literal");
    expect(matchNames("text-black")).toContain("theme-blind black literal");
    // The theme-aware replacements are what the law asks for, so none of
    // them may trip the pattern - including the ink-on-* names that end in
    // a word the regex must not treat as the colour.
    for (const ok of [
      "bg-interactive-hover",
      "hover:bg-interactive-hover",
      "text-ink-on-accent",
      "bg-ink-on-accent",
      "text-ink-on-chrome",
      "border-line-2",
      "bg-mask-1",
      "bg-surface-1",
    ]) {
      expect(matchNames(ok)).toEqual([]);
    }
    // Prose in a file header is not a class: the pattern is anchored on the
    // utility prefix, so an ordinary hyphenated word does not trip it.
    expect(matchNames("an off-white plate, a coal-black rail")).toEqual([]);
  });

  it("flags the bare font-doto utility but not the sanctioned class", () => {
    expect(matchNames('className="font-doto text-[10px]"')).toContain(
      "bare font-doto utility (use .vex-doto-label)",
    );
    // The class is the sanctioned register; its name must not self-trigger.
    expect(matchNames('className="vex-doto-label uppercase"')).toEqual([]);
    expect(matchNames('className="vex-doto-label vex-doto-label--wide"')).toEqual(
      [],
    );
  });

  it("flags a Doto label below the ink-secondary floor tier, in either order", () => {
    expect(
      matchNames('className="vex-doto-label uppercase text-ink-tertiary"'),
    ).toContain("Doto label below the ink-secondary floor tier");
    expect(
      matchNames('className="text-ink-caption vex-doto-label uppercase"'),
    ).toContain("Doto label below the ink-secondary floor tier");
    // The floor tier itself is fine, as is a receding DISABLED/hover state.
    expect(
      matchNames('className="vex-doto-label uppercase text-ink-secondary"'),
    ).toEqual([]);
    expect(
      matchNames(
        'className="vex-doto-label text-accent-primary disabled:text-ink-tertiary"',
      ),
    ).toEqual([]);
    // A tertiary tier on a NON-Doto label is untouched by this rule.
    expect(matchNames('className="vex-micro text-ink-tertiary"')).toEqual([]);
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
