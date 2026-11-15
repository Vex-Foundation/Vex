/** A mood drawn from a file of its own (held is offer's, dimmed). */
export type KimmMoodName = "hi" | "think" | "offer" | "signed" | "refused" | "rest";

export const KIMM_MOODS: readonly KimmMoodName[];

export const KIMM_ART_DIR: "art/kimm";

export const KIMM_BUDGETS: Readonly<{
  chip: number;
  still: number;
  fieldStill: number;
  fieldStillWide: number;
}>;

export const KIMM_STILL_HEIGHTS: Readonly<Record<KimmMoodName, number>>;

/** One `BRAND_ASSETS` entry of `check-build-artifacts.mjs`. */
export interface BrandAssetEntry {
  /** Relative to the renderer's public root and to dist/renderer/. */
  readonly file: string;
  readonly format: string;
  /** `null` until the file exists and its size is pinned. */
  readonly width: number | null;
  readonly height: number | null;
  readonly maxBytes: number;
  /** Registered before the file exists: skipped while absent from the source. */
  readonly awaited?: boolean;
}

export const KIMM_BRAND_ASSETS: readonly BrandAssetEntry[];

export function brandAssetPlan(entry: BrandAssetEntry, publicDir: string): "check" | "awaiting" | "unpinned";

/** Her live model's folder, relative to the renderer's public root and to dist/renderer/. */
export const KIMM_LIVE_DIR: "art/kimm/live";

/** One pinned file of her live model. */
export interface KimmLiveFile {
  /** Relative to the renderer's public root and to dist/renderer/. */
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

export const KIMM_LIVE_FILES: readonly KimmLiveFile[];

/** What is wrong with her live files under `root`; empty when the folder holds exactly the pinned bytes. */
export function kimmLiveFindings(root: string): string[];
