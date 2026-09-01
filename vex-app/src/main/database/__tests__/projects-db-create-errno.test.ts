/**
 * WHAT `createProject` SAYS WHEN THE DIRECTORY CLAIM FAILS (B3).
 *
 * Every non-EEXIST `mkdir` failure used to become `projects.root_unavailable`,
 * whose message asks the user to check that the location exists, is a folder,
 * and is writable. For a full disk that is wrong, for a permission problem it
 * buries the one fact that matters, and for a root path this system cannot
 * express it sends them to look at a folder that is fine. This suite is the
 * table that pins each errno to the refusal that names its actual remedy.
 *
 * WHAT IS FAKED AND WHY. `mkdir` alone, because the errnos worth distinguishing
 * cannot all be staged on one machine: ENOSPC needs a full volume, EINVAL and
 * ENAMETOOLONG need Windows, and EACCES needs a non-root user on a POSIX box.
 * The subject here is OUR mapping decision, not the operating system's errno
 * behaviour, and a mapping is exactly the kind of pure decision a table test
 * owns. The one row that CAN be staged for real (EACCES on a read-only parent)
 * is also exercised against the real filesystem at the bottom, wherever the
 * platform actually enforces it.
 *
 * The sibling suite `projects-db-create.test.ts` keeps a real filesystem and
 * covers the claim, the EEXIST refusal and the compensation.
 */

import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectCreateInput } from "@shared/schemas/projects.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({}) as { projectsRoot?: string }),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getWalletById: vi.fn(),
  getClient: vi.fn<() => Client>(),
  mkdir: vi.fn(),
}));

vi.mock("@config/store.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));
vi.mock("@vex-lib/wallet.js", () => ({ getWalletById: mocks.getWalletById }));
vi.mock("../sessions/connection.js", async () => {
  const actual = await vi.importActual<typeof import("../sessions/connection.js")>(
    "../sessions/connection.js",
  );
  return {
    ...actual,
    withClient: async (fn: (c: Client) => Promise<unknown>) => fn(mocks.getClient()),
  };
});
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, mkdir: mocks.mkdir };
});

const { createProject } = await import("../projects/create.js");
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

const CORR = "corr-create-errno";
const INPUT: ProjectCreateInput = {
  name: "My App",
  permission: "restricted",
  agents: ["claude-code"],
  wallets: { evm: null, solana: null },
};

let root: string;
let query: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  // The projects root itself is created through the same mocked `mkdir`, so it
  // passes through to the real one by default; only the project directory's
  // claim is scripted per test.
  mocks.mkdir.mockImplementation(actualFs.mkdir);
  root = await realpath(await mkdtemp(path.join(tmpdir(), "vex-create-errno-")));
  mocks.loadConfig.mockReturnValue({ projectsRoot: root });
  mocks.getWalletById.mockReturnValue(null);
  query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  mocks.getClient.mockReturnValue(Object.assign(new Client(), { query }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Fail only the exclusive claim of `<root>/<slug>`; let the root itself be real. */
function failClaimWith(code: string): void {
  mocks.mkdir.mockImplementation(async (target: string, options?: unknown) => {
    if (path.resolve(target) === path.join(root, "my-app")) {
      throw Object.assign(new Error(`mkdir ${code}`), { code });
    }
    return actualFs.mkdir(target, options as Parameters<typeof actualFs.mkdir>[1]);
  });
}

interface Row {
  readonly errno: string;
  readonly code: string;
  readonly retryable: boolean;
}

const ROWS: readonly Row[] = [
  { errno: "EACCES", code: "projects.root_permission_denied", retryable: false },
  { errno: "EPERM", code: "projects.root_permission_denied", retryable: false },
  { errno: "ENOSPC", code: "projects.root_out_of_space", retryable: false },
  { errno: "EDQUOT", code: "projects.root_out_of_space", retryable: false },
  { errno: "EINVAL", code: "projects.root_path_invalid", retryable: false },
  { errno: "ENOTDIR", code: "projects.root_path_invalid", retryable: false },
  { errno: "ENAMETOOLONG", code: "projects.root_path_invalid", retryable: false },
  // The unmapped fallback keeps the error it always had; what changed is that
  // the errno is now in the log rather than nowhere.
  { errno: "ENOENT", code: "projects.root_unavailable", retryable: true },
  { errno: "EWHATEVER", code: "projects.root_unavailable", retryable: true },
];

describe("createProject - directory claim errno mapping", () => {
  it.each(ROWS)("maps $errno to $code", async (row) => {
    failClaimWith(row.errno);

    const outcome = await createProject(INPUT, { evm: null, solana: null }, CORR);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe(row.code);
    expect(outcome.error.domain).toBe("projects");
    expect(outcome.error.retryable).toBe(row.retryable);
    expect(outcome.error.userActionable).toBe(true);
    expect(outcome.error.redacted).toBe(true);
    // No absolute path travels to the renderer, whatever the errno was.
    expect(JSON.stringify(outcome.error)).not.toContain(root);
    // The claim failed before the transaction opened: nothing was written. The
    // only statement this path may have run is the tombstone check that guards
    // the claim itself.
    expect(query.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("BEGIN");
  });

  it("names the errno in the log so an unmapped one arrives identifiable", async () => {
    failClaimWith("EWHATEVER");
    await createProject(INPUT, { evm: null, solana: null }, CORR);

    const warned = mocks.log.warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(warned).toContain("errno=EWHATEVER");
  });

  it("refuses a name that derives a Windows device name, on every platform", async () => {
    // No filesystem call happens at all: the refusal is at slug derivation, so
    // a project that could not be opened on Windows is never created anywhere.
    const outcome = await createProject(
      { ...INPUT, name: "con" },
      { evm: null, solana: null },
      CORR,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.name_reserved");
    expect(outcome.error.message).toMatch(/Windows/);
    expect(mocks.mkdir).not.toHaveBeenCalled();
  });

  it("still refuses an unusable name with the validation error it always had", async () => {
    const outcome = await createProject(
      { ...INPUT, name: "!!! ???" },
      { evm: null, solana: null },
      CORR,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("validation.invalid_input");
  });
});

/**
 * THE ONE ROW A REAL FILESYSTEM CAN STAGE, where the platform enforces it.
 *
 * The permission is measured rather than assumed: the test makes the root
 * read-only and PROBES whether this platform actually denies the write (it does
 * not when the process is root, and `chmod` has no such effect on Windows). The
 * probe result decides which assertion runs, so the test is honest on all three
 * lanes instead of failing on the ones where the premise does not hold.
 */
describe("createProject - real EACCES where the platform enforces it", () => {
  it("reports projects.root_permission_denied for a genuinely unwritable root", async () => {
    mocks.mkdir.mockImplementation(actualFs.mkdir);
    await chmod(root, 0o500);

    let enforced = true;
    try {
      await actualFs.mkdir(path.join(root, "probe"));
      enforced = false;
      await actualFs.rm(path.join(root, "probe"), { recursive: true, force: true });
    } catch {
      enforced = true;
    }

    const outcome = await createProject(INPUT, { evm: null, solana: null }, CORR);
    await chmod(root, 0o700);

    if (!enforced) {
      // Windows, or a run as root. The premise does not hold here and the
      // mapping table above is what proves the behaviour on this lane.
      expect(outcome.ok).toBe(true);
      return;
    }
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.root_permission_denied");
  });
});
