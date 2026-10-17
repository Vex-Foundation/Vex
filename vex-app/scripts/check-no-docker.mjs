#!/usr/bin/env node
/**
 * The no-Docker ratchet: Vex must install and run with nothing but itself, so
 * no shipped code may come to depend on Docker again.
 *
 * WHAT IT COUNTS — per file, in everything that ships:
 *   vex-app/src (main, preload, renderer, shared, pty-host), vex-app/resources
 *   and the agent engine under ../src, tests and e2e excluded. A "reference" is
 *   any mention of `docker` (CLI, socket, `com.docker`, `vex:docker:` channels,
 *   `features/docker`, `docker compose` copy) or `testcontainers`, plus every
 *   import from the Docker-only compose module (`.../compose/...`).
 *
 * THE RATCHET — `no-docker-baseline.json` records today's count per file:
 *   - a file not in the baseline that has a reference, or a file whose count
 *     grew, FAILS: that is new Docker reachability;
 *   - a file whose count dropped, or that no longer exists, also FAILS until
 *     `pnpm run check:no-docker:update` records the smaller baseline, so the
 *     list only ever shrinks and stays an honest inventory of what is left;
 *   - `--update` refuses to record growth. Growth needs a reviewed hand edit.
 *
 * The baseline starts as today's Docker inventory and must reach {} once the
 * Docker provider and the migration path from Docker are deleted.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "..");
const baselinePath = path.join(appRoot, "no-docker-baseline.json");

const ROOTS = [
  path.join(appRoot, "src"),
  path.join(appRoot, "resources"),
  path.join(repoRoot, "src"),
];
const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".yml", ".yaml", ".html", ".css", ".sh"]);
const SKIP_DIRS = new Set(["__tests__", "node_modules", "dist", "e2e", "__fixtures__"]);
const isTestFile = (name) => /\.(test|spec|int\.test)\.[cm]?[jt]sx?$/.test(name);

const MENTION = /docker|testcontainers/gi;
const COMPOSE_IMPORT = /["'](?:\.{1,2}\/)+(?:[\w-]+\/)*compose\/[\w./-]+["']/g;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name)) && !isTestFile(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

function currentCounts() {
  const counts = {};
  for (const root of ROOTS) {
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`scan root missing: ${root}`);
    }
    for (const file of walk(root)) {
      const text = readFileSync(file, "utf8");
      const n = (text.match(MENTION)?.length ?? 0) + (text.match(COMPOSE_IMPORT)?.length ?? 0);
      if (n > 0) counts[path.relative(repoRoot, file).split(path.sep).join("/")] = n;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function readBaseline() {
  if (!existsSync(baselinePath)) return null;
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || typeof parsed.files !== "object") {
    throw new Error(`${baselinePath} is not a { files: { path: count } } baseline`);
  }
  return parsed.files;
}

const update = process.argv.includes("--update");
const current = currentCounts();
const baseline = readBaseline();

const grown = [];
const shrunk = [];
for (const [file, n] of Object.entries(current)) {
  const was = baseline?.[file] ?? 0;
  if (n > was) grown.push(`${file}: ${was} -> ${n}`);
  else if (n < was) shrunk.push(`${file}: ${was} -> ${n}`);
}
for (const [file, was] of Object.entries(baseline ?? {})) {
  if (!(file in current)) shrunk.push(`${file}: ${was} -> 0`);
}

if (update) {
  if (baseline !== null && grown.length > 0) {
    console.error(`${RED}Refusing to record new Docker references:${RESET}\n  ${grown.join("\n  ")}`);
    process.exit(1);
  }
  writeFileSync(baselinePath, `${JSON.stringify({ files: current }, null, 2)}\n`);
  const total = Object.values(current).reduce((s, n) => s + n, 0);
  console.log(`${GREEN}Recorded ${total} Docker reference(s) in ${Object.keys(current).length} file(s).${RESET}`);
  process.exit(0);
}

if (baseline === null) {
  console.error(`${RED}No ${path.basename(baselinePath)}; run pnpm run check:no-docker:update.${RESET}`);
  process.exit(1);
}
if (grown.length > 0) {
  console.error(
    `${RED}New Docker references in shipped code (Vex must not depend on Docker):${RESET}\n  ${grown.join("\n  ")}`,
  );
  process.exit(1);
}
if (shrunk.length > 0) {
  console.error(
    `${YELLOW}Docker references were removed; record the smaller baseline with ` +
      `pnpm run check:no-docker:update:${RESET}\n  ${shrunk.join("\n  ")}`,
  );
  process.exit(1);
}
const total = Object.values(current).reduce((s, n) => s + n, 0);
console.log(`${GREEN}✓ No-Docker ratchet green — ${total} known reference(s) in ${Object.keys(current).length} file(s).${RESET}`);
