/**
 * C2b — the image BYTE-resolver seam (agent-runtime side).
 *
 * A Trench launch requires an image, but the locker BYTES live only in the
 * Electron main process under `userData`. The launch handler runs inside
 * `src/vex-agent`, and a reverse import from the canonical agent runtime into
 * `vex-app/main` is forbidden (`check:boundaries`). So the runtime declares the
 * interface and owns the registration point; MAIN registers its implementation
 * at startup (main → runtime is the legal direction), exactly the way
 * `bug-report-registry.ts` mounts its production sink from
 * `vex-app/src/main/agent/index.ts`.
 *
 * FAIL-CLOSED is the whole point. With no implementation registered there is no
 * fallback and no empty-image default: {@link resolveLaunchImageBytes} throws
 * {@link LaunchImageResolverUnavailableError} by name. A launch that cannot
 * prove which bytes it is about to commit to a real, irreversible on-chain
 * create must not proceed — a silently empty image would be accepted by the
 * Diamond and produce a permanently image-less token.
 *
 * The resolver returns the stored `digest` ALONGSIDE the bytes so the execute
 * leg can verify it against the digest bound in the authorization record (C0)
 * before signing; an image swapped between authorization and execution then
 * cannot slip through.
 */

/** Bytes of a locker image plus the digest recorded when they were stored. */
export interface LaunchImageBytes {
  readonly bytes: Uint8Array;
  /** sha256 of `bytes`, as recorded in the locker metadata row (C2). */
  readonly digest: string;
}

/**
 * Resolve a locker image's bytes by its opaque id.
 *
 * `null` means "no such image" — a normal, expected answer the caller refuses
 * on by name. It never means "the resolver is missing"; that is the throw.
 */
export type LaunchImageByteResolver = (
  imageId: string,
) => Promise<LaunchImageBytes | null>;

/** Thrown when a launch needs image bytes but no resolver has been registered. */
export class LaunchImageResolverUnavailableError extends Error {
  override readonly name = "LaunchImageResolverUnavailableError";
  constructor() {
    super(
      "Launch image bytes are unavailable: no LaunchImageByteResolver is registered. " +
        "The image store is mounted by the desktop app at startup; refusing to launch " +
        "rather than committing a token with no image.",
    );
  }
}

let currentResolver: LaunchImageByteResolver | null = null;

/** Install the main-process implementation. Idempotent — last writer wins. */
export function registerLaunchImageByteResolver(
  resolver: LaunchImageByteResolver,
): void {
  currentResolver = resolver;
}

/** Unmount the resolver. Used on app teardown and by tests in `afterEach`. */
export function resetLaunchImageByteResolver(): void {
  currentResolver = null;
}

/** True when an implementation is mounted. Lets a caller refuse early. */
export function hasLaunchImageByteResolver(): boolean {
  return currentResolver !== null;
}

/**
 * Resolve image bytes through the registered implementation.
 *
 * @throws {LaunchImageResolverUnavailableError} when nothing is registered.
 */
export async function resolveLaunchImageBytes(
  imageId: string,
): Promise<LaunchImageBytes | null> {
  if (currentResolver === null) throw new LaunchImageResolverUnavailableError();
  return currentResolver(imageId);
}
