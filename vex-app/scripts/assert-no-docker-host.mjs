#!/usr/bin/env node
/**
 * THE CLEAN-MACHINE PRECONDITION (plan D12): assert that nothing Docker is
 * installed, running or reachable on THIS machine, or fail naming every trace
 * that is left. The clean-machine gate runs it after removing Docker from the
 * runner and before it launches the packaged app, so a green gate cannot mean
 * "the app quietly used a Docker that was still there".
 *
 * Two kinds of evidence, both required:
 *
 *   1. THE APP'S OWN EYES. The Docker locator and engine-endpoint probe the
 *      app itself runs (`src/main/docker/locate.ts`, `engine-endpoint.ts`),
 *      imported rather than restated, so this check looks exactly where Vex
 *      would and cannot drift from it: no CLI in any install directory or on
 *      PATH, no Docker Desktop executable, no default engine endpoint present
 *      or answering.
 *   2. THE MACHINE, beyond what the app happens to look at: Docker's
 *      environment variables, every `docker*` / `containerd` executable on
 *      PATH, the other well-known engine sockets and named pipes, the
 *      system services, and running processes.
 *
 * Usage (from vex-app/; Node 22 strips the imported modules' types):
 *   node --experimental-strip-types --no-warnings scripts/assert-no-docker-host.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { locateDockerDesktopExe, resolveDockerCli, isExistingFile } from "../src/main/docker/locate.ts";
import { defaultDockerEngineEndpoints, probeDockerEngineEndpoint } from "../src/main/docker/engine-endpoint.ts";

const platform = process.platform;
const home = homedir();
const found = [];
const checked = [];

// ── 1. What the app itself would find ──────────────────────────────────────

const cli = resolveDockerCli();
checked.push("the app's Docker CLI locator (install directories, then PATH)");
if (cli !== null) found.push(`the app's locator finds a Docker CLI: ${cli.executablePath} (${cli.source})`);

if (platform === "win32") {
  const desktop = locateDockerDesktopExe({ env: process.env, fileExists: isExistingFile });
  checked.push("the app's Docker Desktop locator");
  if (desktop !== null) found.push(`the app's locator finds Docker Desktop: ${desktop}`);
}

const appEndpoints = defaultDockerEngineEndpoints({ platform, homedir: home });
const reach = await probeDockerEngineEndpoint({ platform, homedir: home });
checked.push(`the app's engine probe of ${appEndpoints.join(", ")}`);
// `not_running` is the probe's "nothing listens there" (ENOENT, ECONNREFUSED).
if (reach.kind !== "not_running") found.push(`the app's engine probe: ${JSON.stringify(reach)}`);

// ── 2. The machine ─────────────────────────────────────────────────────────

for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]) {
  const value = process.env[name];
  if (value !== undefined && value !== "") found.push(`${name} is set (${value})`);
}
checked.push("DOCKER_* environment");

const programs = ["docker", "dockerd", "docker-compose", "com.docker.cli", "containerd"];
const extensions = platform === "win32" ? [".exe", ".cmd", ".bat", ".com", ""] : [""];
const pathDirs = (process.env["PATH"] ?? process.env["Path"] ?? "").split(path.delimiter).filter((dir) => path.isAbsolute(dir));
for (const dir of new Set(pathDirs)) {
  for (const program of programs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, program + extension);
      if (isExistingFile(candidate)) found.push(`on PATH: ${candidate}`);
    }
  }
}
checked.push(`${programs.join(", ")} in ${String(new Set(pathDirs).size)} PATH directories`);

if (platform === "win32") {
  // Named pipes are listable as a directory on Windows.
  const pipes = readdirSync("\\\\.\\pipe\\").filter((name) => /docker/i.test(name));
  for (const pipe of pipes) found.push(`named pipe \\\\.\\pipe\\${pipe}`);
  checked.push("named pipes matching /docker/i");
} else {
  const runtimeDir = process.env["XDG_RUNTIME_DIR"];
  const sockets = [
    ...appEndpoints,
    "/run/docker.sock",
    "/var/run/docker.sock",
    "/run/containerd/containerd.sock",
    path.join(home, ".docker", "run", "docker.sock"),
    path.join(home, ".docker", "desktop", "docker.sock"),
    path.join(home, ".colima", "default", "docker.sock"),
    path.join(home, ".orbstack", "run", "docker.sock"),
    path.join(home, ".rd", "docker.sock"),
    ...(runtimeDir === undefined ? [] : [path.join(runtimeDir, "docker.sock")]),
  ];
  for (const socket of new Set(sockets)) {
    if (existsSync(socket)) found.push(`engine socket ${socket} (${statSync(socket).isSocket() ? "socket" : "file"})`);
  }
  checked.push(`${String(new Set(sockets).size)} well-known engine sockets`);
}

if (platform === "linux") {
  for (const unit of ["docker.service", "docker.socket", "containerd.service"]) {
    const state = spawnSync("systemctl", ["is-active", unit], { encoding: "utf8" }).stdout.trim();
    if (state === "active" || state === "activating") found.push(`systemd unit ${unit} is ${state}`);
  }
  checked.push("systemd units docker.service, docker.socket, containerd.service");
}
if (platform === "win32") {
  for (const service of ["docker", "com.docker.service"]) {
    const query = spawnSync("sc.exe", ["query", service], { encoding: "utf8" });
    // 1060: the service does not exist.
    if (query.status !== 1060) found.push(`Windows service ${service} exists:\n${query.stdout.trim()}`);
  }
  checked.push("Windows services docker, com.docker.service");
}

const processes =
  platform === "win32"
    ? spawnSync("tasklist", ["/fo", "csv", "/nh"], { encoding: "utf8" }).stdout
        .split(/\r?\n/)
        .map((line) => line.split(",")[0]?.replaceAll('"', "") ?? "")
    : spawnSync("ps", ["-A", "-o", "comm="], { encoding: "utf8" }).stdout.split("\n").map((line) => path.basename(line.trim()));
const dockerProcess = /^(docker|dockerd|containerd|com\.docker\..*|Docker Desktop)(\.exe)?$/i;
for (const name of new Set(processes.filter((name) => dockerProcess.test(name)))) found.push(`running process ${name}`);
checked.push(`${String(processes.length)} running processes`);

console.log(`Checked:\n${checked.map((line) => `  - ${line}`).join("\n")}`);
if (found.length > 0) {
  console.error(`\nDocker is still on this machine:\n${found.map((line) => `  - ${line}`).join("\n")}`);
  process.exit(1);
}
console.log("\nNo Docker on this machine: no CLI, no engine endpoint, no service, no process.");
