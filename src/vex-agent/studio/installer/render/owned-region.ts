/**
 * Reading back the region of a config file Vex claims to own.
 *
 * The renderers write. This module READS, and it exists for two questions A5b
 * must answer before it writes anything:
 *
 *   1. OWNERSHIP. "Something already sits at `mcpServers.vex`. Is it what Vex
 *      last wrote, or did another tool claim that name?" The privileged
 *      provenance store holds the digest of what Vex last wrote; this module
 *      produces the digest of what is there NOW, over the same normalized text,
 *      so the two are comparable. A mismatch is a COLLISION and refuses.
 *   2. UNKNOWN KEYS INSIDE OUR ENTRY. A provenance-proven Vex entry that has
 *      grown a key Vex never writes (`autoApprove`, `tools`, `env`) is not
 *      simply stale: somebody added authority to a server entry we are about
 *      to rewrite. The keys are reported BY NAME so the refusal says what was
 *      found, instead of the rewrite silently deleting it and hiding that an
 *      attempt was made.
 *
 * The digest is over a NORMALIZED rendering (keys in file order, whitespace
 * collapsed), not over raw bytes. Reformatting a config with a JSON formatter
 * must not read as "someone else owns this entry" - it is the CONTENT of the
 * entry that proves ownership, not the user's indentation.
 */

import { createHash } from "node:crypto";
import { findNodeAtLocation, parseTree, type Node } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

import type { StudioWritableAgent } from "../../agents.js";
import { STUDIO_ENTRY_KEY_ALLOWLIST } from "./entry.js";
import { studioTomlHeader } from "./toml-file.js";

/** What is at the Vex-owned path right now. */
export type StudioOwnedRegion =
  /** Nothing at the path: a fresh install, no ownership question to answer. */
  | { readonly kind: "absent" }
  | {
    readonly kind: "present";
    /** Digest of the normalized region. Comparable with a stored provenance hash. */
    readonly hash: string;
    /** The entry's own keys, in file order. */
    readonly keys: readonly string[];
    /**
     * Keys in the entry that are NOT in this dialect's closed allowlist, by
     * name. Empty for an entry that only holds what Vex writes.
     */
    readonly unknownKeys: readonly string[];
  }
  /** The file cannot be inspected at all (malformed, or a TOML text rewrite is unsafe). */
  | { readonly kind: "unreadable"; readonly detail: string };

/** Read the Vex-owned region of an existing config file. */
export function readStudioOwnedRegion(
  existing: string,
  agent: StudioWritableAgent,
): StudioOwnedRegion {
  return agent.format === "toml"
    ? readTomlRegion(existing, agent)
    : readJsonRegion(existing, agent);
}

/** The digest function. One definition, so the writer and the reader agree. */
export function studioRegionHash(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** Validation only. Nothing is ever serialized back through the parser. */
function isParsableToml(text: string): boolean {
  try {
    parseToml(text);
    return true;
  } catch {
    return false;
  }
}

function allowlistFor(agent: StudioWritableAgent): ReadonlySet<string> {
  return new Set(STUDIO_ENTRY_KEY_ALLOWLIST[agent.dialect]);
}

function readJsonRegion(existing: string, agent: StudioWritableAgent): StudioOwnedRegion {
  const root = parseTree(existing, [], { allowTrailingComma: true });
  if (root === undefined) return { kind: "unreadable", detail: "the file does not parse as JSON" };

  const ownedPath = agent.ownedPaths[0];
  if (ownedPath === undefined) {
    return { kind: "unreadable", detail: `${agent.id} declares no owned path` };
  }
  const node = findNodeAtLocation(root, [...ownedPath]);
  if (node === undefined) return { kind: "absent" };
  if (node.type !== "object") {
    // A non-object at our path is somebody else's value with our name on it.
    return {
      kind: "present",
      hash: studioRegionHash(`non-object:${node.type}`),
      keys: [],
      unknownKeys: [],
    };
  }

  const allowed = allowlistFor(agent);
  const keys: string[] = [];
  const unknownKeys: string[] = [];
  const parts: string[] = [];
  for (const property of node.children ?? []) {
    const key = propertyKey(property);
    if (key === null) continue;
    keys.push(key);
    if (!allowed.has(key)) unknownKeys.push(key);
    parts.push(`${key}=${normalizeJsonValue(property.children?.[1])}`);
  }

  return {
    kind: "present",
    hash: studioRegionHash(parts.join("\n")),
    keys,
    unknownKeys,
  };
}

function propertyKey(property: Node): string | null {
  if (property.type !== "property") return null;
  const keyNode = property.children?.[0];
  return typeof keyNode?.value === "string" ? keyNode.value : null;
}

/** A stable rendering of a JSON value, independent of the file's formatting. */
function normalizeJsonValue(node: Node | undefined): string {
  if (node === undefined) return "undefined";
  switch (node.type) {
    case "array":
      return `[${(node.children ?? []).map(normalizeJsonValue).join(",")}]`;
    case "object":
      return `{${(node.children ?? [])
        .map((child) => `${propertyKey(child) ?? ""}:${normalizeJsonValue(child.children?.[1])}`)
        .join(",")}}`;
    default:
      return JSON.stringify(node.value ?? null);
  }
}

function readTomlRegion(existing: string, agent: StudioWritableAgent): StudioOwnedRegion {
  // A broken file has no readable region, and the line scanner below would
  // happily produce an ownership digest from one anyway. Committing that digest
  // as provenance would record a claim over bytes nobody can parse.
  if (!isParsableToml(existing)) {
    return { kind: "unreadable", detail: "the file does not parse as TOML" };
  }
  if (existing.includes('"""') || existing.includes("'''")) {
    return {
      kind: "unreadable",
      detail:
        "the file contains a multi-line string, which a section-level text rewrite "
        + "cannot distinguish from a section header",
    };
  }

  const lines = existing.split("\n");
  const header = studioTomlHeader(agent);
  const allowed = allowlistFor(agent);

  const keys: string[] = [];
  const unknownKeys: string[] = [];
  const parts: string[] = [];
  let inSection = false;
  let found = false;

  for (const line of lines) {
    const trimmed = line.trim().replace(/\s*#.*$/, "");
    if (/^\[\[?[^[\]]+\]\]?$/.test(trimmed)) {
      if (inSection) break;
      inSection = agent.dialect === "mcp-servers-toml-array"
        ? trimmed === "[[mcp_servers]]"
        : trimmed === header;
      if (inSection) {
        // For the array dialect this may be somebody ELSE's element; the `name`
        // check below decides, and a non-matching element resets the scan.
        found = agent.dialect !== "mcp-servers-toml-array";
        keys.length = 0;
        unknownKeys.length = 0;
        parts.length = 0;
      }
      continue;
    }
    if (!inSection || trimmed === "") continue;

    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (match === null) continue;
    const [, key = "", value = ""] = match;
    if (agent.dialect === "mcp-servers-toml-array" && key === "name") {
      if (!/^["']vex["']$/.test(value.trim())) {
        // Another server's element. Keep scanning for ours.
        inSection = false;
        continue;
      }
      found = true;
    }
    keys.push(key);
    if (!allowed.has(key)) unknownKeys.push(key);
    parts.push(`${key}=${value.trim()}`);
  }

  if (!found) return { kind: "absent" };
  return {
    kind: "present",
    hash: studioRegionHash(parts.join("\n")),
    keys,
    unknownKeys,
  };
}
