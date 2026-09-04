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
export type BridgeTarget = `${BridgeGoos}-${BridgeGoarch}`;

export interface BridgeArtifact {
  readonly name: string;
  readonly cmd: string;
  readonly targets: readonly BridgeTarget[];
}

export const BRIDGE_TARGETS: readonly BridgeTarget[];
export const BRIDGE_ARTIFACTS: readonly BridgeArtifact[];

export function artifactBinaryName(artifact: BridgeArtifact, goos: BridgeGoos): string;
export function builtArtifactPath(
  repoRoot: string,
  artifact: BridgeArtifact,
  goos: BridgeGoos,
  goarch: BridgeGoarch,
): string;
/**
 * Accepts plain strings, like `goTargetFor`: refusing an unknown triple BY NAME
 * is this function's job, so a signature that only admitted known values would
 * put the check out of reach of every caller that has a string to validate.
 */
export function artifactsFor(goos: string, goarch: string): readonly BridgeArtifact[];
export type BridgeExecutableFormat = "elf" | "macho" | "pe";

export interface BridgeInspection {
  readonly format: BridgeExecutableFormat;
  readonly goos: BridgeGoos;
  readonly arch: BridgeGoarch;
}

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
