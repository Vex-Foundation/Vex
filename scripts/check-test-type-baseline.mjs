#!/usr/bin/env node
/**
 * Strict zero-debt root test-tree TypeScript gate. Historical baseline and
 * allowlist remain immutable records and never admit current diagnostics.
 * The reviewed test topology preserves source scope and inherited checks;
 * production config and compiler version retain their historical locks.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { assertTestTypeConfigContract, assertZeroTestTypeDiagnostics } from "./test-type-config-contract.mjs";

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(repositoryRoot, "tsconfig.test.json");
const tscVersion = require("typescript/package.json").version;

function main() {
  if (process.argv.length > 2) throw new Error("strict test type checking accepts no baseline or diagnostic suppression arguments");
  assertTestTypeConfigContract(repositoryRoot, tscVersion);
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (parsed === undefined) throw new Error("could not parse tsconfig.test.json");
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
    configFileParsingDiagnostics: parsed.errors,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const formatHost = {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => repositoryRoot,
    getNewLine: () => "\n",
  };
  assertZeroTestTypeDiagnostics(diagnostics.map(diagnostic => ts.formatDiagnostic(diagnostic, formatHost).trimEnd()));
  console.log(`✓ strict test TypeScript check passed with zero diagnostics, tsc ${tscVersion}`);
}

try {
  main();
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
