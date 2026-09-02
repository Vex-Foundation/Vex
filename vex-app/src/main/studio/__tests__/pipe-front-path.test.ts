/**
 * WHERE MAIN LOOKS FOR THE WINDOWS PIPE FRONT, and what it says when the
 * answer is "nowhere".
 *
 * `locateStudioPipeFront` decides an absolute path that the PRIVILEGED main
 * process will spawn. Two properties are load-bearing and both are asserted
 * here rather than assumed:
 *
 *   1. NO `PATH` SEARCH, EVER. A bare `vex-pipe-front.exe` would let any
 *      binary of that name earlier on the user's `PATH` run with Vex's
 *      authority. Every answer is an absolute path under either the app's own
 *      resources or the repository's build output, and nothing else.
 *   2. "NOT BUILT FOR THIS OS" IS NOT "MISSING". The front is a Windows-only
 *      artifact (`BRIDGE_ARTIFACTS` in scripts/bridge-artifact.mjs), so on
 *      macOS and Linux its absence is the design. Collapsing that into
 *      `unavailable` would put a "reinstall Vex" remedy in front of a user
 *      whose installation is perfectly fine.
 *
 * `electron` is mocked because the resolver reads `app.isPackaged` and
 * `app.getAppPath()` as DEFAULTS only; every case here passes them explicitly,
 * which is what lets the packaged layout be exercised on a Linux runner.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "" } }));

const { locateStudioPipeFront, PIPE_FRONT_BINARY_NAME } = await import(
  "../installer/bridge-path.js"
);

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vex-pipe-front-"));
  temporaryRoots.push(root);
  return root;
}

/** An empty but EXECUTABLE file: the resolver checks `X_OK`, not content. */
function writeExecutable(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "");
  chmodSync(file, 0o755);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the packaged layout", () => {
  it("resolves <resources>/bridge/vex-pipe-front.exe", async () => {
    const resourcesPath = temporaryRoot();
    const expected = path.join(resourcesPath, "bridge", PIPE_FRONT_BINARY_NAME);
    writeExecutable(expected);

    await expect(
      locateStudioPipeFront({ packaged: true, resourcesPath, platform: "win32", arch: "x64" }),
    ).resolves.toEqual({ kind: "found", command: expected });
  });

  it("reports unavailable - never a bare name - when the packaged file is gone", async () => {
    const resourcesPath = temporaryRoot();
    const located = await locateStudioPipeFront({
      packaged: true,
      resourcesPath,
      platform: "win32",
      arch: "x64",
    });
    expect(located.kind).toBe("unavailable");
    expect(located.kind === "unavailable" && located.detail).toContain("missing from this");
    expect(JSON.stringify(located)).not.toContain(`"${PIPE_FRONT_BINARY_NAME}"`);
  });
});

describe("the development layout", () => {
  it("resolves the build wrapper's output for the running architecture", async () => {
    const repoRoot = temporaryRoot();
    const expected = path.join(
      repoRoot,
      "bridge",
      "dist",
      "windows-arm64",
      PIPE_FRONT_BINARY_NAME,
    );
    writeExecutable(expected);

    await expect(
      locateStudioPipeFront({ packaged: false, repoRoot, platform: "win32", arch: "arm64" }),
    ).resolves.toEqual({ kind: "found", command: expected });
  });

  it("does not accept an amd64 build for an arm64 host, or the reverse", async () => {
    const repoRoot = temporaryRoot();
    writeExecutable(
      path.join(repoRoot, "bridge", "dist", "windows-amd64", PIPE_FRONT_BINARY_NAME),
    );
    // One triple's output can never stand in for another's: the path carries
    // the triple, so this is a property of the layout rather than a check.
    const located = await locateStudioPipeFront({
      packaged: false,
      repoRoot,
      platform: "win32",
      arch: "arm64",
    });
    expect(located.kind).toBe("unavailable");
  });

  it("reports unavailable when nothing has been built yet", async () => {
    const repoRoot = temporaryRoot();
    const located = await locateStudioPipeFront({
      packaged: false,
      repoRoot,
      platform: "win32",
      arch: "x64",
    });
    expect(located.kind).toBe("unavailable");
  });
});

describe("platforms with no front at all", () => {
  it("answers unsupported_platform on darwin and linux, packaged or not", async () => {
    const repoRoot = temporaryRoot();
    const cases = await Promise.all(
      (
        [
          { platform: "darwin" as const, packaged: true },
          { platform: "darwin" as const, packaged: false },
          { platform: "linux" as const, packaged: true },
          { platform: "linux" as const, packaged: false },
        ]
      ).map(async ({ platform, packaged }) =>
        (await locateStudioPipeFront({ packaged, repoRoot, resourcesPath: repoRoot, platform, arch: "x64" }))
          .kind,
      ),
    );
    expect(cases).toEqual([
      "unsupported_platform",
      "unsupported_platform",
      "unsupported_platform",
      "unsupported_platform",
    ]);
  });

  it("says so even when a file of that name happens to sit at the packaged path", async () => {
    // The platform decision comes FIRST. A stray `vex-pipe-front.exe` in a
    // macOS bundle must not be reported as found and spawned.
    const resourcesPath = temporaryRoot();
    writeExecutable(path.join(resourcesPath, "bridge", PIPE_FRONT_BINARY_NAME));
    const located = await locateStudioPipeFront({
      packaged: true,
      resourcesPath,
      platform: "darwin",
      arch: "arm64",
    });
    expect(located.kind).toBe("unsupported_platform");
    expect(located.kind === "unsupported_platform" && located.detail).toContain("Windows component");
  });

  it("names an unsupported ARCHITECTURE rather than reporting a missing file", async () => {
    const repoRoot = temporaryRoot();
    const located = await locateStudioPipeFront({
      packaged: false,
      repoRoot,
      platform: "win32",
      arch: "ia32",
    });
    expect(located.kind).toBe("unsupported_platform");
    expect(located.kind === "unsupported_platform" && located.detail).toContain("win32/ia32");
  });
});
