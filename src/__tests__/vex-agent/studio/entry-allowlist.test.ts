/**
 * THE CLOSED KEY ALLOWLIST is the security boundary of the writers.
 *
 * Everything Vex can ever put in an agent's config is one of a finite set of
 * keys. This file proves the set is actually closed: what the builders emit is
 * a subset of what the allowlist permits, no allowlisted key is a field the
 * same agent's record forbids, and nothing anywhere can produce an `env` map.
 *
 * An assertion that the builders emit only allowlisted keys is worth more than
 * it looks: without it the allowlist would be documentation, and a new dialect
 * branch could add a key without anyone noticing.
 */

import { describe, it, expect } from "vitest";

import {
  STUDIO_AGENT_LIST,
  isWritableStudioAgent,
} from "@vex-agent/studio/agents.js";
import {
  STUDIO_ENTRY_KEY_ALLOWLIST,
  buildStudioEntryFields,
  studioBridgeArgs,
  studioEntryObject,
  VEX_BRIDGE_PROJECT_FLAG,
} from "@vex-agent/studio/installer/render/index.js";

import { STUDIO_TEST_FACTS } from "./render-fixtures.js";

const writable = STUDIO_AGENT_LIST.filter(isWritableStudioAgent);

describe("the closed per-dialect entry allowlist", () => {
  it("covers every key the builders emit, for every agent", () => {
    for (const agent of writable) {
      const allowed = STUDIO_ENTRY_KEY_ALLOWLIST[agent.dialect];
      for (const [key] of buildStudioEntryFields(agent, STUDIO_TEST_FACTS)) {
        expect(allowed, `${agent.id} emitted ${key}, outside its dialect allowlist`)
          .toContain(key);
      }
    }
  });

  it("never permits a key that agent's own record forbids", () => {
    for (const agent of writable) {
      for (const key of STUDIO_ENTRY_KEY_ALLOWLIST[agent.dialect]) {
        expect(agent.neverWritten, `${agent.id}: ${key} is both allowed and forbidden`)
          .not.toContain(key);
      }
    }
  });

  it("has no `env` or `environment` key in ANY dialect", () => {
    // Structural, not incidental: the bridge finds the Vex socket itself, so a
    // Vex entry needs no environment map. That is what makes "a client's own
    // timeout environment variable never reaches the bridge child" impossible to
    // violate rather than merely unlikely.
    for (const keys of Object.values(STUDIO_ENTRY_KEY_ALLOWLIST)) {
      expect(keys).not.toContain("env");
      expect(keys).not.toContain("environment");
    }
  });
});

describe("the entry each builder produces", () => {
  it("always carries the bridge command and the project id", () => {
    for (const agent of writable) {
      const entry = studioEntryObject(agent, STUDIO_TEST_FACTS);
      const serialized = JSON.stringify(entry);
      expect(serialized).toContain(STUDIO_TEST_FACTS.bridgeCommand);
      expect(serialized).toContain(STUDIO_TEST_FACTS.projectId);
      expect(serialized).toContain(VEX_BRIDGE_PROJECT_FLAG);
    }
  });

  it("emits `type` exactly where the record declares one", () => {
    for (const agent of writable) {
      const entry = studioEntryObject(agent, STUDIO_TEST_FACTS);
      if (agent.dialect === "opencode-json") {
        // The one dialect where `type` is REQUIRED by the vendor schema.
        expect(entry.type).toBe("local");
        continue;
      }
      if (agent.serverTypeValue === null) {
        expect(entry, `${agent.id} must omit type`).not.toHaveProperty("type");
      } else {
        expect(entry.type, `${agent.id} type`).toBe(agent.serverTypeValue);
      }
    }
  });

  it("emits a timeout field exactly where the mechanism is a server-entry field", () => {
    for (const agent of writable) {
      const keys = buildStudioEntryFields(agent, STUDIO_TEST_FACTS).map(([key]) => key);
      if (agent.timeout.kind === "server-entry-field") {
        expect(keys, `${agent.id}`).toContain(agent.timeout.field);
      } else {
        expect(keys, `${agent.id} must not restate a timeout it does not set`)
          .not.toContain("timeout");
        expect(keys).not.toContain("tool_timeout_sec");
      }
    }
  });

  it("puts opencode's command and arguments in ONE array, per its schema", () => {
    const opencode = writable.find((agent) => agent.id === "opencode");
    if (opencode === undefined) throw new Error("opencode is missing from the registry");
    expect(studioEntryObject(opencode, STUDIO_TEST_FACTS).command).toEqual([
      STUDIO_TEST_FACTS.bridgeCommand,
      VEX_BRIDGE_PROJECT_FLAG,
      STUDIO_TEST_FACTS.projectId,
    ]);
  });

  it("gives Vibe's array-of-tables entry the required `name`", () => {
    const vibe = writable.find((agent) => agent.id === "mistral-vibe");
    if (vibe === undefined) throw new Error("mistral-vibe is missing from the registry");
    expect(studioEntryObject(vibe, STUDIO_TEST_FACTS).name).toBe("vex");
  });

  it("derives the bridge arguments from the project id, once", () => {
    expect(studioBridgeArgs(STUDIO_TEST_FACTS)).toEqual([
      VEX_BRIDGE_PROJECT_FLAG,
      STUDIO_TEST_FACTS.projectId,
    ]);
  });
});
