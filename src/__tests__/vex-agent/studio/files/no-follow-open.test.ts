/**
 * Containment tests for the Studio no-follow image reader.
 *
 * REAL FILESYSTEM, NO `fs` MOCKING. The subject of these tests is what the
 * KERNEL does with `O_NOFOLLOW`, a symlinked parent directory, a FIFO and a
 * size bound. A mocked `fs` would only prove that our own branches call our own
 * branches. This follows the VS Code `pfs` test style: a real temp directory
 * per test, real files, real links, torn down in `afterEach` on success and on
 * failure alike.
 *
 * Platforms that cannot create a symlink (an unprivileged Windows account) skip
 * the link cases with a stated reason rather than reporting a false pass.
 */

import { execFileSync } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NO_FOLLOW_IMAGE_MAX_BYTES,
  openImageInsideRoot,
  type NoFollowImageOpen,
} from "@vex-agent/studio/files/no-follow-open.js";

// -- fixtures --------------------------------------------------------------

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const GIF89A_HEADER = Buffer.from("GIF89a", "ascii");

function pngBytes(payload = "vex"): Buffer {
  return Buffer.concat([PNG_HEADER, Buffer.from(payload, "utf8")]);
}

function jpegBytes(): Buffer {
  return Buffer.concat([JPEG_HEADER, Buffer.from("jfif-ish", "utf8")]);
}

function webpBytes(): Buffer {
  // RIFF at 0, the little-endian chunk size, then WEBP at 8.
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4, 4);
  header.write("WEBP", 8, "ascii");
  return Buffer.concat([header, Buffer.from("VP8 payload", "utf8")]);
}

function gifBytes(): Buffer {
  return Buffer.concat([GIF89A_HEADER, Buffer.from("gif payload", "utf8")]);
}

/** A PNG-headed file of an exact total byte length. */
function pngOfExactly(byteLength: number): Buffer {
  const bytes = Buffer.alloc(byteLength, 0x41);
  PNG_HEADER.copy(bytes, 0);
  return bytes;
}

// -- harness ---------------------------------------------------------------

/**
 * `tmpdir()` is itself a symlink on macOS, so the SANDBOX is deliberately not
 * resolved here: several tests need a root reached through a link.
 */
let sandbox: string;
let root: string;

/** Resolved once per test, because containment is defined against the real root. */
async function realRoot(): Promise<string> {
  return fs.realpath(root);
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "vex-no-follow-"));
  root = path.join(sandbox, "proj");
  await fs.mkdir(root, { recursive: true });
});

afterEach(async () => {
  // Runs after a failed expectation too, so a red test never leaks a temp tree.
  await fs.rm(sandbox, { recursive: true, force: true });
});

let symlinksUsable: boolean | undefined;

/** Probe the platform once: an unprivileged Windows account cannot make links. */
async function canCreateSymlinks(): Promise<boolean> {
  if (symlinksUsable !== undefined) return symlinksUsable;
  const probe = await fs.mkdtemp(path.join(os.tmpdir(), "vex-symlink-probe-"));
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

function fifoTool(): string | null {
  if (process.platform === "win32") return null;
  try {
    execFileSync("mkfifo", ["--version"], { stdio: "ignore" });
    return "mkfifo";
  } catch {
    return null;
  }
}

function refusalOf(result: NoFollowImageOpen): Extract<NoFollowImageOpen, { ok: false }>["refusal"] {
  if (result.ok) {
    throw new Error(`expected a refusal, got a success for ${result.relativePath}`);
  }
  return result.refusal;
}

// -- accepted formats ------------------------------------------------------

describe("openImageInsideRoot: accepted images", () => {
  it("returns byte-identical PNG bytes, the mime, and the root-relative path", async () => {
    const bytes = pngBytes("a real payload");
    await fs.mkdir(path.join(root, "assets"), { recursive: true });
    await fs.writeFile(path.join(root, "assets", "logo.png"), bytes);

    const result = await openImageInsideRoot({
      projectRoot: root,
      requestedPath: "assets/logo.png",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mime).toBe("image/png");
    expect(Buffer.from(result.bytes).equals(bytes)).toBe(true);
    expect(result.byteLength).toBe(bytes.byteLength);
    expect(result.relativePath).toBe(path.join("assets", "logo.png"));
    expect(result.resolvedPath).toBe(path.join(await realRoot(), "assets", "logo.png"));
  });

  it("accepts an absolute path that lands inside the root", async () => {
    await fs.writeFile(path.join(root, "cover.png"), pngBytes());

    const result = await openImageInsideRoot({
      projectRoot: root,
      requestedPath: path.join(await realRoot(), "cover.png"),
    });

    expect(result.ok).toBe(true);
  });

  it.each([
    ["JPEG", "shot.jpg", jpegBytes(), "image/jpeg"],
    ["WebP", "shot.webp", webpBytes(), "image/webp"],
    ["GIF89a", "shot.gif", gifBytes(), "image/gif"],
  ] as const)("accepts %s from its magic bytes", async (_label, name, bytes, mime) => {
    await fs.writeFile(path.join(root, name), bytes);

    const result = await openImageInsideRoot({ projectRoot: root, requestedPath: name });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mime).toBe(mime);
  });
});

// -- format is never taken from the extension -------------------------------

describe("openImageInsideRoot: format sniffing", () => {
  it("refuses a text file as unsupported_image", async () => {
    await fs.writeFile(path.join(root, "notes.txt"), "not an image at all");

    const refusal = refusalOf(
      await openImageInsideRoot({ projectRoot: root, requestedPath: "notes.txt" }),
    );

    expect(refusal.kind).toBe("unsupported_image");
    expect(refusal).toHaveProperty("detail", expect.stringContaining("PNG"));
  });

  it("refuses a file whose .png extension lies, proving the extension is never trusted", async () => {
    await fs.writeFile(path.join(root, "evil.png"), "MZ this is not a PNG");

    const refusal = refusalOf(
      await openImageInsideRoot({ projectRoot: root, requestedPath: "evil.png" }),
    );

    expect(refusal.kind).toBe("unsupported_image");
  });
});

// -- containment -----------------------------------------------------------

describe("openImageInsideRoot: root containment", () => {
  it("refuses a relative path that climbs out of the root, and never opens the file", async () => {
    const outside = path.join(sandbox, "secret.png");
    await fs.writeFile(outside, pngBytes("secret"));

    const refusal = refusalOf(
      await openImageInsideRoot({ projectRoot: root, requestedPath: "../secret.png" }),
    );

    expect(refusal.kind).toBe("escapes_root");
  });

  it("refuses an absolute path outside the root", async () => {
    const outside = path.join(sandbox, "secret.png");
    await fs.writeFile(outside, pngBytes("secret"));

    const refusal = refusalOf(
      await openImageInsideRoot({ projectRoot: root, requestedPath: outside }),
    );

    expect(refusal.kind).toBe("escapes_root");
  });

  it("refuses a sibling directory that merely PREFIXES the root name", async () => {
    // The test that dies if the containment check loses its path separator:
    // `<sandbox>/projX` starts with `<sandbox>/proj`.
    const sibling = path.join(sandbox, "projX");
    await fs.mkdir(sibling, { recursive: true });
    const target = path.join(sibling, "a.png");
    await fs.writeFile(target, pngBytes());

    const refusal = refusalOf(
      await openImageInsideRoot({ projectRoot: root, requestedPath: target }),
    );

    expect(refusal.kind).toBe("escapes_root");
  });

  it("refuses the root itself, which is not a file", async () => {
    const refusal = refusalOf(await openImageInsideRoot({ projectRoot: root, requestedPath: "." }));

    expect(refusal.kind).toBe("escapes_root");
  });

  it("keeps the absolute filesystem layout out of an escapes_root detail", async () => {
    await fs.writeFile(path.join(sandbox, "secret.png"), pngBytes("secret"));

    const refusal = refusalOf(
      await openImageInsideRoot({ projectRoot: root, requestedPath: "../secret.png" }),
    );

    expect(refusal.kind).toBe("escapes_root");
    if (refusal.kind !== "escapes_root") return;
    expect(refusal.detail).not.toContain(sandbox);
    expect(refusal.detail).not.toContain(await realRoot());
    expect(refusal.detail).not.toContain(os.tmpdir());
    // The model's own request is echoed back, because the model can act on it.
    expect(refusal.detail).toContain("../secret.png");
  });
});

// -- symbolic links --------------------------------------------------------

describe("openImageInsideRoot: symbolic links are never followed", () => {
  it("refuses a link inside the root that points outside it", async () => {
    if (!(await canCreateSymlinks())) {
      console.warn("skipped: this platform cannot create symbolic links");
      return;
    }
    const outside = path.join(sandbox, "outside.png");
    await fs.writeFile(outside, pngBytes("outside"));
    await fs.symlink(outside, path.join(root, "link.png"));

    const refusal = refusalOf(
      await openImageInsideRoot({ projectRoot: root, requestedPath: "link.png" }),
    );

    expect(refusal.kind).toBe("symlink");
  });

  it("refuses a link pointing INSIDE the root too: the rule is no-follow, not no-escape", async () => {
    if (!(await canCreateSymlinks())) {
      console.warn("skipped: this platform cannot create symbolic links");
      return;
    }
    const real = path.join(root, "real.png");
    await fs.writeFile(real, pngBytes());
    await fs.symlink(real, path.join(root, "alias.png"));

    const refusal = refusalOf(
      await openImageInsideRoot({ projectRoot: root, requestedPath: "alias.png" }),
    );

    expect(refusal.kind).toBe("symlink");
  });

  it("refuses a file reached through an intermediate symlinked directory that leaves the root", async () => {
    if (!(await canCreateSymlinks())) {
      console.warn("skipped: this platform cannot create symbolic links");
      return;
    }
    const outsideDir = path.join(sandbox, "elsewhere");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "a.png"), pngBytes("elsewhere"));
    // `O_NOFOLLOW` cannot see this one: the link is a PARENT, not the final
    // component, so only the post-open re-resolution catches it.
    await fs.symlink(outsideDir, path.join(root, "images"), "dir");

    const refusal = refusalOf(
      await openImageInsideRoot({ projectRoot: root, requestedPath: "images/a.png" }),
    );

    expect(refusal.kind).toBe("escapes_root");
  });

  it("accepts an ordinary file when the project root ITSELF lives behind a symlink", async () => {
    if (!(await canCreateSymlinks())) {
      console.warn("skipped: this platform cannot create symbolic links");
      return;
    }
    await fs.writeFile(path.join(root, "logo.png"), pngBytes());
    const linkedRoot = path.join(sandbox, "proj-link");
    await fs.symlink(root, linkedRoot, "dir");

    const result = await openImageInsideRoot({
      projectRoot: linkedRoot,
      requestedPath: "logo.png",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.relativePath).toBe("logo.png");
  });
});

// -- file kind -------------------------------------------------------------

describe("openImageInsideRoot: file kind", () => {
  it("refuses a directory as not_a_regular_file", async () => {
    await fs.mkdir(path.join(root, "assets"), { recursive: true });

    const refusal = refusalOf(
      await openImageInsideRoot({ projectRoot: root, requestedPath: "assets" }),
    );

    expect(refusal.kind).toBe("not_a_regular_file");
  });

  it("refuses a FIFO as not_a_regular_file", async () => {
    const tool = fifoTool();
    if (tool === null) {
      console.warn("skipped: mkfifo is unavailable on this platform");
      return;
    }
    const fifo = path.join(root, "pipe.png");
    execFileSync(tool, [fifo]);

    // O_NONBLOCK keeps this test from hanging if the guard ever regresses to a
    // blocking open on a FIFO with no writer.
    const refusal = refusalOf(
      await Promise.race([
        openImageInsideRoot({ projectRoot: root, requestedPath: "pipe.png" }),
        new Promise<NoFollowImageOpen>((_resolve, reject) => {
          setTimeout(() => reject(new Error("opening a FIFO blocked")), 5000).unref();
        }),
      ]),
    );

    expect(refusal.kind).toBe("not_a_regular_file");
  });

  it("refuses a missing file as not_found", async () => {
    const refusal = refusalOf(
      await openImageInsideRoot({ projectRoot: root, requestedPath: "nope.png" }),
    );

    expect(refusal.kind).toBe("not_found");
  });
});

// -- bounds ----------------------------------------------------------------

describe("openImageInsideRoot: size bounds", () => {
  it("refuses a zero-byte file as empty_file", async () => {
    await fs.writeFile(path.join(root, "empty.png"), Buffer.alloc(0));

    const refusal = refusalOf(
      await openImageInsideRoot({ projectRoot: root, requestedPath: "empty.png" }),
    );

    expect(refusal.kind).toBe("empty_file");
  });

  it("accepts a file of exactly the cap", async () => {
    await fs.writeFile(path.join(root, "big.png"), pngOfExactly(NO_FOLLOW_IMAGE_MAX_BYTES));

    const result = await openImageInsideRoot({ projectRoot: root, requestedPath: "big.png" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.byteLength).toBe(NO_FOLLOW_IMAGE_MAX_BYTES);
  });

  it("refuses one byte over the cap and names the cap in the refusal", async () => {
    await fs.writeFile(path.join(root, "big.png"), pngOfExactly(NO_FOLLOW_IMAGE_MAX_BYTES + 1));

    const refusal = refusalOf(
      await openImageInsideRoot({ projectRoot: root, requestedPath: "big.png" }),
    );

    expect(refusal.kind).toBe("too_large");
    if (refusal.kind !== "too_large") return;
    expect(refusal.maxBytes).toBe(NO_FOLLOW_IMAGE_MAX_BYTES);
    expect(refusal.byteLength).toBe(NO_FOLLOW_IMAGE_MAX_BYTES + 1);
  });
});

// -- request and root shape ------------------------------------------------

describe("openImageInsideRoot: input shape", () => {
  it("refuses a path containing a NUL byte without ever reaching a syscall", async () => {
    const nul = String.fromCharCode(0);
    const target = path.join(root, "logo.png");
    await fs.writeFile(target, pngBytes());
    // Proof it never opened anything: the file below is created unreadable, and
    // the NUL-bearing request names it. A syscall would give a different kind.
    const refusal = refusalOf(
      await openImageInsideRoot({ projectRoot: root, requestedPath: `logo.png${nul}.jpg` }),
    );

    expect(refusal.kind).toBe("read_failed");
    expect(refusal).toHaveProperty("detail", expect.stringContaining("NUL"));
  });

  it("refuses an empty requested path", async () => {
    const refusal = refusalOf(await openImageInsideRoot({ projectRoot: root, requestedPath: "" }));

    expect(refusal.kind).toBe("read_failed");
  });

  it("refuses a relative project root as not_absolute_root", async () => {
    const refusal = refusalOf(
      await openImageInsideRoot({ projectRoot: "relative/proj", requestedPath: "logo.png" }),
    );

    expect(refusal.kind).toBe("not_absolute_root");
  });

  it("refuses a project root that does not exist on disk", async () => {
    const refusal = refusalOf(
      await openImageInsideRoot({
        projectRoot: path.join(sandbox, "missing-root"),
        requestedPath: "logo.png",
      }),
    );

    expect(refusal.kind).toBe("not_absolute_root");
  });
});

// -- permissions -----------------------------------------------------------

describe("openImageInsideRoot: permissions", () => {
  it("refuses an unreadable file as permission_denied", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      console.warn("skipped: file mode does not deny reads for this platform or user");
      return;
    }
    const target = path.join(root, "locked.png");
    await fs.writeFile(target, pngBytes());
    await fs.chmod(target, 0o000);
    try {
      const refusal = refusalOf(
        await openImageInsideRoot({ projectRoot: root, requestedPath: "locked.png" }),
      );

      expect(refusal.kind).toBe("permission_denied");
    } finally {
      await fs.chmod(target, 0o600);
    }
  });
});

// -- platform contract -----------------------------------------------------

describe("the platform contract this module depends on", () => {
  it("exposes O_NOFOLLOW everywhere except Windows", () => {
    if (process.platform === "win32") return;
    expect(typeof fsConstants.O_NOFOLLOW).toBe("number");
  });
});
