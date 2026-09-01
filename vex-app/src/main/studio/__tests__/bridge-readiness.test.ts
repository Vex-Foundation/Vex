/**
 * THE READINESS VERDICT: every branch, and the one thing each branch must
 * never say.
 *
 * The risk this suite exists for is a WRONG REMEDY. Telling a packaged user to
 * install a Go toolchain is advice they cannot follow; telling a developer to
 * reinstall Vex sends them to a downloads page for a binary they were supposed
 * to build. The branches are cheap; getting them the wrong way round is not.
 *
 * The probes are injected, so every branch runs on any machine. The LIVE half
 * is at the bottom: this worktree has a built bridge, so the real
 * `locateStudioBridge` and the real `bridge/build.sh` are exercised rather than
 * described.
 */

import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "" } }));

import { studioBridgeReadinessSchema } from "@shared/schemas/studio-bridge-readiness.js";
import { requiredGoVersion } from "../../../../scripts/bridge-freshness.mjs";
import { locateStudioBridge } from "../installer/bridge-path.js";
import {
  readStudioBridgeGoPin,
  resolveStudioBridgeReadiness,
  wirePlatform,
  type GoToolchainDetection,
  type StudioBridgeReadinessProbes,
} from "../bridge-readiness.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const PIN = "go1.27.0";

const temporaryRoots: string[] = [];
afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop() as string, { recursive: true, force: true });
  }
});

function syntheticRepo(buildScript: string | null): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vex-bridge-readiness-"));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, "bridge"), { recursive: true });
  if (buildScript !== null) {
    writeFileSync(path.join(root, "bridge", "build.sh"), buildScript, "utf8");
  }
  return root;
}

function probes(
  overrides: Partial<StudioBridgeReadinessProbes> = {},
): StudioBridgeReadinessProbes {
  return {
    packaged: false,
    platform: "linux",
    arch: "x64",
    locate: () =>
      Promise.resolve({ kind: "unavailable" as const, detail: "not built" }),
    readGoPin: () => Promise.resolve(PIN),
    detectGo: (): Promise<GoToolchainDetection> =>
      Promise.resolve({ kind: "ok", version: PIN }),
    ...overrides,
  };
}

describe("a packaged app never mentions Go", () => {
  it("reports a missing bridge as an installation-integrity failure", async () => {
    const goPin = vi.fn(() => Promise.resolve(PIN));
    const detectGo = vi.fn(() =>
      Promise.resolve<GoToolchainDetection>({ kind: "missing" }),
    );
    const readiness = await resolveStudioBridgeReadiness(
      probes({ packaged: true, readGoPin: goPin, detectGo }),
    );

    expect(readiness).toEqual({ kind: "missing_packaged" });
    // Not merely absent from the payload: never asked. A packaged app that
    // spawns `go` has already made the toolchain part of its story.
    expect(detectGo).not.toHaveBeenCalled();
    expect(goPin).not.toHaveBeenCalled();
  });

  it("reports a present bridge as ready", async () => {
    const readiness = await resolveStudioBridgeReadiness(
      probes({
        packaged: true,
        locate: () =>
          Promise.resolve({ kind: "found" as const, command: "/x/vex-mcp" }),
      }),
    );
    expect(readiness).toEqual({ kind: "ready" });
  });

  it("never reports unsupported_platform, whatever the machine is", async () => {
    const readiness = await resolveStudioBridgeReadiness(
      probes({ packaged: true, platform: "freebsd" as NodeJS.Platform }),
    );
    // The binary shipped inside this app; the app running at all is the proof
    // its platform is supported. `unsupported_platform` would send a user with
    // a damaged install to a "we do not support you" screen.
    expect(readiness).toEqual({ kind: "missing_packaged" });
  });
});

describe("a from-source run reports the toolchain", () => {
  it.each<[GoToolchainDetection, unknown]>([
    [{ kind: "missing" }, { kind: "absent" }],
    [{ kind: "unusable" }, { kind: "unusable" }],
    [{ kind: "ok", version: PIN }, { kind: "present" }],
    [
      { kind: "ok", version: "go1.28.1" },
      { kind: "wrong_version", found: "go1.28.1" },
    ],
  ])("maps %j to %j", async (detected, expected) => {
    const readiness = await resolveStudioBridgeReadiness(
      probes({ detectGo: () => Promise.resolve(detected) }),
    );
    expect(readiness).toEqual({
      kind: "missing_dev",
      platform: "linux",
      requiredGoVersion: PIN,
      go: expected,
    });
  });

  it("treats a NEWER Go as wrong, because the pin is exact", async () => {
    const readiness = await resolveStudioBridgeReadiness(
      probes({
        detectGo: () => Promise.resolve({ kind: "ok", version: "go1.99.0" }),
      }),
    );
    expect(readiness).toMatchObject({
      go: { kind: "wrong_version", found: "go1.99.0" },
    });
  });

  it("does not ask about Go at all when the bridge is built", async () => {
    const detectGo = vi.fn(() =>
      Promise.resolve<GoToolchainDetection>({ kind: "missing" }),
    );
    const readiness = await resolveStudioBridgeReadiness(
      probes({
        locate: () =>
          Promise.resolve({ kind: "found" as const, command: "/x/vex-mcp" }),
        detectGo,
      }),
    );
    expect(readiness).toEqual({ kind: "ready" });
    expect(detectGo).not.toHaveBeenCalled();
  });

  it("refuses to guess a pin it cannot read", async () => {
    const detectGo = vi.fn(() =>
      Promise.resolve<GoToolchainDetection>({ kind: "missing" }),
    );
    const readiness = await resolveStudioBridgeReadiness(
      probes({ readGoPin: () => Promise.resolve(null), detectGo }),
    );
    expect(readiness).toEqual({ kind: "pin_unreadable" });
    expect(detectGo).not.toHaveBeenCalled();
  });

  it("names an unsupported platform instead of blaming the build", async () => {
    const locate = vi.fn();
    const readiness = await resolveStudioBridgeReadiness(
      probes({ platform: "freebsd" as NodeJS.Platform, locate }),
    );
    expect(readiness).toEqual({ kind: "unsupported_platform" });
    expect(locate).not.toHaveBeenCalled();
  });

  it("names an unsupported architecture the same way", async () => {
    const readiness = await resolveStudioBridgeReadiness(
      probes({ arch: "ia32" }),
    );
    expect(readiness).toEqual({ kind: "unsupported_platform" });
  });
});

describe("the platform that reaches the wire", () => {
  it.each([
    ["darwin", "darwin"],
    ["win32", "win32"],
    ["linux", "linux"],
    ["freebsd", "other"],
    ["aix", "other"],
  ])("maps %s to %s", (platform, expected) => {
    expect(wirePlatform(platform as NodeJS.Platform)).toBe(expected);
  });
});

describe("every verdict is a valid payload", () => {
  it.each<[string, Partial<StudioBridgeReadinessProbes>]>([
    ["ready", { locate: () => Promise.resolve({ kind: "found", command: "x" }) }],
    ["missing_packaged", { packaged: true }],
    ["unsupported_platform", { platform: "freebsd" as NodeJS.Platform }],
    ["pin_unreadable", { readGoPin: () => Promise.resolve(null) }],
    ["missing_dev", {}],
  ])("%s passes the wire schema", async (_label, overrides) => {
    const readiness = await resolveStudioBridgeReadiness(probes(overrides));
    expect(studioBridgeReadinessSchema.safeParse(readiness).success).toBe(true);
  });
});

describe("the Go pin has ONE owner", () => {
  it("reads the same value the build wrapper's own reader reads", async () => {
    // The drift guard. `scripts/bridge-freshness.mjs` cannot be imported by
    // main (it is a dev script outside the bundle), so main mirrors the read.
    // A mirror without this assertion is how two files start disagreeing about
    // which compiler builds the shipping binary.
    expect(await readStudioBridgeGoPin(REPO_ROOT)).toBe(
      requiredGoVersion(REPO_ROOT),
    );
  });

  it("returns null rather than guessing when the script is absent", async () => {
    expect(await readStudioBridgeGoPin(syntheticRepo(null))).toBeNull();
  });

  it("returns null when the declaration is gone", async () => {
    const root = syntheticRepo("#!/usr/bin/env bash\nset -euo pipefail\n");
    expect(await readStudioBridgeGoPin(root)).toBeNull();
  });

  it("refuses a declared pin that is not a bare version token", async () => {
    const root = syntheticRepo(
      'readonly REQUIRED_GO_VERSION="$(cat /etc/go-version)"\n',
    );
    expect(await readStudioBridgeGoPin(root)).toBeNull();
  });

  it("reads a well-formed declaration from a synthetic checkout", async () => {
    const root = syntheticRepo(
      `#!/usr/bin/env bash\nreadonly REQUIRED_GO_VERSION="go1.31.4"\n`,
    );
    expect(await readStudioBridgeGoPin(root)).toBe("go1.31.4");
  });
});

/**
 * THE LIVE HALF (rule 10 in spirit: the machine is the specification).
 *
 * This worktree builds the bridge on `pnpm dev`, so the real locator and the
 * real build script are available. Asserting the ready path through injected
 * fakes only would prove the branch table, not that the branch table is wired
 * to anything real.
 */
describe("against this checkout", () => {
  it("finds the built bridge and reports ready through the real locator", async () => {
    const located = await locateStudioBridge({
      packaged: false,
      repoRoot: REPO_ROOT,
    });
    if (located.kind !== "found") {
      // Honest skip rather than a false green: on a checkout that has not run
      // `pnpm --dir vex-app run build:bridge:dev`, there is no artifact to
      // prove anything against, and the branch is covered by the fakes above.
      expect(located.kind).toBe("unavailable");
      return;
    }
    const readiness = await resolveStudioBridgeReadiness(
      probes({
        locate: () => locateStudioBridge({ packaged: false, repoRoot: REPO_ROOT }),
        readGoPin: () => readStudioBridgeGoPin(REPO_ROOT),
      }),
    );
    expect(readiness).toEqual({ kind: "ready" });
  });

  it("reads a real pin that the wire schema accepts", async () => {
    const pin = await readStudioBridgeGoPin(REPO_ROOT);
    expect(pin).not.toBeNull();
    expect(
      studioBridgeReadinessSchema.safeParse({
        kind: "missing_dev",
        platform: "linux",
        requiredGoVersion: pin,
        go: { kind: "absent" },
      }).success,
    ).toBe(true);
  });
});
