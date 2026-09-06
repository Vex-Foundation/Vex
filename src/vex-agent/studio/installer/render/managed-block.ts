/**
 * The `AGENTS.md` MANAGED BLOCK: the only region of that file Vex owns.
 *
 * `AGENTS.md` is the user's file. Vex maintains a fenced region inside it and
 * nothing else:
 *
 *     <!-- vex:studio:begin hash=<16 hex> -->
 *     ...generated body...
 *     <!-- vex:studio:end -->
 *
 * THE HASH IN THE OPENING MARKER IS THE DRIFT CONTRACT. It is the digest of the
 * body Vex wrote. Re-reading the file and re-hashing what is between the markers
 * answers one question exactly: is this still the text Vex generated, or did a
 * human (or another tool) edit inside the fence? A drifted block is REPORTED and
 * left alone; only an explicit Repair overwrites it. That is why the hash lives
 * in the file rather than in a side table: the evidence travels with the bytes,
 * so a project cloned to another machine is still checkable.
 *
 * The body REUSES `STUDIO_SAFETY_PREFIX` from `mcp/instructions.ts` and the
 * extracted `STUDIO_USAGE_NOTES` directly. An agent reading this file and an
 * agent reading the MCP handshake receive the same words, from the same source.
 *
 * TWO DOCUMENTS, ONE FENCE (2026-09-04). `.vex/vex-guide.md` carries the
 * sections `AGENTS.md` no longer can (`vex-guide.ts`) and is managed with
 * exactly this machinery: the same markers, the same digest, the same drift
 * rule, the same repair-only overwrite. The generic half lives here and takes
 * the body as an argument; each document adds only its own composition, so
 * there is one drift contract rather than two that could disagree.
 */

import { createHash } from "node:crypto";

import type { StudioProjectBrief } from "../../instructions/project-brief.js";
import {
  STUDIO_COMMON_JOBS_NOTE,
  STUDIO_READ_ON_START_NOTE,
  STUDIO_YOUR_POSITION_NOTE,
  renderStudioBlockTitle,
  renderStudioHowToWorkWithVexMcp,
  renderStudioProjectIdentity,
} from "../../instructions/project-brief.js";
import type { StudioRenderResult } from "./facts.js";
import { rendered } from "./facts.js";

const BEGIN_PREFIX = "<!-- vex:studio:begin ";
const BEGIN_SUFFIX = " -->";
const END_MARKER = "<!-- vex:studio:end -->";

/**
 * The opening marker carries the Vex version that wrote the block ALONGSIDE the
 * drift hash: `<!-- vex:studio:begin vex=0.2.6 hash=<16 hex> -->`.
 *
 * The version is provenance a reader can see without opening the app, and it is
 * read from the app's own version at render time - never a literal in this file.
 * Only the HASH is the drift contract: it digests the body, and the version sits
 * outside the body, so bumping Vex does not by itself read as a human edit.
 */
function beginMarker(vexVersion: string, bodyHash: string): string {
  return `${BEGIN_PREFIX}vex=${vexVersion} hash=${bodyHash}${BEGIN_SUFFIX}`;
}

/** The hash recorded in an existing marker, or null when it has none. */
function hashFromMarker(markerBody: string): string | null {
  const match = /(?:^|\s)hash=([0-9a-f]+)(?:\s|$)/.exec(markerBody);
  return match?.[1] ?? null;
}

/** Digest length in hex characters. 16 is 64 bits: ample against accidental collision. */
const HASH_CHARS = 16;

/** Where the rich per-protocol declarations live, relative to the project root. */
export const STUDIO_PROTOCOLS_DOC_PATH = ".vex/protocols.md";

/**
 * The generated body, without the markers: THE AUTHORITY CORE.
 *
 * WHAT BELONGS HERE, since the 2026-09-04 split: the text an agent must have in
 * context on the turn it acts, without going and fetching anything. The
 * permission level in force, the wallets, how tools are found and named, what a
 * result means, what Vex charges, the safety rules, the task shapes, and what
 * each read tool actually knows. Everything an agent can read WHEN IT NEEDS IT
 * moved WHOLE into `.vex/vex-guide.md` (`renderStudioVexGuideBody`), which the
 * first section here tells it to open.
 *
 * DETERMINISTIC IN ITS INPUTS, and project-only. The generic half (safety
 * prefix, usage notes) is the same words every client gets at handshake; the
 * project half (what the server is, how large the surface is, which authority
 * was granted and when, what changed for this project) comes from the `brief`
 * the privileged caller resolved. Nothing here depends on the INSTALLATION any
 * more - which provider keys this machine has is a fact about the protocol
 * blocks, and they live in the guide - so this body is the same bytes on every
 * machine for the same project. Everything is INSIDE the hash, so a stale
 * count, an edited change note or a tampered authority line is drift like any
 * other byte.
 */
export function renderStudioManagedBody(brief: StudioProjectBrief): string {
  return [
    renderStudioBlockTitle(brief),
    "",
    "This repository is connected to Vex, a self-custodial crypto agent. The Vex",
    "tools reach REAL wallets on REAL chains. This section is the authority: what",
    "this project may do, how to call the tools, what a result means, how to do",
    "the usual jobs, and what you actually know. The two files named below carry",
    "the rest, and this section is not complete without the first of them.",
    "",
    // 1. The pointer, FIRST: the sections that are not here, and when to read them.
    STUDIO_READ_ON_START_NOTE,
    "",
    // 2. This project: the level in force, the wallets, the binding.
    renderStudioProjectIdentity(brief),
    "",
    // 3. The protocol: discovery, names, outcomes, fees, the shared rules.
    renderStudioHowToWorkWithVexMcp(brief),
    "",
    // 4. The task shapes, in MCP names.
    STUDIO_COMMON_JOBS_NOTE,
    "",
    // 5. What each read tool actually knows.
    STUDIO_YOUR_POSITION_NOTE,
    "",
    "---",
    "",
    "AGENTS: this section is generated by Vex, between the `vex:studio:begin` and",
    "`vex:studio:end` comment markers. NEVER edit between them, even when asked -",
    "Vex reports the edit as drift and stops regenerating the section until the",
    "user asks Vex for a repair. Text outside the markers belongs to the user.",
  ].join("\n");
}

/**
 * THE BYTE BOUND on the managed body. 24 KiB, and the number is a MEASUREMENT
 * of a client's loader, not a taste.
 *
 * Codex reads `AGENTS.md` under `project_doc_max_bytes`, which defaults to
 * 32,768 (`agents-colab/codex/codex-rs/config/defaults.toml:8`). That budget is
 * a TOTAL across every `AGENTS.md` from the project root down to the cwd, and
 * the loader TRUNCATES the file that crosses it -
 * `read_agents_md` does `data.truncate(remaining)` and logs
 * "project doc exceeds remaining budget; truncating"
 * (`codex-rs/core/src/agents_md.rs`). There is no include mechanism and no
 * warning to the model: the official guide's own advice for a long file is to
 * split it. Before 2026-09-04 a fresh block was 36,687 bytes, so a Codex user
 * got it CUT inside the protocol catalogue, losing every section below it.
 *
 * 32,768 minus an 8 KiB RESERVE = 24,576. The reserve is not slack: the budget
 * is shared with the user's own text around our fence in the same file, and
 * with any ancestor `AGENTS.md` above the project root, neither of which Vex
 * writes or can measure.
 *
 * `managed-block.test.ts` renders the LONGEST project half the store can hand
 * this renderer - eight selected wallets, `STUDIO_CHANGE_NOTE_LIMIT` notes each
 * at the 400-character `project_change_notes.summary` bound - and fails when
 * that render exceeds the bound. NOTHING IS EVER CUT TO FIT: exceeding it fails
 * that test, and the shortening decision is to move a whole section into
 * `.vex/vex-guide.md` - never the permission paragraph, never the outcome
 * table, never a shortened sentence.
 */
export const STUDIO_MANAGED_BLOCK_MAX_BYTES = 24_576;

/** The digest recorded in the opening marker. */
export function studioManagedBodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, HASH_CHARS);
}

/**
 * One managed body, FENCED: markers, digest, newline-terminated.
 *
 * The GENERIC half, shared by `AGENTS.md` and `.vex/vex-guide.md`. It knows
 * nothing about which document it is fencing, which is what keeps the drift
 * contract single: both files are hashed the same way, so an edit inside either
 * fence is caught by the same rule and repaired by the same explicit action.
 */
export function renderStudioFencedDocument(body: string, vexVersion: string): string {
  return `${beginMarker(vexVersion, studioManagedBodyHash(body))}\n${body}\n${END_MARKER}\n`;
}

/** The complete `AGENTS.md` managed block, markers included, newline-terminated. */
export function renderStudioManagedBlock(brief: StudioProjectBrief): string {
  return renderStudioFencedDocument(renderStudioManagedBody(brief), brief.vexVersion);
}

/** What an existing `AGENTS.md` currently holds in the Vex fence. */
export type StudioManagedBlockState =
  /** No Vex fence in the file. */
  | { readonly kind: "absent" }
  /** A fence whose body still hashes to the value in its own marker. */
  | { readonly kind: "intact"; readonly upToDate: boolean }
  /**
   * A fence whose body no longer matches its recorded hash: someone edited
   * inside it. Never overwritten except by an explicit Repair.
   */
  | { readonly kind: "drifted"; readonly recordedHash: string; readonly actualHash: string }
  /** An opening marker with no closing marker, or the two in the wrong order. */
  | { readonly kind: "malformed"; readonly detail: string };

/**
 * The block's OWNERSHIP state, without a brief.
 *
 * Everything `inspectStudioManagedBlock` decides except `upToDate` is
 * brief-independent: whether a fence exists, whether it is well formed, and
 * whether its body still hashes to the value in its own marker are all
 * properties of the FILE. Only "does it match what we would render now" needs
 * the project summary.
 *
 * TEARDOWN needs exactly the brief-independent half. A project being deleted
 * has no scope left to render a brief from, and asking "is this block still
 * ours" must not require inventing one. So the shared part lives here and
 * `inspectStudioManagedBlock` adds the comparison on top.
 */
export type StudioManagedBlockOwnership =
  | { readonly kind: "absent" }
  | { readonly kind: "intact"; readonly bodyHash: string }
  | { readonly kind: "drifted"; readonly recordedHash: string; readonly actualHash: string }
  | { readonly kind: "malformed"; readonly detail: string };

export function studioManagedBlockOwnership(
  existing: string,
): StudioManagedBlockOwnership {
  const found = locateManagedBlock(existing);
  if (found === undefined) return { kind: "absent" };
  if (typeof found === "string") return { kind: "malformed", detail: found };

  const actualHash = studioManagedBodyHash(found.body);
  if (actualHash !== found.recordedHash) {
    return { kind: "drifted", recordedHash: found.recordedHash, actualHash };
  }
  return { kind: "intact", bodyHash: actualHash };
}

/**
 * The fence's state against the body Vex WOULD render now.
 *
 * Generic, like the renderer: `desiredBody` is whichever document's body the
 * caller composed, so `AGENTS.md` and `.vex/vex-guide.md` answer "is this still
 * ours, and is it current" through one implementation.
 */
export function inspectStudioFencedDocument(
  existing: string,
  desiredBody: string,
): StudioManagedBlockState {
  const ownership = studioManagedBlockOwnership(existing);
  if (ownership.kind !== "intact") return ownership;

  // The one question that needs the desired text.
  const found = locateManagedBlock(existing);
  const body = typeof found === "object" && found !== undefined ? found.body : "";
  return { kind: "intact", upToDate: body === desiredBody };
}

export function inspectStudioManagedBlock(
  existing: string,
  brief: StudioProjectBrief,
): StudioManagedBlockState {
  return inspectStudioFencedDocument(existing, renderStudioManagedBody(brief));
}

/**
 * A file with the Vex fence present and current, whichever document it carries.
 *
 * An absent fence is APPENDED; an intact one is replaced in place; a DRIFTED one
 * is left exactly as the user left it unless `overwriteDrift` says this is an
 * explicit Repair. Text outside the fence is never touched.
 */
export function mergeStudioFencedDocument(
  existing: string,
  body: string,
  vexVersion: string,
  options: { readonly overwriteDrift: boolean },
): StudioRenderResult {
  const found = locateManagedBlock(existing);
  if (typeof found === "string") {
    // A half-open fence is ambiguous: Vex cannot tell where its region ends, so
    // it refuses rather than guess a boundary inside the user's file.
    return { status: "refused", reason: "malformed_managed_block", detail: found };
  }

  const block = renderStudioFencedDocument(body, vexVersion);

  if (found === undefined) {
    // Exactly one blank line between the user's text and the Vex fence.
    const separator = existing === ""
      ? ""
      : existing.endsWith("\n\n")
        ? ""
        : existing.endsWith("\n") ? "\n" : "\n\n";
    return rendered(`${existing}${separator}${block}`);
  }

  if (
    !options.overwriteDrift
    && studioManagedBodyHash(found.body) !== found.recordedHash
  ) {
    return { status: "unchanged" };
  }

  const next = `${existing.slice(0, found.start)}${block}${existing.slice(found.end)}`;
  return next === existing ? { status: "unchanged" } : rendered(next);
}

/** `AGENTS.md` with the Vex block present and current. */
export function mergeStudioManagedBlock(
  existing: string,
  brief: StudioProjectBrief,
  options: { readonly overwriteDrift: boolean },
): StudioRenderResult {
  return mergeStudioFencedDocument(
    existing,
    renderStudioManagedBody(brief),
    brief.vexVersion,
    options,
  );
}

/**
 * A managed file with the Vex fence removed and every other byte preserved.
 *
 * Generic, like the fence itself: it locates the markers, not a document, so
 * `AGENTS.md` and `.vex/vex-guide.md` are taken back out the same way.
 */
export function removeStudioManagedBlock(existing: string): StudioRenderResult {
  const found = locateManagedBlock(existing);
  if (typeof found === "string") {
    return { status: "refused", reason: "malformed_managed_block", detail: found };
  }
  if (found === undefined) return { status: "unchanged" };
  return rendered(`${existing.slice(0, found.removeStart)}${existing.slice(found.end)}`);
}

interface LocatedBlock {
  /** Offset of the first character of the opening marker. */
  readonly start: number;
  /**
   * Offset where a REMOVE begins: the opening marker, minus the one blank
   * separator line an append inserted before it. That line is part of what Vex
   * added, so removing it returns the file to the bytes it started with. (The
   * one nuance: a file that already had a blank line exactly there before Vex
   * ever touched it loses it. Whitespace at a seam, never content.)
   */
  readonly removeStart: number;
  /** Offset just past the newline that follows the closing marker. */
  readonly end: number;
  readonly recordedHash: string;
  /** The text between the markers, excluding the newlines adjacent to them. */
  readonly body: string;
}

/** The block, `undefined` when absent, or a string naming why it is malformed. */
function locateManagedBlock(existing: string): LocatedBlock | undefined | string {
  const start = existing.indexOf(BEGIN_PREFIX);
  if (start === -1) {
    return existing.includes(END_MARKER)
      ? "a vex:studio:end marker with no matching begin marker"
      : undefined;
  }

  const markerEnd = existing.indexOf(BEGIN_SUFFIX, start + BEGIN_PREFIX.length);
  if (markerEnd === -1) return "the vex:studio:begin marker is not terminated";

  const recordedHash = hashFromMarker(
    existing.slice(start + BEGIN_PREFIX.length, markerEnd),
  );
  if (recordedHash === null) {
    return "the vex:studio:begin marker carries no hash= attribute";
  }
  const bodyStart = markerEnd + BEGIN_SUFFIX.length + 1; // skip the newline
  const endMarker = existing.indexOf(END_MARKER, bodyStart);
  if (endMarker === -1) return "a vex:studio:begin marker with no matching end marker";

  const afterEnd = endMarker + END_MARKER.length;
  const end = existing.charAt(afterEnd) === "\n" ? afterEnd + 1 : afterEnd;

  return {
    start,
    // Reclaim the blank separator line an append inserted before the marker.
    removeStart: existing.slice(0, start).endsWith("\n\n") ? start - 1 : start,
    end,
    recordedHash,
    // The body excludes the newline that precedes the closing marker.
    body: existing.slice(bodyStart, Math.max(bodyStart, endMarker - 1)),
  };
}
