/**
 * The lease-release CHOKEPOINT guard.
 *
 * The end-of-turn approval resume hook is the difference between an approval
 * resolved under a busy lease resuming in under 500 ms and it waiting out the
 * 2s/5s/15s ladder or the 5-minute reconciler. It used to be a line every
 * lease-releasing runner had to remember; half of them did not, and the misses
 * were found one at a time by review.
 *
 * `releaseLeaseAndEmitControlState` now owns the hook, so the property that has
 * to hold for the whole class is narrow enough to test: NOTHING releases a
 * runner lease except that helper. This file is the static half of that
 * guard — `release-and-emit-resume-hook.test.ts` is the behavioural half.
 *
 * If this test fails you have added a lease release that bypasses the
 * chokepoint, and the session it belongs to will not get the fast resume.
 * Route it through `releaseLeaseAndEmitControlState` rather than relaxing the
 * assertion.
 */

import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

/**
 * The two ways to let go of a runner lease: calling `release()` on a
 * `LeaseHandle`, or calling the repo's `releaseLease` directly.
 */
const HANDLE_RELEASE = /\b(?:handle|lease|leaseHandle|sessionLease|runLease)\.release\s*\(/i;
const REPO_RELEASE = /\breleaseLease\s*\(/;

/**
 * Files allowed to release a lease.
 *   - `release-and-emit.ts` IS the chokepoint.
 *   - `lease-handle.ts` implements `LeaseHandle.release` and is what the
 *     chokepoint calls.
 *   - `runner-leases.ts` is the repo that owns the DELETE.
 */
const ALLOWED = new Set([
  "vex-agent/engine/runtime/release-and-emit.ts",
  "vex-agent/engine/runtime/lease-handle.ts",
  "vex-agent/db/repos/runner-leases.ts",
]);

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      found.push(...(await collectSourceFiles(full)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

describe("runner lease release chokepoint", () => {
  it("is the only place a runner lease is released", async () => {
    const files = await collectSourceFiles(path.join(SRC_ROOT, "vex-agent"));
    const offenders: string[] = [];

    for (const file of files) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      if (ALLOWED.has(rel)) continue;
      const source = await readFile(file, "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        // `pg` pool clients also expose `.release()`; only lease-shaped
        // receivers and the lease repo function are in scope here.
        if (HANDLE_RELEASE.test(line) || REPO_RELEASE.test(line)) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The release must not be reachable only through a fallible runtime load.
   *
   * Eight `finally` blocks used to do `const { releaseLeaseAndEmitControlState }
   * = await import("...release-and-emit.js")` BEFORE releasing. A rejected
   * import — or a rejected module evaluation — meant `handle.release()` was
   * never reached at all, and the lease sat stranded until its TTL with its
   * heartbeat still renewing, blocking the session for minutes.
   *
   * The import was vestigial: `release-and-emit.ts` statically imports only the
   * lease/mission-run repos, the control bus and `lease-handle.ts`, none of
   * which reach back into `engine/core/`, and four runners already imported it
   * statically. So every call site now binds it statically and the failure mode
   * is gone by construction rather than by a fallback.
   *
   * The boundary that IS real is untouched: `release-and-emit.ts` still reaches
   * `core/approval-runtime/` dynamically, so `runtime/` keeps no static edge
   * into `core/` — and it does so strictly AFTER the release, so a failure
   * there costs the fast resume and never the lease.
   */
  it("is never loaded by a dynamic import at a call site", async () => {
    const files = await collectSourceFiles(path.join(SRC_ROOT, "vex-agent"));
    const offenders: string[] = [];

    for (const file of files) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      const source = await readFile(file, "utf8");
      // The specifier may sit on its own line, so match the whole file.
      if (/await import\(\s*\n?\s*"[^"]*release-and-emit\.js"/.test(source)) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("fires the end-of-turn resume hook from the chokepoint", async () => {
    const source = await readFile(
      path.join(SRC_ROOT, "vex-agent/engine/runtime/release-and-emit.ts"),
      "utf8",
    );
    expect(source).toContain("dispatchPendingApprovalResumesAfterRelease");
  });
});
