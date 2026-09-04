/**
 * The walk, against a REAL temporary tree.
 *
 * A mocked `fs` would prove that this module calls `readdir`, which is not the
 * risk. The risk is what the walk does with what a filesystem actually returns:
 * whether it honours the same exclude policy a directory listing honours,
 * whether it descends without following a symlink into somewhere it must not
 * go, and whether its cap stops it and SAYS so rather than quietly returning a
 * short list. All three need a real directory.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { walkProjectFileNames } from "../name-walk.js";

const roots: string[] = [];

async function makeTree(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vex-name-walk-"));
  roots.push(root);
  return root;
}

async function file(root: string, relativePath: string, body = "x"): Promise<void> {
  const absolute = path.join(root, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, body);
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("the project name walk", () => {
  it("collects every file in the tree, project-relative and POSIX", async () => {
    const root = await makeTree();
    await file(root, "README.md");
    await file(root, "src/main.ts");
    await file(root, "src/deep/nested/thing.ts");

    const walked = await walkProjectFileNames({
      projectId: "p1",
      projectDirectory: root,
    });

    expect([...walked.paths].sort()).toEqual([
      "README.md",
      "src/deep/nested/thing.ts",
      "src/main.ts",
    ]);
    expect(walked.capped).toBe(false);
  });

  it("honours the listing's default excludes, so search cannot offer a hidden folder", async () => {
    const root = await makeTree();
    await file(root, "src/app.ts");
    await file(root, "node_modules/left-pad/index.js");
    await file(root, "dist/bundle.js");
    await file(root, ".git/config");

    const walked = await walkProjectFileNames({
      projectId: "p1",
      projectDirectory: root,
    });

    expect(walked.paths).toEqual(["src/app.ts"]);
  });

  it("honours a .gitignore, including a deeper file's re-inclusion", async () => {
    const root = await makeTree();
    await file(root, ".gitignore", "secrets/\n*.log\n");
    await file(root, "keep.ts");
    await file(root, "noisy.log");
    await file(root, "secrets/key.pem");
    await file(root, "sub/.gitignore", "!important.log\n");
    await file(root, "sub/important.log");

    const walked = await walkProjectFileNames({
      projectId: "p1",
      projectDirectory: root,
    });

    expect(walked.paths).toContain("keep.ts");
    expect(walked.paths).not.toContain("noisy.log");
    expect(walked.paths).not.toContain("secrets/key.pem");
    // The deeper level's negation wins, which is git's rule and the rule
    // `isPathIgnored` implements. Search agreeing with the tree matters more
    // than search being generous.
    expect(walked.paths).toContain("sub/important.log");
  });

  it("never follows a symlink, so no name can escape the project", async () => {
    const root = await makeTree();
    const outside = await makeTree();
    await file(outside, "stolen.txt");
    await file(root, "inside.ts");
    await symlink(outside, path.join(root, "escape"), "dir");
    await symlink(path.join(outside, "stolen.txt"), path.join(root, "link.txt"), "file");

    const walked = await walkProjectFileNames({
      projectId: "p1",
      projectDirectory: root,
    });

    // Neither the linked DIRECTORY's contents nor the linked FILE itself: this
    // surface never opens a symlink, so offering its name would be offering a
    // row that `readFile` refuses.
    expect(walked.paths).toEqual(["inside.ts"]);
  });

  it("survives a self-referential symlink without spinning", async () => {
    const root = await makeTree();
    await file(root, "a.ts");
    await symlink(root, path.join(root, "loop"), "dir");

    const walked = await walkProjectFileNames({
      projectId: "p1",
      projectDirectory: root,
    });

    // Terminating here is the ASSERTION. Not following links means there is no
    // cycle to detect, which is why this walk carries no realpath bookkeeping.
    expect(walked.paths).toEqual(["a.ts"]);
  });

  it("stops at the cap and REPORTS it, never returning a short list silently", async () => {
    const root = await makeTree();
    for (let index = 0; index < 12; index += 1) {
      await file(root, `src/f${String(index)}.ts`);
    }

    const walked = await walkProjectFileNames({
      projectId: "p1",
      projectDirectory: root,
      fileCap: 5,
    });

    expect(walked.paths).toHaveLength(5);
    expect(walked.capped).toBe(true);
  });

  it("stops when its owner says the session is gone", async () => {
    const root = await makeTree();
    await file(root, "a.ts");
    await file(root, "b/c.ts");

    const walked = await walkProjectFileNames({
      projectId: "p1",
      projectDirectory: root,
      isCancelled: () => true,
    });

    expect(walked.paths).toEqual([]);
    expect(walked.directoriesWalked).toBe(0);
  });

  it("skips a directory it cannot read instead of losing the whole index", async () => {
    const root = await makeTree();
    await file(root, "readable/a.ts");
    // A path that is a FILE where the walk will look for a directory cannot
    // happen through `readdir` alone, so the unreadable case is provoked by
    // removing a directory between the queue push and the read.
    await mkdir(path.join(root, "vanishing"));
    await file(root, "vanishing/gone.ts");
    const walkPromise = walkProjectFileNames({
      projectId: "p1",
      projectDirectory: root,
    });
    await rm(path.join(root, "vanishing"), { recursive: true, force: true });
    const walked = await walkPromise;

    expect(walked.paths).toContain("readable/a.ts");
  });
});
