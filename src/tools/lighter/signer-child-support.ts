import { ErrorCodes, VexError } from "../../errors.js";

/**
 * Pieces shared by the two signer helper runners (the one-shot runner in
 * `signer-binary-adapter.ts` and the resident runner in
 * `signer-resident-runner.ts`), so both produce the same error shapes and the
 * same settlement evidence. Moved here unchanged from the adapter.
 */

/**
 * How the signer child ended, as far as this process can prove it.
 *
 * `"exited"` means the child's `close` event was observed: the process is gone,
 * its pipes are closed, and no further signing work can be in flight. That is
 * the ONLY state in which a nonce reservation may be released, because it is
 * the only one in which "nothing was signed and submitted behind our back" is a
 * fact rather than a hope.
 *
 * `"unknown"` means the adapter gave up waiting: it sent SIGKILL and the child
 * still had not closed within the drain grace. The signing outcome is
 * indeterminate and every caller must treat it conservatively - no re-sign, no
 * resubmit, no reservation release, reconcile instead.
 *
 * The resident runner reports `"exited"` for a request ONLY on the same
 * strength of proof: either the helper answered that request id (a serial
 * helper does no work it was not asked for, so its answer proves it is done
 * with the request), or the helper was killed and its `close` was observed.
 */
export type LighterSignerChildState = "exited" | "unknown";

export const MAX_STDOUT_BYTES = 256 * 1024;

/**
 * How long the adapter waits for a killed child to actually close before it
 * declares the outcome unknown. Long enough for a normal SIGKILL teardown on a
 * loaded machine, short enough that a wedged helper cannot hold a signing path
 * open indefinitely.
 */
export const KILL_DRAIN_GRACE_MS = 5_000;

export function withChildState<E extends object>(error: E, state: LighterSignerChildState): E {
  Object.defineProperty(error, "lighterSignerChildState", {
    value: state,
    enumerable: true,
    writable: false,
  });
  return error;
}

/**
 * The environment the helper is given.
 *
 * NOT `process.env`. The privileged Vex process holds vault material, provider
 * credentials and RPC endpoints in its environment, and the signer helper needs
 * none of it: its entire input arrives as JSON on stdin. Every variable
 * withheld here is one that cannot leak into a crash dump, a child of the
 * helper, or a helper that is not the one we think it is.
 *
 * Windows keeps `SystemRoot` and `windir` because the loader and the platform
 * crypto libraries resolve system DLLs through them; a Windows process started
 * with a truly empty environment can fail before `main`. Nothing else is
 * inherited on any platform, PATH included: the helper is launched by absolute
 * path and never resolves a program name.
 */
export function signerChildEnvironment(platform: NodeJS.Platform): NodeJS.ProcessEnv {
  if (platform !== "win32") return {};
  const inherited: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "windir"]) {
    const value = process.env[name];
    if (value !== undefined) inherited[name] = value;
  }
  return inherited;
}

/** A pipe that is already gone cannot be destroyed; abandoning must not throw. */
export function destroyQuietly(pipe: { destroy(): unknown } | null): void {
  if (pipe === null) return;
  try {
    pipe.destroy();
  } catch {
    // The handle is already closed; nothing is left to release.
  }
}

export function parseHelperJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw signerUnavailable("Lighter signer helper returned invalid output.");
  }
}

export function signerProcessFailed(raw: unknown): VexError {
  const code = isRecord(raw) && typeof raw.errorCode === "string" ? raw.errorCode : "unknown";
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `Lighter signer helper failed (${code}).`,
    "Retry after the Lighter trading credential, nonce, and signer helper are checked.",
  );
}

export function signerUnavailable(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Install or build the packaged Lighter signer helper before live order submission.",
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
