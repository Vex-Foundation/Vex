/**
 * What the bundled local runtime needs from this machine (plan 8.5), as pure
 * verdicts over the facts main measures (`vex:system:localRuntimeCheck`).
 * Shared so main's tests and System Check's rows read one set of numbers.
 *
 * DISK, measured on the volume that holds the runtime directory:
 *   - BLOCK when the embeddings model still has to be downloaded and the free
 *     space cannot take it plus the database's margin. Setup cannot finish
 *     without the model (D14), so continuing would only fail later.
 *   - WARN under 2 GiB free, or under 10% free while under 20 GiB free (a
 *     volume that is both nearly full and small fills up quickly).
 *
 * MEMORY: warn when the machine has under 4 GB. Free memory is advisory only:
 * the OS counts its file cache as used, so a low number is normal.
 */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const DISK_WARN_FREE_BYTES = 2 * GiB;
export const DISK_WARN_FREE_FRACTION = 0.1;
/** The 10% rule only applies while free space is below this. */
export const DISK_FRACTION_RULE_BELOW_BYTES = 20 * GiB;

/**
 * The database's share of a first run: a new cluster (38 MB measured after
 * initdb, PG 18.6) and the WAL Postgres may keep between checkpoints
 * (`max_wal_size = 512MB` in the Vex conf block).
 */
export const DATABASE_MARGIN_BYTES = 512 * MiB + 64 * MiB;

/**
 * "4 GB" as machines are sold: the OS reports a 4 GB machine's memory as a
 * little under 4 GiB (firmware and GPU reservations), so the line is the
 * decimal 4e9 bytes, under which a 3 GB machine falls and a 4 GB one does not.
 */
export const MEMORY_WARN_TOTAL_BYTES = 4_000_000_000;

export interface DiskFacts {
  readonly freeBytes: number;
  readonly totalBytes: number;
  readonly modelVerified: boolean;
  /** Bytes the model download may still put on this volume (0 once verified). */
  readonly modelBytesToWrite: number;
}

export type DiskVerdict =
  | { readonly level: "ok" }
  | { readonly level: "warn"; readonly reason: "low_free" | "low_fraction" }
  /** `requiredBytes`: what the model and the database need free. */
  | { readonly level: "block"; readonly requiredBytes: number };

export function diskVerdict(facts: DiskFacts): DiskVerdict {
  const requiredBytes = facts.modelBytesToWrite + DATABASE_MARGIN_BYTES;
  if (!facts.modelVerified && facts.freeBytes < requiredBytes) return { level: "block", requiredBytes };
  if (facts.freeBytes < DISK_WARN_FREE_BYTES) return { level: "warn", reason: "low_free" };
  if (
    facts.freeBytes < DISK_FRACTION_RULE_BELOW_BYTES
    && facts.totalBytes > 0
    && facts.freeBytes / facts.totalBytes < DISK_WARN_FREE_FRACTION
  ) {
    return { level: "warn", reason: "low_fraction" };
  }
  return { level: "ok" };
}

export function memoryVerdict(totalBytes: number): "ok" | "warn" {
  return totalBytes < MEMORY_WARN_TOTAL_BYTES ? "warn" : "ok";
}
