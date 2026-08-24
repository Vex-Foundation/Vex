/**
 * Making the Vex Studio endpoint BINDABLE, and refusing when it is not.
 *
 * Split from `mcp-host.ts` because it has its own reason to change: everything
 * here is filesystem trust (ownership, mode, symlinks, stale entries), while
 * the host owns connection lifecycle. `endpoint.ts` decides WHERE; this module
 * decides whether that place is safe to bind right now.
 *
 * ## Stale removal is NEVER a blind unlink
 *
 * The four checks below exist because each of them is a way an attacker or an
 * accident turns "clean up a leftover socket" into "delete or hijack something
 * else": a parent directory somebody else can write, a symlink pointing at a
 * real file, a regular file that is not a socket at all, and a LIVE endpoint
 * another Vex is already serving. Stealing that last one would leave the other
 * Vex's bridges talking to nothing, so it refuses startup instead.
 *
 * ## Windows keeps only the fourth check
 *
 * A named pipe is not a filesystem entry: there is no parent directory to
 * verify, no symlink to refuse, and NOTHING TO UNLINK, because the name exists
 * only while a server holds it. `refuseLiveEndpoint` is that path.
 */

import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { connect } from "node:net";

import type { EndpointDirectoryFacts, StudioEndpointPlan } from "./endpoint.js";

/** How long a connect probe waits before calling an endpoint LIVE. */
const LIVENESS_PROBE_MS = 1_000;

/**
 * The real filesystem probe the planner needs. `null` when absent.
 *
 * `lstat`, never `stat`: a symlinked parent directory must be seen as a
 * symlink, which is not a directory, so the planner refuses it by name rather
 * than validating the ownership and mode of whatever it points at.
 */
export function nodeDirectoryProbe(dir: string): EndpointDirectoryFacts | null {
  try {
    const stats = lstatSync(dir);
    return {
      isDirectory: stats.isDirectory(),
      uid: stats.uid,
      mode: stats.mode & 0o777,
    };
  } catch {
    return null;
  }
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

/**
 * The uid reader, injectable so the ownership refusal is testable.
 *
 * A test cannot `chown` a directory to another user without privileges, so the
 * only way to exercise "this directory belongs to somebody else" on a real
 * filesystem is to make the CURRENT uid the thing that differs. The default is
 * the real process uid; nothing in production passes anything else.
 */
export interface EndpointDirectoryDeps {
  readonly uid?: () => number;
}

/**
 * Create (when the host owns it) and VERIFY the endpoint's parent directory.
 *
 * Returns `null` on success, or the sentence that refuses startup.
 *
 * ## Nothing is chmod-ed before ownership is PROVEN
 *
 * The previous version created the directory with `recursive: true` and then
 * chmod-ed it unconditionally. Both halves were exploitable by any other local
 * user who could win the race to create `/tmp/vex-studio-<uid>` first: a
 * recursive mkdir succeeds silently when the path already exists, `statSync`
 * FOLLOWS a symlink, and the chmod then landed on whatever the symlink pointed
 * at - an attacker-chosen file, made 0700 by Vex.
 *
 * So the creation is EXCLUSIVE and non-recursive (the parent is the system
 * tmpdir, which exists), and the only pre-existing entry Vex will accept is
 * one `lstat` reports as a REAL DIRECTORY owned by this uid. A chmod happens
 * only after both of those are true, and only to tighten a directory Vex has
 * already proven is its own. Anything else refuses startup by name rather than
 * being repaired.
 */
export function prepareEndpointDirectory(
  plan: Extract<StudioEndpointPlan, { kind: "unix" }>,
  deps: EndpointDirectoryDeps = {},
): string | null {
  const uid = deps.uid ?? currentUid;
  if (plan.createParent) {
    const created = createOwnedDirectory(plan.parentDir, uid());
    if (created !== null) return created;
  }

  // The verification pass runs for EVERY plan, created here or not: an
  // override's parent and `XDG_RUNTIME_DIR` are owned by somebody else and
  // still have to satisfy the same three facts.
  let facts: ReturnType<typeof lstatSync>;
  try {
    facts = lstatSync(plan.parentDir);
  } catch {
    return `The Vex Studio MCP host's directory ${plan.parentDir} is missing.`;
  }
  if (facts.isSymbolicLink()) {
    return symlinkRefusal(plan.parentDir);
  }
  if (!facts.isDirectory()) {
    return `The Vex Studio MCP host's directory ${plan.parentDir} is not a directory.`;
  }
  if (facts.uid !== uid()) {
    return (
      `The Vex Studio MCP host's directory ${plan.parentDir} is owned by another `
      + "user. Vex will not put a privileged listener there."
    );
  }
  if ((facts.mode & 0o077) !== 0) {
    return (
      `The Vex Studio MCP host's directory ${plan.parentDir} is readable by other `
      + `users (mode 0${(facts.mode & 0o777).toString(8)}). Vex will not put a `
      + "privileged listener there."
    );
  }
  return null;
}

/** The sentence for an entry that is a symlink. It is never followed. */
function symlinkRefusal(dir: string): string {
  return (
    `The Vex Studio MCP host's directory ${dir} is a symbolic link. Vex will not `
    + "follow it, create a listener through it, or change its permissions: "
    + "another user can point a link at a file that is not theirs to give away. "
    + "Remove it, or set VEX_STUDIO_SOCKET to a directory Vex can verify."
  );
}

/**
 * Create the runtime directory EXCLUSIVELY, or prove the existing one is ours.
 *
 * `mkdirSync` without `recursive` fails with `EEXIST` rather than succeeding
 * silently, which is what makes "did Vex create this" answerable at all. On
 * `EEXIST` the entry is inspected with `lstat` - never `stat` - and only a real
 * directory this uid owns is tightened.
 */
function createOwnedDirectory(dir: string, uid: number): string | null {
  try {
    mkdirSync(dir, { mode: 0o700 });
    // Created by this process, so it is ours and the only thing that can have
    // loosened the mode is the umask.
    chmodSync(dir, 0o700);
    return null;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      return (
        "The Vex Studio MCP host could not create its runtime directory "
        + `${dir}: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
  }

  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(dir);
  } catch (cause) {
    return (
      `The Vex Studio MCP host could not inspect its runtime directory ${dir}: `
      + `${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
  if (entry.isSymbolicLink()) return symlinkRefusal(dir);
  if (!entry.isDirectory()) {
    return (
      `${dir} exists and is not a directory, so the Vex Studio MCP host will `
      + "not use it. Move that file, or set VEX_STUDIO_SOCKET to another path."
    );
  }
  if (entry.uid !== uid) {
    return (
      `The Vex Studio MCP host's directory ${dir} already exists and is owned by `
      + "another user. Vex will not put a privileged listener there, and will "
      + "not change permissions on a directory that is not its own."
    );
  }
  // PROVEN ours and PROVEN a real directory. Only now may the mode be tightened.
  if ((entry.mode & 0o077) !== 0) {
    try {
      chmodSync(dir, 0o700);
    } catch (cause) {
      return (
        `The Vex Studio MCP host could not tighten the permissions of ${dir}: `
        + `${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
  }
  return null;
}

/**
 * Is an existing socket file LIVE? Answered by a connect probe.
 *
 * A probe that connects and then goes silent is LIVE too: a server that
 * accepts and never answers is still a server holding the path.
 */
function probeEndpointLiveness(endpoint: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = connect(endpoint);
    let settled = false;
    const settle = (live: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.removeAllListeners();
      probe.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => {
      settle(true);
    }, LIVENESS_PROBE_MS);
    timer.unref?.();
    probe.once("connect", () => {
      settle(true);
    });
    probe.once("error", () => {
      settle(false);
    });
  });
}

/**
 * Is another Vex already serving this endpoint? The WHOLE stale check on
 * Windows, where the endpoint is a named pipe.
 *
 * A pipe has no filesystem entry to `lstat`, no parent directory whose
 * ownership and mode gate its removal, and NOTHING TO UNLINK: the name exists
 * only while a server holds it, and the operating system reclaims it when that
 * server closes. So the four checks `clearStaleEndpoint` performs collapse to
 * the one that still has meaning - a connect probe - and a pipe that answers
 * means another Vex owns it. Startup refuses rather than racing it, exactly as
 * it does for a live socket: stealing the name would leave the other Vex's
 * bridges talking to nothing.
 *
 * Returns `null` when the name is free, or the sentence that refuses startup.
 */
export async function refuseLiveEndpoint(endpoint: string): Promise<string | null> {
  if (!(await probeEndpointLiveness(endpoint))) return null;
  return (
    `${endpoint} is already served by a running Vex. Two Vex installations `
    + "cannot share one Studio endpoint; close the other one first."
  );
}

/**
 * Remove a socket file only when it is PROVEN dead. Returns `null` when the
 * path is now free to bind, or the sentence that refuses startup.
 *
 * `lstat`, never `stat`: a SYMLINK must be seen as a symlink rather than as
 * whatever it points at, and a symlink is not a socket, so it is refused and
 * left in place.
 */
export async function clearStaleEndpoint(endpoint: string): Promise<string | null> {
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(endpoint);
  } catch {
    return null;
  }
  if (!entry.isSocket()) {
    return (
      `${endpoint} exists and is not a socket, so the Vex Studio MCP host will `
      + "not remove it. Move that file, or set VEX_STUDIO_SOCKET to another path."
    );
  }
  if (await probeEndpointLiveness(endpoint)) {
    return (
      `${endpoint} is already served by a running Vex. Two Vex installations `
      + "cannot share one Studio endpoint; close the other one first."
    );
  }
  try {
    unlinkSync(endpoint);
    return null;
  } catch (cause) {
    return (
      `Could not remove the stale Vex Studio socket ${endpoint}: `
      + `${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
}
