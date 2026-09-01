import type { BridgeGoarch, BridgeGoos } from "./bridge-artifact.mjs";

export const BRIDGE_BUILD_SCRIPT: string;
export const BRIDGE_MANIFEST_NAME: "build-manifest.json";

export interface BridgeBuildManifest {
  readonly manifestVersion: number;
  readonly goos: BridgeGoos;
  readonly goarch: BridgeGoarch;
  readonly goVersion: string;
  readonly sourcesDigest: string;
  readonly artifactDigest: string;
  readonly stamp: string;
  readonly builtAt: string;
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
      readonly artifact: string;
      readonly manifest: BridgeBuildManifest;
    }
  | {
      readonly kind: "stale";
      readonly reason: string;
      readonly stamp: string;
      readonly artifact: string;
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
