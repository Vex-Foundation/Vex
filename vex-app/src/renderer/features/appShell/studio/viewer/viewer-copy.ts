/**
 * EVERY user-visible string in the file viewer.
 *
 * One module, for the same reason `explorer-copy.ts` is one module: a sentence
 * that lives beside the branch that raises it gets edited by whoever is
 * editing the branch, and the product's voice drifts a paragraph at a time.
 * Here they can be read together and reviewed as writing.
 *
 * ## What a refusal sentence has to do
 *
 * Main answers a read with a CODE (`@shared/schemas/files.ts`). The viewer's
 * job is to turn each one into a statement about THE FILE - never about Vex
 * failing - and to say what the person can do next when there is anything to
 * do. "That file is binary" is an answer; "Vex could not open the file" is a
 * shrug that happens to be shorter.
 *
 * ## No escape hatch is offered
 *
 * `too_large`, `binary`, `symlinked_path` and `not_a_file` are MAIN's refusals,
 * enforced in the privileged process against the bytes it actually read. There
 * is no "Open anyway" here and there must never be one: the renderer cannot
 * grant itself a capability main declined, and a button that appeared to would
 * be a lie about who decides. The copy therefore explains the refusal and
 * offers nothing that pretends to bypass it.
 */

import { FILE_READ_MAX_BYTES, type FilesErrorCode } from "@shared/schemas/files.js";

/** Header labels and actions. */
export const COPY_FILE_LABEL = "Copy file contents";
export const COPY_FILE_DONE = "Copied";
export const RETRY_LABEL = "Retry";
export const VIEWER_LOADING = "Reading file...";

/**
 * Bytes as a person reads them.
 *
 * Binary units (KiB/MiB), because the bound this is almost always shown next to
 * is `FILE_READ_MAX_BYTES`, which is 2 * 1024 * 1024. Printing "2.1 MB" beside
 * a limit called "2 MiB" would make a correct refusal look like an off-by-one.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 1 : 0)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`;
}

/** The read bound, spelled the way the refusal copy spells it. */
export const FILE_READ_MAX_LABEL = formatBytes(FILE_READ_MAX_BYTES);

/**
 * What a typed refusal says.
 *
 * Every member of `FilesErrorCode` that a READ can produce has its own
 * sentence. The listing-only codes (`invalid_cursor`, `not_a_directory`, the
 * watcher ones) are not reachable here and are covered by the fallback, which
 * is deliberately honest rather than reassuring.
 */
export function refusalText(code: FilesErrorCode, size: number | undefined): string {
  switch (code) {
    case "too_large":
      return size === undefined
        ? `This file is larger than ${FILE_READ_MAX_LABEL}, so Vex does not load it into the viewer.`
        : `This file is ${formatBytes(size)}, over the ${FILE_READ_MAX_LABEL} the viewer loads. Open it in another editor to read it.`;
    case "binary":
      return "This file looks binary, so there is no text to show. Vex checks the first bytes for a NUL and does not guess an encoding.";
    case "invalid_utf8":
      return "This file is not valid UTF-8, so Vex cannot show it as text without inventing characters.";
    case "not_found":
      return "This file is no longer on disk.";
    case "symlinked_path":
      return "Part of this path is a symbolic link. Vex does not follow links out of a project, so it will not open this file.";
    case "not_a_file":
      return "This path is not a regular file, so there is nothing to read.";
    case "project_closed":
      return "This project is closed, so its files cannot be read.";
    case "outside_project":
      return "This path resolves outside the project folder, so Vex will not open it.";
    case "invalid_node":
      return "This file reference has expired. Open the file again from the explorer.";
    case "root_unavailable":
      return "The projects folder is unavailable, so this file cannot be read.";
    case "io_error":
      return "The filesystem refused to read this file.";
    default:
      // Every remaining member belongs to the listing or watcher surfaces and
      // cannot reach a read. Naming the code beats a sentence that pretends to
      // know which one it was.
      return `This file could not be read (${code}).`;
  }
}

/** A read that never got an answer. Distinct from a refusal: retry is real. */
export const TRANSPORT_FAILED =
  "Vex could not reach the file service to read this file.";

/**
 * The file went away while the tab was open.
 *
 * `role="status"` rather than `alert`: nothing is broken and nothing is
 * required of the user. What matters is that the text on screen is now a
 * MEMORY, and saying so is the difference between stale content and a lie.
 */
export const ORPHANED_NOTICE =
  "This file was deleted on disk. Showing the last contents read.";

/** Why the code on screen has no colour. Each is a bound reporting itself. */
export type PlainReason =
  | "plain_language"
  | "too_large_to_highlight"
  | "grammar_unavailable"
  | "tokenize_failed"
  | "worker_failed"
  | "worker_unavailable"
  | "malformed_result"
  | "too_many_tokens";

export function plainReasonText(reason: PlainReason, size: number, bound: number): string {
  switch (reason) {
    case "plain_language":
      return "Not highlighted: no grammar for this file type.";
    case "too_large_to_highlight":
      return `Not highlighted: ${formatBytes(size)} is over the ${formatBytes(bound)} highlighting limit.`;
    case "grammar_unavailable":
      return "Not highlighted: this language's grammar could not be loaded.";
    case "tokenize_failed":
      return "Not highlighted: this file could not be tokenized.";
    case "worker_failed":
      return "Not highlighted: the highlighter stopped. It will be retried on the next file.";
    case "worker_unavailable":
      return "Not highlighted: the highlighter is unavailable.";
    case "malformed_result":
      return "Not highlighted: the highlighter returned a result Vex could not use.";
    case "too_many_tokens":
      return "Not highlighted: this file has too many syntax pieces to colour.";
  }
}

/**
 * How many lines were too long to tokenize.
 *
 * Shown WHENEVER the count is above zero, including on an otherwise fully
 * highlighted file, because those lines look plain and the user is owed the
 * reason. This is the reporting half of the long-line bound.
 */
export function longLinesText(count: number, maxLineLength: number): string {
  const lines = count === 1 ? "1 line is" : `${String(count)} lines are`;
  return `${lines} over ${String(maxLineLength)} characters and not highlighted.`;
}

/** The accessible name of the code area, so a screen reader can find it. */
export const CODE_REGION_LABEL = "File contents";
