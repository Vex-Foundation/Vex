/**
 * The Vex Studio bridge artifact: where it lives, and what it must actually be.
 *
 * electron-builder 26 only WARNS on a missing `extraResources` source and
 * packages on regardless, so a tag could otherwise ship a Vex with no bridge
 * at all - or, worse, with the previous architecture's binary still sitting in
 * `resources/bridge` from an earlier build. Both are silent until a user's MCP
 * client fails to start. This module is the fail-closed answer: nothing is
 * staged or packaged unless the file on disk is an executable of the right
 * FORMAT and the right MACHINE.
 *
 * The format check reads the executable's own header - ELF, Mach-O or PE. That
 * is a few dozen bytes of well-specified structure, so it needs no dependency,
 * and unlike a file-name convention it cannot be satisfied by a stale copy
 * that merely sits in the right directory.
 *
 * Owner of the packaging identity, frozen with the endpoint contract:
 * Electron `x64` -> Go `amd64`, `arm64` -> `arm64`, `mac`/`win`/`linux` ->
 * `darwin`/`windows`/`linux`. Packaged path: `resources/bridge/vex-mcp`
 * (`.exe` on Windows).
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

/** Electron's arch vocabulary to Go's. */
export const GO_ARCH_BY_ELECTRON_ARCH = Object.freeze({
  x64: "amd64",
  arm64: "arm64",
});

/** Electron's and electron-builder's platform names to Go's. */
export const GOOS_BY_ELECTRON_PLATFORM = Object.freeze({
  darwin: "darwin",
  mac: "darwin",
  win32: "windows",
  win: "windows",
  linux: "linux",
});

/** The packaged location, relative to the app's resources directory. */
export const PACKAGED_BRIDGE_SUBPATH = "bridge";

/** The binary's file name for a Go platform. */
export function bridgeBinaryName(goos) {
  return goos === "windows" ? "vex-mcp.exe" : "vex-mcp";
}

/** The build wrapper's output path for one target. */
export function builtBridgePath(repoRoot, goos, goarch) {
  return path.join(repoRoot, "bridge", "dist", `${goos}-${goarch}`, bridgeBinaryName(goos));
}

/**
 * The staging directory for ONE Electron arch.
 *
 * Per-arch, not one shared directory: the macOS release job packages arm64 and
 * x64 in a single electron-builder invocation, and a single staged binary
 * would put one architecture's bridge inside the other's bundle. The configs
 * point `extraResources` at `resources/bridge-${arch}`, which app-builder-lib
 * expands per arch (verified in fileMatcher.js: `from` and `to` both pass
 * through the macro expander).
 */
export function stagedBridgeDir(appRoot, electronArch) {
  return path.join(appRoot, "resources", `bridge-${electronArch}`);
}

/**
 * Translate an Electron platform/arch pair to the Go target, refusing an
 * unknown one by NAME rather than defaulting to something plausible.
 */
export function goTargetFor(electronPlatform, electronArch) {
  const goos = GOOS_BY_ELECTRON_PLATFORM[electronPlatform];
  if (goos === undefined) {
    throw new Error(
      `unknown packaging platform "${electronPlatform}"; the bridge maps mac/win/linux (and darwin/win32) only`
    );
  }
  const goarch = GO_ARCH_BY_ELECTRON_ARCH[electronArch];
  if (goarch === undefined) {
    throw new Error(
      `unknown packaging architecture "${electronArch}"; the bridge maps x64 and arm64 only`
    );
  }
  return { goos, goarch };
}

// ── Executable headers ──────────────────────────────────────────────────────

const ELF_MACHINE = new Map([
  [0x3e, "amd64"],
  [0xb7, "arm64"],
]);

const MACHO_CPUTYPE = new Map([
  [0x01000007, "amd64"],
  [0x0100000c, "arm64"],
]);

const PE_MACHINE = new Map([
  [0x8664, "amd64"],
  [0xaa64, "arm64"],
]);

/**
 * Read the executable format and machine from a file's own header.
 *
 * Throws with a sentence naming the file when the bytes are not one of the
 * three formats Vex ships, or when the machine field is one Vex does not
 * target. An unreadable or truncated file is a failure, never a pass.
 */
export function inspectExecutable(file) {
  if (!existsSync(file)) {
    throw new Error(`missing: ${file}`);
  }
  const size = statSync(file).size;
  if (size < 64) {
    throw new Error(`${file} is ${size} bytes, too short to be an executable`);
  }
  const head = readFileSync(file);

  // ELF: 0x7F 'E' 'L' 'F', 64-bit, little-endian, e_machine at offset 18.
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
    if (head[4] !== 2) throw new Error(`${file} is a 32-bit ELF; Vex ships 64-bit only`);
    if (head[5] !== 1) throw new Error(`${file} is a big-endian ELF; Vex ships little-endian only`);
    const machine = head.readUInt16LE(18);
    const arch = ELF_MACHINE.get(machine);
    if (arch === undefined) {
      throw new Error(`${file} is an ELF for machine 0x${machine.toString(16)}, which Vex does not target`);
    }
    return { format: "elf", goos: "linux", arch };
  }

  // Mach-O 64-bit, little-endian on disk: CF FA ED FE, cputype at offset 4.
  if (head[0] === 0xcf && head[1] === 0xfa && head[2] === 0xed && head[3] === 0xfe) {
    const cpuType = head.readUInt32LE(4);
    const arch = MACHO_CPUTYPE.get(cpuType);
    if (arch === undefined) {
      throw new Error(`${file} is a Mach-O for cputype 0x${cpuType.toString(16)}, which Vex does not target`);
    }
    return { format: "macho", goos: "darwin", arch };
  }

  // A universal binary is REFUSED rather than accepted: the build wrapper
  // emits one binary per architecture on purpose, and a fat file here means
  // something other than the wrapper produced it.
  if (head[0] === 0xca && head[1] === 0xfe && head[2] === 0xba && head[3] === 0xbe) {
    throw new Error(`${file} is a universal (fat) Mach-O; the bridge ships one binary per architecture`);
  }

  // PE: 'MZ', e_lfanew at 0x3C, then 'PE\0\0' and the machine field.
  if (head[0] === 0x4d && head[1] === 0x5a) {
    const peOffset = head.readUInt32LE(0x3c);
    if (peOffset + 6 > head.length) {
      throw new Error(`${file} claims a PE header at 0x${peOffset.toString(16)}, past the end of the file`);
    }
    if (
      head[peOffset] !== 0x50 || head[peOffset + 1] !== 0x45
      || head[peOffset + 2] !== 0x00 || head[peOffset + 3] !== 0x00
    ) {
      throw new Error(`${file} starts with MZ but carries no PE signature`);
    }
    const machine = head.readUInt16LE(peOffset + 4);
    const arch = PE_MACHINE.get(machine);
    if (arch === undefined) {
      throw new Error(`${file} is a PE for machine 0x${machine.toString(16)}, which Vex does not target`);
    }
    return { format: "pe", goos: "windows", arch };
  }

  throw new Error(
    `${file} is not an ELF, Mach-O or PE executable (first bytes ${[...head.subarray(0, 4)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ")})`
  );
}

/**
 * Assert that `file` is the bridge binary for exactly this Go target.
 *
 * Returns the inspection so a caller can log what it accepted; throws with the
 * mismatch named otherwise.
 */
export function assertBridgeArtifact(file, goos, goarch) {
  const found = inspectExecutable(file);
  if (found.goos !== goos) {
    throw new Error(
      `${file} is a ${found.format} executable for ${found.goos}; this package needs ${goos}`
    );
  }
  if (found.arch !== goarch) {
    throw new Error(
      `${file} is a ${found.goos} executable for ${found.arch}; this package needs ${goarch}`
    );
  }
  return found;
}
