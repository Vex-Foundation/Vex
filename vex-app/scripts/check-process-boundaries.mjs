#!/usr/bin/env node
/**
 * Source-level process-boundary checks for the Electron app.
 *
 * This is intentionally a small repo-local gate, not a replacement for a
 * future ESLint/dependency-cruiser setup. It catches the highest-risk drift:
 * renderer importing privileged modules and shared importing runtime-specific
 * code.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const srcRoot = path.join(root, "src");
const rendererRoot = path.join(srcRoot, "renderer");
const sharedRoot = path.join(srcRoot, "shared");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "crypto",
  "dns",
  "fs",
  "http",
  "https",
  "net",
  "os",
  "path",
  "process",
  "readline",
  "stream",
  "tls",
  "tty",
  "url",
  "util",
  "worker_threads",
  "zlib",
]);

// Privileged repo-root trees reachable through build aliases. `@vex-lib`
// resolves to `../src/lib` (vite.renderer.config.ts / tsconfig.renderer.json),
// which contains wallet.ts, local-secret-vault.ts, secret-keys.ts,
// wallet-backup.ts and db/ — wallet/secret/db code that must never enter the
// untrusted renderer (nor `shared`, which bundles into it). `@vex-agent`
// (repo-root runtime engine) is main-process-only.
const rootLibDir = path.resolve(root, "..", "src", "lib");
const rootAgentDir = path.resolve(root, "..", "src", "vex-agent");

// The only `@vex-lib` modules the renderer/shared may import: deliberately
// pure, dependency-free constants/schemas with zero privileged imports
// (verified: agent-config, embedding-constants and token-metadata-text-policy
// import nothing; bug-report-schema imports only zod). Anything else fails the
// gate.
const PURE_VEX_LIB_MODULES = new Set([
  "@vex-lib/agent-config.js",
  "@vex-lib/embedding-constants.js",
  "@vex-lib/diagnostics/bug-report-schema.js",
  // Registers zod's English locale, which zod's own `sideEffects: false`
  // lets the bundler tree-shake away. Imports NOTHING but `zod`, exactly like
  // bug-report-schema above, and must stay ONE definition across the engine,
  // main, preload and renderer so all four report the same wording.
  "@vex-lib/zod-locale.js",
  // The on-chain token metadata text policy. It must be ONE definition across
  // the agent runtime, the IPC schema and the renderer form, and it is pure by
  // construction (no imports at all) so the renderer may hold it.
  "@vex-lib/token-metadata-text-policy.js",
  // The measured on-chain metadata length caps. Same reason and same purity as
  // the text policy above: one definition across the agent runtime, the IPC
  // schema and the renderer form, and it imports nothing at all.
  "@vex-lib/token-metadata-limits.js",
  // The canonical board contract (`src/lib/board/`). Same reason as the two
  // entries above: it must be ONE definition across the agent runtime that
  // composes a board, the shared message DTO that ships it, and the renderer
  // that draws it - two copies would drift into boards silently collapsing to
  // null in the DB mapper with no error anywhere. Pure by construction: zod
  // schemas and a text predicate, no privileged imports.
  "@vex-lib/board/index.js",
]);

function isForbiddenRootAliasImport(spec) {
  if (spec === "@vex-agent" || spec.startsWith("@vex-agent/")) return true;
  if (spec === "@vex-lib" || spec.startsWith("@vex-lib/")) {
    return !PURE_VEX_LIB_MODULES.has(spec);
  }
  return false;
}

const failures = [];

function collectFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "__tests__"
      ) {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(tsx?|mts|cts)$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function importSpecifiers(source) {
  const specs = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^"'()]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^"'()]+?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1];
      if (typeof spec === "string") specs.push(spec);
    }
  }
  return specs;
}

function isNodeBuiltin(spec) {
  if (spec.startsWith("node:")) return true;
  const first = spec.split("/")[0] ?? spec;
  return NODE_BUILTINS.has(first);
}

function resolveRelativeImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  return path.resolve(path.dirname(fromFile), spec);
}

function isInside(target, dir) {
  const rel = path.relative(dir, target);
  return rel.length === 0 || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function checkRendererFile(file) {
  const source = readFileSync(file, "utf8");
  for (const spec of importSpecifiers(source)) {
    const resolved = resolveRelativeImport(file, spec);
    const forbidden =
      spec === "electron" ||
      spec.startsWith("@main/") ||
      spec.startsWith("@preload/") ||
      isForbiddenRootAliasImport(spec) ||
      isNodeBuiltin(spec) ||
      (resolved !== null &&
        (isInside(resolved, path.join(srcRoot, "main")) ||
          isInside(resolved, path.join(srcRoot, "preload")) ||
          isInside(resolved, rootLibDir) ||
          isInside(resolved, rootAgentDir)));
    if (forbidden) {
      failures.push(
        `${path.relative(root, file)} imports privileged module "${spec}"`
      );
    }
  }
}

function checkSharedFile(file) {
  const source = readFileSync(file, "utf8");
  for (const spec of importSpecifiers(source)) {
    const resolved = resolveRelativeImport(file, spec);
    const forbidden =
      spec === "electron" ||
      spec === "react" ||
      spec.startsWith("@main/") ||
      spec.startsWith("@preload/") ||
      spec.startsWith("@renderer/") ||
      isForbiddenRootAliasImport(spec) ||
      isNodeBuiltin(spec) ||
      (resolved !== null &&
        (isInside(resolved, path.join(srcRoot, "main")) ||
          isInside(resolved, path.join(srcRoot, "preload")) ||
          isInside(resolved, path.join(srcRoot, "renderer")) ||
          isInside(resolved, rootLibDir) ||
          isInside(resolved, rootAgentDir)));
    if (forbidden) {
      failures.push(
        `${path.relative(root, file)} imports runtime-specific module "${spec}"`
      );
    }
  }
}

for (const file of collectFiles(rendererRoot)) {
  checkRendererFile(file);
}
for (const file of collectFiles(sharedRoot)) {
  checkSharedFile(file);
}

if (failures.length > 0) {
  console.log(`${RED}Process boundary check failed:${RESET}`);
  for (const failure of failures) {
    console.log(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(`${GREEN}Process boundary check passed.${RESET}`);
