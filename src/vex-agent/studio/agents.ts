/**
 * THE agent registry: one record per canonical Studio agent id.
 *
 * This module is the single machine-readable statement of every per-client fact
 * the installer needs - config path, dialect, the JSON/TOML path to OUR entry,
 * the timeout mechanism, the fields we must NEVER write, and the client version
 * the facts were established against.
 *
 * PROVENANCE. Every value here is transcribed from
 * `tools/tool-surface-spec/studio-mcp/agent-dialect-research-2026-08-24.md`
 * INCLUDING its "Addendum 2026-08-25", which supersedes the original rows
 * wherever they disagree, and is formalized for review in
 * `tools/tool-surface-spec/studio-mcp/agent-dialect-matrix.md`. A wire name that
 * is not in those artifacts is a defect here even if it happens to be correct
 * (rule 10): `__tests__/vex-agent/studio/agent-dialect-matrix.test.ts` enumerates
 * every path, key and field this registry emits against the matrix document, so
 * code and reviewed artifact cannot drift apart.
 *
 * CONFIG MODE IS A DISCRIMINATED UNION, not a flag. `project`, `launch` and
 * `unsupported` carry DIFFERENT fields, so "does this id have a writer?", "does
 * it need launch instructions?" and "does it produce an unsupported outcome?"
 * are answered by the type rather than by a runtime check that a future id
 * could forget. There is no renderer for `unsupported` and no way to ask for
 * one: `renderStudioAgentConfig()` accepts `StudioWritableAgent`, so passing an
 * unsupported record is a COMPILE error rather than a runtime branch.
 *
 * THE TIMEOUT COLUMN IS THE SAFETY COLUMN. A Studio approval can keep a tool
 * call waiting for the full `APPROVAL_TTL_MS` (one hour), so every client whose
 * tool-call timeout we can influence is configured well past it, and every
 * client whose timeout we CANNOT influence says so by type instead of pretending.
 * The mechanisms are deliberately distinct kinds: a value written into OUR
 * server entry, a vendor default that is already sufficient, a variable in the
 * CLIENT's own process environment (never written into the bridge child's env),
 * a user-scope config a project cannot reach, and an honestly UNVERIFIED cell
 * awaiting the stage A-test live probe.
 */

import type { StudioAgentId } from "../../lib/studio-agent-ids.js";
import { STUDIO_AGENT_IDS } from "../../lib/studio-agent-ids.js";

/**
 * How a client's tool-call timeout is governed for this agent.
 *
 * `seconds` on the kinds that carry a number is the SAME unit for every client
 * regardless of what the vendor field uses, so the "outlasts an approval" lint
 * compares one quantity instead of re-deriving units per row. `field` and
 * `unit` record what actually goes on the wire.
 */
export type StudioTimeoutMechanism =
  /** We write `field` into our own server entry. The explicit write governs. */
  | {
    readonly kind: "server-entry-field";
    readonly field: string;
    readonly unit: "ms" | "s";
    /** The literal value the renderer emits, in `unit`. */
    readonly value: number;
    /**
     * How the value must appear on the wire. TOML distinguishes `3900` from
     * `3900.0` and a client whose field is declared FLOAT (Vibe's
     * `tool_timeout_sec: float`) is told so here rather than by a renderer
     * guessing from the dialect.
     */
    readonly literal: "integer" | "float";
    /** The same value in seconds, for the approval-outlives lint. */
    readonly seconds: number;
    readonly note: string;
  }
  /** The vendor default already outlasts an approval, so we write nothing. */
  | {
    readonly kind: "vendor-default-sufficient";
    readonly field: string;
    readonly unit: "ms" | "s";
    readonly documentedDefault: number;
    readonly seconds: number;
    readonly note: string;
  }
  /**
   * The bound lives in the CLIENT PROCESS environment. Recorded, never written:
   * a client env var is the user's to set, and putting it in the bridge child's
   * env would configure the wrong process entirely.
   */
  | {
    readonly kind: "client-env";
    readonly variable: string;
    readonly unit: "ms" | "s";
    readonly documentedDefault: number;
    readonly seconds: number;
    readonly note: string;
  }
  /**
   * The bound lives in a USER-SCOPE config a project file cannot reach. The
   * documented default is NOT sufficient, so this is surfaced as a user action
   * rather than silently accepted.
   */
  | {
    readonly kind: "user-global-config";
    readonly path: string;
    readonly field: string;
    readonly unit: "ms" | "s";
    readonly documentedDefault: number;
    readonly documentedDefaultSeconds: number;
    /** What the user must do, verbatim, for a Studio approval to survive. */
    readonly userAction: string;
  }
  /**
   * No documented tool-call timeout after two primary-source passes. Absence of
   * documentation is not absence of a timer, so this is a named limitation with
   * an owed probe, never an assumption that the client waits forever.
   */
  | {
    readonly kind: "unverified";
    readonly probe: string;
  };

/** Which client version the facts in a record were established against. */
export type StudioClientVersionBasis =
  | { readonly kind: "pinned"; readonly version: string; readonly note: string }
  | { readonly kind: "detected-at-install"; readonly note: string };

/** The file format of an agent's config, which selects the merge strategy. */
export type StudioConfigFormat = "jsonc" | "toml";

/**
 * The concrete writer dialect. Distinct from `format` because two clients can
 * share JSONC and still disagree on wrapper key, entry shape and required
 * fields. Every dialect has exactly one renderer in `installer/render/`.
 */
export type StudioDialect =
  /**
   * `mcpServers.<name>` = `{ type?, command, args, timeout? }`. `type` appears
   * only where the record names one and `timeout` only where the timeout
   * mechanism is a `server-entry-field`, so the Claude shape (neither) and the
   * Copilot shape (both) are the same dialect with different record columns.
   */
  | "mcp-servers-json"
  /** `mcp` = `{ <name>: { type: "local", command: [..], timeout } }` (opencode). */
  | "opencode-json"
  /** `[mcp_servers.<name>]` TOML table (codex, grok). */
  | "mcp-servers-toml-table"
  /** `[[mcp_servers]]` TOML array-of-tables keyed by a required `name` (vibe). */
  | "mcp-servers-toml-array";

/** A JSON path we own, as literal key segments (a segment MAY contain a dot). */
export type StudioOwnedJsonPath = readonly string[];

/** Common columns every record carries, whatever its config mode. */
interface StudioAgentCommon {
  readonly id: StudioAgentId;
  /** Product copy: what the picker shows. */
  readonly displayName: string;
  readonly clientVersionBasis: StudioClientVersionBasis;
  /**
   * Fields this agent's config format accepts that would grant tool authority,
   * pre-approve calls, or assert trust. The writers NEVER emit any of them, and
   * `never-written-fields.test.ts` asserts their ABSENCE from every rendered
   * artifact. A FOREIGN occurrence beside our entry is preserved (it is the
   * user's statement, not ours) and reported by A5b as a security warning.
   */
  readonly neverWritten: readonly string[];
  /**
   * A gate outside our reach that makes a correct write inert until the user
   * acts (folder trust, in-app approval). Non-null means "a write is not a
   * working integration" and the DTO must say so.
   */
  readonly inertUntil: string | null;
}

/** A constant value Vex owns at a path outside its server entry. */
export interface StudioAdditionalWrite {
  readonly path: StudioOwnedJsonPath;
  readonly value: readonly string[];
  /** Why this file needs it. Shown in the matrix, not in the file. */
  readonly reason: string;
}

/** Columns shared by the two variants that HAVE a renderer. */
interface StudioWritableCommon extends StudioAgentCommon {
  /** Repo-relative POSIX path Vex writes. */
  readonly configPath: string;
  readonly format: StudioConfigFormat;
  readonly dialect: StudioDialect;
  /**
   * Every JSON path (or TOML section) that belongs to Vex in that file. The
   * FIRST entry is always the server entry; any others come from
   * `additionalWrites`.
   */
  readonly ownedPaths: readonly StudioOwnedJsonPath[];
  readonly timeout: StudioTimeoutMechanism;
  /**
   * The `type` discriminator this client wants on a stdio server entry, or
   * `null` to OMIT the field. Not a default: the three states (absent,
   * `"local"`, `"stdio"`) are per-client wire facts and the wrong one is a
   * silent misconfiguration.
   */
  readonly serverTypeValue: string | null;
  /** Constant Vex-owned values elsewhere in the same file. */
  readonly additionalWrites: readonly StudioAdditionalWrite[];
}

/** An agent that reads a file from the repository. */
export interface StudioProjectAgent extends StudioWritableCommon {
  readonly configMode: "project";
  /**
   * Other repo-relative paths this client ALSO reads. Recorded so the residual
   * is visible (owner decision 2026-08-24: Copilot and Grok also reading
   * Claude's `.mcp.json` is accepted and described in the trust copy). Vex
   * never writes these.
   */
  readonly alsoReads: readonly string[];
}

/** An agent with no project scope: we generate a file it must be POINTED at. */
export interface StudioLaunchAgent extends StudioWritableCommon {
  readonly configMode: "launch";
  /** The exact command the user runs, with `{configPath}` as the placeholder. */
  readonly launchInstruction: string;
}

/** An agent Vex cannot integrate today. No file is written, ever. */
export interface StudioUnsupportedAgent extends StudioAgentCommon {
  readonly configMode: "unsupported";
  /** Shown verbatim in the picker: why, and what would change it. */
  readonly reason: string;
  /** The condition under which support returns. */
  readonly supportReturnsWhen: string;
}

export type StudioAgent =
  | StudioProjectAgent
  | StudioLaunchAgent
  | StudioUnsupportedAgent;

/** The variants that have a renderer. Narrowed by type, never by a check. */
export type StudioWritableAgent = StudioProjectAgent | StudioLaunchAgent;

/** The key our server entry takes in every dialect that keys entries by name. */
export const STUDIO_SERVER_KEY = "vex";

/**
 * Gemini CLI reads `GEMINI.md` by default, so a project whose instructions live
 * in `AGENTS.md` - the file every other agent here reads - is invisible to it
 * until `context.fileName` says otherwise. This is the ONE non-server value Vex
 * owns in an agent config.
 */
const GEMINI_CONTEXT_WRITE = [
  {
    path: ["context", "fileName"],
    value: ["AGENTS.md"],
    reason:
      "Gemini CLI's default context file is GEMINI.md; without this it never "
      + "reads the AGENTS.md managed block Vex maintains.",
  },
] as const;

const CLAUDE: StudioProjectAgent = {
  id: "claude-code",
  displayName: "Claude Code",
  configMode: "project",
  configPath: ".mcp.json",
  alsoReads: [],
  format: "jsonc",
  dialect: "mcp-servers-json",
  serverTypeValue: null,
  additionalWrites: [],
  ownedPaths: [["mcpServers", STUDIO_SERVER_KEY]],
  timeout: {
    kind: "client-env",
    variable: "MCP_TOOL_TIMEOUT",
    unit: "ms",
    documentedDefault: 100_800_000,
    seconds: 100_800,
    note:
      "Wall clock, default ~28 h, set by the USER in the client's own process "
      + "environment - we write nothing. Progress notifications do NOT extend "
      + "this wall clock; they reset the separate 30-minute stdio IDLE timer, "
      + "which is exactly what the host's ~2 s approval progress frames serve. "
      + "Version-gated semantics (v2.1.187+ / v2.1.203+): re-verify against the "
      + "installed CLI.",
  },
  neverWritten: [
    "enableAllProjectMcpServers",
    "enabledMcpjsonServers",
    "disabledMcpjsonServers",
    "hasTrustDialogAccepted",
  ],
  clientVersionBasis: {
    kind: "pinned",
    version: "2.1.x",
    note: "Schema shifts within the 2.1 line; idle-timer semantics are version-gated.",
  },
  inertUntil: null,
};

const CODEX: StudioProjectAgent = {
  id: "codex",
  displayName: "Codex CLI",
  configMode: "project",
  configPath: ".codex/config.toml",
  alsoReads: [],
  format: "toml",
  dialect: "mcp-servers-toml-table",
  serverTypeValue: null,
  additionalWrites: [],
  ownedPaths: [["mcp_servers", STUDIO_SERVER_KEY]],
  timeout: {
    kind: "server-entry-field",
    field: "tool_timeout_sec",
    unit: "s",
    value: 3900,
    literal: "integer",
    seconds: 3900,
    note: "Vendor default 60 s, far below an approval wait.",
  },
  neverWritten: [
    "default_tools_approval_mode",
    "approval_mode",
    "approval_policy",
    "trust_level",
  ],
  clientVersionBasis: {
    kind: "detected-at-install",
    note: "Config keys are stable across the versions surveyed; the trust gate is not.",
  },
  inertUntil:
    "the user trusts this project in Codex; until then the config is inert and a "
    + "write is not a working integration",
};

const GEMINI: StudioProjectAgent = {
  id: "gemini-cli",
  displayName: "Gemini CLI",
  configMode: "project",
  configPath: ".gemini/settings.json",
  alsoReads: [],
  format: "jsonc",
  dialect: "mcp-servers-json",
  serverTypeValue: null,
  additionalWrites: GEMINI_CONTEXT_WRITE,
  ownedPaths: [
    ["mcpServers", STUDIO_SERVER_KEY],
    ["context", "fileName"],
  ],
  timeout: {
    kind: "server-entry-field",
    field: "timeout",
    unit: "ms",
    value: 3_900_000,
    literal: "integer",
    seconds: 3900,
    note: "Vendor default 600000 ms (10 min), below an approval wait.",
  },
  neverWritten: ["trust", "folderTrust"],
  clientVersionBasis: {
    kind: "detected-at-install",
    note: "`context.fileName` and the `mcpServers` shape are stable across surveyed versions.",
  },
  inertUntil: null,
};

const OPENCODE: StudioProjectAgent = {
  id: "opencode",
  displayName: "opencode",
  configMode: "project",
  configPath: "opencode.json",
  alsoReads: ["opencode.jsonc"],
  format: "jsonc",
  dialect: "opencode-json",
  serverTypeValue: "local",
  additionalWrites: [],
  ownedPaths: [["mcp", STUDIO_SERVER_KEY]],
  timeout: {
    kind: "server-entry-field",
    field: "timeout",
    unit: "ms",
    value: 3_900_000,
    literal: "integer",
    seconds: 3900,
    note: "Vendor default 5000 ms, three orders of magnitude below an approval wait.",
  },
  neverWritten: ["permission"],
  clientVersionBasis: {
    kind: "pinned",
    version: "1.18.x",
    note:
      "npm `opencode-ai` latest 1.18.23; the \"V2\" line is REFUTED (it does not "
      + "exist). Schema re-confirmed against the live https://opencode.ai/config.json "
      + "($defs.McpLocalConfig): `additionalProperties: false`, `type: \"local\"` "
      + "required, `command` an ARRAY, `environment` not `env`.",
  },
  inertUntil: null,
};

const GROK: StudioProjectAgent = {
  id: "grok-build",
  displayName: "Grok Build",
  configMode: "project",
  configPath: ".grok/config.toml",
  alsoReads: [".mcp.json", ".cursor/mcp.json"],
  format: "toml",
  dialect: "mcp-servers-toml-table",
  serverTypeValue: null,
  additionalWrites: [],
  ownedPaths: [["mcp_servers", STUDIO_SERVER_KEY]],
  timeout: {
    kind: "vendor-default-sufficient",
    field: "tool_timeout_sec",
    unit: "s",
    documentedDefault: 6000,
    seconds: 6000,
    note:
      "Confirmed in the vendor settings reference and already 100 minutes, so "
      + "Vex writes no timeout rather than restating a sufficient default.",
  },
  neverWritten: ["permission", "permission_mode"],
  clientVersionBasis: {
    kind: "detected-at-install",
    note:
      "A project `.grok/config.toml` can carry `[mcp_servers]`, `[plugins]` AND "
      + "`[permission]`: a project file CAN grant tool authority, which is why "
      + "`[permission]` heads the never-written list.",
  },
  inertUntil: null,
};

const KIMI: StudioLaunchAgent = {
  id: "kimi",
  displayName: "Kimi CLI",
  configMode: "launch",
  configPath: ".vex/mcp/kimi.json",
  format: "jsonc",
  dialect: "mcp-servers-json",
  serverTypeValue: null,
  additionalWrites: [],
  ownedPaths: [["mcpServers", STUDIO_SERVER_KEY]],
  launchInstruction: "kimi --mcp-config-file {configPath}",
  timeout: {
    kind: "user-global-config",
    path: "~/.kimi/config.toml",
    field: "[mcp.client] tool_call_timeout_ms",
    unit: "ms",
    documentedDefault: 60_000,
    documentedDefaultSeconds: 60,
    userAction:
      "Kimi's tool-call timeout is GLOBAL and defaults to 60 s, which no project "
      + "file can raise. Set `[mcp.client] tool_call_timeout_ms = 3900000` in "
      + "`~/.kimi/config.toml` or a Studio approval will time out before you can "
      + "answer it.",
  },
  neverWritten: [],
  clientVersionBasis: {
    kind: "detected-at-install",
    note:
      "MoonshotAI/kimi-cli. Sources disagree on the rebranded \"Kimi Code\" user "
      + "path (`~/.kimi-code/`) and per-server overrides; irrelevant to the "
      + "writer, which never reads or writes a user-scope path.",
  },
  inertUntil:
    "the user launches Kimi with `--mcp-config-file` pointing at the generated "
    + "file; Kimi has no project scope, so the file alone does nothing",
};

const QWEN: StudioProjectAgent = {
  id: "qwen-code",
  displayName: "Qwen Code",
  configMode: "project",
  configPath: ".qwen/settings.json",
  alsoReads: [],
  format: "jsonc",
  dialect: "mcp-servers-json",
  serverTypeValue: null,
  additionalWrites: [],
  ownedPaths: [["mcpServers", STUDIO_SERVER_KEY]],
  timeout: {
    kind: "server-entry-field",
    field: "timeout",
    unit: "ms",
    value: 3_900_000,
    literal: "integer",
    seconds: 3900,
    note:
      "Wall clock only. The separate `mcp.toolIdleTimeoutMs` is HARD-CAPPED at "
      + "3600000 ms, so a 65-minute approval survives ONLY because the host emits "
      + "progress notifications; Vex does not write the idle key.",
  },
  neverWritten: ["trust", "folderTrust", "allowed", "excluded"],
  clientVersionBasis: {
    kind: "detected-at-install",
    note: "Settings shape mirrors Gemini CLI's; the idle cap is the qwen-specific fact.",
  },
  inertUntil: null,
};

const COPILOT: StudioProjectAgent = {
  id: "copilot-cli",
  displayName: "GitHub Copilot CLI",
  configMode: "project",
  configPath: ".github/mcp.json",
  alsoReads: [".mcp.json"],
  format: "jsonc",
  dialect: "mcp-servers-json",
  serverTypeValue: "local",
  additionalWrites: [],
  ownedPaths: [["mcpServers", STUDIO_SERVER_KEY]],
  timeout: {
    kind: "server-entry-field",
    field: "timeout",
    unit: "ms",
    value: 3_900_000,
    literal: "integer",
    seconds: 3900,
    note:
      "The vendor DEFAULT is version-dependent (the current CLI reference states "
      + "30000 ms; vendor issue copilot-cli#1378 measured 180000 ms at v0.0.406) "
      + "and either is far below an approval wait, so the EXPLICIT write governs "
      + "and the default never does. That closed issue also reports a per-server "
      + "timeout being lost after `notifications/tools/list_changed` - re-verify "
      + "at the installed version if the Vex host ever emits that notification.",
  },
  neverWritten: ["tools"],
  clientVersionBasis: {
    kind: "detected-at-install",
    note:
      "Both project paths confirmed: `.mcp.json` walking up to the repo root takes "
      + "precedence over `.github/mcp.json` at the same level. Vex writes "
      + "`.github/mcp.json` so it never collides with Claude's file.",
  },
  inertUntil:
    "the folder is trusted in Copilot; project servers are SILENTLY skipped in "
    + "untrusted directories",
};

const CURSOR: StudioProjectAgent = {
  id: "cursor",
  displayName: "Cursor",
  configMode: "project",
  configPath: ".cursor/mcp.json",
  alsoReads: [],
  format: "jsonc",
  dialect: "mcp-servers-json",
  serverTypeValue: "stdio",
  additionalWrites: [],
  ownedPaths: [["mcpServers", STUDIO_SERVER_KEY]],
  timeout: {
    kind: "unverified",
    probe:
      "No documented tool-call timeout after two primary-source passes. Stage "
      + "A-test: expose a deliberately slow stdio tool and measure where Cursor "
      + "aborts.",
  },
  neverWritten: [],
  clientVersionBasis: {
    kind: "detected-at-install",
    note: "`type: \"stdio\"` and `envFile` documented; no config pre-approval field exists.",
  },
  inertUntil: null,
};

const AMP: StudioProjectAgent = {
  id: "amp",
  displayName: "Amp",
  configMode: "project",
  configPath: ".amp/settings.json",
  alsoReads: [".amp/settings.jsonc"],
  format: "jsonc",
  dialect: "mcp-servers-json",
  serverTypeValue: null,
  additionalWrites: [],
  // `amp.mcpServers` is ONE literal key containing a dot, not two segments.
  ownedPaths: [["amp.mcpServers", STUDIO_SERVER_KEY]],
  timeout: {
    kind: "unverified",
    probe:
      "No documented tool-call timeout after two primary-source passes. Stage "
      + "A-test: slow stdio tool, measure the abort.",
  },
  neverWritten: ["mcpPermissions", "disable"],
  clientVersionBasis: {
    kind: "detected-at-install",
    note: "Dotted top-level settings keys; `.jsonc` is read as an alternate.",
  },
  inertUntil: null,
};

const KIRO: StudioProjectAgent = {
  id: "kiro",
  displayName: "Kiro",
  configMode: "project",
  configPath: ".kiro/settings/mcp.json",
  alsoReads: [],
  format: "jsonc",
  dialect: "mcp-servers-json",
  serverTypeValue: null,
  additionalWrites: [],
  ownedPaths: [["mcpServers", STUDIO_SERVER_KEY]],
  timeout: {
    kind: "unverified",
    probe:
      "No documented tool-call timeout after two primary-source passes. Stage "
      + "A-test: slow stdio tool, measure the abort.",
  },
  neverWritten: ["autoApprove"],
  clientVersionBasis: {
    kind: "detected-at-install",
    note:
      "`disabled` and `autoApprove` are the documented per-server fields; open "
      + "vendor bugs on `autoApprove` semantics are a second reason never to emit it.",
  },
  inertUntil: null,
};

const VIBE: StudioProjectAgent = {
  id: "mistral-vibe",
  displayName: "Mistral Vibe",
  configMode: "project",
  configPath: ".vibe/config.toml",
  alsoReads: [],
  format: "toml",
  dialect: "mcp-servers-toml-array",
  serverTypeValue: null,
  additionalWrites: [],
  // Array-of-tables: the entry is identified by its required `name`, not by a
  // table key, so the owned path is the array plus the name we claim.
  ownedPaths: [["mcp_servers", STUDIO_SERVER_KEY]],
  timeout: {
    kind: "server-entry-field",
    field: "tool_timeout_sec",
    unit: "s",
    value: 3900,
    literal: "float",
    seconds: 3900,
    note:
      "Float seconds, vendor default 60.0 (`vibe/core/config/models.py`). "
      + "`startup_timeout_sec` is a separate 10.0 s default Vex does not touch.",
  },
  neverWritten: [],
  clientVersionBasis: {
    kind: "detected-at-install",
    note:
      "Project path VERIFIED as `./.vibe/config.toml` (user `~/.vibe/config.toml`). "
      + "`name` is a HARD REQUIRED field (`name: str = Field(...)`), which is why "
      + "this dialect is an array-of-tables rather than a keyed table.",
  },
  inertUntil:
    "the working directory is trusted in Vibe; an untrusted directory's config is "
    + "SILENTLY not loaded",
};

const DROID: StudioProjectAgent = {
  id: "droid",
  displayName: "Factory Droid",
  configMode: "project",
  configPath: ".factory/mcp.json",
  alsoReads: [],
  format: "jsonc",
  dialect: "mcp-servers-json",
  serverTypeValue: null,
  additionalWrites: [],
  ownedPaths: [["mcpServers", STUDIO_SERVER_KEY]],
  timeout: {
    kind: "server-entry-field",
    field: "timeout",
    unit: "ms",
    value: 3_900_000,
    literal: "integer",
    seconds: 3900,
    note:
      "Per-server milliseconds with NO documented default, so the explicit write "
      + "is the only bound we can reason about. `connectTimeout` is a separate "
      + "field Vex does not touch.",
  },
  neverWritten: [],
  clientVersionBasis: {
    kind: "detected-at-install",
    note:
      "No pre-approval config field exists at all; Factory approves servers "
      + "out of band by fingerprint.",
  },
  inertUntil: null,
};

const CLINE: StudioUnsupportedAgent = {
  id: "cline",
  displayName: "Cline",
  configMode: "unsupported",
  reason:
    "The Cline CLI reads MCP servers from `~/.cline/mcp.json` only. Writing a "
    + "user-global file from a project would configure every one of your "
    + "repositories at once, so Vex does not do it.",
  supportReturnsWhen: "the Cline CLI gains a project-scoped or launch-flag MCP mechanism",
  neverWritten: [
    // Recorded even though no writer exists: in Cline's dialect an OMITTED
    // `type` means legacy SSE rather than stdio - the inverse of Claude - so if
    // this id ever becomes writable, the field is a correctness trap, not a
    // formality.
    "type",
  ],
  clientVersionBasis: {
    kind: "detected-at-install",
    note: "No writer exists, so no version is pinned.",
  },
  inertUntil: null,
};

const WARP: StudioUnsupportedAgent = {
  id: "warp",
  displayName: "Warp",
  configMode: "unsupported",
  reason:
    "The Warp CLI reads MCP servers from its global config only - project-scoped "
    + "MCP files in repositories are not detected - and it has no `--mcp` flag; "
    + "MCP is managed in-session with `/mcp`. The deprecated `oz` binary's launch "
    + "flag was declined by the owner (2026-08-25) rather than build a bridge on a "
    + "binary the vendor is removing, and the Warp APP's project `.warp/.mcp.json`, "
    + "which requires explicit in-app manual approval, is not built in A5.",
  supportReturnsWhen: "the `warp` CLI gains a project or launch MCP mechanism",
  neverWritten: [],
  clientVersionBasis: {
    kind: "detected-at-install",
    note: "No writer exists, so no version is pinned.",
  },
  inertUntil: null,
};

/** The registry, keyed by canonical id. Exhaustive over `STUDIO_AGENT_IDS`. */
export const STUDIO_AGENTS: Readonly<Record<StudioAgentId, StudioAgent>> = {
  "claude-code": CLAUDE,
  codex: CODEX,
  "gemini-cli": GEMINI,
  opencode: OPENCODE,
  "grok-build": GROK,
  kimi: KIMI,
  "qwen-code": QWEN,
  "copilot-cli": COPILOT,
  cursor: CURSOR,
  amp: AMP,
  kiro: KIRO,
  "mistral-vibe": VIBE,
  cline: CLINE,
  droid: DROID,
  warp: WARP,
};

/** The registry in canonical roster order. */
export const STUDIO_AGENT_LIST: readonly StudioAgent[] = STUDIO_AGENT_IDS.map(
  (id) => STUDIO_AGENTS[id],
);

export function studioAgent(id: StudioAgentId): StudioAgent {
  return STUDIO_AGENTS[id];
}

/** Type predicate: does this agent have a renderer at all? */
export function isWritableStudioAgent(agent: StudioAgent): agent is StudioWritableAgent {
  return agent.configMode !== "unsupported";
}

/**
 * The seconds a client must be willing to wait for one tool call, or `null`
 * when no documented mechanism exists (`unverified`) or the only mechanism is
 * out of a project's reach (`user-global-config`).
 *
 * `null` is the honest answer, not a safe one: the caller must surface the
 * limitation rather than treat the absence of a number as "no timeout".
 */
export function studioTimeoutSeconds(mechanism: StudioTimeoutMechanism): number | null {
  switch (mechanism.kind) {
    case "server-entry-field":
    case "vendor-default-sufficient":
    case "client-env":
      return mechanism.seconds;
    case "user-global-config":
    case "unverified":
      return null;
  }
}
