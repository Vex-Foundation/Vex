/**
 * Projects-root contract (Vex Studio stage P).
 *
 * Three things are proved here, and each of them is the difference between a
 * project the user can open and a project pointing at somebody else's files:
 *
 *   1. the configured root honours an ABSOLUTE `projectsRoot` override and
 *      IGNORES a relative one (the same rule `VEX_CONFIG_DIR` follows);
 *   2. the root is REALPATH-resolved, so a symlinked root is compared as the
 *      place it actually points to rather than the link that names it;
 *   3. a root that no longer matches the one recorded in `studio_settings`
 *      fails closed with `projects.root_changed` - it never silently re-homes
 *      the existing rows, whose `root_path` is relative to the recorded root.
 */

import { mkdtemp, mkdir, realpath, stat, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({}) as { projectsRoot?: string }),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@config/store.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const {
  assertProjectsRootUnchanged,
  configuredProjectsRoot,
  formatProjectDisplayPath,
  resolveProjectDirectory,
  resolveProjectsRoot,
} = await import("../projects-root.js");
const { DEFAULT_PROJECTS_ROOT } = await import("../../paths/config-dir.js");

const CORR = "corr-projects-root";
let scratch: string;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.loadConfig.mockReturnValue({});
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), "vex-projects-root-")));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Minimal scripted `pg.Client` - only `studio_settings` is read here. */
function scriptedClient(rows: ReadonlyArray<{ projects_root: string }>): Client {
  return Object.assign(new Client(), {
    query: vi.fn(async () => ({ rows, rowCount: rows.length })),
  });
}

describe("configuredProjectsRoot", () => {
  it("uses the platform default when no override is configured", () => {
    expect(configuredProjectsRoot()).toBe(DEFAULT_PROJECTS_ROOT);
  });

  it("honours an ABSOLUTE projectsRoot override", () => {
    mocks.loadConfig.mockReturnValue({ projectsRoot: scratch });
    expect(configuredProjectsRoot()).toBe(scratch);
  });

  it("IGNORES a relative projectsRoot override (a typo must not redirect into the cwd)", () => {
    mocks.loadConfig.mockReturnValue({ projectsRoot: "projects" });
    expect(configuredProjectsRoot()).toBe(DEFAULT_PROJECTS_ROOT);
    mocks.loadConfig.mockReturnValue({ projectsRoot: "./here/../there" });
    expect(configuredProjectsRoot()).toBe(DEFAULT_PROJECTS_ROOT);
    mocks.loadConfig.mockReturnValue({ projectsRoot: "" });
    expect(configuredProjectsRoot()).toBe(DEFAULT_PROJECTS_ROOT);
  });
});

describe("resolveProjectsRoot", () => {
  it("creates the root when absent and returns it", async () => {
    const target = path.join(scratch, "nested", "projects");
    mocks.loadConfig.mockReturnValue({ projectsRoot: target });
    const outcome = await resolveProjectsRoot(CORR);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toBe(await realpath(target));
  });

  it("returns the REALPATH, so a symlinked root resolves to its real location", async () => {
    const real = path.join(scratch, "real-projects");
    const link = path.join(scratch, "linked-projects");
    await mkdir(real);
    await symlink(real, link, "dir");
    mocks.loadConfig.mockReturnValue({ projectsRoot: link });

    const outcome = await resolveProjectsRoot(CORR);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The link name never becomes the root: everything downstream compares
    // against the place the link points to.
    expect(outcome.data).toBe(real);
    expect(outcome.data).not.toBe(link);
  });

  it("fails closed with projects.root_unavailable when the root cannot be created", async () => {
    // A FILE where the directory belongs. Nothing is written and the failure is
    // named, not collapsed into an unexpected error.
    const filePath = path.join(scratch, "not-a-dir");
    await (await import("node:fs/promises")).writeFile(filePath, "x");
    mocks.loadConfig.mockReturnValue({ projectsRoot: filePath });

    const outcome = await resolveProjectsRoot(CORR);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.root_unavailable");
    expect(outcome.error.domain).toBe("projects");
    expect(outcome.error.redacted).toBe(true);
    // The absolute path is main-process information and never rides the error.
    expect(JSON.stringify(outcome.error)).not.toContain(filePath);
  });
});

describe("assertProjectsRootUnchanged", () => {
  it("reports 'no root recorded yet' so the create path knows it owns the first write", async () => {
    const outcome = await assertProjectsRootUnchanged(
      scriptedClient([]),
      scratch,
      CORR,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toBeNull();
  });

  it("passes when the configured root equals the recorded one", async () => {
    const outcome = await assertProjectsRootUnchanged(
      scriptedClient([{ projects_root: scratch }]),
      scratch,
      CORR,
    );
    expect(outcome.ok).toBe(true);
  });

  it("fails closed with projects.root_changed when a project already exists under another root", async () => {
    // BOTH directories exist, and that is now load-bearing: root equality is
    // decided by filesystem identity (B3), so a recorded root that is not there
    // at all is the DIFFERENT refusal `projects.root_unverifiable`, proved in
    // the identity suite below. This test is about two real, different folders.
    const old = path.join(scratch, "old");
    const fresh = path.join(scratch, "new");
    await mkdir(old);
    await mkdir(fresh);

    const outcome = await assertProjectsRootUnchanged(
      scriptedClient([{ projects_root: old }]),
      fresh,
      CORR,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.root_changed");
    expect(outcome.error.userActionable).toBe(true);
    expect(outcome.error.retryable).toBe(false);
    // The remedy must be stated: a refusal that does not say what to restore is
    // a dead end.
    expect(outcome.error.message).toMatch(/restore/i);
    // Neither path leaks to the renderer.
    expect(JSON.stringify(outcome.error)).not.toContain(scratch);
  });
});

/**
 * ROOT EQUALITY IS FILESYSTEM IDENTITY, NOT SPELLING (B3).
 *
 * Real directories, real links, real `stat`: the property under test is one
 * the operating system owns, and a fake `stat` could only prove that our code
 * calls the function we told it to call. The one row a real filesystem cannot
 * produce on demand (an identity of `dev=0, ino=0`) is pinned in
 * `projects-root-identity.test.ts`, where `stat` IS faked for exactly that row.
 */
describe("root equality by filesystem identity", () => {
  it("accepts two spellings that reach the SAME directory (old code refused this)", async () => {
    // A root reachable by two names is the ordinary case behind the bug this
    // replaces: a `config.json` root spelled one way, an anchor recorded the
    // other. On Linux a symlink is how that is expressed; on win32 and darwin
    // a case difference does the same thing, which the probe test below shows.
    const real = path.join(scratch, "real-root");
    const link = path.join(scratch, "link-root");
    await mkdir(real);
    await symlink(real, link, "dir");

    const outcome = await assertProjectsRootUnchanged(
      scriptedClient([{ projects_root: link }]),
      real,
      CORR,
    );
    expect(outcome.ok).toBe(true);
  });

  it("refuses two different directories with projects.root_changed", async () => {
    const a = path.join(scratch, "root-a");
    const b = path.join(scratch, "root-b");
    await mkdir(a);
    await mkdir(b);

    const outcome = await assertProjectsRootUnchanged(
      scriptedClient([{ projects_root: a }]),
      b,
      CORR,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.root_changed");
  });

  it("refuses with projects.root_unverifiable when the recorded root cannot be inspected", async () => {
    // The offline-network-drive shape: the anchor names a folder that is not
    // there right now. Telling the user to restore a config value they never
    // changed would send them to fix the one thing that is not broken, so this
    // is a DIFFERENT code, and a retryable one.
    const present = path.join(scratch, "present-root");
    await mkdir(present);

    const outcome = await assertProjectsRootUnchanged(
      scriptedClient([{ projects_root: path.join(scratch, "gone-root") }]),
      present,
      CORR,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.root_unverifiable");
    expect(outcome.error.retryable).toBe(true);
    expect(outcome.error.userActionable).toBe(true);
    // No path reaches the renderer, exactly as with every other projects error.
    expect(JSON.stringify(outcome.error)).not.toContain(scratch);
  });

  /**
   * THE CASE ROW, decided by the VOLUME rather than by `process.platform`.
   *
   * On a case-insensitive volume (NTFS, a default APFS volume) the two
   * spellings are one directory and the check must ACCEPT: refusing would lock
   * the user out of every project they own. On a case-sensitive volume they are
   * two directories and it must REFUSE. The test measures which kind of volume
   * the scratch directory is on and asserts the corresponding outcome, so it is
   * a real assertion on all three CI lanes rather than a `process.platform`
   * branch that asserts our guess about the platform.
   */
  it("follows the VOLUME's case behaviour, because identity comes from the filesystem", async () => {
    const exact = path.join(scratch, "CaseRoot");
    await mkdir(exact);
    const lowered = path.join(scratch, "caseroot");

    let volumeIsCaseInsensitive: boolean;
    try {
      const [a, b] = await Promise.all([stat(exact), stat(lowered)]);
      volumeIsCaseInsensitive = a.dev === b.dev && a.ino === b.ino;
    } catch {
      volumeIsCaseInsensitive = false;
    }

    const outcome = await assertProjectsRootUnchanged(
      scriptedClient([{ projects_root: lowered }]),
      exact,
      CORR,
    );
    if (volumeIsCaseInsensitive) {
      expect(outcome.ok, "a case-insensitive volume must not report root_changed").toBe(true);
    } else {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      // On a case-sensitive volume the lower-cased spelling names nothing at
      // all, so the honest refusal is "could not be verified", not "you changed
      // the root". Two real, different directories are covered above.
      expect(outcome.error.code).toBe("projects.root_unverifiable");
    }
  });
});

/**
 * The roots below are RESOLVED, because the only caller (`createProject`)
 * hands `resolveProjectDirectory` the value `resolveProjectsRoot` returned -
 * a realpath, already absolute in this platform's own spelling. A bare POSIX
 * literal is not such a value on win32 (`path.resolve` would add the drive the
 * literal lacks), so testing with one would exercise a shape production never
 * produces and would refuse everything on that lane for a reason that has
 * nothing to do with containment.
 */
const ROOT = path.resolve("/roots/projects");
const UPPER_ROOT = path.resolve("/roots/PROJECTS");

describe("resolveProjectDirectory", () => {
  it("resolves exactly one segment below the root", () => {
    expect(resolveProjectDirectory(ROOT, "my-app")).toBe(
      path.resolve(ROOT, "my-app"),
    );
  });

  it("refuses anything that escapes or nests below the root (defence in depth)", () => {
    // Unreachable through the slug alphabet - this guard exists so a future
    // caller cannot widen the input without tripping it.
    for (const slug of ["..", "../escape", "a/b", "", ".", "/absolute"]) {
      expect(
        resolveProjectDirectory(ROOT, slug),
        `slug ${JSON.stringify(slug)} was accepted`,
      ).toBeNull();
    }
  });

  /**
   * THE CONTAINMENT DECISION, PINNED (B3).
   *
   * Containment is compared byte-exactly on every platform, and this test
   * exists so that a future "fix" for a case-insensitive filesystem has to
   * delete an explicit decision rather than quietly widen a `startsWith`.
   *
   * The direction of the safe failure is the whole argument: refusing a
   * differently-cased spelling of the user's own root costs a refusal the user
   * can act on, while ACCEPTING one on a case-sensitive volume (ext4, a
   * case-sensitive APFS volume, a case-sensitive mount on Windows) accepts a
   * path that is genuinely a different directory. The platform the comparison
   * RUNS on does not tell you the case behaviour of the volume the path is ON,
   * which is why there is no `process.platform` branch to test either.
   */
  it("compares case-sensitively on every platform (a safe refusal beats a false match)", () => {
    expect(resolveProjectDirectory(UPPER_ROOT, "my-app")).toBe(
      path.resolve(UPPER_ROOT, "my-app"),
    );
    // The slug's own case is not folded either: the slug alphabet is already
    // lowercase, so an upper-case slug reaching here came from somewhere new.
    expect(resolveProjectDirectory(ROOT, "My-App")).toBe(
      path.resolve(ROOT, "My-App"),
    );
  });
});

/**
 * Resolved for the same reason as `ROOT` above: the callers in
 * `database/projects/{create,read}.ts` pass a realpath-ed root and `homedir()`,
 * both absolute in this platform's own spelling.
 */
const HOME = path.resolve("/home/someone");

describe("formatProjectDisplayPath", () => {
  it("collapses the home directory to ~ so a screenshot carries no identity path", () => {
    expect(
      formatProjectDisplayPath(path.join(HOME, "Vex", "projects"), "my-app", HOME),
    ).toBe(path.join("~", "Vex", "projects", "my-app"));
  });

  /**
   * B3 CONTRACT CHANGE, deliberate: this used to return the absolute path.
   *
   * The JSDoc promises the label carries no identity-revealing absolute path,
   * and the old behaviour kept that promise only while the home prefix matched
   * byte-for-byte. On win32 and darwin one home directory has many spellings
   * (`C:\Users\Ada` / `c:\users\ada`), so a config written with the other
   * spelling silently put the username back into the label. The promise is now
   * unconditional: either the prefix is PROVEN and collapses to `~`, or the
   * root is named abstractly.
   */
  it("names an unprovable root abstractly rather than printing an absolute path", () => {
    expect(
      formatProjectDisplayPath(path.resolve("/srv/workspaces"), "my-app", HOME),
    ).toBe(path.join("<projects root>", "my-app"));
  });

  it("never leaks a home directory whose spelling differs from the configured root", () => {
    // The exact win32/darwin shape, expressed in a platform-independent way:
    // the root is under the home directory, spelled differently. Vex cannot
    // PROVE the prefix, so it must not print the path.
    const rendered = formatProjectDisplayPath(
      path.resolve("/home/Someone", "Vex", "projects"),
      "my-app",
      HOME,
    );
    expect(rendered).not.toContain("Someone");
    expect(rendered).not.toContain("someone");
    expect(rendered).toBe(path.join("<projects root>", "my-app"));
  });
});
