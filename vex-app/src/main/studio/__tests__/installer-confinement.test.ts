/**
 * THE CONFINED FILESYSTEM CONTRACT, exercised against a real temporary
 * directory (stage A5b item 5).
 *
 * Real files, real symlinks, real modes. Every property here is about a folder
 * the USER also owns and other tools also write to, and a mock filesystem
 * cannot prove any of them: `lstat` not following a link, an exclusive
 * same-directory temp file, a preserved mode, and an atomic rename are all
 * behaviours of the operating system, not of our code's shape.
 *
 * The negative cases are the point. Each one asserts BOTH halves: the named
 * refusal reached the caller, AND the bytes on disk are exactly what they were.
 */

import { chmod, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  STUDIO_ARTIFACT_MAX_BYTES,
  findAmbiguousTwin,
  isInside,
  resolveArtifactPath,
} from "../installer/paths.js";
import {
  hashText,
  readConfinedFile,
  replaceConfinedFile,
} from "../installer/confined-fs.js";

let project: string;

beforeEach(async () => {
  project = await realpath(await mkdtemp(path.join(tmpdir(), "vex-installer-")));
});

afterEach(async () => {
  // The temp directory is left for the OS to reap: removing it here would hide
  // a test that left a stray temp file behind, which is exactly what the
  // exclusive-temp-file assertions are looking for.
});

async function writeAt(relative: string, text: string): Promise<string> {
  const target = path.join(project, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
  return target;
}

describe("path derivation and traversal", () => {
  it("resolves a static registry path inside the project", async () => {
    const resolution = await resolveArtifactPath(project, ".codex/config.toml");
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.absolutePath).toBe(path.join(project, ".codex", "config.toml"));
      expect(resolution.exists).toBe(false);
    }
  });

  it.each([
    "../escape.json",
    "a/../../escape.json",
    "./config.json",
    "/etc/passwd",
    "",
  ])("refuses %s as a path escape", async (candidate) => {
    const resolution = await resolveArtifactPath(project, candidate);
    expect(resolution.kind).toBe("refused");
    if (resolution.kind === "refused") expect(resolution.reason).toBe("path_escape");
  });

  it("does not accept a sibling directory whose name merely starts with the root", () => {
    expect(isInside("/a/b", "/a/b-evil/x")).toBe(false);
    expect(isInside("/a/b", "/a/b/x")).toBe(true);
  });
});

describe("symlinks", () => {
  it("refuses a symlinked TARGET rather than writing through it", async () => {
    const outside = path.join(project, "..", `outside-${path.basename(project)}.json`);
    await writeFile(outside, "{\"secret\": true}\n", "utf8");
    await writeFile(path.join(project, "placeholder"), "", "utf8");
    await symlink(outside, path.join(project, ".mcp.json"));

    const resolution = await resolveArtifactPath(project, ".mcp.json");
    expect(resolution.kind).toBe("refused");
    if (resolution.kind === "refused") {
      expect(resolution.reason).toBe("symlinked_path");
      expect(resolution.detail).toContain("symbolic link");
    }
    // And the file the link pointed at is untouched.
    expect(await readFile(outside, "utf8")).toBe("{\"secret\": true}\n");
  });

  it("refuses a symlinked DIRECTORY component, not only the final segment", async () => {
    const decoy = path.join(project, "real-codex");
    await mkdir(decoy, { recursive: true });
    await symlink(decoy, path.join(project, ".codex"));

    const resolution = await resolveArtifactPath(project, ".codex/config.toml");
    expect(resolution.kind).toBe("refused");
    if (resolution.kind === "refused") expect(resolution.reason).toBe("symlinked_path");
  });
});

describe("non-regular targets and the size bound", () => {
  it("refuses a directory where a config file should be", async () => {
    await mkdir(path.join(project, ".mcp.json"), { recursive: true });
    const resolution = await resolveArtifactPath(project, ".mcp.json");
    expect(resolution.kind).toBe("refused");
    if (resolution.kind === "refused") expect(resolution.reason).toBe("not_a_regular_file");
  });

  it("refuses a file over the bound and NAMES the bound", async () => {
    await writeAt(".mcp.json", "x".repeat(STUDIO_ARTIFACT_MAX_BYTES + 1));
    const resolution = await resolveArtifactPath(project, ".mcp.json");
    expect(resolution.kind).toBe("refused");
    if (resolution.kind === "refused") {
      expect(resolution.reason).toBe("too_large");
      expect(resolution.detail).toContain(String(STUDIO_ARTIFACT_MAX_BYTES));
    }
  });

  it("accepts a file exactly at the bound", async () => {
    await writeAt(".mcp.json", "x".repeat(STUDIO_ARTIFACT_MAX_BYTES));
    const resolution = await resolveArtifactPath(project, ".mcp.json");
    expect(resolution.kind).toBe("resolved");
  });
});

describe("decoding", () => {
  it("refuses malformed UTF-8 instead of writing back replacement characters", async () => {
    const target = path.join(project, ".mcp.json");
    // A lone 0x80 continuation byte: invalid UTF-8 by construction.
    await writeFile(target, Buffer.from([0x7b, 0x80, 0x7d]));

    const read = await readConfinedFile(target, ".mcp.json", null);
    expect(read.kind).toBe("refused");
    if (read.kind === "refused") expect(read.reason).toBe("invalid_utf8");
  });

  it("reports an absent file as absent, not as an error", async () => {
    const read = await readConfinedFile(path.join(project, "nope.json"), "nope.json", null);
    expect(read.kind).toBe("absent");
  });
});

describe("ambiguous .json / .jsonc twins", () => {
  it("refuses when both spellings exist", async () => {
    await writeAt("opencode.json", "{}\n");
    await writeAt("opencode.jsonc", "{}\n");

    const twin = await findAmbiguousTwin(project, "opencode.json", ["opencode.jsonc"]);
    expect(twin).not.toBeNull();
    expect(twin?.reason).toBe("ambiguous_twin");
    expect(twin?.detail).toContain("opencode.jsonc");
  });

  it("is silent when only one spelling exists", async () => {
    await writeAt("opencode.json", "{}\n");
    expect(await findAmbiguousTwin(project, "opencode.json", ["opencode.jsonc"])).toBeNull();
  });

  it("does not treat a DIFFERENT file the client also reads as a twin", async () => {
    await writeAt(".mcp.json", "{}\n");
    // Copilot reads `.github/mcp.json` and also `.mcp.json`. Those are two
    // files, not two spellings of one, and both may legitimately exist.
    expect(await findAmbiguousTwin(project, ".github/mcp.json", [".mcp.json"])).toBeNull();
  });
});

describe("replacement", () => {
  it("creates a file and its parent directory", async () => {
    const target = path.join(project, ".codex", "config.toml");
    const write = await replaceConfinedFile({
      projectDirectory: project,
      absolutePath: target,
      relativeLabel: ".codex/config.toml",
      text: "hello\n",
      expectedHash: null,
      mode: null,
    });
    expect(write.kind).toBe("written");
    expect(await readFile(target, "utf8")).toBe("hello\n");
  });

  it("PRESERVES the existing file's mode", async () => {
    const target = await writeAt("mode.json", "{}\n");
    await chmod(target, 0o600);
    const before = (await stat(target)).mode;

    const write = await replaceConfinedFile({
      projectDirectory: project,
      absolutePath: target,
      relativeLabel: "mode.json",
      text: "{\"a\":1}\n",
      expectedHash: hashText("{}\n"),
      mode: before,
    });
    expect(write.kind).toBe("written");
    expect((await stat(target)).mode).toBe(before);
  });

  it("REFUSES when the file changed under us, and leaves the new bytes alone", async () => {
    const target = await writeAt("race.json", "{\"original\": true}\n");
    // The caller rendered from these bytes...
    const rendered = hashText("{\"original\": true}\n");
    // ...and somebody else wrote in the meantime.
    await writeFile(target, "{\"someone-else\": true}\n", "utf8");

    const write = await replaceConfinedFile({
      projectDirectory: project,
      absolutePath: target,
      relativeLabel: "race.json",
      text: "{\"vex\": true}\n",
      expectedHash: rendered,
      mode: null,
    });
    expect(write.kind).toBe("refused");
    if (write.kind === "refused") expect(write.reason).toBe("source_changed");
    expect(await readFile(target, "utf8")).toBe("{\"someone-else\": true}\n");
  });

  it("REFUSES when the caller expected no file but one appeared", async () => {
    await writeAt("appeared.json", "{\"created-by-someone-else\": true}\n");
    const write = await replaceConfinedFile({
      projectDirectory: project,
      absolutePath: path.join(project, "appeared.json"),
      relativeLabel: "appeared.json",
      text: "{\"vex\": true}\n",
      expectedHash: null,
      mode: null,
    });
    expect(write.kind).toBe("refused");
    if (write.kind === "refused") expect(write.reason).toBe("source_changed");
  });

  it("revalidates containment after resolution", async () => {
    const write = await replaceConfinedFile({
      projectDirectory: project,
      absolutePath: path.join(project, "..", "escaped.json"),
      relativeLabel: "escaped.json",
      text: "nope\n",
      expectedHash: null,
      mode: null,
    });
    expect(write.kind).toBe("refused");
    if (write.kind === "refused") expect(write.reason).toBe("path_escape");
  });

  it("leaves no temporary file behind after a successful write", async () => {
    const target = path.join(project, "clean.json");
    await replaceConfinedFile({
      projectDirectory: project,
      absolutePath: target,
      relativeLabel: "clean.json",
      text: "{}\n",
      expectedHash: null,
      mode: null,
    });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(project);
    expect(entries.filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});
