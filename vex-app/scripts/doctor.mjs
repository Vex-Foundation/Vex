#!/usr/bin/env node
/**
 * vex-app doctor — preflight checks before `pnpm dev` / `pnpm make`.
 *
 * Validates dev environment readiness:
 *   - Node version satisfies engines.node
 *   - On WSL2: WSLg active OR `$DISPLAY` set OR fallback X server reachable
 *   - Electron binary cached (avoid first-run download surprise mid-session)
 *   - The Vex Studio bridge for THIS platform and architecture is built and
 *     still matches the sources and the pinned Go toolchain
 *
 * The bridge check is a VERIFICATION, not a build: `predev` runs
 * `build:bridge:dev` first, so by the time doctor speaks the build has already
 * had its chance and a failure here means it did not produce what it should
 * have. Running doctor on its own (`pnpm doctor`) reports the same fact
 * without building anything.
 *
 * Exits 0 if everything OK, 1 with actionable instructions otherwise.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BRIDGE_BUILD_SCRIPT,
  evaluateBridgeFreshness,
  hostGoTarget,
  resolveGoToolchain,
} from "./bridge-freshness.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..");

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const RESET = "\x1b[0m";

let exitCode = 0;
const issues = [];

function ok(msg) {
  console.log(`${GREEN}✓${RESET} ${msg}`);
}
function warn(msg, fix) {
  console.log(`${YELLOW}⚠${RESET} ${msg}`);
  if (fix) console.log(`  ${BLUE}→${RESET} ${fix}`);
}
function fail(msg, fix) {
  console.log(`${RED}✗${RESET} ${msg}`);
  if (fix) console.log(`  ${BLUE}→${RESET} ${fix}`);
  exitCode = 1;
  issues.push({ msg, fix });
}

// ── Node version ──────────────────────────────────────────────────────────
function checkNode() {
  const required = ">=22.21.0";
  const actual = process.versions.node;
  const [major, minor] = actual.split(".").map(Number);
  const ok22plus = major > 22 || (major === 22 && minor >= 21);
  if (ok22plus) {
    ok(`Node ${actual} satisfies ${required}`);
  } else {
    warn(
      `Node ${actual} below required ${required}`,
      `Upgrade Node (use Volta / fnm / nvm). Build will work but engine warnings persist.`
    );
  }
}

// ── WSL detection ─────────────────────────────────────────────────────────
function isWSL() {
  try {
    const release = readFileSync("/proc/version", "utf8").toLowerCase();
    return release.includes("microsoft") || release.includes("wsl");
  } catch {
    return false;
  }
}

// ── Display server ────────────────────────────────────────────────────────
function checkDisplay() {
  if (process.platform !== "linux") {
    ok(`Display: ${process.platform} — native window system, no X check needed`);
    return;
  }

  const display = process.env.DISPLAY;
  const wayland = process.env.WAYLAND_DISPLAY;
  const wslg = existsSync("/mnt/wslg");
  const wsl = isWSL();

  if (display || wayland) {
    if (wslg && wsl) {
      ok(`Display: WSLg active (DISPLAY=${display || "?"}, WAYLAND_DISPLAY=${wayland || "?"})`);
    } else {
      ok(`Display: DISPLAY=${display || ""} WAYLAND_DISPLAY=${wayland || ""}`);
    }
    return;
  }

  if (wsl) {
    fail(
      "Display: WSL2 detected without DISPLAY/WAYLAND_DISPLAY",
      [
        "Electron requires a graphical display. Pick one:",
        "",
        "  Option A — WSLg (recommended on Windows 11):",
        "    1. In elevated PowerShell (Windows side):",
        "         wsl --version && wsl --update && wsl --shutdown",
        "    2. Ensure %UserProfile%\\.wslconfig has:",
        "         [wsl2]",
        "         guiApplications=true",
        "    3. wsl --shutdown, then re-open WSL.",
        "    4. Verify in WSL: ls /mnt/wslg/ && echo \"$DISPLAY\"",
        "",
        "  Option B — VcXsrv on Windows (fallback):",
        "    1. Install VcXsrv on Windows, run it with disabled access control (-ac).",
        "    2. In WSL: export DISPLAY=\"$(ip route show default | awk '{print $3}'):0\"",
        "    3. Re-run pnpm dev.",
        "",
        "  Option C — Headless tests only:",
        "    pnpm vex:test:e2e   (uses xvfb-run, no GUI)",
      ].join("\n  ")
    );
  } else {
    fail(
      "Display: no DISPLAY or WAYLAND_DISPLAY set on Linux",
      "Start an X11/Wayland session or run `xvfb-run pnpm dev` for headless mode."
    );
  }
}

// ── Electron binary cache ─────────────────────────────────────────────────
function checkElectronBinary() {
  const electronBin = path.join(
    process.cwd(),
    "node_modules",
    "electron",
    "dist",
    process.platform === "win32" ? "electron.exe" : "electron"
  );
  if (existsSync(electronBin)) {
    const stats = statSync(electronBin);
    ok(`Electron binary cached: ${path.basename(electronBin)} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    warn(
      "Electron binary not yet downloaded",
      "Will download on first `pnpm dev`. Run `pnpm install` to pre-fetch."
    );
  }
}

// ── Vex Studio bridge ─────────────────────────────────────────────────────
const REBUILD_HINT = "Build it: pnpm --dir vex-app run build:bridge:dev";

function checkStudioBridge() {
  let target;
  try {
    target = hostGoTarget();
  } catch (error) {
    warn(
      `Studio bridge: ${error.message}`,
      "Vex will run, but Studio writes no coding-agent config files on this machine."
    );
    return;
  }
  const { goos, goarch } = target;

  const toolchain = resolveGoToolchain(REPO_ROOT);
  if (toolchain.kind === "refused") {
    // The refusal already carries its own remediation - installing the right
    // Go, not re-running a build that cannot work yet - so no rebuild hint is
    // appended here.
    const [headline, ...rest] = toolchain.message.split("\n");
    fail(
      `Studio bridge (${goos}-${goarch}): ${headline}`,
      rest.map((line) => line.trim()).filter(Boolean).join("\n  ")
    );
    return;
  }

  const freshness = evaluateBridgeFreshness({
    repoRoot: REPO_ROOT,
    goos,
    goarch,
    goVersion: toolchain.version,
  });
  if (freshness.kind === "fresh") {
    ok(
      `Studio bridge: ${path.relative(REPO_ROOT, freshness.artifact)} built with `
        + `${toolchain.version} and current with the sources`
    );
    return;
  }
  fail(
    `Studio bridge (${goos}-${goarch}) is not usable: ${freshness.reason}`,
    [
      `Expected ${path.relative(REPO_ROOT, freshness.artifact)}, built by ${BRIDGE_BUILD_SCRIPT} `
        + `with Go ${toolchain.version}.`,
      REBUILD_HINT,
      "Without it, Vex Studio writes no coding-agent config files at all.",
    ].join("\n  ")
  );
}

// ── Build artifacts (optional sanity) ─────────────────────────────────────
function checkBuildArtifacts() {
  const distMain = path.join(process.cwd(), "dist", "main", "index.js");
  const distPreload = path.join(process.cwd(), "dist", "preload", "index.cjs");
  if (existsSync(distMain) && existsSync(distPreload)) {
    ok(`Build artifacts present: dist/main/index.js + dist/preload/index.cjs`);
  } else {
    warn(
      "Build artifacts missing",
      "Run `pnpm build` (or `pnpm dev` will rebuild on the fly)."
    );
  }
}

// ── Run ───────────────────────────────────────────────────────────────────
console.log(`\n${BLUE}vex-app doctor${RESET} — preflight checks\n`);
checkNode();
checkDisplay();
checkElectronBinary();
checkStudioBridge();
checkBuildArtifacts();

if (exitCode !== 0) {
  console.log(
    `\n${RED}${issues.length} issue${issues.length === 1 ? "" : "s"} blocking dev.${RESET} See actions above.\n`
  );
} else {
  console.log(`\n${GREEN}All checks passed. Ready to run.${RESET}\n`);
}
process.exit(exitCode);
