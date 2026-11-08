/** A mood drawn from a file of its own (held is offer's, dimmed). */
export type KimmMoodName = "hi" | "think" | "offer" | "signed" | "refused" | "rest";

export const KIMM_MOODS: readonly KimmMoodName[];

export const KIMM_ART_DIR: "art/kimm";

export const KIMM_BUDGETS: Readonly<{
  keyMoods: number;
  section: number;
  strip: number;
}>;

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
