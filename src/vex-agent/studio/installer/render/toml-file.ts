/**
 * TOML config rendering: fresh, MERGE-NOT-CLOBBER, and remove, by SECTION-LEVEL
 * TEXT REPLACEMENT.
 *
 * WHY TEXT AND NOT A TOML AST. These files (`.codex/config.toml`,
 * `.grok/config.toml`, `.vibe/config.toml`) are human-authored, comment-rich,
 * and carry sections whose semantics Vex must not touch - most sharply Grok's
 * `[permission]`, which can GRANT tool authority. A serializing round trip
 * through any TOML library rewrites the whole document: comments move or die,
 * key order changes, and a foreign `[permission]` block comes back out in the
 * library's spelling rather than the user's. Replacing exactly one section's
 * TEXT leaves every other byte of the file identical, which is precisely the
 * invariant the tests assert.
 *
 * THE ONE CASE THIS CANNOT DO SAFELY is a multi-line string. A `[header]` inside
 * a `"""..."""` literal is indistinguishable from a real section header without
 * a full parser, so a file containing one is REFUSED rather than risked. That is
 * a named, reported limitation, not a silent skip.
 *
 * Vex owns exactly ONE section per file and rewrites it wholesale from the
 * closed key allowlist, so a stale key inside our own section cannot survive a
 * merge - while everything outside it always does.
 */

import { parse as parseToml } from "smol-toml";

import type { StudioWritableAgent } from "../../agents.js";
import { STUDIO_SERVER_KEY } from "../../agents.js";
import { buildStudioEntryFields, type StudioEntryValue } from "./entry.js";
import type { StudioProjectFacts, StudioRenderResult } from "./facts.js";
import { refused, rendered } from "./facts.js";

/** A top-level TOML section: its header line plus every line up to the next header. */
interface TomlBlock {
  /**
   * Blank lines that separate this block from the PREVIOUS one. Always empty
   * for a block parsed out of an existing file (there, the separation belongs to
   * the previous block's `trailingBlanks`); set only on a block Vex APPENDS, so
   * that removing that block later takes its separator with it and the file
   * returns to exactly the bytes it started with.
   */
  readonly leadingBlanks: readonly string[];
  /** `undefined` for the preamble before the first header. */
  readonly header: string | undefined;
  /** Content lines, excluding the header and excluding trailing blank lines. */
  readonly body: readonly string[];
  /** Blank lines that separated this block from the next. Preserved verbatim. */
  readonly trailingBlanks: readonly string[];
}

/** Matches a top-level `[table]` or `[[array.of.tables]]` header line. */
const HEADER = /^\s*\[\[?[^[\]]+\]\]?\s*(?:#.*)?$/;

/** The section header Vex owns in this agent's file. */
export function studioTomlHeader(agent: StudioWritableAgent): string {
  return agent.dialect === "mcp-servers-toml-array"
    ? "[[mcp_servers]]"
    : `[mcp_servers.${STUDIO_SERVER_KEY}]`;
}

/** The complete text of the Vex section, header included, newline-terminated. */
export function renderStudioTomlSection(
  agent: StudioWritableAgent,
  facts: StudioProjectFacts,
): string {
  const literal = agent.timeout.kind === "server-entry-field" ? agent.timeout.literal : "integer";
  const lines = [studioTomlHeader(agent)];
  for (const [key, value] of buildStudioEntryFields(agent, facts)) {
    lines.push(`${key} = ${tomlValue(value, literal)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderFreshTomlConfig(
  agent: StudioWritableAgent,
  facts: StudioProjectFacts,
): StudioRenderResult {
  return rendered(renderStudioTomlSection(agent, facts));
}

export function mergeTomlConfig(
  existing: string,
  agent: StudioWritableAgent,
  facts: StudioProjectFacts,
): StudioRenderResult {
  const parseFailure = describeTomlParseFailure(existing);
  if (parseFailure !== undefined) return refused("malformed_toml", parseFailure);

  const blocks = splitTomlBlocks(existing);
  if (typeof blocks === "string") return refused("toml_multiline_string", blocks);

  const section = renderStudioTomlSection(agent, facts).replace(/\n$/, "").split("\n");
  const index = blocks.findIndex((block) => isStudioBlock(block, agent));
  const next = [...blocks];

  if (index === -1) {
    // Separate an appended section from whatever preceded it, unless the file
    // already ends in a blank line. The separator belongs to the APPENDED block
    // so that a later remove takes it away again.
    const previous = next[next.length - 1];
    const needsSeparator = previous !== undefined && previous.trailingBlanks.length === 0
      && !(previous.header === undefined && previous.body.length === 0);
    next.push({
      leadingBlanks: needsSeparator ? [""] : [],
      header: section[0],
      body: section.slice(1),
      trailingBlanks: [],
    });
  } else {
    const current = blocks[index];
    if (current === undefined) throw new Error("unreachable: index came from findIndex");
    next[index] = {
      leadingBlanks: current.leadingBlanks,
      header: section[0],
      body: section.slice(1),
      trailingBlanks: current.trailingBlanks,
    };
  }

  const text = joinTomlBlocks(next);
  return text === existing ? { status: "unchanged" } : rendered(text);
}

export function removeTomlConfig(
  existing: string,
  agent: StudioWritableAgent,
): StudioRenderResult {
  const parseFailure = describeTomlParseFailure(existing);
  if (parseFailure !== undefined) return refused("malformed_toml", parseFailure);

  const blocks = splitTomlBlocks(existing);
  if (typeof blocks === "string") return refused("toml_multiline_string", blocks);

  const index = blocks.findIndex((block) => isStudioBlock(block, agent));
  if (index === -1) return { status: "unchanged" };

  const remaining = blocks.filter((_, position) => position !== index);
  // A section Vex APPENDED was introduced by one blank separator line. After a
  // round trip through text that separator is indistinguishable from the
  // previous block's own trailing blank, so removing the LAST block also drops
  // exactly one trailing blank line - otherwise every install/uninstall cycle
  // would grow the file by a newline. The one nuance this cannot recover: a
  // file that ALREADY ended in a blank line before Vex ever touched it loses
  // that blank line here. Whitespace at end of file, never content.
  const last = remaining[remaining.length - 1];
  if (index === blocks.length - 1 && last !== undefined && last.trailingBlanks.length > 0) {
    remaining[remaining.length - 1] = {
      ...last,
      trailingBlanks: last.trailingBlanks.slice(0, -1),
    };
  }

  const text = joinTomlBlocks(remaining);
  return text === existing ? { status: "unchanged" } : rendered(text);
}

/** Is this the block Vex owns? Identity differs by dialect. */
function isStudioBlock(block: TomlBlock, agent: StudioWritableAgent): boolean {
  if (block.header === undefined) return false;
  const header = block.header.trim().replace(/\s*#.*$/, "");

  if (agent.dialect === "mcp-servers-toml-array") {
    // An array-of-tables has no key in its header, so the REQUIRED `name` field
    // is what identifies our element among the user's other servers.
    if (header !== "[[mcp_servers]]") return false;
    return block.body.some((line) => /^\s*name\s*=\s*["']vex["']\s*$/.test(line));
  }
  return header === studioTomlHeader(agent);
}

/**
 * `undefined` when `text` is valid TOML, otherwise a reportable reason.
 *
 * WHY A REAL PARSER RUNS BEFORE A TEXT REWRITE. `splitTomlBlocks` is a line
 * scanner: it finds `[header]` lines and copies everything else through
 * untouched. That is exactly what preserves the user's comments and key order,
 * and it is also why it CANNOT NOTICE that the file is broken. A config with an
 * unterminated string, a duplicate key or a duplicate table sailed straight
 * through it, got a `[mcp_servers.vex]` section appended, and was handed back to
 * a client that then failed to parse the whole file - with Vex's own section
 * sitting at the bottom of it, looking like the cause. `malformed_toml` was
 * DECLARED in the refusal set for precisely this and nothing ever emitted it.
 *
 * The parser is used as a VALIDATOR ONLY. Nothing is ever serialized back
 * through it: a round trip would rewrite the whole document in the library's
 * spelling and destroy the comments and ordering this module exists to keep.
 *
 * The refusal names the LINE AND COLUMN, never `TomlError.codeblock` - that
 * field quotes the user's own bytes back, and a refusal detail travels to the
 * renderer and the logs. Position is what makes the error actionable; content
 * is what makes it a leak.
 */
function describeTomlParseFailure(text: string): string | undefined {
  try {
    parseToml(text);
    return undefined;
  } catch (cause) {
    const at = tomlErrorPosition(cause);
    return at === null
      ? "the file is not valid TOML"
      : `the file is not valid TOML (line ${String(at.line)}, column ${String(at.column)})`;
  }
}

/** `line`/`column` off a `TomlError`, duck-typed so a duplicated copy still works. */
function tomlErrorPosition(cause: unknown): { line: number; column: number } | null {
  if (typeof cause !== "object" || cause === null) return null;
  const { line, column } = cause as { line?: unknown; column?: unknown };
  return typeof line === "number" && typeof column === "number" ? { line, column } : null;
}

/** Blocks, or a string describing why the text cannot be edited by text. */
function splitTomlBlocks(text: string): TomlBlock[] | string {
  if (text.includes('"""') || text.includes("'''")) {
    return "the file contains a multi-line string, which a section-level text "
      + "rewrite cannot distinguish from a section header";
  }

  const lines = text.split("\n");
  // A trailing newline yields a final empty element; drop it and re-add on join.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const blocks: TomlBlock[] = [];
  let header: string | undefined;
  let body: string[] = [];

  const flush = (): void => {
    if (header === undefined && body.length === 0 && blocks.length === 0) return;
    let end = body.length;
    while (end > 0 && (body[end - 1] ?? "").trim() === "") end--;
    blocks.push({
      leadingBlanks: [],
      header,
      body: body.slice(0, end),
      trailingBlanks: body.slice(end),
    });
  };

  for (const line of lines) {
    if (HEADER.test(line)) {
      flush();
      header = line;
      body = [];
      continue;
    }
    body.push(line);
  }
  flush();

  return blocks;
}

function joinTomlBlocks(blocks: readonly TomlBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    lines.push(...block.leadingBlanks);
    if (block.header !== undefined) lines.push(block.header);
    lines.push(...block.body, ...block.trailingBlanks);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** TOML literal for the closed set of values a Vex entry can hold. */
function tomlValue(value: StudioEntryValue, numberLiteral: "integer" | "float"): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "number") {
    return numberLiteral === "float" && Number.isInteger(value)
      ? `${String(value)}.0`
      : String(value);
  }
  return `[${value.map(tomlString).join(", ")}]`;
}

/**
 * A TOML BASIC STRING, escaped to the specification rather than to the set of
 * characters we expect.
 *
 * TOML 1.0 forbids every unescaped control character (U+0000-U+0008,
 * U+000A-U+001F, U+007F) inside a basic string. Escaping only `\` and `"` was
 * betting that an absolute filesystem path and a UUID never contain one - a bet
 * about a value that arrives from `locateStudioBridge()`, i.e. from the
 * filesystem. A newline or a tab in a bridge path would have emitted a config
 * that is not TOML at all, and the client would fail to start with a parse
 * error naming the user's own file.
 *
 * The named escapes come first (they are what a human reads), then `\uXXXX` for
 * the rest of the control range. DEL (U+007F) is included: TOML's `basic-char`
 * production stops at U+007E.
 */
function tomlString(value: string): string {
  const escaped = value.replace(
    // The control range IS the subject, so it is written as an explicit codepoint
    // range rather than as literal control bytes in this source file.
    /[\\"\u0000-\u001F\u007F]/gu,
    (character) => TOML_ESCAPES[character] ?? unicodeEscape(character),
  );
  return `"${escaped}"`;
}

const TOML_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  "\"": "\\\"",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
};

function unicodeEscape(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
}
