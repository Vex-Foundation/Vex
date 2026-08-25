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

/** The server entry Vex owns, and the path it lives at. */
export interface StudioServerEntryWrite {
  readonly path: readonly string[];
  readonly value: Readonly<Record<string, StudioEntryValue>>;
}

/** Where this agent's server entry goes. The FIRST owned path, always. */
export function studioServerEntryWrite(
  agent: StudioWritableAgent,
  facts: StudioProjectFacts,
): StudioServerEntryWrite {
  const serverPath = agent.ownedPaths[0];
  if (serverPath === undefined) {
    throw new Error(`Studio agent ${agent.id} declares no owned path.`);
  }
  return { path: serverPath, value: studioEntryObject(agent, facts) };
}

/**
 * Read the list at an additional-write path, or say why it cannot be used.
 *
 * `absent` is the ordinary first-install state. `list` carries the user's own
 * elements, in file order, which a merge must return untouched. Anything else
 * is a shape Vex does not understand at a path the user owns, and the ONLY safe
 * move there is to refuse by name: a string where a list belongs might be this
 * client's older single-file spelling, and coercing it would delete the user's
 * setting while looking like a successful install.
 */
type OwnedList =
  | { readonly kind: "absent" }
  | { readonly kind: "list"; readonly members: readonly string[] }
  | { readonly kind: "unusable"; readonly detail: string };

function readOwnedList(text: string, path: readonly string[]): OwnedList {
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (root === undefined) return { kind: "absent" };
  const node = findNodeAtLocation(root, [...path]);
  if (node === undefined) return { kind: "absent" };

  const label = path.join(".");
  if (node.type !== "array") {
    return {
      kind: "unusable",
      detail: `"${label}" holds a JSON ${node.type}, not a list, so Vex cannot add `
        + "its entry without replacing a setting it does not own",
    };
  }
  const members: string[] = [];
  for (const child of node.children ?? []) {
    if (child.type !== "string" || typeof child.value !== "string") {
      return {
        kind: "unusable",
        detail: `"${label}" contains a non-string element, so Vex cannot tell which `
          + "entry is its own",
      };
    }
    members.push(child.value);
  }
  return { kind: "list", members };
}

/** The complete contents of a config file Vex creates from nothing. */
export function renderFreshJsonConfig(
  agent: StudioWritableAgent,
  facts: StudioProjectFacts,
): StudioRenderResult {
  const server = studioServerEntryWrite(agent, facts);
  let text = applyEdits("{}\n", modify("{}\n", [...server.path], server.value, {
    formattingOptions: FORMATTING,
  }));
  for (const write of agent.additionalWrites) {
    // A fresh file has no list of the user's, so the membership set is exactly
    // Vex's one element.
    text = applyEdits(text, modify(text, [...write.path], [write.member], {
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
  const rootFailure = describeNonObjectRoot(existing);
  if (rootFailure !== undefined) return refused("malformed_json", rootFailure);

  const server = studioServerEntryWrite(agent, facts);
  let text = applyEdits(existing, modify(existing, [...server.path], server.value, {
    formattingOptions: FORMATTING,
  }));

  for (const write of agent.additionalWrites) {
    // SET MEMBERSHIP, not assignment. The user's other entries in this list are
    // theirs; Vex guarantees only that its own member is present, and a member
    // that is already there is left exactly where it is rather than moved to
    // the end.
    const current = readOwnedList(text, write.path);
    if (current.kind === "unusable") return refused("malformed_json", current.detail);
    if (current.kind === "list" && current.members.includes(write.member)) continue;
    const next = current.kind === "list"
      ? [...current.members, write.member]
      : [write.member];
    text = applyEdits(text, modify(text, [...write.path], next, {
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
  const rootFailure = describeNonObjectRoot(existing);
  if (rootFailure !== undefined) return refused("malformed_json", rootFailure);

  const root = parseTree(existing);
  if (root === undefined) return { status: "unchanged" };

  // The server entry's own wrapper (`mcpServers`, `mcp`, `amp.mcpServers`) is
  // NEVER pruned: an empty one is a state a user's file can legitimately be in,
  // and other tools write into that same key.
  const serverWrapper = agent.ownedPaths[0]?.slice(0, -1) ?? [];

  let text = existing;

  const server = studioServerEntryWrite(agent, facts);
  if (findNodeAtLocation(root, [...server.path]) !== undefined) {
    text = applyEdits(text, modify(text, [...server.path], undefined, {
      formattingOptions: FORMATTING,
    }));
    text = pruneEmptyAncestors(text, server.path, serverWrapper);
  }

  for (const write of agent.additionalWrites) {
    // Take back ONE ELEMENT, never the list. A deselect that emptied
    // `context.fileName` would delete whatever else the user had asked Gemini
    // to read - a setting Vex never wrote and has no standing to remove.
    const current = readOwnedList(text, write.path);
    if (current.kind === "unusable") return refused("malformed_json", current.detail);
    if (current.kind === "absent") continue;
    if (!current.members.includes(write.member)) continue;

    const remaining = current.members.filter((member) => member !== write.member);
    if (remaining.length > 0) {
      text = applyEdits(text, modify(text, [...write.path], remaining, {
        formattingOptions: FORMATTING,
      }));
      continue;
    }
    // Nothing of the user's was in the list, so the list itself was Vex's and
    // goes with the element, along with any wrapper it was the sole occupant of.
    text = applyEdits(text, modify(text, [...write.path], undefined, {
      formattingOptions: FORMATTING,
    }));
    text = pruneEmptyAncestors(text, write.path, serverWrapper);
  }

  text = ensureTrailingNewline(text);
  return text === existing ? { status: "unchanged" } : rendered(text);
}

/**
 * Drop ancestors of `path` that Vex's own value was the only occupant of, so a
 * remove leaves no `"context": {}` residue behind.
 *
 * An ancestor that still holds anything of the user's is left exactly as it is,
 * and `serverWrapper` (`mcpServers`, `mcp`, `amp.mcpServers`) is never pruned
 * even when empty: that key is not ours and other tools write into it.
 */
function pruneEmptyAncestors(
  text: string,
  path: readonly string[],
  serverWrapper: readonly string[],
): string {
  let next = text;
  for (let depth = path.length - 1; depth >= 1; depth--) {
    const ancestor = path.slice(0, depth);
    if (samePath(ancestor, serverWrapper)) break;
    const current = parseTree(next);
    const node = current === undefined ? undefined : findNodeAtLocation(current, [...ancestor]);
    if (node === undefined || node.type !== "object" || (node.children ?? []).length > 0) break;
    next = applyEdits(next, modify(next, [...ancestor], undefined, {
      formattingOptions: FORMATTING,
    }));
  }
  return next;
}

/**
 * `undefined` when the text parses as JSONC, otherwise a reportable reason.
 *
 * A file holding ONLY whitespace is not a parse failure here, and that
 * exception is the contract rather than a leniency: a zero-byte file has no
 * content to preserve, which makes it identical to an absent file for every
 * question this module asks. Vex installs into it exactly as it would create
 * it, and nothing of the user's is overwritten because there is nothing there.
 * The root-shape gate below is the one that refuses `[]`, `"text"` and `42` -
 * documents that DO hold a value, one a rewrite would destroy.
 */
function describeJsonParseFailure(text: string): string | undefined {
  if (text.trim() === "") return undefined;
  const errors: ParseError[] = [];
  parseTree(text, errors, { allowTrailingComma: true });
  const first = errors[0];
  if (first === undefined) return undefined;
  return `${printParseErrorCode(first.error)} at offset ${String(first.offset)}`;
}

/**
 * `undefined` when the document's ROOT is a JSON object, otherwise a reason.
 *
 * `parseTree` accepts any JSON value as a document, so `[]`, `"text"`, `42` and
 * `null` all parse without a single `ParseError`. `modify()` would then happily
 * build an edit that turns the user's array (or their string) into an object
 * with `mcpServers` in it - a well-formed rewrite that destroys the whole file.
 * Every config in the registry is an object at the root, so anything else is a
 * file we do not understand and must not touch.
 */
function describeNonObjectRoot(text: string): string | undefined {
  const root = parseTree(text, [], { allowTrailingComma: true });
  // NO ROOT AT ALL is the whitespace-only file, and it passes: there is no
  // value here for a rewrite to destroy, so it installs like the absent file
  // it is equivalent to. See `describeJsonParseFailure`, which lets it through
  // deliberately. Everything below this line is about a document that DOES
  // hold a value.
  if (root === undefined) return undefined;
  if (root.type !== "object") {
    return `the file's top level is a JSON ${root.type}, not an object`;
  }
  return undefined;
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, i) => segment === right[i]);
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
