#!/usr/bin/env node
/**
 * Post-build CI smoke checks per skill §13 + plan §"Phase 1 acceptance gates".
 *
 * Run after `pnpm build` (or in CI release workflow). Asserts:
 *   1. dist/main/index.js exists and matches package.json `main` field.
 *   2. The privileged process bundles — preload exposure surface plus every
 *      emitted dist/main/*.js chunk (bundler-config regressions, bundled
 *      Postgres runtime, no bare `__filename`, zod's English locale surviving
 *      tree-shaking). Those live in scripts/check-privileged-bundles.mjs and
 *      run through this runner.
 *   3. dist/renderer/index.html has strict CSP — no `'unsafe-inline'`, no `'unsafe-eval'`,
 *      and `script-src`/`connect-src` parse to EXACTLY `'self'`. `img-src` is now
 *      pinned to EXACTLY `'self' data:` (remote images DISABLED for launch to
 *      close the img-src exfiltration channel — see docs/audit/vexapp-prerelease-audit.md
 *      finding W1); this gate fails if anyone re-widens it back to `https:`.
 *   4. dist/renderer/assets/*.js bundle has no `localStorage`/`sessionStorage`/`dangerouslySetInnerHTML`.
 *   5. Built CSP includes mandatory directives: default-src 'self', object-src 'none',
 *      base-uri 'none', frame-ancestors 'none', form-action 'none'.
 *   6. Brand assets in dist/renderer/ — exist, decode cleanly, match expected
 *      dimensions, fit byte budget, carry no EXIF/IPTC/XMP metadata
 *      (privacy hygiene for self-custodial wallet binary). An entry
 *      registered before its file exists (Kimm's art) is skipped while the
 *      file is absent from the renderer's public source and checked in full
 *      once it is there.
 *   7. Compiled CSS contains no bare `--color-*` references in property values
 *      (must be wrapped in `var(...)`). Catches Tailwind v4 arbitrary-value
 *      footgun: `text-[--color-foo]` compiles to `color:--color-foo` (broken)
 *      instead of `color:var(--color-foo)`. Use `text-[var(--color-foo)]` or
 *      a semantic alias.
 *   8. Renderer source must not use the bare Tailwind arbitrary-color syntax
 *      `[--color-x]`. Required form: semantic alias (`bg-card`, `text-success`)
 *      or explicit `[var(--color-x)]`. Catches regressions BEFORE build.
 *   9. Compose templates pin every image by sha256 digest (skill §10), bind
 *      every published port to host_ip 127.0.0.1, and leave no
 *      `REPLACE_WITH_VERIFIED_DIGEST_BEFORE_FIRST_RUN` placeholders behind.
 *   10. Packaged migration resources are byte-for-byte in sync with the
 *      canonical `src/vex-agent/db/migrations/` source.
 *   11. Studio highlight worker (3b): the built CSP pins `worker-src` to
 *      exactly `'self'`, and whenever the renderer bundle can actually REACH
 *      the highlighter port, a `highlight.worker-<hash>.js` chunk exists in
 *      dist/renderer/assets/. Conditional on reachability on purpose: the
 *      Studio surface is not mounted in the shell until stage B4, and a gate
 *      that demanded the chunk today would fail every build while a gate that
 *      merely skipped it would still be off when B4 lands. This one ARMS
 *      ITSELF the moment the port enters the module graph.
 *   12. Lighter signer helper resources exist for every supported packaged
 *      Electron platform/arch pair, so live order signing cannot ship without
 *      its privileged helper.
 *   13. The native runtime lock (native-runtime.lock.json) is well formed and
 *      pins every target the app packages.
 *   14. The H3 shell harness (src/renderer/dev/h3-shell/, its fixtures and
 *      the stand-in art under standins/) never ships: no module outside the
 *      harness imports it, and nothing of it reaches dist/ - not by path, not
 *      as a byte-identical copy, not by an emitted asset name, not under the
 *      stand-ins' `kimm-standin-*` name, and not as bundled code carrying the
 *      harness's marks.
 *
 * Exit non-zero on any violation.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  evaluateHighlightWorkerBundle,
  privilegedBundleChecks,
} from "./check-privileged-bundles.mjs";
import { nativeArtifactChecks } from "./check-native-artifacts.mjs";
import { brandAssetPlan, KIMM_BRAND_ASSETS } from "./kimm-brand-assets.mjs";
import {
  builtLighterSignerDir,
  evaluateBuiltLighterSigners,
} from "./lighter-signer-artifact.mjs";
import { NATIVE_RUNTIME_TARGETS, readNativeRuntimeLock } from "./native-runtime-artifact.mjs";

const root = path.resolve(process.cwd());
const distRendererHtml = path.join(root, "dist", "renderer", "index.html");
const distRendererAssets = path.join(root, "dist", "renderer", "assets");
const pkgJson = path.join(root, "package.json");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

const failures = [];

function check(label, fn) {
  try {
    fn();
    console.log(`${GREEN}✓${RESET} ${label}`);
  } catch (e) {
    console.log(`${RED}✗${RESET} ${label}`);
    console.log(`  ${e.message}`);
    failures.push({ label, message: e.message });
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`${GREEN}✓${RESET} ${label}`);
  } catch (e) {
    console.log(`${RED}✗${RESET} ${label}`);
    console.log(`  ${e.message}`);
    failures.push({ label, message: e.message });
  }
}

// 1. main entrypoint
check("package.json `main` resolves to existing file", () => {
  const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
  if (!pkg.main) throw new Error("package.json missing `main` field");
  const resolved = path.join(root, pkg.main);
  if (!existsSync(resolved)) {
    throw new Error(`package.json main = "${pkg.main}" but file not found at ${resolved}`);
  }
});

// 2. privileged process bundles (dist/main/*.js + dist/preload/index.cjs)
for (const { label, run } of privilegedBundleChecks) {
  check(label, () => run(root));
}

// 2b. Vex Studio pty-host bundle + the native runtime dependencies it needs
// (node-pty, @parcel/watcher): present, right architecture, unpacked from the
// asar by both electron-builder profiles. Lives in check-native-artifacts.mjs.
for (const { label, run } of nativeArtifactChecks) {
  check(label, () => run(root));
}

// 3. renderer CSP
check("renderer index.html CSP — no unsafe-inline / unsafe-eval", () => {
  if (!existsSync(distRendererHtml)) throw new Error(`missing: ${distRendererHtml}`);
  const html = readFileSync(distRendererHtml, "utf8");
  // Multiline-tolerant regex: <meta ... http-equiv="CSP" ... content="...">
  // CSP can contain single quotes (e.g. 'self'), so the capture group must
  // stop only on the surrounding double quote. We anchor the surrounding
  // attribute quote to ".
  const cspMatch = html.match(/<meta\b[^>]*?http-equiv="Content-Security-Policy"[^>]*?content="([^"]+)"/is);
  if (!cspMatch) {
    throw new Error("no Content-Security-Policy <meta> tag found");
  }
  const csp = cspMatch[1];
  if (csp.includes("'unsafe-inline'") || csp.includes('"unsafe-inline"')) {
    throw new Error(`CSP contains 'unsafe-inline': ${csp}`);
  }
  if (csp.includes("'unsafe-eval'") || csp.includes('"unsafe-eval"')) {
    throw new Error(`CSP contains 'unsafe-eval': ${csp}`);
  }
  // Mandatory hardening directives
  const required = [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ];
  for (const directive of required) {
    if (!csp.includes(directive)) {
      throw new Error(`CSP missing required directive: ${directive}`);
    }
  }

  // Parse directives so the script/connect strictness check is exact — a
  // substring scan would let `connect-src 'self' https://evil` slip past.
  // Split on `;`, then split each directive into name + source tokens.
  const directives = new Map();
  for (const part of csp.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    directives.set(tokens[0], tokens.slice(1));
  }
  // script-src, connect-src and worker-src must remain EXACTLY ['self'].
  //
  // worker-src is spelled out rather than inherited from default-src because
  // the Studio file viewer runs shiki in a module worker, and the directive
  // that governs it is the one that must be pinned: `blob:` here would be a way
  // to run code that `script-src 'self'` alone refuses.
  for (const name of ["script-src", "connect-src", "worker-src"]) {
    const sources = directives.get(name);
    if (!sources) {
      throw new Error(`CSP missing required directive: ${name} 'self'`);
    }
    if (sources.length !== 1 || sources[0] !== "'self'") {
      throw new Error(
        `CSP ${name} must be exactly 'self' (found: ${name} ${sources.join(" ")})`
      );
    }
  }
  // img-src must be EXACTLY `'self' data:` — remote images are disabled for
  // launch to close the img-src exfiltration channel. If anyone re-widens it
  // (e.g. back to `https:`), this gate fails. Compare as sorted source sets so
  // ordering does not matter.
  {
    const sources = directives.get("img-src");
    if (!sources) {
      throw new Error("CSP missing required directive: img-src 'self' data:");
    }
    const expected = ["'self'", "data:"].slice().sort();
    const actual = sources.slice().sort();
    if (
      actual.length !== expected.length ||
      actual.some((src, i) => src !== expected[i])
    ) {
      throw new Error(
        `CSP img-src must be exactly 'self' data: (found: img-src ${sources.join(" ")})`
      );
    }
  }
});

// 3b. Studio highlight worker: the CSP directive that governs it, and the
// chunk itself once anything in the renderer can reach it. Pure predicate in
// check-privileged-bundles.mjs so its RED cases are provable on synthetic
// input (src/main/__tests__/highlight-worker-bundle-gate.test.ts).
check("renderer highlight worker - worker-src pinned + chunk emitted when reachable", () => {
  if (!existsSync(distRendererHtml)) throw new Error(`missing: ${distRendererHtml}`);
  const html = readFileSync(distRendererHtml, "utf8");
  const cspMatch = html.match(/<meta\b[^>]*?http-equiv="Content-Security-Policy"[^>]*?content="([^"]+)"/is);
  if (!cspMatch) throw new Error("no Content-Security-Policy <meta> tag found");
  if (!existsSync(distRendererAssets)) throw new Error(`missing: ${distRendererAssets}`);

  const assetFileNames = readdirSync(distRendererAssets);
  const bundleSources = assetFileNames
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(path.join(distRendererAssets, name), "utf8"));

  const verdict = evaluateHighlightWorkerBundle({
    csp: cspMatch[1],
    assetFileNames,
    bundleSources,
  });
  if (!verdict.ok) {
    throw new Error(`Highlight worker violations:\n    ${verdict.violations.join("\n    ")}`);
  }
});

// 4. renderer source hygiene (NOT built bundle — React's own API definitions
// would always trip a built-bundle scan for `dangerouslySetInnerHTML`).
check("renderer source — no localStorage/sessionStorage/dangerouslySetInnerHTML/eval in our code", () => {
  const srcDir = path.join(root, "src", "renderer");
  if (!existsSync(srcDir)) throw new Error(`missing: ${srcDir}`);
  // The pre-paint theme stamp reads (never writes) the Zustand persist
  // payload before the bundle loads; CSP forbids inlining it. This is the
  // ONE sanctioned localStorage reader outside the persist middleware.
  const SANCTIONED_LOCALSTORAGE_FILES = new Set([
    path.join(srcDir, "public", "theme-boot.js"),
  ]);
  const violations = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (
          ent.name === "node_modules" ||
          ent.name === "test" ||
          ent.name === "__tests__"
        ) {
          continue;
        }
        walk(full);
      } else if (/\.(tsx?|jsx?|mts|cts)$/.test(ent.name)) {
        const src = readFileSync(full, "utf8");
        if (
          /\blocalStorage\.(setItem|getItem|removeItem)\b/.test(src) &&
          !SANCTIONED_LOCALSTORAGE_FILES.has(full)
        ) {
          violations.push(`${full}: uses localStorage (allowed only via Zustand persist whitelist)`);
        }
        // The icon library left with the rebrand (F6): components/icons/
        // glyphs is the only icon source. components.json still says
        // "iconLibrary": "lucide" (fixed shadcn vocabulary), so this gate is
        // what turns an accidental `shadcn add` re-import into a red build.
        if (/from\s+["']lucide-react["']/.test(src)) {
          violations.push(`${full}: imports lucide-react (removed in the rebrand; use components/icons glyphs)`);
        }
        if (/\bsessionStorage\.(setItem|getItem|removeItem)\b/.test(src)) {
          violations.push(`${full}: uses sessionStorage (forbidden)`);
        }
        // JSX attribute use only (not React's internal definition).
        if (/\bdangerouslySetInnerHTML\s*=/.test(src)) {
          violations.push(`${full}: uses dangerouslySetInnerHTML JSX attribute (forbidden)`);
        }
        if (/\beval\s*\(/.test(src)) {
          violations.push(`${full}: contains eval()`);
        }
      }
    }
  };
  walk(srcDir);
  if (violations.length > 0) {
    throw new Error(`Renderer source violations:\n    ${violations.join("\n    ")}`);
  }
});

// 6. brand assets — exist, decode, expected dimensions, byte budget, no EXIF
// vex.jpg was the only pinned raster until the transcript drew the inline
// `VexMark` SVG (UIUX round 2). A re-encoded brand asset takes its entry here
// and the matching copy step in copy-brand-assets.mjs together.
//
// Kimm's art (H3, plan rows S4-01 and S4-18) arrives from the designer byte
// for byte into src/renderer/public/art/kimm/, with no copy step. Its entries
// are registered before the files exist (`awaited`, kimm-brand-assets.mjs,
// where the budgets and their reasons are): absent from the public source,
// an entry is reported and skipped; present, it is checked in full, and its
// width and height must be pinned there first.
const BRAND_ASSETS = [...KIMM_BRAND_ASSETS];
const RENDERER_PUBLIC_DIR = path.join(root, "src", "renderer", "public");

await checkAsync("brand assets — exist, decode, dimensions, byte budget, no EXIF/IPTC/XMP", async () => {
  const issues = [];
  const awaiting = [];
  for (const expect of BRAND_ASSETS) {
    const plan = brandAssetPlan(expect, RENDERER_PUBLIC_DIR);
    if (plan === "awaiting") {
      awaiting.push(expect.file);
      continue;
    }
    if (plan === "unpinned") {
      issues.push(`${expect.file}: arrived, but its width and height are not pinned in the registry`);
      continue;
    }
    const full = path.join(root, "dist", "renderer", expect.file);
    if (!existsSync(full)) {
      issues.push(`${expect.file}: missing in dist/renderer/`);
      continue;
    }
    const size = statSync(full).size;
    if (size > expect.maxBytes) {
      issues.push(`${expect.file}: ${size} bytes exceeds budget ${expect.maxBytes}`);
    }
    let meta;
    try {
      meta = await sharp(full).metadata();
    } catch (e) {
      issues.push(`${expect.file}: cannot decode (${e.message})`);
      continue;
    }
    if (meta.format !== expect.format) {
      issues.push(`${expect.file}: format ${meta.format}, expected ${expect.format}`);
    }
    if (meta.width !== expect.width || meta.height !== expect.height) {
      issues.push(
        `${expect.file}: ${meta.width}x${meta.height}, expected ${expect.width}x${expect.height}`
      );
    }
    if (meta.exif) issues.push(`${expect.file}: carries EXIF metadata`);
    if (meta.iptc) issues.push(`${expect.file}: carries IPTC metadata`);
    if (meta.xmp) issues.push(`${expect.file}: carries XMP metadata`);
  }
  // Said, not hidden: a skipped entry shows in every build log until its file
  // lands.
  for (const file of awaiting) console.log(`    awaited, not in the source yet: ${file}`);
  if (issues.length > 0) {
    throw new Error(`Brand asset issues:\n    ${issues.join("\n    ")}`);
  }
});

// 7. compiled CSS must wrap `--color-*` references in `var(...)`.
// First gate #7 used `\b--color-` which never matches (both sides are non-word
// characters, so the boundary never fires) — codex 2026-05-08 turn 2. Replaced
// with a declaration-position scan: find every `--color-x` occurrence in
// VALUE context (after a `:` within the same declaration) that is NOT
// wrapped in `var(...)`.
check("renderer CSS - xterm's own layout sheet reached the bundle", () => {
  // A REGRESSION GUARD for a dependency nothing else can see. xterm positions
  // its screen, helper textarea and measure element from its own stylesheet;
  // without it `Terminal.open()` builds a stack of unpositioned divs and the
  // Studio terminal renders as a blank pane. That sheet reaches the bundle
  // through ONE `@import` at the top of `styles/global-css/terminal.css`, and
  // an `@import` is only valid at the top of its sheet - so an edit that adds a
  // rule above it, or moves it, turns it into dead text rather than an error.
  // No test can catch that: the failure is invisible in jsdom (which applies no
  // stylesheets) and invisible in source (the line is still there). Only the
  // built artifact shows it.
  if (!existsSync(distRendererAssets)) {
    throw new Error(`missing assets dir: ${distRendererAssets}`);
  }
  const cssFiles = readdirSync(distRendererAssets).filter((f) => f.endsWith(".css"));
  const css = cssFiles
    .map((file) => readFileSync(path.join(distRendererAssets, file), "utf8"))
    .join("\n");
  // Selectors xterm's sheet owns and nothing in this repo defines (read from
  // node_modules/@xterm/xterm/css/xterm.css, not guessed), so their
  // presence can only mean the vendor rules are actually in the bundle.
  const required = [".xterm-screen", ".xterm-helper-textarea", ".xterm-char-measure-element"];
  const missing = required.filter((selector) => !css.includes(selector));
  if (missing.length > 0) {
    throw new Error(
      `xterm stylesheet missing from the renderer bundle (no ${missing.join(", ")}). ` +
        `Keep \`@import "@xterm/xterm/css/xterm.css"\` as the FIRST rule of src/renderer/styles/global-css/terminal.css.`
    );
  }
});

check("renderer CSS — no bare --color-* references (must be wrapped in var(...))", () => {
  if (!existsSync(distRendererAssets)) {
    throw new Error(`missing assets dir: ${distRendererAssets}`);
  }
  const cssFiles = readdirSync(distRendererAssets).filter((f) => f.endsWith(".css"));
  if (cssFiles.length === 0) {
    throw new Error(`no compiled CSS in ${distRendererAssets}`);
  }
  const violations = [];
  for (const file of cssFiles) {
    const raw = readFileSync(path.join(distRendererAssets, file), "utf8");
    // Strip block comments first.
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    const bare = [];
    for (const m of css.matchAll(/--color-[a-z][a-z0-9-]*/g)) {
      const idx = m.index;
      // Reject when wrapped in `var(` — both literal (declarations) and
      // backslash-escaped (CSS class selectors generated by Tailwind for
      // arbitrary values like `.text-\[var\(--color-x\)\]`).
      if (idx >= 4 && css.slice(idx - 4, idx) === "var(") continue;
      if (idx >= 5 && css.slice(idx - 5, idx) === "var\\(") continue;
      // Selectors live before `{`. If the next significant char going
      // forward is `{` (rule open), this `--color-x` is part of a selector
      // class name (e.g. Tailwind's escaped arbitrary-value class), not a
      // declaration value. Declarations end in `;` or `}`.
      let inSelector = false;
      for (let i = idx; i < css.length; i += 1) {
        const ch = css[i];
        if (ch === ";" || ch === "}") break;
        if (ch === "{") {
          inSelector = true;
          break;
        }
      }
      if (inSelector) continue;
      // Walk back to nearest declaration boundary to determine if this
      // occurrence is a custom-property NAME (left of `:`) or a VALUE
      // reference (right of `:` / inside a function arg).
      let context = "name";
      for (let i = idx - 1; i >= 0; i -= 1) {
        const ch = css[i];
        if (ch === ";" || ch === "{" || ch === "}") break;
        if (ch === ":" || ch === "," || ch === "(") {
          context = "value";
          break;
        }
      }
      if (context === "value") bare.push(m[0]);
    }
    if (bare.length > 0) {
      const sample = bare.slice(0, 5).join(", ");
      violations.push(`${file}: ${bare.length} bare --color refs (${sample})`);
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `Bare --color refs (use var(--color-x) or semantic alias):\n    ${violations.join("\n    ")}`
    );
  }
});

// 8. renderer source must NOT use the Tailwind v4 bare arbitrary-color syntax
// `text-[--color-x]` / `bg-[--color-x]` / etc. Required form is either a
// semantic alias (`text-foreground`, `bg-card`, `bg-success`) or an explicit
// `[var(--color-x)]` wrapper. Catches the regression class BEFORE build —
// gate #7 above is the dist-side safety net.
check("renderer source — no bare `*-[--color-*]` Tailwind arbitrary syntax", () => {
  const srcDir = path.join(root, "src", "renderer");
  if (!existsSync(srcDir)) throw new Error(`missing: ${srcDir}`);
  const violations = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (
          ent.name === "node_modules" ||
          ent.name === "test" ||
          ent.name === "__tests__"
        ) {
          continue;
        }
        walk(full);
      } else if (/\.(tsx?|jsx?|css)$/.test(ent.name)) {
        const src = readFileSync(full, "utf8");
        // Match `[--color-x]` NOT preceded by `[var(`.
        const re = /\[--color-[a-z][a-z0-9-]*\]/g;
        const hits = [];
        for (const m of src.matchAll(re)) {
          // Allow `[var(--color-x)]` — the bracket pair would be `[var(...`,
          // not `[--color-`, so the pattern above already excludes it.
          hits.push(m[0]);
        }
        if (hits.length > 0) {
          const sample = hits.slice(0, 3).join(", ");
          violations.push(
            `${path.relative(root, full)}: ${hits.length} bare arbitrary refs (${sample}) — use semantic alias or [var(...)]`
          );
        }
      }
    }
  };
  walk(srcDir);
  if (violations.length > 0) {
    throw new Error(`Bare Tailwind arbitrary refs:\n    ${violations.join("\n    ")}`);
  }
});

// 9. Compose templates conform to skill §10. The one template left is the
// previous release's stack, which the Docker-to-native migration renders to
// read that install's data.
const composeTemplates = [
  path.join(root, "resources", "compose", "docker-compose.template.yml"),
];

check("compose templates — sha256 digest pinning + host_ip 127.0.0.1", () => {
  const issues = [];
  // Real (non-placeholder) sha256 hex must be exactly 64 lowercase hex chars.
  const realDigestRe = /@sha256:([0-9a-f]{64})\b/;
  // Codex turn 5 RED #1: gate rejects the placeholder string outright.
  // Operator workflow: `docker pull pgvector/pgvector:<TAG>` then
  // `docker inspect --format '{{index .RepoDigests 0}}' pgvector/pgvector:<TAG>`
  // to capture the real `@sha256:<hex>`, then commit the change.
  const placeholder = "REPLACE_WITH_VERIFIED_DIGEST_BEFORE_FIRST_RUN";

  for (const file of composeTemplates) {
    if (!existsSync(file)) {
      issues.push(`${path.relative(root, file)}: missing`);
      continue;
    }
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");

    // Every `image:` line must include a real @sha256:<64-hex> digest.
    // Placeholder is rejected outright (release-blocking per skill §10/§14).
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const match = line.match(/^\s*image:\s*(\S+)/);
      if (!match) continue;
      const value = match[1] ?? "";
      if (value.includes(placeholder)) {
        issues.push(
          `${path.relative(root, file)}:${i + 1}: image still contains placeholder; run \`docker pull <tag>\` + \`docker inspect --format '{{index .RepoDigests 0}}'\` and commit the real @sha256:<hex>`
        );
        continue;
      }
      if (!realDigestRe.test(value)) {
        issues.push(
          `${path.relative(root, file)}:${i + 1}: image must pin @sha256:<64-hex> (skill §10 — release-blocking)`
        );
      }
    }

    // Every `- target:` (long-form port mapping) must have a matching
    // `host_ip: 127.0.0.1` line within the same entry. Count globally —
    // YAML port blocks can't legitimately have one without the other in
    // our convention.
    const targetCount = (content.match(/^\s*-\s+target:/gm) ?? []).length;
    const loopbackCount = (content.match(/^\s*host_ip:\s*127\.0\.0\.1\s*$/gm) ?? []).length;
    if (targetCount !== loopbackCount) {
      issues.push(
        `${path.relative(root, file)}: long-form port mapping count (${targetCount}) does not match host_ip: 127.0.0.1 count (${loopbackCount})`
      );
    }
    // Reject short-form `"<host>:<container>"` port lists — they bypass
    // the host_ip check entirely and would expose services on 0.0.0.0
    // by default on Linux.
    const shortForm = content.match(/^\s*-\s+["'][^"']*:\d+["']\s*$/gm) ?? [];
    if (shortForm.length > 0) {
      issues.push(
        `${path.relative(root, file)}: ${shortForm.length} short-form port mapping(s); use long-form with host_ip: 127.0.0.1`
      );
    }
  }

  if (issues.length > 0) {
    throw new Error(`Compose template issues:\n    ${issues.join("\n    ")}`);
  }
});

// 10. Migration resources mirror the canonical vex-agent migrations.
check("migration resources — mirror canonical vex-agent migrations", () => {
  const repoRoot = path.resolve(root, "..");
  const srcDir = path.join(repoRoot, "src", "vex-agent", "db", "migrations");
  const destDir = path.join(root, "resources", "migrations");
  const isMigrationFile = (name) => name.endsWith(".sql") && /^\d{3}_/.test(name);
  const hashFile = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

  if (!existsSync(srcDir)) throw new Error(`missing source migrations dir: ${srcDir}`);
  if (!existsSync(destDir)) throw new Error(`missing packaged migrations dir: ${destDir}`);

  const sourceNames = readdirSync(srcDir).filter(isMigrationFile).sort();
  const destNames = readdirSync(destDir).filter(isMigrationFile).sort();

  if (sourceNames.length === 0) {
    throw new Error(`no canonical migrations found in ${srcDir}`);
  }

  if (sourceNames.join("\n") !== destNames.join("\n")) {
    throw new Error(
      `packaged migration list differs from canonical source.\n` +
        `Run \`node scripts/copy-migrations.mjs\` from vex-app/ before building.`
    );
  }

  const mismatches = [];
  for (const name of sourceNames) {
    const sourceHash = hashFile(path.join(srcDir, name));
    const destHash = hashFile(path.join(destDir, name));
    if (sourceHash !== destHash) {
      mismatches.push(name);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `packaged migration content differs for: ${mismatches.join(", ")}.\n` +
        `Run \`node scripts/copy-migrations.mjs\` from vex-app/ before building.`
    );
  }
});

// 12. Lighter signer helper resources are built for every packaged target, and
//     are byte-for-byte the ones the pinned Go toolchain recorded.
check("lighter signer helpers - built, correct machine, digests match SHA256SUMS", () => {
  const { issues, verified } = evaluateBuiltLighterSigners(builtLighterSignerDir(root));
  if (issues.length > 0) {
    throw new Error(
      `Lighter signer helper issues:\n    ${issues.join("\n    ")}\n` +
        "Run `node ../scripts/build-lighter-signer-runtime.mjs` from vex-app/ with the pinned Go toolchain."
    );
  }
  // Printed, not just counted: the digests are the evidence that the shipped
  // signing helper came from the reviewed compiler and the committed module
  // graph, and a build log nobody can compare proves nothing later.
  for (const helper of verified) {
    console.log(`    ${helper.name} ${helper.format} sha256 ${helper.digest}`);
  }
});

// 13. The native runtime lock pins every target the app packages. A build
//     needs no network, so the trees themselves are fetched and verified by
//     the packaging preflight (prepackage:native-runtime) and the afterPack
//     gate; this is the part a build can own: a lock that is missing a target,
//     or whose digests are malformed, fails here rather than at release time.
check("native runtime lock - pins every packaged target", () => {
  const lock = readNativeRuntimeLock(root);
  for (const target of NATIVE_RUNTIME_TARGETS) {
    const entry = lock.targets[target.name];
    console.log(`    ${target.name} ${entry.asset} sha256 ${entry.sha256} tree ${entry.treeSha256} (${lock.release})`);
  }
});

// 14. THE H3 SHELL HARNESS NEVER SHIPS.
//
// `src/renderer/dev/h3-shell/` renders the real shell over a stand-in preload
// bridge and typed fixture data - a waiting swap for 200 USDC, a filled
// receipt, a Portfolio of sample balances - and, under standins/, crops of the
// mockup art used until the real art lands. All of it is dev scaffolding that
// `vite.h3-shell.config.ts` alone serves. A build that carried any of it would
// ship sample money figures beside real ones, which AGENTS.md forbids outright
// ("never present mocks, stubs, fake providers, or simulated proof as
// production behavior"), so the gate is two-sided:
//
//   a. SOURCE: no module outside the harness imports from it. This is the
//      gate that keeps the fixtures unimportable; tests are exempt, because a
//      test that reuses a fixture never reaches a bundle.
//   b. DIST: nothing of the harness is in dist/, by five independent tells -
//      a path segment (`h3-shell`, `standins`), a byte-identical copy of any
//      harness file (the stand-in art, a copied page or sheet), an emitted
//      asset named after a stand-in or harness asset (Vite's
//      `[name]-[hash][ext]`), the stand-ins' own `kimm-standin` name prefix
//      (which holds even for a crop re-encoded on its way into the bundle,
//      and even on a branch that does not carry the crops), and bundled code
//      or CSS carrying the harness's
//      marks. The marks are strings the harness keeps at RUNTIME, so they
//      survive minification where a comment would not: `vex-h3-shell-harness`
//      (`H3_HARNESS_MARK`, which the stand-in bridge and the fixtures carry)
//      and `__vexH3Harness` (the control surface's window property).
const H3_HARNESS_DIR = path.join(root, "src", "renderer", "dev", "h3-shell");
const H3_HARNESS_MARKS = ["vex-h3-shell-harness", "__vexH3Harness"];
const H3_DIST_SEGMENTS = new Set(["h3-shell", "standins"]);
// The stand-in art's own naming rule (standins/manifest.ts): every crop is
// `kimm-standin-*.webp` and sits above Vite's inline limit, so a build that
// reached one would emit `assets/kimm-standin-<hash>.webp`. Refused by prefix
// as well as by digest, so a re-encoded crop is caught too.
const H3_DIST_NAME_PREFIXES = ["kimm-standin"];
const CODE_EXTENSIONS = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/;
const TEXT_EXTENSIONS = /\.(m?js|cjs|css|html?|json|svg|txt|map|md)$/i;

function walkFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(full));
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

check("H3 shell harness - nothing outside the harness imports it", () => {
  const srcDir = path.join(root, "src");
  const rendererDir = path.join(srcDir, "renderer");
  // Every way a module names another one: static and type imports,
  // re-exports, dynamic import(), `new URL(..., import.meta.url)` and Vite's
  // import.meta.glob. Comments that mention the harness are not imports and
  // are not matched.
  const specifierRe =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|new\s+URL\(\s*|import\.meta\.glob\(\s*\[?\s*)["'`]([^"'`]+)["'`]/g;
  const violations = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === "__tests__" || ent.name === "test") continue;
        if (isInside(full, H3_HARNESS_DIR)) continue;
        walk(full);
      } else if (CODE_EXTENSIONS.test(ent.name) && !/\.test\.[cm]?[jt]sx?$/.test(ent.name)) {
        const src = readFileSync(full, "utf8");
        for (const m of src.matchAll(specifierRe)) {
          const spec = m[1];
          let target = null;
          if (spec.startsWith("./") || spec.startsWith("../")) target = path.resolve(path.dirname(full), spec);
          else if (spec.startsWith("@/")) target = path.resolve(rendererDir, spec.slice(2));
          else if (spec.startsWith("/")) target = path.resolve(rendererDir, spec.slice(1));
          if (target !== null && isInside(target, H3_HARNESS_DIR)) {
            violations.push(`${path.relative(root, full)}: imports "${spec}"`);
          }
        }
      }
    }
  };
  walk(srcDir);
  if (violations.length > 0) {
    throw new Error(
      `Production code reaches the H3 shell harness (its fixtures and stand-ins are dev-only):\n    ${violations.join("\n    ")}`
    );
  }
});

check("H3 shell harness - no harness file, fixture or stand-in art in dist/", () => {
  const distDir = path.join(root, "dist");
  if (!existsSync(distDir)) throw new Error(`missing: ${distDir}`);
  const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

  // What the harness is made of: the digest of every non-empty file (an empty
  // one would match every empty file in dist/), and the stems of the files a
  // bundler emits under their own name - the media, font and data files,
  // which is the stand-in art first of all. Code, sheets and pages are
  // renamed into chunks, so the marks below are what finds them.
  const harnessDigests = new Map();
  const assetStems = [];
  for (const file of existsSync(H3_HARNESS_DIR) ? walkFiles(H3_HARNESS_DIR) : []) {
    if (statSync(file).size > 0) harnessDigests.set(sha(file), path.relative(root, file));
    const base = path.basename(file);
    if (/\.(png|jpe?g|webp|avif|gif|svg|woff2?|ttf|otf|mp4|webm|json|bin)$/i.test(base)) {
      const ext = path.extname(base);
      assetStems.push({ stem: base.slice(0, base.length - ext.length), ext, source: path.relative(root, file) });
    }
  }

  const violations = [];
  for (const file of walkFiles(distDir)) {
    const rel = path.relative(distDir, file);
    const hit = rel.split(path.sep).find((segment) => H3_DIST_SEGMENTS.has(segment));
    if (hit !== undefined) violations.push(`dist/${rel}: a harness path ("${hit}")`);

    const base = path.basename(file);
    const prefix = H3_DIST_NAME_PREFIXES.find((p) => base.startsWith(p));
    if (prefix !== undefined) violations.push(`dist/${rel}: stand-in art by name ("${prefix}")`);
    for (const { stem, ext, source } of assetStems) {
      if (stem.length > 0 && base.endsWith(ext) && (base === `${stem}${ext}` || base.startsWith(`${stem}-`))) {
        violations.push(`dist/${rel}: emitted under the name of ${source}`);
      }
    }

    const copyOf = harnessDigests.get(sha(file));
    if (copyOf !== undefined) violations.push(`dist/${rel}: a byte-identical copy of ${copyOf}`);

    if (TEXT_EXTENSIONS.test(base)) {
      const text = readFileSync(file, "utf8");
      for (const mark of H3_HARNESS_MARKS) {
        if (text.includes(mark)) violations.push(`dist/${rel}: carries the harness mark "${mark}"`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`H3 shell harness reached the build:\n    ${violations.join("\n    ")}`);
  }
});

if (failures.length > 0) {
  console.log(`\n${RED}${failures.length} build artifact check(s) FAILED.${RESET}\n`);
  process.exit(1);
}
console.log(`\n${GREEN}All build artifact checks passed.${RESET}\n`);
