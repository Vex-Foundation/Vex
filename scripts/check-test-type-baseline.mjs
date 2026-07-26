#!/usr/bin/env node
/**
 * Root test-tree TypeScript diagnostic ratchet.
 *
 * `tsconfig.json` deliberately excludes `src/__tests__`; this script gives the
 * strict `tsconfig.test.json` project its own hard no-growth gate while its
 * historical debt is burned down. It is stricter than vex-app's older
 * file+code counter: every baseline entry also binds the normalized diagnostic
 * text and the hash of the source line that caused it. An old TS2345 therefore
 * cannot mask a new TS2345 in the same file.
 *
 * The baseline is created exactly once from a recorded compiler transcript:
 *
 *   node scripts/check-test-type-baseline.mjs --bootstrap \
 *     --diagnostics agents_dm/parked/typecheck-baseline/diagnostics.txt \
 *     --environment agents_dm/parked/typecheck-baseline/environment.txt
 *
 * Normal use is compare-only. New or grown diagnostics fail unless the exact
 * fingerprint has a reviewed, bounded entry in test-type-baseline-allowlist.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const configPath = path.join(repositoryRoot, "tsconfig.test.json");
const extendsConfigPath = path.join(repositoryRoot, "tsconfig.json");
const baselinePath = path.join(scriptDirectory, "test-type-baseline.json");
const allowlistPath = path.join(scriptDirectory, "test-type-baseline-allowlist.json");
const tscVersion = require("typescript/package.json").version;

const ERROR_MARKER = "): error TS";
const ERROR_LINE = /^(?<file>.+?)\((?<line>\d+),(?<column>\d+)\): error (?<code>TS\d+): (?<message>.+)$/;

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function fail(message) {
  console.error(`${RED}✗ ${message}${RESET}`);
  process.exit(1);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(file) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(repositoryRoot, file);
  const relative = path.relative(repositoryRoot, absolute).replaceAll("\\", "/");
  return relative.startsWith("../") ? absolute.replaceAll("\\", "/") : relative;
}

function normalizeMessage(message) {
  return message
    .replaceAll(repositoryRoot.replaceAll("\\", "/"), "<repo>")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceLineFingerprint(file, line) {
  const absolute = path.isAbsolute(file) ? file : path.join(repositoryRoot, file);
  if (!existsSync(absolute)) fail(`diagnostic references a missing source file: ${file}`);
  const sourceLine = readFileSync(absolute, "utf8").split(/\r?\n/)[line - 1];
  if (sourceLine === undefined) fail(`diagnostic references missing line ${line} in ${file}`);
  return sha256(sourceLine.trim().replace(/\s+/g, " "));
}

function parseDiagnostics(output) {
  const diagnostics = new Map();
  const drift = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const match = ERROR_LINE.exec(rawLine);
    if (!match?.groups) {
      if (rawLine.includes(ERROR_MARKER)) drift.push(rawLine);
      continue;
    }

    const file = normalizePath(match.groups.file);
    const line = Number(match.groups.line);
    const column = Number(match.groups.column);
    const code = match.groups.code;
    const message = normalizeMessage(match.groups.message);
    const sourceFingerprint = sourceLineFingerprint(file, line);
    const messageFingerprint = sha256(message);
    const key = `${file}::${sourceFingerprint}::${column}::${code}::${messageFingerprint}`;
    const existing = diagnostics.get(key);
    diagnostics.set(key, {
      file,
      line,
      column,
      code,
      message,
      sourceFingerprint,
      messageFingerprint,
      count: (existing?.count ?? 0) + 1,
    });
  }

  if (drift.length > 0) {
    fail(`tsc emitted ${drift.length} error-shaped line(s) the ratchet could not parse. Update its parser before trusting this run.\n${drift.slice(0, 10).join("\n")}`);
  }
  return diagnostics;
}

function currentDiagnostics() {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (parsed === undefined) fail("could not parse tsconfig.test.json");

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const current = new Map();

  for (const diagnostic of diagnostics) {
    if (diagnostic.file === undefined || diagnostic.start === undefined) {
      fail(`test TypeScript configuration diagnostic: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
    }
    const file = normalizePath(diagnostic.file.fileName);
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    const line = position.line + 1;
    const column = position.character + 1;
    const code = `TS${diagnostic.code}`;
    const message = normalizeMessage(ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
    const sourceFingerprint = sourceLineFingerprint(file, line);
    const messageFingerprint = sha256(message);
    const key = `${file}::${sourceFingerprint}::${column}::${code}::${messageFingerprint}`;
    const existing = current.get(key);
    current.set(key, {
      file,
      line,
      column,
      code,
      message,
      sourceFingerprint,
      messageFingerprint,
      count: (existing?.count ?? 0) + 1,
    });
  }
  return current;
}

function parseEnvironment(file) {
  const values = new Map();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

function createBaseline(diagnostics, environment = new Map()) {
  const entries = Object.fromEntries(
    [...diagnostics.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value]),
  );
  return {
    $comment: "Historical strict test-tree diagnostics. Compare-only ratchet: no new or grown source/message fingerprint may ship without scripts/test-type-baseline-allowlist.json.",
    schemaVersion: 1,
    command: "pnpm exec tsc --noEmit -p tsconfig.test.json",
    tscVersion: environment.get("tsc")?.replace(/^Version\s+/, "") ?? tscVersion,
    nodeVersion: environment.get("node") ?? process.version,
    configSha256: sha256(readFileSync(configPath)),
    extendsConfigSha256: sha256(readFileSync(extendsConfigPath)),
    sourceCommit: environment.get("commit") ?? null,
    recordedAtUtc: environment.get("date-utc") ?? null,
    diagnostics: entries,
  };
}

function readJson(file, label) {
  if (!existsSync(file)) fail(`${label} is missing: ${path.relative(repositoryRoot, file)}`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function loadBaseline() {
  const baseline = readJson(baselinePath, "test type baseline");
  if (baseline?.schemaVersion !== 1 || typeof baseline.diagnostics !== "object" || baseline.diagnostics === null) {
    fail("test type baseline has an unsupported shape");
  }
  if (baseline.tscVersion !== tscVersion) {
    fail(`TypeScript version changed: baseline ${baseline.tscVersion}, installed ${tscVersion}. Regenerate only through reviewed baseline maintenance.`);
  }
  const configHash = sha256(readFileSync(configPath));
  const extendsHash = sha256(readFileSync(extendsConfigPath));
  if (baseline.configSha256 !== configHash || baseline.extendsConfigSha256 !== extendsHash) {
    fail("test TypeScript config changed since the baseline. Do not silently rebaseline; review the config and baseline change together.");
  }
  return baseline;
}

function loadAllowlist() {
  const allowlist = readJson(allowlistPath, "test type baseline allowlist");
  if (allowlist?.schemaVersion !== 1 || typeof allowlist.entries !== "object" || allowlist.entries === null) {
    fail("test type baseline allowlist has an unsupported shape");
  }
  return allowlist.entries;
}

function printDiagnostic(entry) {
  return `${entry.file}:${entry.line}:${entry.column} ${entry.code} — ${entry.message}`;
}

function compare(current, baseline, allowlist) {
  const violations = [];
  const allowed = [];
  const improvements = [];

  for (const [key, entry] of current) {
    const prior = baseline.diagnostics[key]?.count ?? 0;
    if (entry.count <= prior) continue;
    const allowance = allowlist[key];
    if (allowance && Number.isInteger(allowance.maxCount) && allowance.maxCount >= entry.count && typeof allowance.reason === "string" && allowance.reason.trim() !== "") {
      allowed.push({ entry, prior, allowance });
    } else {
      violations.push({ entry, prior });
    }
  }

  for (const [key, prior] of Object.entries(baseline.diagnostics)) {
    const currentCount = current.get(key)?.count ?? 0;
    if (currentCount < prior.count) improvements.push({ prior, currentCount });
  }

  if (violations.length > 0) {
    console.error(`${RED}✗ ${violations.length} test type diagnostic fingerprint(s) exceed baseline:${RESET}`);
    for (const { entry, prior } of violations) {
      console.error(`  baseline ${prior}, now ${entry.count}: ${printDiagnostic(entry)}`);
    }
    console.error("Add a real fix, or an exact reviewed allowlist entry with a bounded maxCount and reason.");
    process.exit(1);
  }

  if (allowed.length > 0) {
    console.warn(`${YELLOW}! ${allowed.length} diagnostic fingerprint(s) admitted by reviewed allowlist:${RESET}`);
    for (const { entry, allowance } of allowed) console.warn(`  ${printDiagnostic(entry)} — ${allowance.reason}`);
  }
  if (improvements.length > 0) {
    console.log(`${YELLOW}! ${improvements.length} baseline fingerprint(s) improved; keep the baseline immutable until a reviewed cleanup compacts it.${RESET}`);
  }
  const count = [...current.values()].reduce((total, entry) => total + entry.count, 0);
  console.log(`${GREEN}✓ test type ratchet green — ${count} diagnostic(s), tsc ${tscVersion}, config ${sha256(readFileSync(configPath))}.${RESET}`);
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function bootstrap() {
  if (existsSync(baselinePath)) fail("test type baseline already exists; bootstrap is intentionally one-shot");
  const diagnosticsPath = argumentValue("--diagnostics");
  const environmentPath = argumentValue("--environment");
  if (!diagnosticsPath || !environmentPath) fail("bootstrap requires --diagnostics <file> and --environment <file>");
  const diagnostics = parseDiagnostics(readFileSync(path.resolve(repositoryRoot, diagnosticsPath), "utf8"));
  const environment = parseEnvironment(path.resolve(repositoryRoot, environmentPath));
  const baseline = createBaseline(diagnostics, environment);
  const expectedCount = Number(environment.get("error-count"));
  const actualCount = [...diagnostics.values()].reduce((total, entry) => total + entry.count, 0);
  if (!Number.isInteger(expectedCount) || expectedCount !== actualCount) {
    fail(`bootstrap transcript count mismatch: environment says ${environment.get("error-count")}, parser found ${actualCount}`);
  }
  if (baseline.tscVersion !== tscVersion) fail(`bootstrap compiler mismatch: transcript ${baseline.tscVersion}, installed ${tscVersion}`);
  // The baseline deliberately stays single-line: it is generated metadata, and the
  // repository's 500-line cap applies to every file we leave behind.
  writeFileSync(baselinePath, `${JSON.stringify(baseline)}\n`, "utf8");
  console.log(`${GREEN}✓ wrote ${path.relative(repositoryRoot, baselinePath)} with ${actualCount} diagnostic(s).${RESET}`);
}

function main() {
  if (process.argv.includes("--bootstrap")) {
    bootstrap();
    return;
  }
  const baseline = loadBaseline();
  compare(currentDiagnostics(), baseline, loadAllowlist());
}

main();
