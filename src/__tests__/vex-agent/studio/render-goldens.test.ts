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
// The same parser the renderer validates with. Used here to prove the emitted
// bytes are TOML a client can actually read, rather than to compare strings.
import { parse as parseToml } from "smol-toml";

import {
  STUDIO_AGENT_LIST,
  isWritableStudioAgent,
  type StudioWritableAgent,
} from "@vex-agent/studio/agents.js";
import {
  mergeClaudeMdImport,
  mergeStudioAgentConfig,
  mergeStudioManagedBlock,
  removeClaudeMdImport,
  removeStudioAgentConfig,
  removeStudioManagedBlock,
  renderFreshClaudeMd,
  renderStudioAgentConfig,
  renderStudioManagedBlock,
} from "@vex-agent/studio/installer/render/index.js";

import {
  STUDIO_TEST_BRIEF,
  STUDIO_TEST_FACTS,
  existingConfigFixture,
} from "./render-fixtures.js";

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

  /**
   * `malformed_toml` was DECLARED in the closed refusal set and nothing ever
   * emitted it. The line scanner that does the section rewrite cannot notice
   * that a file is broken - it copies every non-header line through untouched -
   * so a config with an unterminated string or a duplicate key got a
   * `[mcp_servers.vex]` section appended and was handed to a client that then
   * failed to parse the whole file, with Vex's section at the bottom looking
   * like the cause.
   *
   * One case per TOML failure class the parser distinguishes, because they are
   * different mistakes a human makes in a config by hand.
   */
  describe("refuses a file that is not valid TOML, before rewriting a byte", () => {
    const malformed = {
      "an unterminated string": 'command = "unterminated\n',
      "a duplicate key": 'timeout = 1\ntimeout = 2\n',
      "a duplicate table": '[tools]\nx = 1\n[tools]\ny = 2\n',
      "a malformed array": 'args = ["--project", "p"\n',
    };

    for (const [label, broken] of Object.entries(malformed)) {
      it(`refuses ${label}`, () => {
        for (const agent of tomlAgents) {
          const merge = mergeStudioAgentConfig(broken, agent, STUDIO_TEST_FACTS);
          expect(merge.status, `${agent.id}: ${label} must refuse`).toBe("refused");
          if (merge.status === "refused") {
            expect(merge.reason).toBe("malformed_toml");
            // Actionable position, and NOT the user's own bytes: a refusal
            // detail travels to the renderer and into the logs.
            expect(merge.detail).toContain("not valid TOML");
            expect(merge.detail).toMatch(/line \d+, column \d+/);
            expect(merge.detail).not.toContain("unterminated");
          }

          const remove = removeStudioAgentConfig(broken, agent, STUDIO_TEST_FACTS);
          expect(remove.status, `${agent.id}: ${label} remove must refuse`).toBe("refused");
          if (remove.status === "refused") expect(remove.reason).toBe("malformed_toml");
        }
      });
    }

    /**
     * TOML 1.0 forbids every unescaped control character inside a basic string.
     * Escaping only `\` and `"` was a bet that a bridge path never contains
     * one - a bet about a value that arrives from the FILESYSTEM. A newline in
     * that path emitted a file that is not TOML at all, and the client failed
     * to parse the user's own config.
     *
     * The proof is the parser, not a string comparison: whatever we emit must
     * come back out of `smol-toml` as the exact bytes we put in.
     */
    it("escapes control characters in a bridge path so the file stays valid TOML", () => {
      const agent = tomlAgents[0];
      if (agent === undefined) throw new Error("no TOML agent in the registry");

      const nasty = [
        "/tmp/vex",
        String.fromCharCode(10),
        "nl/",
        String.fromCharCode(9),
        "tab/",
        String.fromCharCode(7),
        "bell/",
        String.fromCharCode(127),
        "del/",
        String.fromCharCode(92),
        'quote"end/vex-mcp',
      ].join("");

      const rendered = textOf(
        renderStudioAgentConfig(agent, { ...STUDIO_TEST_FACTS, bridgeCommand: nasty }),
        "control-character bridge path",
      );

      // It parses at all, which is the property that was broken.
      const parsed = parseToml(rendered) as Record<string, unknown>;
      // And it round-trips: the path the client reads is the path we were given.
      const servers = parsed.mcp_servers as Record<string, { command: string }>;
      expect(servers.vex?.command).toBe(nasty);

      // No raw control byte survived into the emitted text. Newline is the
      // document's own line separator and is the one exclusion.
      const CONTROL = new RegExp("[\\u0000-\\u0009\\u000B-\\u001F\\u007F]", "u");
      expect(CONTROL.test(rendered)).toBe(false);
    });

    it("still accepts every valid config the goldens are built from", () => {
      // The guard rejects BROKEN files, not unusual ones. If it ever starts
      // refusing a file this repository itself renders, that is the bug.
      for (const agent of tomlAgents) {
        const existing = existingConfigFixture(agent);
        const merged = mergeStudioAgentConfig(existing, agent, STUDIO_TEST_FACTS);
        expect(merged.status, `${agent.id} must not be refused`).not.toBe("refused");
      }
    });
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

  /**
   * `context.fileName` is a LIST THE USER ALSO OWNS, and Vex claims exactly one
   * element of it.
   *
   * Declaring it as `value: ["AGENTS.md"]` made every render assign the whole
   * array. A user who had told Gemini to read their own files lost all of them,
   * silently, on a scope edit made for an unrelated reason - and got them
   * deleted again on every subsequent render.
   */
  describe("Gemini's context.fileName is set membership, not assignment", () => {
    const gemini = writable.find((agent) => agent.id === "gemini-cli");
    if (gemini === undefined) throw new Error("gemini-cli is not in the registry");

    const withUserList = (...names: string[]): string =>
      `${JSON.stringify({ context: { fileName: names } }, null, 2)}\n`;

    it("PRESERVES a pre-existing list and appends only its own element", () => {
      const merged = textOf(
        mergeStudioAgentConfig(
          withUserList("GEMINI.md", "docs/house-rules.md"),
          gemini,
          STUDIO_TEST_FACTS,
        ),
        "gemini merge",
      );
      const list = JSON.parse(merged).context.fileName;
      expect(list).toEqual(["GEMINI.md", "docs/house-rules.md", "AGENTS.md"]);
    });

    it("does not move or duplicate an element that is already there", () => {
      const existing = withUserList("AGENTS.md", "GEMINI.md");
      const merged = mergeStudioAgentConfig(existing, gemini, STUDIO_TEST_FACTS);
      const text = merged.status === "rendered" ? merged.text : existing;
      const list = JSON.parse(text).context.fileName;
      // Same order, one occurrence: a re-render is not a reshuffle.
      expect(list).toEqual(["AGENTS.md", "GEMINI.md"]);
    });

    it("survives a post-install edit that adds a filename of the user's", () => {
      const installed = textOf(
        mergeStudioAgentConfig(withUserList("GEMINI.md"), gemini, STUDIO_TEST_FACTS),
        "gemini install",
      );
      // The user then adds their own file, as they are entitled to.
      const edited = installed.replace('"AGENTS.md"', '"AGENTS.md",\n      "NOTES.md"');
      const rerendered = mergeStudioAgentConfig(edited, gemini, STUDIO_TEST_FACTS);
      const text = rerendered.status === "rendered" ? rerendered.text : edited;
      expect(JSON.parse(text).context.fileName).toEqual([
        "GEMINI.md",
        "AGENTS.md",
        "NOTES.md",
      ]);
    });

    it("on DESELECT takes back only its element and leaves the rest", () => {
      const installed = textOf(
        mergeStudioAgentConfig(
          withUserList("GEMINI.md", "docs/house-rules.md"),
          gemini,
          STUDIO_TEST_FACTS,
        ),
        "gemini install",
      );
      const removed = textOf(
        removeStudioAgentConfig(installed, gemini, STUDIO_TEST_FACTS),
        "gemini remove",
      );
      expect(JSON.parse(removed).context.fileName).toEqual([
        "GEMINI.md",
        "docs/house-rules.md",
      ]);
    });

    it("on DESELECT drops a list that held nothing but its own element", () => {
      const fresh = textOf(
        renderStudioAgentConfig(gemini, STUDIO_TEST_FACTS),
        "gemini fresh",
      );
      expect(JSON.parse(fresh).context.fileName).toEqual(["AGENTS.md"]);
      const removed = textOf(
        removeStudioAgentConfig(fresh, gemini, STUDIO_TEST_FACTS),
        "gemini remove",
      );
      // The wrapper Vex was the sole occupant of goes with it, no `{}` residue.
      expect(removed).not.toContain("context");
    });

    it("REFUSES a shape it cannot own instead of reshaping the user's value", () => {
      // A string where a list belongs may be an older single-file spelling.
      // Coercing it would delete a setting while looking like a clean install.
      for (const hostile of [
        '{\n  "context": { "fileName": "GEMINI.md" }\n}\n',
        '{\n  "context": { "fileName": [1, 2] }\n}\n',
      ]) {
        const merged = mergeStudioAgentConfig(hostile, gemini, STUDIO_TEST_FACTS);
        expect(merged.status).toBe("refused");
        if (merged.status === "refused") expect(merged.reason).toBe("malformed_json");
      }
    });
  });

  /**
   * A non-object root parses without a single `ParseError`, so nothing stopped
   * `modify()` from turning the user's array - or their string, or their number
   * - into an object with `mcpServers` in it. A well-formed rewrite that
   * destroys the entire file.
   */
  it("refuses a JSON document whose ROOT is not an object", () => {
    const agent = jsonAgents[0];
    if (agent === undefined) throw new Error("no JSON agent in the registry");
    for (const root of ['["a", "b"]\n', '"just a string"\n', "42\n", "null\n"]) {
      const merge = mergeStudioAgentConfig(root, agent, STUDIO_TEST_FACTS);
      expect(merge.status, `root ${root.trim()} must refuse`).toBe("refused");
      if (merge.status === "refused") {
        expect(merge.reason).toBe("malformed_json");
        expect(merge.detail).toContain("not an object");
      }
      const remove = removeStudioAgentConfig(root, agent, STUDIO_TEST_FACTS);
      expect(remove.status).toBe("refused");
    }
  });

  it("INSTALLS into a whitespace-only file, which the root-shape gate must not refuse", () => {
    // The boundary of the gate above, and the reason it is a ROOT-SHAPE gate
    // rather than a parse gate: `[]` and `"text"` hold a value a rewrite would
    // destroy, while a file of zero bytes holds nothing at all and is
    // equivalent to the absent file Vex creates without hesitating. Refusing
    // it would strand every user whose editor or installer left an empty
    // config behind, with no content lost in either direction.
    const agent = jsonAgents[0];
    if (agent === undefined) throw new Error("no JSON agent in the registry");
    for (const empty of ["", "   \n"]) {
      const merged = mergeStudioAgentConfig(empty, agent, STUDIO_TEST_FACTS);
      expect(merged.status, `"${empty}" must install`).toBe("rendered");
    }
  });
});

/**
 * The instruction-file goldens. Same protocol as the config goldens: the bytes
 * of the fresh file, the bytes after a merge into a user's existing file, and
 * the bytes after a remove. `AGENTS.md` is the one file whose content changes
 * with the project, so its goldens are rendered from the fixed
 * `STUDIO_TEST_BRIEF` rather than from a live inventory.
 */
describe("AGENTS.md and CLAUDE.md", () => {
  const USER_AGENTS = "# Contributing\n\nRun the tests before you push.\n";
  const USER_CLAUDE = "# My rules\n\nBe brief.\n";

  it("renders the committed AGENTS.md goldens", () => {
    compareGolden("AGENTS.fresh.md", renderStudioManagedBlock(STUDIO_TEST_BRIEF));
    compareGolden("AGENTS.existing.md", USER_AGENTS);
    const merged = textOf(
      mergeStudioManagedBlock(USER_AGENTS, STUDIO_TEST_BRIEF, { overwriteDrift: false }),
      "AGENTS.md merge",
    );
    compareGolden("AGENTS.merged.md", merged);
    compareGolden(
      "AGENTS.removed.md",
      textOf(removeStudioManagedBlock(merged), "AGENTS.md remove"),
    );
  });

  it("renders the committed CLAUDE.md goldens", () => {
    compareGolden("CLAUDE.fresh.md", textOf(renderFreshClaudeMd(), "CLAUDE.md fresh"));
    compareGolden("CLAUDE.existing.md", USER_CLAUDE);
    const merged = textOf(mergeClaudeMdImport(USER_CLAUDE), "CLAUDE.md merge");
    compareGolden("CLAUDE.merged.md", merged);
    compareGolden(
      "CLAUDE.removed.md",
      textOf(removeClaudeMdImport(merged), "CLAUDE.md remove"),
    );
  });

  it("returns AGENTS.md to the user's original bytes after merge then remove", () => {
    const merged = textOf(
      mergeStudioManagedBlock(USER_AGENTS, STUDIO_TEST_BRIEF, { overwriteDrift: false }),
      "AGENTS.md merge",
    );
    expect(textOf(removeStudioManagedBlock(merged), "AGENTS.md remove")).toBe(USER_AGENTS);
  });
});
