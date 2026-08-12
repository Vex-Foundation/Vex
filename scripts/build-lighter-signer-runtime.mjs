#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(repoRoot, "src", "tools", "lighter", "signer-runtime");
const outputDir = path.join(repoRoot, "vex-app", "resources", "lighter-signer");
const binaryName = process.platform === "win32"
  ? `vex-lighter-signer-${process.platform}-${process.arch}.exe`
  : `vex-lighter-signer-${process.platform}-${process.arch}`;
const outputPath = path.join(outputDir, binaryName);

mkdirSync(outputDir, { recursive: true });

const result = spawnSync(
  "go",
  ["build", "-trimpath", "-ldflags=-s -w", "-o", outputPath, "."],
  {
    cwd: sourceDir,
    env: {
      ...process.env,
      CGO_ENABLED: "0",
    },
    stdio: "inherit",
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`[lighter-signer] built ${path.relative(repoRoot, outputPath)}`);
