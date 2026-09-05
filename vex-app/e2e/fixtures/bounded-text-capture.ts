/**
 * A BOUNDED TEXT BUFFER THAT REPORTS WHAT IT DROPPED.
 *
 * The e2e fixtures in this directory own real child processes whose stdout and
 * stderr are attacker-free but not size-free: a live `codex exec` turn writes
 * an unbounded JSONL stream, and a bridge that goes wrong can write to stderr
 * until the run dies of memory rather than of the defect. Rule 05 asks every
 * growing buffer for an explicit bound AND an explicit policy; the repository's
 * truncation rule asks that nothing be cut silently.
 *
 * THE POLICY, one for every caller here: keep the leading bytes up to
 * `limitBytes`, drop every chunk that no longer fits WHOLE, and count both the
 * bytes and the chunks dropped. Two consequences the callers depend on:
 *
 *  - a chunk is never kept in part, so a multi-byte character is never split
 *    and the retained text is always valid UTF-8 that the provider itself
 *    wrote;
 *  - `dropReport()` is empty exactly when nothing was lost, so a caller can
 *    append it to an evidence file or a failure message unconditionally and a
 *    clean run stays clean.
 *
 * This bounds RETENTION only. A caller that must not lose semantics decodes
 * the stream as it arrives (see `codex-live-runner.ts`, which parses each line
 * on the `data` event and keeps this capture purely for the archive).
 */

/** A bounded, self-reporting text accumulator. Not thread-shared; one owner. */
export interface BoundedTextCapture {
  /** Add a chunk. Kept whole when it fits, dropped whole and counted when not. */
  append(chunk: string): void;
  /** The retained leading text. */
  text(): string;
  /** UTF-8 bytes never retained. */
  droppedBytes(): number;
  /** Chunks never retained. */
  droppedChunks(): number;
  /**
   * A sentence naming exactly what was lost, or `""` when nothing was.
   *
   * Safe to concatenate unconditionally: a run within budget adds nothing.
   */
  dropReport(): string;
}

/**
 * @param label how this stream is named in the drop report, e.g. `codex stdout`.
 * @param limitBytes the retention bound in UTF-8 bytes; must be positive.
 */
export function createBoundedTextCapture(label: string, limitBytes: number): BoundedTextCapture {
  if (!Number.isInteger(limitBytes) || limitBytes <= 0) {
    throw new Error(`bounded capture "${label}" needs a positive byte limit, got ${String(limitBytes)}`);
  }
  const kept: string[] = [];
  let keptBytes = 0;
  let droppedBytes = 0;
  let droppedChunks = 0;

  return {
    append(chunk) {
      if (chunk === "") return;
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (keptBytes + bytes <= limitBytes) {
        kept.push(chunk);
        keptBytes += bytes;
        return;
      }
      droppedBytes += bytes;
      droppedChunks += 1;
    },
    text() {
      return kept.join("");
    },
    droppedBytes() {
      return droppedBytes;
    },
    droppedChunks() {
      return droppedChunks;
    },
    dropReport() {
      if (droppedChunks === 0) return "";
      return (
        `[${label}] bounded at ${String(limitBytes)} bytes: ` +
        `${String(droppedChunks)} chunk(s) totalling ${String(droppedBytes)} bytes were not retained`
      );
    },
  };
}
