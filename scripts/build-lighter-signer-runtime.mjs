#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(repoRoot, "src", "tools", "lighter", "signer-runtime");
const outputDir = path.join(repoRoot, "vex-app", "resources", "lighter-signer");
const targets = [
  { platform: "darwin", arch: "arm64", goos: "darwin", goarch: "arm64" },
  { platform: "darwin", arch: "x64", goos: "darwin", goarch: "amd64" },
  { platform: "linux", arch: "arm64", goos: "linux", goarch: "arm64" },
  { platform: "linux", arch: "x64", goos: "linux", goarch: "amd64" },
  { platform: "win32", arch: "arm64", goos: "windows", goarch: "arm64" },
  { platform: "win32", arch: "x64", goos: "windows", goarch: "amd64" },
];

function binaryNameFor(target) {
  const suffix = target.platform === "win32" ? ".exe" : "";
  return `vex-lighter-signer-${target.platform}-${target.arch}${suffix}`;
}

mkdirSync(outputDir, { recursive: true });

if (existsSync(outputDir)) {
  for (const name of readdirSync(outputDir)) {
    if (name.startsWith("vex-lighter-signer-")) {
      rmSync(path.join(outputDir, name), { force: true });
    }
  }
}

for (const target of targets) {
  const outputPath = path.join(outputDir, binaryNameFor(target));
  const result = spawnSync(
    "go",
    ["build", "-trimpath", "-ldflags=-s -w", "-o", outputPath, "."],
    {
      cwd: sourceDir,
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: target.goos,
        GOARCH: target.goarch,
      },
      stdio: "inherit",
    },
  );

  if (result.error) {
    console.error(`[lighter-signer] failed to launch Go compiler: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  console.log(`[lighter-signer] built ${path.relative(repoRoot, outputPath)}`);
}

console.log(`[lighter-signer] ${targets.length} helper binary target(s) ready`);
