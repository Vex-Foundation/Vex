/**
 * RECONCILIATION: ownership, provenance, drift, repair, and the fault-injection
 * case (stage A5b items 4, 6 and 8).
 *
 * These tests drive the REAL renderers, the REAL confinement checks and the
 * REAL ordering against a real temporary directory. Only two things are
 * injected: the provenance store (an in-memory map, because a Postgres instance
 * proves nothing extra about this logic) and, for the fault-injection case, a
 * `replaceFile` wrapper that fails after the Nth successful replacement.
 *
 * WHY THE FAULT INJECTION IS MEANINGFUL, and not a test that passes by
 * construction: it asserts a THREE-part property that a single run cannot fake.
 *   (a) after the failed run, the provenance store holds exactly the artifacts
 *       that were actually written - not zero, and not all of them;
 *   (b) the files that were written are on disk with Vex's entry in them;
 *   (c) a SECOND run, using the REAL writer and the provenance the first run
 *       left behind, completes the remainder AND does not refuse the earlier
 *       files as collisions.
 * Part (c) is the one that would fail if provenance were committed in one
 * transaction at the end of the run: the second pass would meet its own
 * entries, be unable to prove them, and refuse every one.
 */

import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  STUDIO_AGENTS,
  isWritableStudioAgent,
  type StudioWritableAgent,
} from "@vex-agent/studio/agents.js";
import {
  readStudioOwnedRegion,
  renderStudioAgentConfig,
  type StudioProjectBrief,
  type StudioProjectFacts,
} from "@vex-agent/studio/installer/render/index.js";
import type { StudioArtifactOutcome } from "@shared/schemas/studio-installer.js";
import { hashText, replaceConfinedFile } from "../installer/confined-fs.js";
import { agentArtifactKey, buildStudioPlan } from "../installer/plan.js";
import {
  reconcileStudioArtifacts,
  type ArtifactProvenanceWrite,
  type ReconcileIo,
} from "../installer/reconcile.js";

const FACTS: StudioProjectFacts = {
  projectId: "0f6b1c2e-8a4d-4f1b-9c3e-7d5a2b8e4c10",
  bridgeCommand: "/opt/vex/bin/vex-mcp",
};

const BRIEF: StudioProjectBrief = {
  projectName: "acme",
  projectId: FACTS.projectId,
  vexVersion: "0.2.6",
  permission: "restricted",
  wallets: [{ family: "evm", address: "0xabc" }],
  createdOn: "2026-08-01",
  scopeUpdatedOn: "2026-08-25",
  agentNames: ["Claude Code"],
  inventory: {
    alwaysLoadedCount: 2,
    alwaysLoadedNames: ["vex_ToolSearch", "WalletBalances"],
    searchableCount: 100,
    protocols: [{ name: "morpho", toolCount: 100 }],
  },
  changeNotes: [],
};

let project: string;
let store: Map<
  string,
  { entryHash: string | null; contentHash: string; origin: "written" | "adopted" }
>;

beforeEach(async () => {
  project = await realpath(await mkdtemp(path.join(tmpdir(), "vex-reconcile-")));
  store = new Map();
});

function io(overrides: Partial<ReconcileIo> = {}): ReconcileIo {
  return {
    replaceFile: replaceConfinedFile,
    commitProvenance: async (record: ArtifactProvenanceWrite) => {
      store.set(record.artifactKey, {
        entryHash: record.entryHash,
        contentHash: record.contentHash,
        origin: record.origin,
      });
      return true;
    },
    clearProvenance: async (key: string) => {
      store.delete(key);
      return true;
    },
    ...overrides,
  };
}

async function run(options: {
  agents: readonly ("claude-code" | "codex" | "cline" | "amp")[];
  repair?: boolean;
  io?: ReconcileIo;
}): Promise<readonly StudioArtifactOutcome[]> {
  return (await runResult(options)).artifacts;
}

/** The whole result, for assertions about `completed` rather than per artifact. */
async function runResult(options: {
  agents: readonly ("claude-code" | "codex" | "cline" | "amp")[];
  repair?: boolean;
  io?: ReconcileIo;
}): Promise<{ artifacts: readonly StudioArtifactOutcome[]; completed: boolean }> {
  const plan = buildStudioPlan({
    selectedAgentIds: [...options.agents],
    previouslyWritten: new Set(store.keys()),
  });
  const result = await reconcileStudioArtifacts({
    projectDirectory: project,
    plan,
    facts: FACTS,
    brief: BRIEF,
    provenance: store,
    repair: options.repair ?? false,
    io: options.io ?? io(),
  });
  return { artifacts: result.artifacts, completed: result.completed };
}

/** Narrow a registry record to the writable variant without an unsafe cast. */
function writable(id: keyof typeof STUDIO_AGENTS): StudioWritableAgent {
  const agent = STUDIO_AGENTS[id];
  if (!isWritableStudioAgent(agent)) throw new Error(`${id} has no writer`);
  return agent;
}

function outcomeFor(
  outcomes: readonly StudioArtifactOutcome[],
  predicate: (outcome: StudioArtifactOutcome) => boolean,
): StudioArtifactOutcome {
  const found = outcomes.find(predicate);
  if (found === undefined) throw new Error("no matching artifact outcome");
  return found;
}

describe("a first install", () => {
  it("writes every artifact and records provenance for each one", async () => {
    const outcomes = await run({ agents: ["claude-code"] });

    expect(outcomes.every((o) => o.status === "written")).toBe(true);
    expect([...store.keys()].sort()).toEqual(
      ["agent:claude-code", "agents-md", "claude-md", "protocols-doc"].sort(),
    );

    const mcp = await readFile(path.join(project, ".mcp.json"), "utf8");
    expect(mcp).toContain("/opt/vex/bin/vex-mcp");
    expect(mcp).toContain(FACTS.projectId);
    expect(await readFile(path.join(project, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
    expect(await readFile(path.join(project, "AGENTS.md"), "utf8"))
      .toContain("vex:studio:begin");
  });

  it("is idempotent: a second run changes nothing", async () => {
    await run({ agents: ["claude-code"] });
    const second = await run({ agents: ["claude-code"] });
    expect(second.every((o) => o.status === "unchanged")).toBe(true);
  });

  it("reports an UNSUPPORTED selection explicitly and writes no file for it", async () => {
    const outcomes = await run({ agents: ["cline"] });
    const cline = outcomeFor(outcomes, (o) => o.agentId === "cline");
    expect(cline.status).toBe("unsupported");
    if (cline.status === "unsupported") {
      expect(cline.path).toBeNull();
      expect(cline.reason).toContain("~/.cline/mcp.json");
      expect(cline.supportReturnsWhen).toContain("project-scoped");
    }
    expect(store.has("agent:cline")).toBe(false);
  });
});

describe("provenance", () => {
  it("REFUSES a foreign entry sitting at the Vex path", async () => {
    await writeFile(
      path.join(project, ".mcp.json"),
      JSON.stringify(
        { mcpServers: { vex: { command: "/somebody/elses/binary" } } },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const outcomes = await run({ agents: ["claude-code"] });
    const config = outcomeFor(outcomes, (o) => o.agentId === "claude-code");
    expect(config.status).toBe("refused");
    if (config.status === "refused") {
      expect(config.reason).toBe("provenance_collision");
      expect(config.detail).toContain("did not write");
    }
    // The foreign entry is EXACTLY as it was.
    expect(await readFile(path.join(project, ".mcp.json"), "utf8"))
      .toContain("/somebody/elses/binary");
    expect(store.has("agent:claude-code")).toBe(false);
  });

  it("REWRITES an entry it can prove is its own", async () => {
    await run({ agents: ["claude-code"] });

    // A new bridge path: the same artifact, different content.
    const plan = buildStudioPlan({
      selectedAgentIds: ["claude-code"],
      previouslyWritten: new Set(store.keys()),
    });
    const result = await reconcileStudioArtifacts({
      projectDirectory: project,
      plan,
      facts: { ...FACTS, bridgeCommand: "/opt/vex/bin/vex-mcp-2" },
      brief: BRIEF,
      provenance: store,
      repair: false,
      io: io(),
    });
    const config = outcomeFor(result.artifacts, (o) => o.agentId === "claude-code");
    expect(config.status).toBe("written");
    expect(await readFile(path.join(project, ".mcp.json"), "utf8"))
      .toContain("/opt/vex/bin/vex-mcp-2");
  });

  it("REJECTS unknown keys inside a proven Vex entry, BY NAME", async () => {
    await run({ agents: ["claude-code"] });

    const target = path.join(project, ".mcp.json");
    const parsed = JSON.parse(await readFile(target, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    // Somebody added authority to OUR entry.
    parsed.mcpServers.vex = { ...parsed.mcpServers.vex, autoApprove: ["*"] };
    await writeFile(target, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    // Re-point provenance at the edited entry so the ONLY thing being tested is
    // the unknown-key rule, not the collision rule.
    const region = readStudioOwnedRegion(
      await readFile(target, "utf8"),
      writable("claude-code"),
    );
    if (region.kind !== "present") throw new Error("expected a present region");
    store.set("agent:claude-code", {
      entryHash: region.hash,
      contentHash: hashText(await readFile(target, "utf8")),
      origin: "written",
    });

    const outcomes = await run({ agents: ["claude-code"] });
    const config = outcomeFor(outcomes, (o) => o.agentId === "claude-code");
    expect(config.status).toBe("refused");
    if (config.status === "refused") {
      expect(config.reason).toBe("unknown_keys_in_vex_entry");
      expect(config.detail).toContain("autoApprove");
    }
    // And the key is still there: refusing is not deleting.
    expect(await readFile(target, "utf8")).toContain("autoApprove");
  });
});

describe("deselect", () => {
  it("removes an UNCHANGED entry Vex wrote, and keeps the file", async () => {
    await writeFile(
      path.join(project, ".mcp.json"),
      "{\n  \"mcpServers\": {\n    \"other\": { \"command\": \"/x\" }\n  }\n}\n",
      "utf8",
    );
    await run({ agents: ["claude-code"] });
    expect(await readFile(path.join(project, ".mcp.json"), "utf8")).toContain("vex-mcp");

    const outcomes = await run({ agents: [] });
    const config = outcomeFor(outcomes, (o) => o.agentId === "claude-code");
    expect(config.status).toBe("removed");

    const after = await readFile(path.join(project, ".mcp.json"), "utf8");
    expect(after).not.toContain("vex-mcp");
    // A5 NEVER deletes a file: the user's other server is still there.
    expect(after).toContain("\"other\"");
    expect(store.has("agent:claude-code")).toBe(false);
  });

  it("REFUSES to remove an entry that was changed after Vex wrote it", async () => {
    await run({ agents: ["claude-code"] });

    const target = path.join(project, ".mcp.json");
    const edited = (await readFile(target, "utf8")).replace(
      "/opt/vex/bin/vex-mcp",
      "/home/me/my-own-build/vex-mcp",
    );
    await writeFile(target, edited, "utf8");

    const outcomes = await run({ agents: [] });
    const config = outcomeFor(outcomes, (o) => o.agentId === "claude-code");
    expect(config.status).toBe("refused");
    if (config.status === "refused") expect(config.reason).toBe("provenance_collision");
    // The user's edit survives, and Vex still remembers it owned the entry.
    expect(await readFile(target, "utf8")).toContain("/home/me/my-own-build/vex-mcp");
    expect(store.has("agent:claude-code")).toBe(true);
  });
});

describe("drift and repair", () => {
  it("reports an edited managed block and does NOT overwrite it", async () => {
    await run({ agents: ["claude-code"] });
    const target = path.join(project, "AGENTS.md");
    const edited = (await readFile(target, "utf8")).replace(
      "This repository is connected to Vex",
      "MY OWN NOTE. This repository is connected to Vex",
    );
    await writeFile(target, edited, "utf8");

    const outcomes = await run({ agents: ["claude-code"] });
    const block = outcomeFor(outcomes, (o) => o.kind === "agents-md");
    expect(block.status).toBe("drift_blocked");
    expect(await readFile(target, "utf8")).toContain("MY OWN NOTE");
  });

  it("overwrites a drifted managed block ONLY on an explicit repair", async () => {
    await run({ agents: ["claude-code"] });
    const target = path.join(project, "AGENTS.md");
    await writeFile(
      target,
      (await readFile(target, "utf8")).replace("Vex Studio", "Vex Studio EDITED"),
      "utf8",
    );

    const repaired = await run({ agents: ["claude-code"], repair: true });
    expect(outcomeFor(repaired, (o) => o.kind === "agents-md").status).toBe("written");
    expect(await readFile(target, "utf8")).not.toContain("EDITED");
  });

  it("never touches the user's text OUTSIDE the markers, even on repair", async () => {
    await writeFile(path.join(project, "AGENTS.md"), "# Mine\n\nKeep me.\n", "utf8");
    await run({ agents: ["claude-code"] });
    await run({ agents: ["claude-code"], repair: true });
    expect(await readFile(path.join(project, "AGENTS.md"), "utf8"))
      .toContain("Keep me.");
  });

  it("reports a removed CLAUDE.md import as drift, and repair restores it", async () => {
    await run({ agents: ["claude-code"] });
    const target = path.join(project, "CLAUDE.md");
    await writeFile(
      target,
      (await readFile(target, "utf8")).replace("@AGENTS.md", ""),
      "utf8",
    );

    const outcomes = await run({ agents: ["claude-code"] });
    expect(outcomeFor(outcomes, (o) => o.kind === "claude-md").status).toBe("drift_blocked");

    const repaired = await run({ agents: ["claude-code"], repair: true });
    expect(outcomeFor(repaired, (o) => o.kind === "claude-md").status).toBe("written");
    expect(await readFile(target, "utf8")).toContain("@AGENTS.md");
  });

  it("refuses a half-open managed fence instead of guessing its boundary", async () => {
    await writeFile(
      path.join(project, "AGENTS.md"),
      "# Mine\n\n<!-- vex:studio:begin hash=abc -->\nhalf open\n",
      "utf8",
    );
    const outcomes = await run({ agents: [] });
    const block = outcomeFor(outcomes, (o) => o.kind === "agents-md");
    expect(block.status).toBe("refused");
    if (block.status === "refused") expect(block.reason).toBe("malformed_managed_block");
  });
});

describe("malformed existing config files", () => {
  it("refuses a malformed JSON config and leaves the bytes alone", async () => {
    await writeFile(path.join(project, ".mcp.json"), "{ \"mcpServers\": { \n", "utf8");
    const outcomes = await run({ agents: ["claude-code"] });
    const config = outcomeFor(outcomes, (o) => o.agentId === "claude-code");
    expect(config.status).toBe("refused");
    if (config.status === "refused") expect(config.reason).toBe("malformed_json");
    expect(await readFile(path.join(project, ".mcp.json"), "utf8"))
      .toBe("{ \"mcpServers\": { \n");
  });

  it("SURFACES the TOML multi-line refusal to the user rather than skipping it", async () => {
    await mkdir(path.join(project, ".codex"), { recursive: true });
    await writeFile(
      path.join(project, ".codex", "config.toml"),
      'notes = """\n[mcp_servers.vex]\nnot really a section\n"""\n',
      "utf8",
    );
    const outcomes = await run({ agents: ["codex"] });
    const config = outcomeFor(outcomes, (o) => o.agentId === "codex");
    expect(config.status).toBe("refused");
    if (config.status === "refused") {
      expect(config.reason).toBe("toml_multiline_string");
      expect(config.detail).toContain("multi-line string");
    }
  });
});

describe("FAULT INJECTION: a run that dies mid-way, and the Repair that finishes it", () => {
  it("commits provenance per file and lets Repair complete the remainder", async () => {
    // Fail immediately after the SECOND successful replacement.
    let successes = 0;
    const failingIo = io({
      replaceFile: async (options) => {
        if (successes >= 2) {
          return {
            kind: "refused" as const,
            reason: "io_error" as const,
            detail: "injected failure",
          };
        }
        const result = await replaceConfinedFile(options);
        if (result.kind === "written") successes += 1;
        return result;
      },
    });

    const first = await run({ agents: ["claude-code", "codex"], io: failingIo });

    const written = first.filter((o) => o.status === "written");
    const failed = first.filter((o) => o.status === "refused");
    // (a) Exactly the writes that landed are the writes that landed.
    expect(written).toHaveLength(2);
    expect(failed.length).toBeGreaterThan(0);
    expect(store.size).toBe(2);
    for (const outcome of written) {
      const key = outcome.agentId === null
        ? outcome.kind === "agents-md"
          ? "agents-md"
          : outcome.kind === "claude-md"
            ? "claude-md"
            : "protocols-doc"
        : agentArtifactKey(outcome.agentId);
      expect(store.has(key)).toBe(true);
    }

    // (b) The bytes that were written are really there.
    const claudeWritten = written.some((o) => o.agentId === "claude-code");
    if (claudeWritten) {
      expect(await readFile(path.join(project, ".mcp.json"), "utf8")).toContain("vex-mcp");
    }

    // (c) THE LOAD-BEARING ASSERTION. A second run with the REAL writer, using
    // only the provenance the failed run left behind, finishes the job - and
    // does NOT refuse the files the first run wrote as collisions.
    const second = await run({ agents: ["claude-code", "codex"] });
    expect(second.filter((o) => o.status === "refused")).toEqual([]);
    expect(
      second.every((o) => o.status === "written" || o.status === "unchanged"),
    ).toBe(true);
    expect(store.size).toBe(5);

    // Every artifact is now really on disk.
    for (const relative of [".mcp.json", ".codex/config.toml", "AGENTS.md", "CLAUDE.md"]) {
      await expect(readFile(path.join(project, relative), "utf8")).resolves.toBeTruthy();
    }
  });

  /**
   * CONTRACT CHANGE (audit finding B). This test used to assert that losing the
   * whole provenance store made Vex refuse its OWN files as collisions forever,
   * and it framed that as the counter-proof for committing per file.
   *
   * That behavior was a defect, not a property worth pinning: it left a project
   * with no remedy but the user hand-deleting an entry Vex itself had written.
   * The reconciler now FINALIZES an entry whose content is byte-for-byte what a
   * fresh render produces, because that is proof of authorship independent of
   * the store.
   *
   * Per-file commit still matters and is still proven, by the fault-injection
   * test above: it is what lets a half-finished run be finished rather than
   * redone. What changed is the blast radius of losing the record entirely.
   */
  it("re-adopts its own entries when the provenance store is lost wholesale", async () => {
    await run({ agents: ["claude-code"] });
    store.clear();

    const outcomes = await run({ agents: ["claude-code"] });
    const config = outcomeFor(outcomes, (o) => o.agentId === "claude-code");
    expect(config.status).toBe("unchanged");
    // The claim is restored, so the project is provable again from here on.
    expect(store.has(agentArtifactKey("claude-code"))).toBe(true);
  });

  it("still refuses an entry that is NOT its own output, store or no store", async () => {
    // The security property the old test was really protecting, asserted
    // directly: adoption is by CONTENT, so an entry named `vex` that Vex would
    // never render is still a collision and still refuses.
    await writeFile(
      path.join(project, ".mcp.json"),
      `${JSON.stringify(
        { mcpServers: { vex: { command: "/tmp/not-the-bridge", args: ["--rm", "-rf"] } } },
        null,
        2,
      )}\n`,
      "utf8",
    );
    store.clear();

    const outcomes = await run({ agents: ["claude-code"] });
    const config = outcomeFor(outcomes, (o) => o.agentId === "claude-code");
    expect(config.status).toBe("refused");
    if (config.status === "refused") expect(config.reason).toBe("provenance_collision");

    // And the foreign entry is untouched on disk.
    const after = await readFile(path.join(project, ".mcp.json"), "utf8");
    expect(after).toContain("/tmp/not-the-bridge");
  });
});

describe("the rendered entry proves its own ownership next time", () => {
  it("stores a digest that matches what the reader computes from the file", async () => {
    await run({ agents: ["codex"] });
    const agent = writable("codex");
    const fresh = renderStudioAgentConfig(agent, FACTS);
    if (fresh.status !== "rendered") throw new Error("expected rendered");
    const expected = readStudioOwnedRegion(fresh.text, agent);
    if (expected.kind !== "present") throw new Error("expected a present region");
    expect(store.get(agentArtifactKey("codex"))?.entryHash).toBe(expected.hash);
  });
});

/**
 * A DURABLE RECORD THAT DID NOT LAND IS NOT A SUCCESSFUL RUN.
 *
 * The file replacement happens before the provenance commit, and the production
 * adapter used to log the commit failure and swallow it. The artifact was then
 * reported `written`, the run reported `completed`, and the completion marker
 * advanced - while the entry on disk was one Vex could no longer prove it
 * owned. The user was told everything was fine and got a `provenance_collision`
 * refusal on that same file at the next render.
 *
 * These tests drive the REAL reconciler over a REAL filesystem with only the
 * database seam failing, which is the one part that cannot be a real database
 * here.
 */
describe("a provenance commit that fails", () => {
  /** The real store, with `commitProvenance` failing for one artifact key. */
  function ioFailingCommitFor(failingKey: string): ReconcileIo {
    const real = io();
    return {
      ...real,
      commitProvenance: async (record: ArtifactProvenanceWrite) => {
        if (record.artifactKey === failingKey) return false;
        return real.commitProvenance(record);
      },
    };
  }

  it("does NOT report the artifact written, and does NOT report the run complete", async () => {
    const key = agentArtifactKey("claude-code");
    const result = await runResult({
      agents: ["claude-code"],
      io: ioFailingCommitFor(key),
    });

    const config = outcomeFor(result.artifacts, (o) => o.agentId === "claude-code");
    expect(config.status).not.toBe("written");
    expect(config.status).toBe("refused");
    if (config.status === "refused") {
      expect(config.reason).toBe("io_error");
      // The detail must not pretend nothing happened: the bytes ARE on disk.
      expect(config.detail).toContain("was changed on disk");
      expect(config.detail).toContain("Repair");
    }

    // `completed: false` is what keeps `recordCompleteRender` from running, so
    // the project stays visibly owing a render.
    expect(result.completed).toBe(false);

    // And nothing was recorded for that artifact.
    expect(store.has(key)).toBe(false);
  });

  it("leaves the file on disk so Repair has something to reconcile", async () => {
    // The failure is in the DATABASE, not the filesystem. Rolling the file back
    // would be a second irreversible act on the user's config to compensate for
    // a failure that had nothing to do with it.
    const key = agentArtifactKey("claude-code");
    await runResult({ agents: ["claude-code"], io: ioFailingCommitFor(key) });

    const written = await readFile(path.join(project, ".mcp.json"), "utf8");
    expect(written).toContain("vex");
    expect(written).toContain(FACTS.bridgeCommand);
  });

  /**
   * THE CRASH WINDOW, reproduced exactly: the file lands, the record does not,
   * and the process is gone before either can be repaired. The next run starts
   * from a file Vex wrote and a store that has never heard of it.
   */
  it("recovers on the NEXT run rather than refusing the file forever", async () => {
    const key = agentArtifactKey("claude-code");
    const first = await runResult({
      agents: ["claude-code"],
      io: ioFailingCommitFor(key),
    });
    expect(first.completed).toBe(false);
    expect(store.has(key)).toBe(false);

    // Second run, database healthy again. The entry on disk is byte-identical
    // to what this run would render, so it is adopted rather than refused.
    const second = await runResult({ agents: ["claude-code"] });
    const config = outcomeFor(second.artifacts, (o) => o.agentId === "claude-code");
    expect(config.status).toBe("unchanged");
    expect(second.completed).toBe(true);
    expect(store.has(key)).toBe(true);
  });

  it("does not advance provenance for a REMOVE whose clear failed", async () => {
    // Install, then deselect with a failing clear.
    await run({ agents: ["claude-code"] });
    const key = agentArtifactKey("claude-code");
    expect(store.has(key)).toBe(true);

    const real = io();
    const result = await runResult({
      agents: [],
      io: { ...real, clearProvenance: async () => false },
    });

    const config = outcomeFor(result.artifacts, (o) => o.agentId === "claude-code");
    expect(config.status).not.toBe("removed");
    expect(config.status).toBe("refused");
    expect(result.completed).toBe(false);
    // The stale claim is still there, which is the safe direction: a claim Vex
    // still holds refuses a rewrite, where a dropped one would let anything in.
    expect(store.has(key)).toBe(true);
  });
});

describe("provenance origin: what Vex WROTE vs what it ADOPTED", () => {
  /**
   * The distinction the B0 teardown depends on, proven through the REAL
   * reconciler rather than seeded.
   *
   * A provenance row used to record only WHAT Vex owns, never HOW it came to
   * own it - and the reconciler writes rows for two materially different
   * events. That was harmless while the record only authorized rewriting
   * identical bytes with identical bytes, and harmful the moment it authorized
   * a DELETION: the project teardown read every row as authorship proof and so
   * deleted a `vex` entry, or an `@AGENTS.md` import line, that the user had
   * authored themselves before ever installing Vex.
   */
  it("records `written` for an entry this run actually replaced", async () => {
    const outcomes = await run({ agents: ["claude-code"] });
    expect(outcomeFor(outcomes, (o) => o.agentId === "claude-code").status).toBe(
      "written",
    );
    expect(store.get(agentArtifactKey("claude-code"))?.origin).toBe("written");
    // The whole-file artifacts of the same run, likewise.
    expect(store.get("protocols-doc")?.origin).toBe("written");
    expect(store.get("agents-md")?.origin).toBe("written");
  });

  it("records `adopted` for bytes that were ALREADY on disk and identical", async () => {
    // FIRST: the user writes the exact entry Vex would write, by hand, with no
    // provenance anywhere - which is what "before they installed Vex" means.
    const agent = writable("claude-code");
    const rendered = renderStudioAgentConfig(agent, FACTS);
    if (rendered.status !== "rendered") throw new Error("render failed");
    const target = path.join(project, agent.configPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, rendered.text, "utf8");
    expect(store.size).toBe(0);

    // THEN Vex installs. The bytes are already right, so nothing is replaced.
    const outcomes = await run({ agents: ["claude-code"] });
    expect(outcomeFor(outcomes, (o) => o.agentId === "claude-code").status).toBe(
      "unchanged",
    );

    // The record exists - without it the NEXT run would refuse these bytes as a
    // collision forever - but it says only what is provable.
    const record = store.get(agentArtifactKey("claude-code"));
    expect(record).toBeDefined();
    expect(record?.origin).toBe("adopted");
    // And the file is untouched.
    expect(await readFile(target, "utf8")).toBe(rendered.text);
  });

  it("does not downgrade a `written` record when a later run changes nothing", async () => {
    await run({ agents: ["claude-code"] });
    expect(store.get(agentArtifactKey("claude-code"))?.origin).toBe("written");
    // A second identical run adopts nothing: the adopt branch only fires when
    // the store has NO record. A downgrade here would quietly make the teardown
    // stop removing an entry Vex really did write.
    await run({ agents: ["claude-code"] });
    expect(store.get(agentArtifactKey("claude-code"))?.origin).toBe("written");
  });
});
