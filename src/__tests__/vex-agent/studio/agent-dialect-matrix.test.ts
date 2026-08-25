/**
 * REGISTRY VERSUS THE REVIEWED MATRIX: a table test over every wire fact.
 *
 * `agent-dialect-matrix.md` is a hand-maintained artifact - a human read the
 * vendor evidence and wrote down what it says - and `studio/agents.ts` is the
 * machine-readable form of the same facts. Two hand-kept statements of the same
 * thing drift; that is what this file exists to prevent. Every config path,
 * alternate read path, dialect, owned path, `type` value, entry-key allowlist,
 * timeout field and unit, never-written token, config mode and unsupported id
 * that the registry carries is read back OUT of the document's tables and
 * compared.
 *
 * The document is parsed, not merely searched: a row that silently disappeared
 * would pass a `toContain` check on the file's text and fails here.
 *
 * Direction matters both ways. A registry edit that is not reflected in the
 * matrix fails; so does a matrix row for an id the registry does not have.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { STUDIO_AGENT_IDS } from "../../../lib/studio-agent-ids.js";
import {
  STUDIO_AGENTS,
  STUDIO_AGENT_LIST,
  isWritableStudioAgent,
  type StudioAgent,
  type StudioWritableAgent,
} from "@vex-agent/studio/agents.js";
import { STUDIO_ENTRY_KEY_ALLOWLIST } from "@vex-agent/studio/installer/render/index.js";

const MATRIX_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../vex-agent/tools/tool-surface-spec/studio-mcp/agent-dialect-matrix.md",
);

const MATRIX = readFileSync(MATRIX_PATH, "utf8");

/**
 * Rows of the Markdown table whose header contains `headerFragment`, as arrays
 * of trimmed cells. Throws when the table is missing, so a deleted table fails
 * loudly instead of vacuously passing with zero rows.
 */
function tableRows(headerFragment: string): string[][] {
  const lines = MATRIX.split("\n");
  const headerIndex = lines.findIndex(
    (line) => line.startsWith("|") && line.includes(headerFragment),
  );
  if (headerIndex === -1) {
    throw new Error(`agent-dialect-matrix.md has no table whose header contains ${headerFragment}`);
  }
  const rows: string[][] = [];
  for (let i = headerIndex + 2; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.startsWith("|")) break;
    rows.push(line.split("|").slice(1, -1).map((cell) => cell.trim()));
  }
  if (rows.length === 0) throw new Error(`table ${headerFragment} has no rows`);
  return rows;
}

/** A cell's value with Markdown code fences stripped; `-` becomes an empty list. */
function cellList(cell: string): string[] {
  if (cell === "-") return [];
  return cell.split(",").map((part) => part.trim().replace(/^`|`$/g, "")).filter((p) => p !== "");
}

function rowsById(headerFragment: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of tableRows(headerFragment)) {
    const id = row[0];
    if (id === undefined) continue;
    map.set(id, row);
  }
  return map;
}

/** How the registry's owned paths read in the matrix's `owned path` column. */
function ownedPathDisplay(agent: StudioWritableAgent): string {
  if (agent.dialect === "mcp-servers-toml-array") return '[[mcp_servers]] where name = "vex"';
  if (agent.dialect === "mcp-servers-toml-table") return "[mcp_servers.vex]";
  return agent.ownedPaths.map((path) => path.join(".")).join(", ");
}

const writable = STUDIO_AGENT_LIST.filter(isWritableStudioAgent);

describe("the config-mode table", () => {
  const rows = rowsById("config mode");

  it("has a row for every canonical id, and no id the registry lacks", () => {
    expect([...rows.keys()]).toEqual([...STUDIO_AGENT_IDS]);
  });

  it("agrees with the registry on display name and config mode", () => {
    for (const id of STUDIO_AGENT_IDS) {
      const row = rows.get(id);
      const agent: StudioAgent = STUDIO_AGENTS[id];
      expect(row?.[1], `${id} display name`).toBe(agent.displayName);
      expect(row?.[2], `${id} config mode`).toBe(agent.configMode);
    }
  });
});

describe("the paths-and-dialect table", () => {
  const rows = rowsById("config path");

  it("has a row for exactly the writable agents", () => {
    expect([...rows.keys()]).toEqual(writable.map((agent) => agent.id));
  });

  it("agrees on config path, alternate reads, format, dialect and owned path", () => {
    for (const agent of writable) {
      const row = rows.get(agent.id);
      if (row === undefined) throw new Error(`no matrix row for ${agent.id}`);

      expect(cellList(row[1] ?? ""), `${agent.id} config path`).toEqual([agent.configPath]);
      const alsoReads = agent.configMode === "project" ? agent.alsoReads : [];
      expect(cellList(row[2] ?? ""), `${agent.id} also reads`).toEqual([...alsoReads]);
      expect(row[3], `${agent.id} format`).toBe(agent.format);
      expect(row[4], `${agent.id} dialect`).toBe(agent.dialect);
      expect(
        (row[5] ?? "").replace(/`/g, ""),
        `${agent.id} owned path`,
      ).toBe(ownedPathDisplay(agent));
    }
  });
});

describe("the entry-shape table", () => {
  const rows = rowsById("entry keys allowed");

  it("has a row for exactly the writable agents", () => {
    expect([...rows.keys()]).toEqual(writable.map((agent) => agent.id));
  });

  it("agrees on the `type` value and the closed key allowlist", () => {
    for (const agent of writable) {
      const row = rows.get(agent.id);
      if (row === undefined) throw new Error(`no matrix row for ${agent.id}`);

      const declaredType = (row[1] ?? "").replace(/`/g, "");
      expect(declaredType, `${agent.id} type value`).toBe(agent.serverTypeValue ?? "omitted");

      expect(cellList(row[2] ?? ""), `${agent.id} entry keys`).toEqual(
        [...STUDIO_ENTRY_KEY_ALLOWLIST[agent.dialect]],
      );
    }
  });
});

describe("the timeout table", () => {
  const rows = rowsById("mechanism");

  it("has a row for exactly the writable agents", () => {
    expect([...rows.keys()]).toEqual(writable.map((agent) => agent.id));
  });

  it("agrees on mechanism, field or variable, and unit", () => {
    for (const agent of writable) {
      const row = rows.get(agent.id);
      if (row === undefined) throw new Error(`no matrix row for ${agent.id}`);

      const timeout = agent.timeout;
      const declaredMechanism = row[1] ?? "";
      const declaredField = (row[2] ?? "").replace(/`/g, "");
      const declaredUnit = row[3] ?? "";

      if (timeout.kind === "unverified") {
        expect(declaredMechanism, `${agent.id}`).toBe("UNVERIFIED");
        expect(declaredField).toBe("-");
        expect(declaredUnit).toBe("-");
        continue;
      }

      expect(declaredMechanism, `${agent.id} mechanism`).toBe(timeout.kind);
      expect(declaredUnit, `${agent.id} unit`).toBe(timeout.unit);
      expect(declaredField, `${agent.id} field`).toBe(
        timeout.kind === "client-env" ? timeout.variable : timeout.field,
      );
    }
  });

  it("agrees on the value Vex actually writes", () => {
    for (const agent of writable) {
      const row = rows.get(agent.id);
      const declaredValue = (row?.[4] ?? "").replace(/`/g, "");
      if (agent.timeout.kind === "server-entry-field") {
        expect(declaredValue, `${agent.id} written value`).toContain(String(agent.timeout.value));
      } else {
        // Every other mechanism writes NOTHING, and the matrix must say so
        // rather than imply a value Vex does not emit.
        expect(declaredValue, `${agent.id} writes nothing`).toContain("nothing");
      }
    }
  });
});

describe("the never-written table", () => {
  const rows = rowsById("never written");

  it("has a row for every canonical id, unsupported ones included", () => {
    expect([...rows.keys()]).toEqual([...STUDIO_AGENT_IDS]);
  });

  it("agrees token for token with the registry", () => {
    for (const id of STUDIO_AGENT_IDS) {
      const row = rows.get(id);
      expect(cellList(row?.[1] ?? ""), `${id} never-written`).toEqual([
        ...STUDIO_AGENTS[id].neverWritten,
      ]);
    }
  });
});

describe("the unsupported table", () => {
  const rows = rowsById("support returns when");

  it("lists exactly the unsupported ids", () => {
    const unsupported = STUDIO_AGENT_LIST
      .filter((agent) => agent.configMode === "unsupported")
      .map((agent) => agent.id);
    expect([...rows.keys()]).toEqual(unsupported);
  });

  it("carries the registry's own return condition", () => {
    for (const agent of STUDIO_AGENT_LIST) {
      if (agent.configMode !== "unsupported") continue;
      expect((rows.get(agent.id)?.[2] ?? "").replace(/`/g, ""), `${agent.id}`)
        .toBe(agent.supportReturnsWhen.replace(/`/g, ""));
    }
  });
});

describe("the client-basis table", () => {
  const rows = rowsById("inert until");

  it("has a row for exactly the writable agents", () => {
    expect([...rows.keys()]).toEqual(writable.map((agent) => agent.id));
  });

  it("agrees on pinned versus detected, and never guesses silently", () => {
    for (const agent of writable) {
      const declared = rows.get(agent.id)?.[1] ?? "";
      if (agent.clientVersionBasis.kind === "pinned") {
        expect(declared, `${agent.id}`).toBe(`pinned ${agent.clientVersionBasis.version}`);
      } else {
        expect(declared, `${agent.id}`).toBe("detected at install");
      }
    }
  });

  it("marks an inert-until gate wherever the registry declares one", () => {
    for (const agent of writable) {
      const declared = rows.get(agent.id)?.[2] ?? "";
      expect(declared === "-", `${agent.id} inertness`).toBe(agent.inertUntil === null);
    }
  });
});

describe("the matrix document itself", () => {
  it("names the research file and its superseding addendum as the source", () => {
    expect(MATRIX).toContain("agent-dialect-research-2026-08-24.md");
    expect(MATRIX).toContain("Addendum 2026-08-25");
  });

  it("names the owed live probes rather than pretending the cells are settled", () => {
    expect(MATRIX).toContain("Owed live probes (stage A-test)");
    for (const id of ["cursor", "amp", "kiro"]) {
      expect(MATRIX).toContain(`**${id}**`);
    }
    expect(MATRIX).toContain("progressToken");
  });

  it("records the Warp owner decision, including the declined alternative", () => {
    expect(MATRIX).toContain("OWNER\nDECISION 2026-08-25");
    expect(MATRIX).toContain("EXPLICITLY DECLINED");
  });
});
