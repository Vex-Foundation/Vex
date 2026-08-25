/**
 * The INPUT contract of every pure renderer in this directory.
 *
 * A renderer takes a registry record plus these facts and returns bytes. It
 * never reads a socket, a database, an endpoint file or any other live state,
 * and it never imports an A4 runtime module to find one: whoever calls a
 * renderer (A5b, in the privileged main process) has already resolved these
 * values and passes them in. That is what makes goldens possible at all - the
 * same facts always produce the same bytes.
 */

/** How the Studio bridge is invoked. */
export const VEX_BRIDGE_PROJECT_FLAG = "--project";

/**
 * Everything a config renderer needs about ONE project.
 *
 * NO ENVIRONMENT. Deliberately: the bridge locates the Vex socket itself from
 * the platform config directory, so the server entry needs no `env` map, and
 * the closed per-dialect key allowlists therefore contain no `env` key at all.
 * That makes "a client's own timeout environment variable is never written into
 * the bridge child's environment" a STRUCTURAL property of these renderers
 * rather than a rule someone has to remember.
 */
export interface StudioProjectFacts {
  /** The project's UUID; the bridge's `--project` argument. */
  readonly projectId: string;
  /**
   * Absolute path to the `vex-mcp` bridge binary, as the installing process
   * resolved it. Written verbatim into every config.
   */
  readonly bridgeCommand: string;
}

/** The bridge argument vector for a project. One derivation, every dialect. */
export function studioBridgeArgs(facts: StudioProjectFacts): readonly string[] {
  return [VEX_BRIDGE_PROJECT_FLAG, facts.projectId];
}

/** A renderer's answer. Bytes, "nothing to do", or a NAMED refusal. */
export type StudioRenderResult =
  /** The complete new contents of the file. */
  | { readonly status: "rendered"; readonly text: string }
  /** The file already says exactly what it should; write nothing. */
  | { readonly status: "unchanged" }
  /**
   * Vex will not touch this file. A refusal is a reportable outcome, never a
   * silent skip and never a clobber: the existing bytes stay exactly as they
   * are and the reason travels to the user.
   */
  | { readonly status: "refused"; readonly reason: StudioRenderRefusal; readonly detail: string };

/** Why a renderer refused. Closed set; each one is user-reportable. */
export type StudioRenderRefusal =
  /** The existing file is not parseable as JSON/JSONC. */
  | "malformed_json"
  /** The existing file is not editable as TOML by a section-level rewrite. */
  | "malformed_toml"
  /**
   * The existing TOML contains a multi-line string. A section-level TEXT
   * rewrite cannot tell a `[header]` inside a `"""` literal from a real one, so
   * the renderer refuses rather than risk corrupting the user's file.
   */
  | "toml_multiline_string"
  /**
   * `AGENTS.md` has a half-open Vex fence (a begin without an end, or the
   * reverse). Vex cannot tell where its own region stops, so it edits nothing.
   */
  | "malformed_managed_block";

export function rendered(text: string): StudioRenderResult {
  return { status: "rendered", text };
}

export function refused(
  reason: StudioRenderRefusal,
  detail: string,
): StudioRenderResult {
  return { status: "refused", reason, detail };
}
