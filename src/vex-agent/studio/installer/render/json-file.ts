/**
 * JSON and JSONC config rendering: fresh, MERGE-NOT-CLOBBER, and remove.
 *
 * All three operations are pure text -> text. Nothing here touches a
 * filesystem; A5b owns reading the old bytes and writing the new ones.
 *
 * WHY `jsonc-parser` AND NOT `JSON.parse` + `JSON.stringify`. Several of these
 * clients read JSONC, and every one of these files is a file a HUMAN edits.
 * Round-tripping through `JSON.parse` would silently delete the user's comments
 * and rewrite their formatting on a merge whose only intent was to add one
 * server entry. `modify()` returns minimal EDITS against the original text, so
 * everything outside the Vex-owned paths - comments, key order, indentation
 * style, trailing content - survives byte for byte. That is the whole reason
 * the dependency exists (spec: "Dependency: `jsonc-parser`").
 *
 * A malformed existing file is REFUSED, never repaired and never overwritten:
 * the user's bytes stay as they are and the reason travels to them.
 */

import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parseTree,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";

import type { StudioWritableAgent } from "../../agents.js";
import { studioEntryObject, type StudioEntryValue } from "./entry.js";
import type { StudioProjectFacts, StudioRenderResult } from "./facts.js";
import { refused, rendered } from "./facts.js";

/** Two-space, LF, spaces-not-tabs: the shape every golden in this repo has. */
const FORMATTING: FormattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" };

/** A value Vex owns at one path in one file. */
export interface StudioOwnedWrite {
  readonly path: readonly string[];
  readonly value: Readonly<Record<string, StudioEntryValue>> | readonly string[];
}

/**
 * Every path/value pair Vex owns in this agent's file, server entry FIRST.
 *
 * The order matters for `remove` only in that it is deterministic; each write is
 * independent.
 */
export function studioOwnedWrites(
  agent: StudioWritableAgent,
  facts: StudioProjectFacts,
): readonly StudioOwnedWrite[] {
  const serverPath = agent.ownedPaths[0];
  if (serverPath === undefined) {
    throw new Error(`Studio agent ${agent.id} declares no owned path.`);
  }
  return [
    { path: serverPath, value: studioEntryObject(agent, facts) },
    ...agent.additionalWrites.map((write) => ({ path: write.path, value: write.value })),
  ];
}

/** The complete contents of a config file Vex creates from nothing. */
export function renderFreshJsonConfig(
  agent: StudioWritableAgent,
  facts: StudioProjectFacts,
): StudioRenderResult {
  let text = "{}\n";
  for (const write of studioOwnedWrites(agent, facts)) {
    text = applyEdits(text, modify(text, [...write.path], write.value, {
      formattingOptions: FORMATTING,
    }));
  }
  return rendered(ensureTrailingNewline(text));
}

/**
 * Add or update the Vex-owned paths in an EXISTING file.
 *
 * Everything outside those paths is preserved verbatim, including comments and
 * keys Vex has never heard of.
 */
export function mergeJsonConfig(
  existing: string,
  agent: StudioWritableAgent,
  facts: StudioProjectFacts,
): StudioRenderResult {
  const parseFailure = describeJsonParseFailure(existing);
  if (parseFailure !== undefined) return refused("malformed_json", parseFailure);

  let text = existing;
  for (const write of studioOwnedWrites(agent, facts)) {
    text = applyEdits(text, modify(text, [...write.path], write.value, {
      formattingOptions: FORMATTING,
    }));
  }
  text = ensureTrailingNewline(text);
  return text === existing ? { status: "unchanged" } : rendered(text);
}

/**
 * Delete ONLY the Vex-owned paths, leaving every other byte untouched.
 *
 * A now-empty SERVER WRAPPER (`"mcpServers": {}`) is deliberately KEPT: that key
 * is not ours, other tools write into it, and an empty one is a state a user's
 * file can legitimately be in. Any OTHER ancestor that Vex's value was the sole
 * occupant of is pruned, so a remove leaves no `"context": {}` residue.
 */
export function removeJsonConfig(
  existing: string,
  agent: StudioWritableAgent,
  facts: StudioProjectFacts,
): StudioRenderResult {
  const parseFailure = describeJsonParseFailure(existing);
  if (parseFailure !== undefined) return refused("malformed_json", parseFailure);

  const root = parseTree(existing);
  if (root === undefined) return { status: "unchanged" };

  // The server entry's own wrapper (`mcpServers`, `mcp`, `amp.mcpServers`) is
  // NEVER pruned: an empty one is a state a user's file can legitimately be in,
  // and other tools write into that same key.
  const serverWrapper = agent.ownedPaths[0]?.slice(0, -1) ?? [];

  let text = existing;
  for (const write of studioOwnedWrites(agent, facts)) {
    if (findNodeAtLocation(root, [...write.path]) === undefined) continue;
    text = applyEdits(text, modify(text, [...write.path], undefined, {
      formattingOptions: FORMATTING,
    }));

    // Prune ancestors that Vex's own value was the only occupant of, so a
    // remove leaves no `"context": {}` residue behind. An ancestor that still
    // holds anything of the user's is left exactly as it is.
    for (let depth = write.path.length - 1; depth >= 1; depth--) {
      const ancestor = write.path.slice(0, depth);
      if (samePath(ancestor, serverWrapper)) break;
      const current = parseTree(text);
      const node = current === undefined ? undefined : findNodeAtLocation(current, [...ancestor]);
      if (node === undefined || node.type !== "object" || (node.children ?? []).length > 0) break;
      text = applyEdits(text, modify(text, [...ancestor], undefined, {
        formattingOptions: FORMATTING,
      }));
    }
  }
  text = ensureTrailingNewline(text);
  return text === existing ? { status: "unchanged" } : rendered(text);
}

/** `undefined` when the text parses as JSONC, otherwise a reportable reason. */
function describeJsonParseFailure(text: string): string | undefined {
  const errors: ParseError[] = [];
  parseTree(text, errors, { allowTrailingComma: true });
  const first = errors[0];
  if (first === undefined) return undefined;
  return `${printParseErrorCode(first.error)} at offset ${String(first.offset)}`;
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, i) => segment === right[i]);
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
