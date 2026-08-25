/**
 * The Vex server entry, built from a CLOSED PER-DIALECT ALLOWLIST of keys.
 *
 * "Closed" is the security property, not a style preference. Every key that can
 * appear in a file Vex writes is enumerated here, in one place, so the
 * never-written audit is a finite check over a finite set: there is no code path
 * that can add `autoApprove`, `tools: ["*"]`, `trust`, a `[permission]` rule or
 * an `env` map to a Vex entry, because no builder below can produce one.
 *
 * The entry is also ENV-FREE by construction (see `facts.ts`), which is what
 * makes "a client's own timeout environment variable is never written into the
 * bridge child's environment" structurally true rather than merely observed.
 */

import type { StudioDialect, StudioWritableAgent } from "../../agents.js";
import { STUDIO_SERVER_KEY } from "../../agents.js";
import type { StudioProjectFacts } from "./facts.js";
import { studioBridgeArgs } from "./facts.js";

/** The JSON values a Vex entry is allowed to contain. Nothing nested beyond this. */
export type StudioEntryValue = string | number | readonly string[];

/** The Vex server entry as ordered key/value pairs. Order IS the emitted order. */
export type StudioEntryFields = readonly (readonly [string, StudioEntryValue])[];

/**
 * The complete allowlist, per dialect. A key absent here cannot be written.
 *
 * `__tests__/vex-agent/studio/entry-allowlist.test.ts` asserts that every key
 * any builder emits is a member, and that no member is a field on any agent's
 * `neverWritten` list.
 */
export const STUDIO_ENTRY_KEY_ALLOWLIST: Readonly<Record<StudioDialect, readonly string[]>> = {
  "mcp-servers-json": ["type", "command", "args", "timeout"],
  "opencode-json": ["type", "command", "timeout"],
  "mcp-servers-toml-table": ["command", "args", "tool_timeout_sec"],
  "mcp-servers-toml-array": ["name", "command", "args", "tool_timeout_sec"],
};

/**
 * Build the Vex entry for one agent.
 *
 * Every branch below reads its shape from the record, so adding an agent is a
 * registry edit; adding a KEY is an edit here plus the allowlist plus the
 * matrix. `timeout` appears exactly when the record's timeout mechanism is a
 * `server-entry-field`: a vendor default that already outlasts an approval is
 * not restated, and a mechanism outside the file (client env, user-global,
 * unverified) has nothing to write.
 */
export function buildStudioEntryFields(
  agent: StudioWritableAgent,
  facts: StudioProjectFacts,
): StudioEntryFields {
  const args = studioBridgeArgs(facts);
  const fields: (readonly [string, StudioEntryValue])[] = [];

  switch (agent.dialect) {
    case "mcp-servers-json": {
      if (agent.serverTypeValue !== null) fields.push(["type", agent.serverTypeValue]);
      fields.push(["command", facts.bridgeCommand], ["args", args]);
      break;
    }
    case "opencode-json": {
      // opencode's schema is `additionalProperties: false` with `type: "local"`
      // REQUIRED and `command` an ARRAY (binary and arguments in one vector).
      fields.push(
        ["type", agent.serverTypeValue ?? "local"],
        ["command", [facts.bridgeCommand, ...args]],
      );
      break;
    }
    case "mcp-servers-toml-table": {
      fields.push(["command", facts.bridgeCommand], ["args", args]);
      break;
    }
    case "mcp-servers-toml-array": {
      // `name` is a hard required field in this dialect: the array-of-tables has
      // no table key to carry the server's identity.
      fields.push(
        ["name", STUDIO_SERVER_KEY],
        ["command", facts.bridgeCommand],
        ["args", args],
      );
      break;
    }
  }

  if (agent.timeout.kind === "server-entry-field") {
    fields.push([agent.timeout.field, agent.timeout.value]);
  }

  return fields;
}

/** The entry as a JSON object, key order preserved. */
export function studioEntryObject(
  agent: StudioWritableAgent,
  facts: StudioProjectFacts,
): Readonly<Record<string, StudioEntryValue>> {
  const object: Record<string, StudioEntryValue> = {};
  for (const [key, value] of buildStudioEntryFields(agent, facts)) object[key] = value;
  return object;
}
