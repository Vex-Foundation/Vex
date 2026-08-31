/**
 * The pty host's boot configuration, and its DELETION.
 *
 * Cloned from VS Code's `electronPtyHostStarter` / `ptyHostMain` pair: main
 * passes configuration as environment variables on the `utilityProcess.fork`
 * options, and the child parses them and then DELETES them from `process.env`
 * before anything else runs.
 *
 * The deletion is the load-bearing half. Every terminal this host spawns
 * inherits a base environment captured from `process.env`, so a variable left
 * behind here would be exported into the user's shell - and from there into
 * every command they run, every subprocess, and every `env` they paste into a
 * bug report. Vex's own configuration is not the shell's business.
 *
 * The deny-list in `process-env.ts` would strip `VEX_*` anyway. This is the
 * second lock on the same door, and it is deliberate: the deny-list protects
 * against variables we forgot to name here, and this deletion protects against
 * a future preserve-list entry that accidentally matches one of ours.
 */

import path from "node:path";
import {
  PTY_HOST_CONFIG_KEYS,
  TERMINAL_DETACH_GRACE_MS,
  TERMINAL_DETACH_SHORT_GRACE_MS,
  TERMINAL_SCROLLBACK_ROWS,
} from "@shared/schemas/terminal.js";

export interface PtyHostConfig {
  /** `<userData>/studio/terminal-snapshots`. Absolute, created 0700 on demand. */
  readonly snapshotDir: string;
  readonly graceMs: number;
  readonly shortGraceMs: number;
  readonly scrollbackRows: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Read the configuration, then remove every key it read.
 *
 * A missing or malformed value falls back to the shared contract's constant
 * rather than failing the process: the host's job is to serve terminals, and a
 * grace time that arrived as "abc" is a main-side bug that must not cost the
 * user every terminal they had open.
 *
 * A relative or empty `VEX_PTY_SNAPSHOT_DIR` is refused rather than defaulted,
 * because guessing a directory to write files into is the one failure here
 * that would put user data somewhere nobody looks.
 */
export function readAndClearPtyHostConfig(
  env: NodeJS.ProcessEnv = process.env,
): PtyHostConfig | null {
  const rawDir = env.VEX_PTY_SNAPSHOT_DIR;
  const config =
    rawDir !== undefined && rawDir.length > 0 && path.isAbsolute(rawDir)
      ? {
          snapshotDir: rawDir,
          graceMs: positiveInt(env.VEX_PTY_GRACE_MS, TERMINAL_DETACH_GRACE_MS),
          shortGraceMs: positiveInt(
            env.VEX_PTY_SHORT_GRACE_MS,
            TERMINAL_DETACH_SHORT_GRACE_MS,
          ),
          scrollbackRows: positiveInt(
            env.VEX_PTY_SCROLLBACK,
            TERMINAL_SCROLLBACK_ROWS,
          ),
        }
      : null;

  // Deleted on EVERY path, including the refusal path: a host that could not
  // parse its configuration must still not export it into a shell.
  for (const key of PTY_HOST_CONFIG_KEYS) {
    delete env[key];
  }

  return config;
}
