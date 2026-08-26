export const GO_ARCH_BY_ELECTRON_ARCH: Readonly<{
  x64: "amd64";
  arm64: "arm64";
}>;

export const GOOS_BY_ELECTRON_PLATFORM: Readonly<{
  darwin: "darwin";
  mac: "darwin";
  win32: "windows";
  win: "windows";
  linux: "linux";
}>;

export const PACKAGED_BRIDGE_SUBPATH: "bridge";

export type BridgeGoos = "darwin" | "windows" | "linux";
export type BridgeGoarch = "amd64" | "arm64";
export type BridgeExecutableFormat = "elf" | "macho" | "pe";

export interface BridgeInspection {
  readonly format: BridgeExecutableFormat;
  readonly goos: BridgeGoos;
  readonly arch: BridgeGoarch;
}

export function bridgeBinaryName(goos: BridgeGoos): string;
export function builtBridgePath(
  repoRoot: string,
  goos: BridgeGoos,
  goarch: BridgeGoarch,
): string;
export function stagedBridgeDir(appRoot: string, electronArch: "x64" | "arm64"): string;
export function goTargetFor(
  electronPlatform: string,
  electronArch: string,
): { readonly goos: BridgeGoos; readonly goarch: BridgeGoarch };
export function inspectExecutable(file: string): BridgeInspection;
export function assertBridgeArtifact(
  file: string,
  goos: BridgeGoos,
  goarch: BridgeGoarch,
): BridgeInspection;
