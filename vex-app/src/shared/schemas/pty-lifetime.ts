import { z } from "zod";

export const PTY_HOST_MARKER = "--vex-pty-host";
export const PTY_PARENT_ARG = "--vex-parent-pid=";
export const ptyParentPidSchema = z.coerce.number().int().positive().safe();
export function ptyParentPid(argv: readonly string[]): number | null {
  if (!argv.includes(PTY_HOST_MARKER)) return null;
  const args = argv.filter((arg) => arg.startsWith(PTY_PARENT_ARG));
  if (args.length !== 1) return null;
  const parsed = ptyParentPidSchema.safeParse(args[0]?.replace(PTY_PARENT_ARG, ""));
  return parsed.success ? parsed.data : null;
}
