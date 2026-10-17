/**
 * Available disk-space probe for the System Check screen. Returns GB
 * available at `targetPath` (rounded to 2 decimals), or 0 on any error.
 * The measurement itself is `system/disk-space.ts`, which the native
 * runtime's System Check reads too.
 */

import { readDiskSpace } from "../../system/disk-space.js";

// ── Disk space ───────────────────────────────────────────────────────

export async function getAvailableDiskGB(targetPath: string): Promise<number> {
  try {
    const { freeBytes } = await readDiskSpace(targetPath);
    const gb = freeBytes / 1024 / 1024 / 1024;
    // Round to 2 decimals — anything below ~5GB is the operational threshold
    // surface as a warning row in System Check.
    return Math.max(0, Math.round(gb * 100) / 100);
  } catch {
    return 0;
  }
}
