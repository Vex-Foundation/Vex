/**
 * THE ENDPOINT DIRECTORY, ON A REAL FILESYSTEM.
 *
 * `prepareEndpointDirectory` is the one place Vex decides that a directory is
 * safe to put a privileged listener in, and every property it has is a property
 * of real `mkdir`, `lstat` and `chmod` behaviour: that a recursive mkdir
 * succeeds silently on an existing path, that `stat` follows a symlink while
 * `lstat` does not, that `chmod` through a symlink lands on the target. A fake
 * filesystem would reproduce whichever of those the author remembered, which is
 * exactly the mistake this suite exists to catch.
 *
 * The attack it pins: another local user pre-creates `/tmp/vex-studio-<uid>` as
 * a symlink to a file of their choosing, and Vex's own startup chmods that file
 * to 0700 - a privileged process editing permissions on somebody else's path.
 *
 * Skipped on win32, which has no unix endpoint and no uid model here.
 */

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  captureEndpointDirectoryChain,
  endpointAncestorChangedRefusal,
  prepareEndpointDirectory,
  verifyEndpointDirectoryChain,
} from "../mcp-host/bind.js";
import type { StudioEndpointPlan } from "../mcp-host/endpoint.js";

type UnixPlan = Extract<StudioEndpointPlan, { kind: "unix" }>;

const onUnix = process.platform === "win32" ? describe.skip : describe;

let root = "";

function planFor(parentDir: string, createParent: boolean): UnixPlan {
  return {
    kind: "unix",
    path: path.join(parentDir, "vex-studio-000000000000.sock"),
    parentDir,
    createParent,
  };
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "vex-studio-bind-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

onUnix("prepareEndpointDirectory on a real filesystem", () => {
  it("creates a private directory and reports no refusal", () => {
    const parent = path.join(root, "runtime");
    expect(prepareEndpointDirectory(planFor(parent, true))).toBeNull();

    const facts = lstatSync(parent);
    expect(facts.isDirectory()).toBe(true);
    expect(facts.isSymbolicLink()).toBe(false);
    expect(facts.mode & 0o777).toBe(0o700);
  });

  it("is idempotent, and tightens a directory it already owns", () => {
    const parent = path.join(root, "runtime");
    mkdirSync(parent, { mode: 0o755 });
    chmodSync(parent, 0o755);

    expect(prepareEndpointDirectory(planFor(parent, true))).toBeNull();
    expect(lstatSync(parent).mode & 0o777).toBe(0o700);
  });

  it("REFUSES a pre-created symlink and leaves its target untouched", () => {
    // The attack, exactly: the entry Vex expects to create already exists and
    // is a link to a file that is not Vex's to modify.
    const victim = path.join(root, "victim");
    writeFileSync(victim, "not vex's file\n", { mode: 0o644 });
    chmodSync(victim, 0o644);
    const targetDir = path.join(root, "victim-dir");
    mkdirSync(targetDir, { mode: 0o755 });
    chmodSync(targetDir, 0o755);
    writeFileSync(path.join(targetDir, "keep.txt"), "keep\n");

    const parent = path.join(root, "runtime");
    symlinkSync(targetDir, parent);

    const refusal = prepareEndpointDirectory(planFor(parent, true));
    expect(refusal).not.toBeNull();
    expect(String(refusal)).toContain("symbolic link");

    // THE SECURITY ASSERTION: the target's mode and contents are unchanged.
    expect(statSync(targetDir).mode & 0o777).toBe(0o755);
    expect(readFileSync(path.join(targetDir, "keep.txt"), "utf8")).toBe("keep\n");
    // And the link itself is still a link: it is refused, never repaired.
    expect(lstatSync(parent).isSymbolicLink()).toBe(true);
    // The unrelated file nobody pointed at is untouched too.
    expect(statSync(victim).mode & 0o777).toBe(0o644);
  });

  it("REFUSES a symlink even when it points at a private directory", () => {
    // Following it would be safe by accident today and unsafe the moment the
    // link is repointed. The rule is structural: Vex does not follow.
    const targetDir = path.join(root, "private");
    mkdirSync(targetDir, { mode: 0o700 });
    chmodSync(targetDir, 0o700);
    const parent = path.join(root, "runtime");
    symlinkSync(targetDir, parent);

    expect(String(prepareEndpointDirectory(planFor(parent, true)))).toContain(
      "symbolic link",
    );
  });

  it("REFUSES a directory owned by another user, and chmods nothing", () => {
    // A test cannot chown without privileges, so the difference is made on the
    // reader's side: the injected uid is what "the current user" means here.
    const parent = path.join(root, "runtime");
    mkdirSync(parent, { mode: 0o755 });
    chmodSync(parent, 0o755);

    const refusal = prepareEndpointDirectory(planFor(parent, true), {
      uid: () => currentUid() + 4242,
    });
    expect(String(refusal)).toContain("owned by");
    // NOT TIGHTENED. A chmod on a directory Vex does not own is the bug.
    expect(lstatSync(parent).mode & 0o777).toBe(0o755);
  });

  it("REFUSES a plain file where the directory should be", () => {
    const parent = path.join(root, "runtime");
    writeFileSync(parent, "occupied\n");

    const refusal = prepareEndpointDirectory(planFor(parent, true));
    expect(String(refusal)).toContain("not a directory");
    expect(readFileSync(parent, "utf8")).toBe("occupied\n");
  });

  it("REFUSES a group- or world-accessible directory it did not create", () => {
    const parent = path.join(root, "runtime");
    mkdirSync(parent, { mode: 0o755 });
    chmodSync(parent, 0o755);

    // `createParent` false is the override and XDG_RUNTIME_DIR case: somebody
    // else owns the directory, so Vex verifies and never repairs.
    const refusal = prepareEndpointDirectory(planFor(parent, false));
    expect(String(refusal)).toContain("readable by other");
    expect(lstatSync(parent).mode & 0o777).toBe(0o755);
  });

  it("REFUSES a missing directory it was not asked to create", () => {
    const parent = path.join(root, "absent");
    expect(String(prepareEndpointDirectory(planFor(parent, false)))).toContain(
      "is missing",
    );
  });

  it("REFUSES an override when an ancestor is swapped before bind", () => {
    const ancestor = path.join(root, "operator-root");
    const parent = path.join(ancestor, "private");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);

    const captured = captureEndpointDirectoryChain(parent);
    if (captured.kind !== "captured") {
      throw new Error(captured.reason);
    }

    // Keep the original tree alive so its inode cannot be recycled into the
    // replacement. The path spelling is unchanged but its identity is not.
    renameSync(ancestor, path.join(root, "held-original"));
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);

    expect(verifyEndpointDirectoryChain(captured.identity)).toBe(
      endpointAncestorChangedRefusal(ancestor),
    );
  });

  it("REFUSES replacement behind a stable intermediate symlink", () => {
    const targetRoot = path.join(root, "target-root");
    const heldTarget = path.join(root, "held-target");
    const realParent = path.join(targetRoot, "private");
    mkdirSync(realParent, { recursive: true, mode: 0o700 });
    chmodSync(realParent, 0o700);

    const lexicalRoot = path.join(root, "operator-root");
    symlinkSync(targetRoot, lexicalRoot, "dir");
    const lexicalParent = path.join(lexicalRoot, "private");
    const captured = captureEndpointDirectoryChain(lexicalParent);
    if (captured.kind !== "captured") {
      throw new Error(captured.reason);
    }

    // The lexical link and final directory identity remain stable. Only the
    // real target ancestor changes from a directory into a symlink, which is
    // why the independently captured realpath chain is required.
    renameSync(targetRoot, heldTarget);
    symlinkSync(heldTarget, targetRoot, "dir");
    expect(lstatSync(lexicalRoot).isSymbolicLink()).toBe(true);
    expect(lstatSync(lexicalParent).isDirectory()).toBe(true);

    expect(verifyEndpointDirectoryChain(captured.identity)).toBe(
      endpointAncestorChangedRefusal(targetRoot),
    );
  });
});
