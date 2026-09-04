import type { BridgeGoarch, BridgeGoos } from "./bridge-artifact.mjs";

export const BRIDGE_BUILD_SCRIPT: string;
export const BRIDGE_MANIFEST_NAME: "build-manifest.json";

export interface BridgeArtifactDigest {
  readonly sha256: string;
  readonly bytes: number;
}

export interface BridgeBuildManifest {
  readonly manifestVersion: number;
  readonly goos: BridgeGoos;
  readonly goarch: BridgeGoarch;
  readonly goVersion: string;
  readonly sourcesDigest: string;
  /** One entry per artifact the table lists for this triple, keyed by name. */
  readonly artifacts: Readonly<Record<string, BridgeArtifactDigest>>;
  readonly stamp: string;
  readonly builtAt: string;
}

/** One built binary this triple is expected to carry. */
export interface BridgeArtifactLocation {
  readonly name: string;
  readonly file: string;
}

export type GoToolchainDetection =
  | { readonly kind: "ok"; readonly version: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unusable"; readonly detail: string };

export type GoToolchainResolution =
  | { readonly kind: "ok"; readonly version: string }
  | { readonly kind: "refused"; readonly message: string };

export type BridgeFreshness =
  | {
      readonly kind: "fresh";
      readonly stamp: string;
      readonly artifacts: readonly BridgeArtifactLocation[];
      readonly manifest: BridgeBuildManifest;
    }
  | {
      readonly kind: "stale";
      readonly reason: string;
      readonly stamp: string;
      readonly artifacts: readonly BridgeArtifactLocation[];
    };

export function requiredGoVersion(repoRoot: string): string;
export function hostGoTarget(
  platform?: string,
  arch?: string,
): { readonly goos: BridgeGoos; readonly goarch: BridgeGoarch };
export function bridgeSourceFiles(repoRoot: string): string[];
export function hashBridgeSources(repoRoot: string): string;
export function hashFile(file: string): string | null;
export function freshnessStamp(input: {
  readonly sourcesDigest: string;
  readonly goos: BridgeGoos;
  readonly goarch: BridgeGoarch;
  readonly goVersion: string;
}): string;
export function manifestPath(repoRoot: string, goos: BridgeGoos, goarch: BridgeGoarch): string;
export function readManifest(
  repoRoot: string,
  goos: BridgeGoos,
  goarch: BridgeGoarch,
): BridgeBuildManifest | null;
export function writeManifest(
  repoRoot: string,
  input: {
    readonly goos: BridgeGoos;
    readonly goarch: BridgeGoarch;
    readonly goVersion: string;
    readonly sourcesDigest: string;
  },
): BridgeBuildManifest;
export function detectGoToolchain(): GoToolchainDetection;
export function resolveGoToolchain(
  repoRoot: string,
  detected?: GoToolchainDetection,
): GoToolchainResolution;
export function evaluateBridgeFreshness(input: {
  readonly repoRoot: string;
  readonly goos: BridgeGoos;
  readonly goarch: BridgeGoarch;
  readonly goVersion: string;
  readonly sourcesDigest?: string;
}): BridgeFreshness;

export const GIT_BASH_OVERRIDE_ENV: "VEX_GIT_BASH";

/** One place a Git for Windows `bash.exe` could be, with the evidence for it. */
export interface GitBashCandidate {
  readonly file: string;
  readonly source: string;
}

export type BuildShellResolution =
  | { readonly kind: "ok"; readonly command: string; readonly source: string }
  | { readonly kind: "refused"; readonly message: string };

export function isWindowsSystemBash(file: string): boolean;
export function detectGitExecPath(): string | null;
export function windowsGitBashCandidates(input?: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly gitExecPath?: string | null;
}): GitBashCandidate[];
export function resolveBuildShell(input?: {
  readonly platform?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly gitExecPath?: string | null;
  readonly fileExists?: (file: string) => boolean;
}): BuildShellResolution;
export function buildScriptArgument(repoRoot: string, platform?: string): string;
