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
import {
  PLAIN_LANGUAGE,
  languageLabel,
  type ViewerLanguageId,
} from "./highlight/language-of-path.js";

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
 * Normally the language the path implies. ON A REFUSED READ IT IS THE KIND THE
 * REFUSAL NAMES, because the path-derived language is a claim about content
 * that was never shown: a `.png` main declined as `invalid_utf8` has no
 * extension any grammar claims, so the header read `Plain text` directly above
 * a body saying the bytes are not text at all (audit A13, measured on
 * `assets/image.png`). One panel, two answers, and the wrong one on top.
 *
 * The table covers exactly the refusals that SAY WHAT THE THING IS - what it
 * contains, how big it is, what kind of entry it is - and each word is the
 * refusal sentence's own word, so the header and the body agree. Every other
 * refusal is about the environment (a closed project, an unavailable root, a
 * filesystem error, an expired token, a file replaced mid-read) and says
 * nothing about the file, so those keep the path-derived label rather than
 * inventing a detection nobody made.
 */
const REFUSAL_KIND_LABELS: Partial<Record<FilesErrorCode, string>> = {
  // Main read the first bytes and found a NUL. This is a detection.
  binary: "Binary",
  // Main decoded the bytes and they are not text. Not the same statement as
  // `binary` and deliberately not spelled as one: no NUL was found, so calling
  // it binary would report evidence that was never collected.
  invalid_utf8: "Not UTF-8",
  // A fact about the size, which is the only thing this read established.
  too_large: "Too large",
  symlinked_path: "Symbolic link",
  not_a_file: "Not a file",
  not_found: "Missing",
};

/** The kind word for a refusal, or `null` when the refusal names no kind. */
export function refusalKindLabel(code: FilesErrorCode): string | null {
  return REFUSAL_KIND_LABELS[code] ?? null;
}

export function viewerKindLabel(
  language: ViewerLanguageId,
  refusalCode: FilesErrorCode | null,
): string {
  if (refusalCode !== null) {
    const kind = refusalKindLabel(refusalCode);
    if (kind !== null) return kind;
  }
  return languageLabel(language);
}

/* ------------------------------------------------------------------ *
 * Reveal in the file manager
 * ------------------------------------------------------------------ */

/**
 * The one action the header's kind menu offers.
 *
 * PLATFORM-NEUTRAL WORDING, and a deliberate departure from the reference. VS
 * Code switches this label per platform - "Reveal in File Explorer", "Reveal in
 * Finder", "Open Containing Folder"
 * (`files/electron-browser/fileActions.contribution.ts:28`) - which it can do
 * because its label is built in the process that knows the platform. This
 * string is renderer copy in a product whose Studio surface names no platform
 * anywhere else, and one sentence that is true on all three beats three
 * sentences kept in step by hand. It is EXPORTED so the explorer's row menu can
 * import the same string rather than spell a second one; until that row exists,
 * this is the only place the sentence is written.
 */
export const REVEAL_IN_FILE_MANAGER_LABEL = "Reveal in file manager";

/** The accessible name of the header's kind button, which opens that menu. */
export const KIND_MENU_LABEL = "File actions";

/**
 * Why a reveal did not happen.
 *
 * Only the resolution can refuse: main either resolved the node and asked the
 * desktop, or it did not get that far. There is deliberately no sentence for
 * "the file manager did not open" - the platform reports nothing back, and a
 * message claiming to know would be invented.
 */
export function revealRefusalText(code: FilesErrorCode): string {
  switch (code) {
    case "not_found":
      return "This file is no longer on disk, so there is nothing to show.";
    case "symlinked_path":
      return "Part of this path is a symbolic link, so Vex will not point the file manager at it.";
    case "outside_project":
      return "This path resolves outside the project folder, so Vex will not show it.";
    case "project_closed":
      return "This project is closed, so its files cannot be shown.";
    case "invalid_node":
      return "This file reference has expired. Open the file again from the explorer.";
    case "root_unavailable":
      return "The projects folder is unavailable, so this file cannot be shown.";
    case "io_error":
      return "The filesystem refused to resolve this file.";
    default:
      // Naming the code beats a sentence that pretends to know which refusal
      // this was; the remaining members belong to other surfaces.
      return `Vex could not show this file in the file manager (${code}).`;
  }
}

/** A reveal the file service never answered. Distinct from a refusal. */
export const REVEAL_TRANSPORT_FAILED =
  "Vex could not reach the file service to show this file.";

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
 * Does this file's kind have a grammar at all?
 *
 * THE PREDICATE READS THE LANGUAGE RESOLUTION, not the highlighter's report,
 * because it is answering a question about the FILE: `language-of-path.ts`
 * resolved a `.txt`, a `.env` or a Makefile to {@link PLAIN_LANGUAGE}, which
 * means no grammar was ever going to run. Nothing happened, nothing was cut and
 * nothing is bounded, so there is no state to report - and the header already
 * says `Plain text`, which is the whole answer.
 *
 * Announcing "Not highlighted: no grammar for this file type" on every plain
 * file is the noise audit A11 measured twice: first as a status chip, then as
 * quiet copy that still put a grammar sentence on a file with no grammar. The
 * viewer now says NOTHING there. Every reason that is a bound Vex hit or a
 * failure it had keeps its chip, which is what the chip is for.
 */
export function languageHasNoGrammar(language: ViewerLanguageId): boolean {
  return language === PLAIN_LANGUAGE;
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
