#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const expectedPnpm = /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageJson.packageManager)?.[1];
if (expectedPnpm === undefined) {
  fail("package.json must pin packageManager to an exact pnpm version");
}

const requiredNode = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.engines?.node ?? "");
if (requiredNode === null) {
  fail("package.json engines.node must use an explicit >=major.minor.patch minimum");
}

const actualNode = process.versions.node;
if (compareVersions(actualNode, requiredNode.slice(1).join(".")) < 0) {
  fail(`Node ${actualNode} is below the required ${packageJson.engines.node}`);
}

const userAgent = process.env.npm_config_user_agent ?? "";
const actualPnpm = /(?:^|\s)pnpm\/(\d+\.\d+\.\d+)(?:\s|$)/.exec(userAgent)?.[1];
if (actualPnpm === undefined) {
  fail("the toolchain check must be run through the pinned pnpm executable");
}
if (actualPnpm !== expectedPnpm) {
  fail(`pnpm ${actualPnpm} does not match the pinned pnpm ${expectedPnpm}`);
}

console.log(`Toolchain verified: Node ${actualNode}, pnpm ${actualPnpm}`);

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function fail(message) {
  console.error(`Toolchain verification failed: ${message}.`);
  process.exit(1);
}
