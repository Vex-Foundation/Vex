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
import { languageLabel, type ViewerLanguageId } from "./highlight/language-of-path.js";

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
    case "path_changed":
      return "This file was replaced while Vex was opening it, so Vex stopped rather than show bytes from something else. Open it again to read the file that is there now.";
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

/**
 * WHAT THE HEADER CALLS THIS FILE.
 *
 * Normally the language the path implies. On a REFUSED read it is the kind MAIN
 * DETECTED, when the refusal names one: a file main declined because its first
 * bytes hold a NUL is a binary, and labelling it `Plain text` - which is what
 * the path-derived language says for an extension no grammar claims - is the
 * header contradicting the body of the same panel (audit A13). Only `binary`
 * carries a detected kind; every other refusal is about the path, the size or
 * the filesystem and says nothing about what the file IS, so those keep the
 * path-derived label.
 */
export const BINARY_KIND_LABEL = "Binary";

export function viewerKindLabel(
  language: ViewerLanguageId,
  refusalCode: FilesErrorCode | null,
): string {
  if (refusalCode === "binary") return BINARY_KIND_LABEL;
  return languageLabel(language);
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

/**
 * Whether this reason is the ORDINARY state of the file rather than a bound
 * Vex hit or a failure it had.
 *
 * Only `plain_language`, and the difference decides how loudly it is said. A
 * `.txt`, a `.env` or a Makefile has no grammar BY NATURE - there is nothing
 * that could have gone better - so announcing it as a status chip on every
 * plain file trains the user to ignore the row that also carries "the
 * highlighter stopped" (audit A11). The expected case becomes quiet secondary
 * copy under the header; everything else keeps the chip and its announcement.
 */
export function plainReasonIsExpected(reason: PlainReason): boolean {
  return reason === "plain_language";
}

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
 *
 * The bound is printed with thousands separators. It is a five-digit number
 * (20000) sitting in a sentence, and `20,000 characters` is read at a glance
 * where `20000 characters` has to be counted (audit A12). `toLocaleString` is
 * not used: the separator would then depend on the machine's locale while every
 * other number in this module is written in one voice.
 */
export function longLinesText(count: number, maxLineLength: number): string {
  const lines = count === 1 ? "1 line is" : `${String(count)} lines are`;
  return `${lines} over ${groupDigits(maxLineLength)} characters and not highlighted.`;
}

/**
 * PARTLY HIGHLIGHTED: the lines whose colouring ran out of clock.
 *
 * The bound this reports is the one that used to be invisible. vscode-textmate
 * stops scanning a line once it has spent the per-line budget on it and hands
 * back what it has, so the line keeps every byte and loses the colours after
 * that point - and before this sentence existed the viewer showed it as if it
 * were finished. A row that is half coloured and half grey, with nothing said,
 * is a highlighter the user is right to stop trusting.
 *
 * It names the FIRST line so there is somewhere to go and look. The count is
 * the exact number of lines, never the length of the list the worker sends: the
 * list is bounded at fifty numbers and the count is not, so on a file with two
 * hundred such lines this still says two hundred.
 */
export function partlyHighlightedText(total: number, firstLine: number): string {
  const lines = total === 1 ? "1 line" : `${groupDigits(total)} lines`;
  return `Partly highlighted: ${lines} ran out of highlighting time, first at line ${groupDigits(firstLine)}.`;
}

/**
 * The quieter half of the same fact: what the budget IS, and what was kept.
 *
 * Separate from the sentence above because it answers a different question. The
 * first says WHICH lines; this says why it is not a failure and what is on
 * screen - the colours found before the clock ran out are real, and the text is
 * complete. Nothing was cut; only colouring stopped.
 */
export function highlightBudgetNote(budgetMs: number): string {
  return `Vex colours each line for at most ${budgetInWords(budgetMs)} and keeps what it found by then. Every character is still there.`;
}

/**
 * The budget as a person would say it.
 *
 * Written in words rather than printed as a number because the sentence it sits
 * in is an explanation, not a measurement: "half a second" is read, "500 ms" is
 * decoded. The three branches cover the value we ship (500) and the two shapes a
 * future one could take, so changing the constant changes the sentence instead
 * of breaking it.
 */
function budgetInWords(budgetMs: number): string {
  if (budgetMs === 500) return "half a second";
  if (budgetMs % 1_000 === 0) {
    const seconds = budgetMs / 1_000;
    return seconds === 1 ? "one second" : `${groupDigits(seconds)} seconds`;
  }
  return `${groupDigits(budgetMs)} milliseconds`;
}

/** `20000` as `20,000`. Whole non-negative numbers only, which is all we pass. */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The accessible name of the code area, so a screen reader can find it. */
export const CODE_REGION_LABEL = "File contents";
