/**
 * C2b — the image BYTE-resolver seam (agent-runtime side).
 *
 * SHARED, not Trench's. It was written for Trench and lived under `trench/`
 * until pools.fun launches needed the same bytes; the locker itself is one
 * locker and the desktop app registers exactly ONE implementation of this seam,
 * so a second launchpad reaching into the first one's internals for it was a
 * cross-feature import with no owner. Moved here MOVE-ONLY: same file name, same
 * public exports, same behaviour.
 *
 * A launch requires an image, but the locker BYTES live only in the
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
 *
 * ── TWO VARIANTS, TWO SEAMS (owner decision 2026-08-19) ────────────────────
 *
 * One locker now feeds two launchpads with different image economics, so there
 * are two independent registration points and the caller picks by lane:
 *
 *  - {@link resolveLaunchImageBytes} — the ORIGINAL bytes the user picked,
 *    stored verbatim. This is what pools.fun uploads to its own backend, where
 *    the image is hosted off-chain and no size limit of ours applies. Its
 *    behaviour is unchanged from before the split.
 *  - {@link resolveLaunchImageOnchainBytes} — the DERIVED Trench copy, under the
 *    20 KB on-chain budget, because Trench writes the bytes inline in `create()`
 *    calldata and every one of them is gas on an irreversible transaction.
 *    Answers `no_onchain_variant` when the ladder could not bring the image
 *    under that budget: the image is real and pools-usable, and saying so is
 *    what lets the Trench handler refuse with the actual reason rather than
 *    reporting a picture the user can see as missing.
 *
 * Both are fail-closed the same way, and the throw names WHICH seam is missing
 * so a half-mounted app cannot be misread as a locker problem.
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

/**
 * How the on-chain variant resolves.
 *
 * `null` from the resolver still means "no such image". `no_onchain_variant` is
 * the genuinely different answer: the image EXISTS, the user can see it, and it
 * is launchable on pools.fun — it simply has no copy small enough for Trench's
 * calldata. Collapsing the two into `null` would make the Trench handler tell
 * the user their picture is missing, which is both false and unactionable.
 */
export type LaunchImageOnchainResolution =
  | ({ readonly kind: "resolved" } & LaunchImageBytes)
  | {
      readonly kind: "no_onchain_variant";
      /** The original's size, so the refusal can state what could not be shrunk. */
      readonly originalByteLength: number;
    };

/** Resolve a locker image's TRENCH on-chain copy. `null` means "no such image". */
export type LaunchImageOnchainByteResolver = (
  imageId: string,
) => Promise<LaunchImageOnchainResolution | null>;

/** Which seam a caller asked for, so an unmounted one can name itself. */
export type LaunchImageResolverVariant = "original" | "onchain";

const RESOLVER_NAME: Readonly<Record<LaunchImageResolverVariant, string>> = {
  original: "LaunchImageByteResolver",
  onchain: "LaunchImageOnchainByteResolver",
};

/** Thrown when a launch needs image bytes but no resolver has been registered. */
export class LaunchImageResolverUnavailableError extends Error {
  override readonly name = "LaunchImageResolverUnavailableError";
  constructor(readonly variant: LaunchImageResolverVariant = "original") {
    super(
      `Launch image bytes are unavailable: no ${RESOLVER_NAME[variant]} is registered. ` +
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

// ── The Trench on-chain variant seam ───────────────────────────────────────
//
// Deliberately a SECOND registration slot rather than an argument on the first.
// The two lanes are mounted by the same desktop bootstrap but consumed by
// different handlers, and a single slot with a mode flag would let a test (or a
// half-finished bootstrap) satisfy the Trench path with the pools implementation
// and commit multi-megabyte calldata.

let currentOnchainResolver: LaunchImageOnchainByteResolver | null = null;

/** Install the main-process implementation. Idempotent — last writer wins. */
export function registerLaunchImageOnchainByteResolver(
  resolver: LaunchImageOnchainByteResolver,
): void {
  currentOnchainResolver = resolver;
}

/** Unmount the resolver. Used on app teardown and by tests in `afterEach`. */
export function resetLaunchImageOnchainByteResolver(): void {
  currentOnchainResolver = null;
}

/** True when an implementation is mounted. Lets a caller refuse early. */
export function hasLaunchImageOnchainByteResolver(): boolean {
  return currentOnchainResolver !== null;
}

/**
 * Resolve the Trench on-chain copy through the registered implementation.
 *
 * @throws {LaunchImageResolverUnavailableError} when nothing is registered.
 */
export async function resolveLaunchImageOnchainBytes(
  imageId: string,
): Promise<LaunchImageOnchainResolution | null> {
  if (currentOnchainResolver === null) {
    throw new LaunchImageResolverUnavailableError("onchain");
  }
  return currentOnchainResolver(imageId);
}
