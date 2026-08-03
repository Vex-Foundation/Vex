/**
 * `--check` / `--update` resolution, shared by the lexical CLI and the dense
 * vitest runner.
 *
 * `--check` is the DEFAULT and is read-only: no run may write a baseline
 * unless `--update` (or `VEX_EVAL_BASELINE_MODE=update`) was asked for
 * explicitly. The environment variable exists because the dense runner is a
 * vitest test — vitest owns its own argv, so the mode has to reach it out of
 * band.
 */

export const BASELINE_MODES = ["check", "update"] as const;
export type BaselineMode = (typeof BASELINE_MODES)[number];

export const BASELINE_MODE_ENV = "VEX_EVAL_BASELINE_MODE";

export function resolveBaselineMode(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): BaselineMode {
  const wantsCheck = argv.includes("--check");
  const wantsUpdate = argv.includes("--update");

  if (wantsCheck && wantsUpdate) {
    throw new Error(
      "--check and --update are mutually exclusive: pass exactly one (default is --check).",
    );
  }
  if (wantsUpdate) return "update";
  if (wantsCheck) return "check";

  const fromEnv = env[BASELINE_MODE_ENV];
  if (fromEnv === undefined || fromEnv === "") return "check";
  if (isBaselineMode(fromEnv)) return fromEnv;

  throw new Error(
    `${BASELINE_MODE_ENV}="${fromEnv}" is not a valid baseline mode — expected one of: ${BASELINE_MODES.join(", ")}.`,
  );
}

function isBaselineMode(value: string): value is BaselineMode {
  return (BASELINE_MODES as readonly string[]).includes(value);
}
