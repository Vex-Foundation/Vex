#!/usr/bin/env node
/**
 * Post-build CI smoke checks per skill §13 + plan §"Phase 1 acceptance gates".
 *
 * Run after `pnpm build` (or in CI release workflow). Asserts:
 *   1. dist/main/index.js exists and matches package.json `main` field.
 *   2. The privileged process bundles — preload exposure surface plus every
 *      emitted dist/main/*.js chunk (bundler-config regressions, bundled
 *      Postgres runtime, no bare `__filename`). Those live in
 *      scripts/check-privileged-bundles.mjs and run through this runner.
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
 *      (privacy hygiene for self-custodial wallet binary).
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
 *
 * Exit non-zero on any violation.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { privilegedBundleChecks } from "./check-privileged-bundles.mjs";

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
  // script-src and connect-src must remain EXACTLY ['self'].
  for (const name of ["script-src", "connect-src"]) {
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
// EMPTY registry: vex.jpg was the only pinned raster and the transcript now
// draws the inline `VexMark` SVG (UIUX round 2), so nothing is pinned today.
// Kept as the gate for the next raster brand asset - add its entry here and
// the matching copy step in copy-brand-assets.mjs together.
const BRAND_ASSETS = [];

await checkAsync("brand assets — exist, decode, dimensions, byte budget, no EXIF/IPTC/XMP", async () => {
  const issues = [];
  for (const expect of BRAND_ASSETS) {
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

// 9. Compose templates conform to skill §10
const composeTemplates = [
  path.join(root, "resources", "compose", "docker-compose.template.yml"),
  path.join(root, "resources", "compose", "docker-compose.e2e.yml"),
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

if (failures.length > 0) {
  console.log(`\n${RED}${failures.length} build artifact check(s) FAILED.${RESET}\n`);
  process.exit(1);
}
console.log(`\n${GREEN}All build artifact checks passed.${RESET}\n`);
