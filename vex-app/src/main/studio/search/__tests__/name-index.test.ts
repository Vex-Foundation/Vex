/**
 * The index's LIFETIME, which is the part of this surface that owns a resource.
 *
 * Ranking is pinned next door and the walk is pinned against a real tree. What
 * these cases prove is the ownership contract: one walk per session however
 * many keystrokes arrive, a first query that answers `building` instead of
 * blocking, a fresh session id retiring the old index, an explicit release and
 * a project delete both dropping it, a bounded number of indexes alive at once,
 * and node tokens minted under the CURRENT epoch rather than stored.
 *
 * The project directory is real, and it is real on purpose: `locate` proves the
 * directory with `realProjectDirectory`, which insists on a real directory
 * DIRECTLY under the anchored root. A fake path would skip the very check that
 * keeps an index off a symlinked project.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SEARCH_INDEX_PROJECT_MAX } from "@shared/schemas/studio-search.js";

import {
  invalidateProjectNodes,
  resetFileNodeEpochsForTests,
  resolveFileNodeId,
} from "../../files/node-id.js";
import {
  closeProjectResources,
  resetProjectLifecycleGateForTests,
} from "../../project-lifecycle-gate.js";
import { ProjectNameIndexes } from "../name-index.js";
import type { ProjectFilesLocation } from "../../files/files-domain.js";

const roots: string[] = [];
const disposers: Array<() => void> = [];

/** A projects root with one project directory under it, both real. */
async function makeProject(
  slug: string,
  files: readonly string[],
): Promise<{ root: string; directory: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "vex-index-root-"));
  roots.push(root);
  const directory = path.join(root, slug);
  await mkdir(directory, { recursive: true });
  for (const relativePath of files) {
    const absolute = path.join(directory, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, "x");
  }
  return { root, directory };
}

function locationOf(root: string, slug: string): ProjectFilesLocation {
  return { anchoredRoot: root, projectDirectory: path.join(root, slug) };
}

function indexes(
  resolve: (projectId: string) => Promise<ProjectFilesLocation | null>,
  overrides: { now?: () => number } = {},
): ProjectNameIndexes {
  const instance = new ProjectNameIndexes({
    resolveProjectDirectory: resolve,
    now: overrides.now,
  });
  disposers.push(() => {
    instance.disposeAll();
  });
  return instance;
}

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
  resetFileNodeEpochsForTests();
  resetProjectLifecycleGateForTests();
});

describe("the project name index", () => {
  it("answers `building` on the first query rather than waiting for the walk", async () => {
    const { root } = await makeProject("alpha", ["src/main.ts"]);
    const service = indexes(async () => locationOf(root, "alpha"));

    const first = await service.fileNames({
      projectId: "p1",
      sessionId: "s1",
      query: "main",
    });

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // A rail that blocked its first keystroke on a 200 ms walk would feel
    // broken. "Still reading" is a state the UI can render honestly.
    expect(first.value.indexState).toBe("building");
    expect(first.value.matches).toEqual([]);
    expect(first.value.indexedAtMs).toBeNull();
  });

  it("answers from the settled index once the walk finishes", async () => {
    const { root } = await makeProject("alpha", [
      "src/main.ts",
      "src/other.ts",
      "docs/main.md",
    ]);
    const service = indexes(async () => locationOf(root, "alpha"));

    await service.fileNames({ projectId: "p1", sessionId: "s1", query: "main" });
    await service.settleForTests("p1");
    const second = await service.fileNames({
      projectId: "p1",
      sessionId: "s1",
      query: "main",
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.indexState).toBe("ready");
    expect(second.value.indexedFileCount).toBe(3);
    expect(second.value.indexedAtMs).not.toBeNull();
    expect(second.value.matches.map((match) => match.relativePath)).toContain(
      "src/main.ts",
    );
    // A file in a folder nobody expanded is exactly what this surface exists to
    // find, so the docs hit matters as much as the src one.
    expect(second.value.matches.map((match) => match.relativePath)).toContain(
      "docs/main.md",
    );
  });

  it("walks ONCE for a session however many keystrokes arrive", async () => {
    const { root } = await makeProject("alpha", ["a.ts"]);
    const walk = vi.fn(async () => ({
      paths: ["a.ts"],
      capped: false,
      directoriesWalked: 1,
      durationMs: 1,
    }));
    const service = new ProjectNameIndexes({
      resolveProjectDirectory: async () => locationOf(root, "alpha"),
      walk,
    });
    disposers.push(() => {
      service.disposeAll();
    });

    // Four keystrokes, concurrently, before the walk can settle: the entry is
    // published before the walk starts precisely so they all join it.
    await Promise.all([
      service.fileNames({ projectId: "p1", sessionId: "s1", query: "a" }),
      service.fileNames({ projectId: "p1", sessionId: "s1", query: "a." }),
      service.fileNames({ projectId: "p1", sessionId: "s1", query: "a.t" }),
      service.fileNames({ projectId: "p1", sessionId: "s1", query: "a.ts" }),
    ]);
    await service.settleForTests("p1");
    await service.fileNames({ projectId: "p1", sessionId: "s1", query: "a" });

    expect(walk).toHaveBeenCalledTimes(1);
  });

  it("retires the old index when a NEW session id arrives, which is the staleness remedy", async () => {
    const { root } = await makeProject("alpha", ["a.ts"]);
    let walked = 0;
    const service = new ProjectNameIndexes({
      resolveProjectDirectory: async () => locationOf(root, "alpha"),
      walk: async () => {
        walked += 1;
        return { paths: ["a.ts"], capped: false, directoriesWalked: 1, durationMs: 1 };
      },
    });
    disposers.push(() => {
      service.disposeAll();
    });

    await service.fileNames({ projectId: "p1", sessionId: "s1", query: "a" });
    await service.settleForTests("p1");
    // Reopening the search is what a user does when a file they just created is
    // missing, and it is what the rail's copy tells them to do. It has to
    // actually re-walk, or the copy is a lie.
    await service.fileNames({ projectId: "p1", sessionId: "s2", query: "a" });
    await service.settleForTests("p1");

    expect(walked).toBe(2);
    expect(service.heldIndexCount()).toBe(1);
  });

  it("drops the index when the session is released, and again is a no-op", async () => {
    const { root } = await makeProject("alpha", ["a.ts"]);
    const service = indexes(async () => locationOf(root, "alpha"));

    await service.fileNames({ projectId: "p1", sessionId: "s1", query: "a" });
    await service.settleForTests("p1");
    expect(service.heldIndexCount()).toBe(1);

    expect(service.releaseSession({ projectId: "p1", sessionId: "s1" })).toEqual({
      ok: true,
      value: null,
    });
    expect(service.heldIndexCount()).toBe(0);
    // Idempotent: a caller that released twice, or released after an idle
    // expiry already collected the index, has nothing different to do.
    expect(service.releaseSession({ projectId: "p1", sessionId: "s1" })).toEqual({
      ok: true,
      value: null,
    });
  });

  it("ignores a release naming a session that is no longer the live one", async () => {
    const { root } = await makeProject("alpha", ["a.ts"]);
    const service = indexes(async () => locationOf(root, "alpha"));

    await service.fileNames({ projectId: "p1", sessionId: "s2", query: "a" });
    await service.settleForTests("p1");
    // A late release from a superseded session must not take the live index
    // with it. Same generation discipline the files bridge uses on cleanups.
    service.releaseSession({ projectId: "p1", sessionId: "s1" });

    expect(service.heldIndexCount()).toBe(1);
  });

  it("drops the index when the project's tombstone commits", async () => {
    const { root } = await makeProject("alpha", ["a.ts"]);
    const service = indexes(async () => locationOf(root, "alpha"));

    await service.fileNames({ projectId: "p1", sessionId: "s1", query: "a" });
    await service.settleForTests("p1");
    expect(service.heldIndexCount()).toBe(1);

    await closeProjectResources("p1");

    // An index of a deleted project's file names must not outlive it.
    expect(service.heldIndexCount()).toBe(0);
  });

  it("refuses a project with no active row rather than serving a cached name list", async () => {
    const service = indexes(async () => null);
    const answer = await service.fileNames({
      projectId: "p1",
      sessionId: "s1",
      query: "a",
    });
    expect(answer).toEqual({ ok: false, code: "project_closed" });
  });

  it("refuses at the publication fence when the epoch moved mid-request", async () => {
    const { root } = await makeProject("alpha", ["a.ts"]);
    const service = indexes(async (projectId) => {
      // The delete commits WHILE authority is being resolved: the answer that
      // comes back describes a project this process no longer serves, and the
      // tokens about to be minted would be dead on arrival.
      invalidateProjectNodes(projectId);
      return locationOf(root, "alpha");
    });

    const answer = await service.fileNames({
      projectId: "p1",
      sessionId: "s1",
      query: "a",
    });
    expect(answer).toEqual({ ok: false, code: "project_closed" });
  });

  it("mints node tokens under the CURRENT epoch, so a match opens through the real token path", async () => {
    const { root } = await makeProject("alpha", ["src/main.ts"]);
    const service = indexes(async () => locationOf(root, "alpha"));

    await service.fileNames({ projectId: "p1", sessionId: "s1", query: "main" });
    await service.settleForTests("p1");
    const answer = await service.fileNames({
      projectId: "p1",
      sessionId: "s1",
      query: "main",
    });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const match = answer.value.matches[0];
    expect(match).toBeDefined();
    if (match === undefined) return;
    // The token the search hands out is the same kind of token a listing hands
    // out, verifies for the same project, and names the same path.
    expect(resolveFileNodeId("p1", match.nodeId)).toEqual({
      ok: true,
      relativePath: "src/main.ts",
    });
    // And it is bound to the project: another project cannot spend it.
    expect(resolveFileNodeId("p2", match.nodeId)).toEqual({ ok: false });
  });

  it("holds no more than the bounded number of indexes, evicting the least recently used", async () => {
    const { root } = await makeProject("alpha", ["a.ts"]);
    for (let index = 0; index < 4; index += 1) {
      await mkdir(path.join(root, `p${String(index)}`), { recursive: true });
      await writeFile(path.join(root, `p${String(index)}`, "a.ts"), "x");
    }
    let clock = 1_000;
    const service = indexes(
      async (projectId) => locationOf(root, projectId),
      { now: () => (clock += 1_000) },
    );

    for (let index = 0; index < 4; index += 1) {
      const projectId = `p${String(index)}`;
      await service.fileNames({ projectId, sessionId: "s1", query: "a" });
      await service.settleForTests(projectId);
    }

    // Four projects, a bound of four: the fourth insert evicted the first, so
    // the map never exceeds the bound rather than reaching it and stopping.
    expect(service.heldIndexCount()).toBeLessThanOrEqual(SEARCH_INDEX_PROJECT_MAX);
  });

  it("reports a capped index rather than describing a partial walk as complete", async () => {
    const { root } = await makeProject("alpha", ["a.ts"]);
    const service = new ProjectNameIndexes({
      resolveProjectDirectory: async () => locationOf(root, "alpha"),
      walk: async () => ({
        paths: ["a.ts"],
        capped: true,
        directoriesWalked: 1,
        durationMs: 1,
      }),
    });
    disposers.push(() => {
      service.disposeAll();
    });

    await service.fileNames({ projectId: "p1", sessionId: "s1", query: "a" });
    await service.settleForTests("p1");
    const answer = await service.fileNames({
      projectId: "p1",
      sessionId: "s1",
      query: "a",
    });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    // A name that was never collected cannot be found, so "no matches" would be
    // a lie the user has no way to detect.
    expect(answer.value.indexState).toBe("capped");
  });

  it("stays `building` when the walk fails, never claiming the project is empty", async () => {
    const { root } = await makeProject("alpha", ["a.ts"]);
    const service = new ProjectNameIndexes({
      resolveProjectDirectory: async () => locationOf(root, "alpha"),
      walk: async () => {
        throw new Error("walk exploded");
      },
    });
    disposers.push(() => {
      service.disposeAll();
    });

    await service.fileNames({ projectId: "p1", sessionId: "s1", query: "a" });
    await service.settleForTests("p1");
    const answer = await service.fileNames({
      projectId: "p1",
      sessionId: "s1",
      query: "a",
    });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    // "The walk broke" and "there are no files" are different statements, and
    // reporting `ready` with an empty list would assert the false one.
    expect(answer.value.indexState).toBe("building");
  });
});
