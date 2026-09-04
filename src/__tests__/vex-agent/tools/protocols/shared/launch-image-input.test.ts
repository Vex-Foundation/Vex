/**
 * How a launch NAMES its picture, per consent surface.
 *
 * Two surfaces, two parameters, and the wrong one is refused BY NAME rather
 * than dropped (rule 90). That distinction is the point of most of this file:
 * a test that only checked `ok === false` would pass for a silent drop too,
 * and a silently dropped `imageId` is how a token gets the wrong art
 * permanently.
 *
 * The `resolveProjectFileLaunchImage` block uses a REAL temp project root with
 * REAL files and REAL symlinks, in the style of the no-follow suite it wraps:
 * the subject is what the kernel does with a model-supplied path, and a mocked
 * `fs` would only prove our branches call our branches. Only the project-root
 * LOOKUP is mocked, because that is a database read.
 */

import { constants as fsConstants, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { makeProtocolContext } from "../../_test-context.js";

const resolveProjectRootPath = vi.fn();

vi.mock("@vex-agent/mcp/project-root.js", () => ({
  resolveProjectRootPath: (projectId: string) => resolveProjectRootPath(projectId),
}));

const {
  readLaunchImageSelection,
  missingImageReason,
  resolveProjectFileLaunchImage,
  LAUNCH_IMAGE_PARAM_BY_SURFACE,
  NO_FOLLOW_IMAGE_MAX_BYTES,
} = await import("@vex-agent/tools/protocols/shared/launch-image-input.js");

const OPTIONS = {
  required: true,
  lockerListTool: "launchpads__images_list",
  toolName: "pools__launch_execute",
} as const;

function inAppContext(overrides?: Partial<ProtocolExecutionContext>): ProtocolExecutionContext {
  return makeProtocolContext(overrides);
}

function studioContext(overrides?: Partial<ProtocolExecutionContext>): ProtocolExecutionContext {
  return makeProtocolContext({ approvalSurface: "studio_mcp", ...overrides });
}

function refusalOf(result: { ok: boolean } & Record<string, unknown>): string {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  return String(result.reason);
}

// ── surface routing ────────────────────────────────────────────────────────

describe("the parameter each surface takes", () => {
  it("is declared once, per surface", () => {
    expect(LAUNCH_IMAGE_PARAM_BY_SURFACE).toEqual({
      in_app_form: "imageId",
      studio_mcp: "imagePath",
    });
  });
});

describe("the in-app form surface", () => {
  // An OMITTED surface is today's default on every direct dispatch, so it has
  // to behave exactly like the explicit one.
  it.each([
    ["omitted", undefined],
    ["explicit in_app_form", "in_app_form" as const],
  ])("accepts an imageId when the surface is %s", (_label, surface) => {
    const context = surface === undefined ? inAppContext() : inAppContext({ approvalSurface: surface });

    const result = readLaunchImageSelection({ imageId: "img_01" }, context, OPTIONS);

    expect(result).toEqual({ ok: true, selection: { kind: "locker", imageId: "img_01" } });
  });

  it.each([
    ["omitted", undefined],
    ["explicit in_app_form", "in_app_form" as const],
  ])("refuses imagePath BY NAME when the surface is %s, and points at the locker list", (_label, surface) => {
    const context = surface === undefined ? inAppContext() : inAppContext({ approvalSurface: surface });

    const reason = refusalOf(readLaunchImageSelection({ imagePath: "./logo.png" }, context, OPTIONS));

    expect(reason).toContain('"imagePath"');
    expect(reason).toContain("launchpads__images_list");
    expect(reason).toMatch(/nothing was launched/i);
  });

  it("refuses the forbidden parameter even when the accepted one is also present", () => {
    const reason = refusalOf(
      readLaunchImageSelection({ imageId: "img_01", imagePath: "./logo.png" }, inAppContext(), OPTIONS),
    );

    expect(reason).toContain('"imagePath"');
  });

  it("trims an imageId, and treats whitespace-only as absent", () => {
    expect(readLaunchImageSelection({ imageId: "  img_01  " }, inAppContext(), OPTIONS)).toEqual({
      ok: true,
      selection: { kind: "locker", imageId: "img_01" },
    });
    expect(
      readLaunchImageSelection({ imageId: "   " }, inAppContext(), { ...OPTIONS, required: false }),
    ).toEqual({ ok: true, selection: null });
  });

  it("refuses a non-string imageId with a type message", () => {
    const reason = refusalOf(readLaunchImageSelection({ imageId: 42 }, inAppContext(), OPTIONS));

    expect(reason).toContain('"imageId"');
    expect(reason).toMatch(/must be the string id/i);
  });
});

describe("the Studio MCP surface", () => {
  it("accepts an imagePath", () => {
    const result = readLaunchImageSelection({ imagePath: "assets/logo.png" }, studioContext(), OPTIONS);

    expect(result).toEqual({
      ok: true,
      selection: { kind: "project_file", imagePath: "assets/logo.png" },
    });
  });

  it("refuses imageId BY NAME, and says why this surface has no locker", () => {
    const reason = refusalOf(readLaunchImageSelection({ imageId: "img_01" }, studioContext(), OPTIONS));

    expect(reason).toContain('"imageId"');
    expect(reason).toContain('"imagePath"');
    expect(reason).toMatch(/no image locker/i);
    expect(reason).toMatch(/nothing was launched/i);
  });

  it("trims an imagePath, and treats whitespace-only as absent", () => {
    expect(readLaunchImageSelection({ imagePath: " a.png " }, studioContext(), OPTIONS)).toEqual({
      ok: true,
      selection: { kind: "project_file", imagePath: "a.png" },
    });
    expect(
      readLaunchImageSelection({ imagePath: "  " }, studioContext(), { ...OPTIONS, required: false }),
    ).toEqual({ ok: true, selection: null });
  });

  it("refuses a non-string imagePath with a type message", () => {
    const reason = refusalOf(readLaunchImageSelection({ imagePath: 7 }, studioContext(), OPTIONS));

    expect(reason).toContain('"imagePath"');
    expect(reason).toMatch(/must be a string path/i);
  });

  it("never accepts a URL as a picture: there is no parameter for one", () => {
    const reason = refusalOf(
      readLaunchImageSelection({ imageUrl: "https://evil.test/a.png" }, studioContext(), OPTIONS),
    );

    // An unknown key names no picture, so the required read refuses for the
    // ordinary missing-image reason rather than reading the URL.
    expect(reason).toMatch(/requires a picture/i);
    expect(reason).not.toContain("evil.test");
  });
});

// ── nothing named at all ───────────────────────────────────────────────────

describe("no picture named", () => {
  it("is allowed when the caller did not require one", () => {
    expect(readLaunchImageSelection({}, inAppContext(), { ...OPTIONS, required: false })).toEqual({
      ok: true,
      selection: null,
    });
    expect(readLaunchImageSelection({}, studioContext(), { ...OPTIONS, required: false })).toEqual({
      ok: true,
      selection: null,
    });
  });

  it("refuses with the surface's own missing-image reason when one was required", () => {
    expect(refusalOf(readLaunchImageSelection({}, inAppContext(), OPTIONS))).toBe(
      missingImageReason("in_app_form", OPTIONS),
    );
    expect(refusalOf(readLaunchImageSelection({}, studioContext(), OPTIONS))).toBe(
      missingImageReason("studio_mcp", OPTIONS),
    );
  });

  it("gives the two surfaces DIFFERENT messages, each naming the parameter it takes", () => {
    const inApp = missingImageReason("in_app_form", OPTIONS);
    const studio = missingImageReason("studio_mcp", OPTIONS);

    expect(inApp).not.toBe(studio);
    expect(inApp).toContain('"imageId"');
    expect(inApp).not.toContain('"imagePath"');
    expect(studio).toContain('"imagePath"');
    expect(studio).not.toContain('"imageId"');
    expect(studio).toContain(String(NO_FOLLOW_IMAGE_MAX_BYTES));
  });

  it("states the permanent consequence on both surfaces, and names the refusing tool", () => {
    for (const surface of ["in_app_form", "studio_mcp"] as const) {
      const reason = missingImageReason(surface, OPTIONS);
      expect(reason).toContain(OPTIONS.toolName);
      expect(reason).toMatch(/renders blank/i);
      expect(reason).toMatch(/cannot be undone/i);
    }
  });
});

// ── resolving a project file to bytes ──────────────────────────────────────

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBytes(payload = "vex"): Buffer {
  return Buffer.concat([PNG_HEADER, Buffer.from(payload, "utf8")]);
}

function pngOfExactly(byteLength: number): Buffer {
  const bytes = Buffer.alloc(byteLength, 0x41);
  PNG_HEADER.copy(bytes, 0);
  return bytes;
}

const PROJECT_ID = "proj_0123456789";

let sandbox: string;
let root: string;

function fileSelection(imagePath: string) {
  return { kind: "project_file", imagePath } as const;
}

let symlinksUsable: boolean | undefined;

/** Probe once: an unprivileged Windows account cannot create links. */
async function canCreateSymlinks(): Promise<boolean> {
  if (symlinksUsable !== undefined) return symlinksUsable;
  const probe = await fs.mkdtemp(path.join(os.tmpdir(), "vex-launch-image-symlink-"));
  try {
    await fs.writeFile(path.join(probe, "target"), "x");
    await fs.symlink(path.join(probe, "target"), path.join(probe, "link"));
    symlinksUsable = true;
  } catch {
    symlinksUsable = false;
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
  return symlinksUsable;
}

beforeEach(async () => {
  resolveProjectRootPath.mockReset();
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "vex-launch-image-"));
  root = path.join(sandbox, "proj");
  await fs.mkdir(root, { recursive: true });
  resolveProjectRootPath.mockResolvedValue({ kind: "ok", rootPath: root });
});

afterEach(async () => {
  // Runs after a failed expectation too, so a red test never leaks a temp tree.
  await fs.rm(sandbox, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("resolveProjectFileLaunchImage: containment premise", () => {
  it("fails closed with NO project on the context, and never looks a root up", async () => {
    // Without a project there is no root, and without a root there is nothing
    // to contain a model-supplied path to. This is the whole premise.
    const result = await resolveProjectFileLaunchImage(fileSelection("logo.png"), studioContext());

    expect(refusalOf(result)).toMatch(/only be read inside a Vex Studio project/i);
    expect(resolveProjectRootPath).not.toHaveBeenCalled();
  });

  it("fails closed for an explicitly null studioProjectId too", async () => {
    const result = await resolveProjectFileLaunchImage(
      fileSelection("logo.png"),
      studioContext({ studioProjectId: null }),
    );

    expect(refusalOf(result)).toMatch(/carries no project/i);
    expect(resolveProjectRootPath).not.toHaveBeenCalled();
  });
});

describe("resolveProjectFileLaunchImage: the project root lookup", () => {
  it("refuses a project that no longer exists", async () => {
    resolveProjectRootPath.mockResolvedValue({ kind: "unknown_project" });

    const result = await resolveProjectFileLaunchImage(
      fileSelection("logo.png"),
      studioContext({ studioProjectId: PROJECT_ID }),
    );

    expect(resolveProjectRootPath).toHaveBeenCalledWith(PROJECT_ID);
    expect(refusalOf(result)).toMatch(/no longer exists/i);
  });

  it("refuses a project with no directory recorded", async () => {
    resolveProjectRootPath.mockResolvedValue({ kind: "no_root_recorded" });

    const result = await resolveProjectFileLaunchImage(
      fileSelection("logo.png"),
      studioContext({ studioProjectId: PROJECT_ID }),
    );

    expect(refusalOf(result)).toMatch(/no directory recorded/i);
  });

  it("reports a database failure as a retryable failure, not as either root answer", async () => {
    resolveProjectRootPath.mockRejectedValue(new Error("connection refused"));

    const result = await resolveProjectFileLaunchImage(
      fileSelection("logo.png"),
      studioContext({ studioProjectId: PROJECT_ID }),
    );

    const reason = refusalOf(result);
    expect(reason).toMatch(/could not read this project's record/i);
    expect(reason).toMatch(/worth trying again/i);
    expect(reason).not.toMatch(/no longer exists/i);
    expect(reason).not.toMatch(/no directory recorded/i);
    // The raw database error never reaches the model.
    expect(reason).not.toContain("connection refused");
  });

  it("gives each lookup answer a DISTINCT sentence", async () => {
    const reasons: string[] = [];
    for (const resolution of [
      { kind: "unknown_project" },
      { kind: "no_root_recorded" },
    ]) {
      resolveProjectRootPath.mockResolvedValue(resolution);
      reasons.push(
        refusalOf(
          await resolveProjectFileLaunchImage(
            fileSelection("logo.png"),
            studioContext({ studioProjectId: PROJECT_ID }),
          ),
        ),
      );
    }
    resolveProjectRootPath.mockRejectedValue(new Error("db down"));
    reasons.push(
      refusalOf(
        await resolveProjectFileLaunchImage(
          fileSelection("logo.png"),
          studioContext({ studioProjectId: PROJECT_ID }),
        ),
      ),
    );

    expect(new Set(reasons).size).toBe(3);
  });
});

describe("resolveProjectFileLaunchImage: a real file inside a real root", () => {
  it("returns byte-identical bytes and the ROOT-RELATIVE label, never the absolute path", async () => {
    const bytes = pngBytes("a real payload");
    await fs.mkdir(path.join(root, "assets"), { recursive: true });
    await fs.writeFile(path.join(root, "assets", "logo.png"), bytes);

    const result = await resolveProjectFileLaunchImage(
      fileSelection("assets/logo.png"),
      studioContext({ studioProjectId: PROJECT_ID }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.image.bytes).equals(bytes)).toBe(true);
    expect(result.image.source).toBe("project_file");
    expect(result.image.mime).toBe("image/png");
    // The absolute path would hand the model the user's directory layout.
    expect(result.image.displayLabel).toBe(path.join("assets", "logo.png"));
    expect(result.image.displayLabel).not.toContain(await fs.realpath(root));
    expect(result.image.displayLabel).not.toContain(os.tmpdir());
  });

  it("accepts a file of exactly the cap", async () => {
    await fs.writeFile(path.join(root, "big.png"), pngOfExactly(NO_FOLLOW_IMAGE_MAX_BYTES));

    const result = await resolveProjectFileLaunchImage(
      fileSelection("big.png"),
      studioContext({ studioProjectId: PROJECT_ID }),
    );

    expect(result.ok).toBe(true);
  });
});

describe("resolveProjectFileLaunchImage: every refusal the reader can produce", () => {
  const studio = () => studioContext({ studioProjectId: PROJECT_ID });

  async function reasonFor(requestedPath: string): Promise<string> {
    return refusalOf(await resolveProjectFileLaunchImage(fileSelection(requestedPath), studio()));
  }

  it("escapes_root: a path that climbs out of the project", async () => {
    await fs.writeFile(path.join(sandbox, "secret.png"), pngBytes("secret"));

    const reason = await reasonFor("../secret.png");

    expect(reason).toMatch(/outside this project/i);
    expect(reason).toMatch(/nothing was launched/i);
    // The refusal must not reveal where the project actually lives.
    expect(reason).not.toContain(sandbox);
  });

  it("symlink: a link is never followed, even one pointing inside the root", async () => {
    if (!(await canCreateSymlinks())) {
      console.warn("skipped: this platform cannot create symbolic links");
      return;
    }
    await fs.writeFile(path.join(root, "real.png"), pngBytes());
    await fs.symlink(path.join(root, "real.png"), path.join(root, "alias.png"));

    const reason = await reasonFor("alias.png");

    expect(reason).toMatch(/symbolic link/i);
    expect(reason).toMatch(/repointed after it is checked/i);
  });

  it("not_found: no file at that path", async () => {
    expect(await reasonFor("nope.png")).toMatch(/no file exists at that path/i);
  });

  it("not_a_regular_file: a directory is not a picture", async () => {
    await fs.mkdir(path.join(root, "assets", "nested"), { recursive: true });

    expect(await reasonFor("assets")).toMatch(/not an ordinary file/i);
  });

  it("empty_file: a zero-byte file has no picture to publish", async () => {
    await fs.writeFile(path.join(root, "empty.png"), Buffer.alloc(0));

    expect(await reasonFor("empty.png")).toMatch(/that file is empty/i);
  });

  it("too_large: one byte over the cap, and the refusal states both numbers", async () => {
    await fs.writeFile(path.join(root, "big.png"), pngOfExactly(NO_FOLLOW_IMAGE_MAX_BYTES + 1));

    const reason = await reasonFor("big.png");

    expect(reason).toContain(String(NO_FOLLOW_IMAGE_MAX_BYTES + 1));
    expect(reason).toContain(String(NO_FOLLOW_IMAGE_MAX_BYTES));
    expect(reason).toMatch(/smaller image/i);
  });

  it("unsupported_image: the extension is never trusted, the magic bytes are", async () => {
    await fs.writeFile(path.join(root, "evil.png"), "MZ this is not a PNG at all");

    expect(await reasonFor("evil.png")).toMatch(/PNG/);
  });

  it("read_failed: a NUL byte in the path, refused before any syscall", async () => {
    const reason = await reasonFor(`logo.png${String.fromCharCode(0)}.jpg`);

    expect(reason).toMatch(/could not be read/i);
    expect(reason).toMatch(/NUL/);
  });

  it("permission_denied: the file exists but Vex may not read it", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      console.warn("skipped: file mode does not deny reads for this platform or user");
      return;
    }
    const target = path.join(root, "locked.png");
    await fs.writeFile(target, pngBytes());
    await fs.chmod(target, 0o000);
    try {
      expect(await reasonFor("locked.png")).toMatch(/not allowed to read it/i);
    } finally {
      await fs.chmod(target, 0o600);
    }
  });

  it("not_absolute_root: a recorded root that is not an absolute directory", async () => {
    resolveProjectRootPath.mockResolvedValue({ kind: "ok", rootPath: "relative/proj" });

    const reason = await reasonFor("logo.png");

    expect(reason).toMatch(/could not establish this project's directory/i);
  });

  it("gives every refusal kind a DISTINCT sentence", async () => {
    await fs.writeFile(path.join(sandbox, "secret.png"), pngBytes("secret"));
    await fs.mkdir(path.join(root, "adir"), { recursive: true });
    await fs.writeFile(path.join(root, "empty.png"), Buffer.alloc(0));
    await fs.writeFile(path.join(root, "big.png"), pngOfExactly(NO_FOLLOW_IMAGE_MAX_BYTES + 1));
    await fs.writeFile(path.join(root, "evil.png"), "MZ not a png");

    const reasons = [
      await reasonFor("../secret.png"),
      await reasonFor("nope.png"),
      await reasonFor("adir"),
      await reasonFor("empty.png"),
      await reasonFor("big.png"),
      await reasonFor("evil.png"),
      await reasonFor(`logo.png${String.fromCharCode(0)}`),
    ];

    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

describe("the platform contract the containment depends on", () => {
  it("exposes O_NOFOLLOW everywhere except Windows", () => {
    if (process.platform === "win32") return;
    expect(typeof fsConstants.O_NOFOLLOW).toBe("number");
  });
});
