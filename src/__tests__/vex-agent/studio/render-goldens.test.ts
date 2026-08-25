/**
 * GOLDEN ARTIFACTS for every project- and launch-integrated agent.
 *
 * Four committed files per agent - the pre-existing fixture, the fresh render,
 * the merge into that fixture, and the remove from the merge result - compared
 * BYTE FOR BYTE. Property tests can prove that a merge does not throw; only
 * bytes can prove that the user's comment is still on line 2, that their block
 * comment did not migrate, that `3900.0` is not `3900`, and that a foreign
 * `[permission]` section came through a merge and a remove untouched. The diff
 * on these files IS the review signal for any renderer change.
 *
 * Regenerate with the SAME command as every other tool-surface artifact in this
 * repository - one protocol, not a second one to remember:
 *
 *     UPDATE_TOOLSNAPS=true pnpm exec vitest run src/__tests__/vex-agent/studio
 *
 * and review the regenerated files as a contract diff.
 *
 * Beyond the bytes, this file asserts the three INVARIANTS the bytes are
 * evidence for: a merge preserves everything outside the Vex-owned paths, a
 * remove deletes only the Vex entry, and remove-after-merge returns the file to
 * exactly the bytes it started with.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  STUDIO_AGENT_LIST,
  isWritableStudioAgent,
  type StudioWritableAgent,
} from "@vex-agent/studio/agents.js";
import {
  mergeStudioAgentConfig,
  removeStudioAgentConfig,
  renderStudioAgentConfig,
} from "@vex-agent/studio/installer/render/index.js";

import { STUDIO_TEST_FACTS, existingConfigFixture } from "./render-fixtures.js";

const GOLDEN_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../vex-agent/studio/installer/render/__goldens__",
);

const UPDATING = process.env.UPDATE_TOOLSNAPS === "true";

const REMEDY =
  "run `UPDATE_TOOLSNAPS=true pnpm exec vitest run src/__tests__/vex-agent/studio` "
  + "if this change is expected, and review the regenerated artifact as a contract diff";

function compareGolden(name: string, actual: string): void {
  const path = join(GOLDEN_DIR, name);
  if (UPDATING) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, actual, "utf8");
    return;
  }
  let stored: string;
  try {
    stored = readFileSync(path, "utf8");
  } catch {
    throw new Error(`golden ${name} does not exist; ${REMEDY}`);
  }
  if (stored !== actual) {
    throw new Error(
      `golden ${name} does not match what the renderer produced; ${REMEDY}\n`
        + firstDifferingLine(stored, actual),
    );
  }
  expect(actual).toBe(stored);
}

function firstDifferingLine(expected: string, actual: string): string {
  const left = expected.split("\n");
  const right = actual.split("\n");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) {
      return `line ${String(i + 1)}:\n  golden:   ${left[i] ?? "<end>"}\n  rendered: ${right[i] ?? "<end>"}`;
    }
  }
  return "the files differ only in trailing content";
}

const writable = STUDIO_AGENT_LIST.filter(isWritableStudioAgent);

function extensionFor(agent: StudioWritableAgent): string {
  return agent.format === "toml" ? "toml" : "json";
}

/** `rendered` text, or a failure that names the status instead of hiding it. */
function textOf(
  result: ReturnType<typeof renderStudioAgentConfig>,
  what: string,
): string {
  if (result.status !== "rendered") {
    throw new Error(
      `${what}: expected rendered bytes, got ${result.status}`
        + (result.status === "refused" ? ` (${result.reason}: ${result.detail})` : ""),
    );
  }
  return result.text;
}

describe.each(writable.map((agent) => [agent.id, agent] as const))(
  "%s config rendering",
  (id, agent) => {
    const extension = extensionFor(agent);
    const existing = existingConfigFixture(agent);
    const fresh = textOf(renderStudioAgentConfig(agent, STUDIO_TEST_FACTS), `${id} fresh`);
    const merged = textOf(
      mergeStudioAgentConfig(existing, agent, STUDIO_TEST_FACTS),
      `${id} merge`,
    );
    const removed = textOf(
      removeStudioAgentConfig(merged, agent, STUDIO_TEST_FACTS),
      `${id} remove`,
    );

    it("renders the committed fresh-file golden", () => {
      compareGolden(`${id}.existing.${extension}`, existing);
      compareGolden(`${id}.fresh.${extension}`, fresh);
    });

    it("renders the committed merged-file golden", () => {
      compareGolden(`${id}.merged.${extension}`, merged);
    });

    it("renders the committed removed-file golden", () => {
      compareGolden(`${id}.removed.${extension}`, removed);
    });

    it("merges without clobbering the user's comments or unknown keys", () => {
      // Assert the CONTENT of the fixture survives, line by line, not merely
      // that the merge succeeded.
      const survivors = existing
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.trim().startsWith("}"));
      for (const line of survivors) {
        expect(merged, `${id}: merge dropped ${JSON.stringify(line)}`).toContain(line.trim());
      }
    });

    it("adds the Vex entry and the bridge invocation", () => {
      expect(merged).toContain(STUDIO_TEST_FACTS.bridgeCommand);
      expect(merged).toContain(STUDIO_TEST_FACTS.projectId);
      expect(merged).toContain("--project");
    });

    it("removes ONLY the Vex entry: the remainder is the original file", () => {
      // The strongest available statement of "only ours": a merge followed by a
      // remove is the identity on the user's bytes.
      expect(removed).toBe(existing);
    });

    it("is a no-op to remove twice", () => {
      expect(removeStudioAgentConfig(removed, agent, STUDIO_TEST_FACTS).status)
        .toBe("unchanged");
    });

    it("is a no-op to merge the same entry twice", () => {
      expect(mergeStudioAgentConfig(merged, agent, STUDIO_TEST_FACTS).status)
        .toBe("unchanged");
    });

    it("never emits an environment map into the bridge child", () => {
      expect(fresh).not.toMatch(/"env"|^\s*env\s*=/m);
      expect(fresh).not.toMatch(/"environment"|^\s*environment\s*=/m);
    });
  },
);

describe("TOML merges and the foreign [permission] section", () => {
  const tomlAgents = writable.filter((agent) => agent.format === "toml");

  it("covers grok, codex and vibe", () => {
    expect(tomlAgents.map((agent) => agent.id).sort()).toEqual([
      "codex",
      "grok-build",
      "mistral-vibe",
    ]);
  });

  it("preserves a foreign [permission] block VERBATIM through merge and remove", () => {
    const foreign = ["[permission]", 'allow = ["shell", "edit"]'];
    for (const agent of tomlAgents) {
      const existing = existingConfigFixture(agent);
      const merged = textOf(
        mergeStudioAgentConfig(existing, agent, STUDIO_TEST_FACTS),
        `${agent.id} merge`,
      );
      for (const line of foreign) {
        expect(merged, `${agent.id}: merge must preserve ${line}`).toContain(line);
      }
      // And it is still the user's comment inside that block, not a rewrite.
      expect(merged).toContain(
        "# FOREIGN AUTHORITY STATEMENT. Vex never writes this and never removes it.",
      );

      const removed = textOf(
        removeStudioAgentConfig(merged, agent, STUDIO_TEST_FACTS),
        `${agent.id} remove`,
      );
      expect(removed).toBe(existing);
    }
  });

  it("refuses a file with a multi-line string rather than risk corrupting it", () => {
    const agent = tomlAgents[0];
    if (agent === undefined) throw new Error("no TOML agent in the registry");
    const hostile = 'notes = """\n[mcp_servers.vex]\nnot really a section\n"""\n';

    const merge = mergeStudioAgentConfig(hostile, agent, STUDIO_TEST_FACTS);
    expect(merge.status).toBe("refused");
    if (merge.status === "refused") {
      expect(merge.reason).toBe("toml_multiline_string");
      expect(merge.detail).toContain("multi-line string");
    }

    const remove = removeStudioAgentConfig(hostile, agent, STUDIO_TEST_FACTS);
    expect(remove.status).toBe("refused");
  });
});

describe("JSON merges", () => {
  const jsonAgents = writable.filter((agent) => agent.format === "jsonc");

  it("refuses a malformed file rather than overwriting the user's bytes", () => {
    const agent = jsonAgents[0];
    if (agent === undefined) throw new Error("no JSON agent in the registry");
    const broken = '{ "mcpServers": { "a": }\n';

    const merge = mergeStudioAgentConfig(broken, agent, STUDIO_TEST_FACTS);
    expect(merge.status).toBe("refused");
    if (merge.status === "refused") expect(merge.reason).toBe("malformed_json");

    expect(removeStudioAgentConfig(broken, agent, STUDIO_TEST_FACTS).status).toBe("refused");
  });

  it("keeps a now-empty container instead of editing a path Vex does not own", () => {
    const agent = jsonAgents.find((candidate) => candidate.id === "claude-code");
    if (agent === undefined) throw new Error("claude-code is not a JSON agent");

    const onlyVex = textOf(
      renderStudioAgentConfig(agent, STUDIO_TEST_FACTS),
      "claude-code fresh",
    );
    const emptied = textOf(
      removeStudioAgentConfig(onlyVex, agent, STUDIO_TEST_FACTS),
      "claude-code remove",
    );
    expect(emptied).toContain("mcpServers");
    expect(emptied).not.toContain("vex-mcp");
  });
});
