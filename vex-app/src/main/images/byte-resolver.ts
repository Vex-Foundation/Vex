/**
 * C2b — the MAIN-SIDE implementation of the launch-image byte resolver.
 *
 * Lane F owns the interface and the registration point in the agent runtime
 * (`@vex-agent/tools/protocols/shared/launch-image-byte-resolver.js`); this
 * file is what main registers into it at startup. The direction is the legal
 * one: main imports the agent runtime, never the reverse (`check:boundaries`
 * forbids `@vex-agent` in renderer/shared, not in main), which is exactly why
 * the seam exists — the launch handler runs in `src/vex-agent`, but the bytes
 * only ever exist here.
 *
 * WHAT THIS RESOLVER GUARANTEES, and what it refuses to:
 *  - it returns bytes together with the digest RECORDED IN THE METADATA ROW,
 *    so the execute leg can compare that digest against the one bound in the
 *    C0 authorization record before signing;
 *  - it re-derives the digest from the bytes it actually read and returns
 *    NOTHING if the two disagree. An image swapped on disk between
 *    authorization and execution therefore cannot be signed over — it looks
 *    to the caller exactly like a missing image, which is a refusal it
 *    already handles;
 *  - `null` means "no such image", a normal answer. It never means "the store
 *    is broken": a genuine I/O failure propagates, because a launch must not
 *    interpret a broken locker as an absent picture and continue.
 *
 * There is deliberately no fallback and no empty-image default anywhere in
 * this path. A token created with no image is permanent and irreversible.
 *
 * TWO LANES since the per-lane image decision (2026-08-19):
 * {@link resolveLockerImageBytesForLaunch} hands out the stored ORIGINAL, which
 * pools.fun uploads to its off-chain host, and
 * {@link resolveLockerImageOnchainBytesForLaunch} hands out the derived copy
 * under Trench's on-chain budget. For every image stored before that decision
 * the two return the same bytes, because the original IS its own copy.
 */

import type {
  LaunchImageByteResolver,
  LaunchImageBytes,
  LaunchImageOnchainByteResolver,
  LaunchImageOnchainResolution,
} from "@vex-agent/tools/protocols/shared/launch-image-byte-resolver.js";
import {
  registerLaunchImageByteResolver,
  registerLaunchImageOnchainByteResolver,
  resetLaunchImageByteResolver,
  resetLaunchImageOnchainByteResolver,
} from "@vex-agent/tools/protocols/shared/launch-image-byte-resolver.js";
import { log } from "../logger/index.js";
import { digestOf, readImageBytes } from "./byte-store.js";
import { getLockerImage, readLockerImageOnchainBytes } from "./locker.js";

export const resolveLockerImageBytesForLaunch: LaunchImageByteResolver = async (
  imageId: string,
): Promise<LaunchImageBytes | null> => {
  const image = await getLockerImage(imageId);
  if (image === null) return null;

  const bytes = await readImageBytes(imageId);
  if (bytes === null) return null;

  const actual = digestOf(bytes);
  if (actual !== image.digest) {
    // Structural log only — never the digests themselves, which are content
    // fingerprints of user material.
    log.error(
      "[images] stored bytes do not match the recorded digest; refusing to hand them to a launch",
    );
    return null;
  }
  if (bytes.byteLength !== image.byteLength) {
    log.error("[images] stored byte length disagrees with the recorded metadata; refusing");
    return null;
  }
  return { bytes, digest: image.digest };
};

/**
 * The TRENCH lane: the derived on-chain copy, or a named "there isn't one".
 *
 * The verification lives in `locker.readLockerImageOnchainBytes` so that the
 * thumbnail and the signing path cannot disagree about which file is the copy
 * or whether it is intact. What this adds is the DISTINCTION the Trench handler
 * needs: an image that exists but has no copy is not a missing image, and
 * telling the user their picture is gone when they can see it in the grid is
 * both false and unactionable.
 *
 * The `getLockerImage` read is what separates the two: it answers whether the
 * row exists at all, after `readLockerImageOnchainBytes` has already said the
 * copy is unusable.
 */
export const resolveLockerImageOnchainBytesForLaunch: LaunchImageOnchainByteResolver = async (
  imageId: string,
): Promise<LaunchImageOnchainResolution | null> => {
  const resolved = await readLockerImageOnchainBytes(imageId);
  if (resolved !== null) {
    return { kind: "resolved", bytes: resolved.bytes, digest: resolved.digest };
  }

  const image = await getLockerImage(imageId);
  if (image === null) return null;
  if (image.onchainByteLength === null) {
    return { kind: "no_onchain_variant", originalByteLength: image.byteLength };
  }
  // The row claims a copy but it could not be read or did not verify. That is
  // the swapped/absent-bytes case, and it must look to the launch exactly like
  // a missing image — the refusal it already handles — not like a size problem.
  return null;
};

/**
 * Mount BOTH resolvers into the agent runtime. Called once from main's agent
 * bootstrap, mirroring how `setBugReportSink` mounts its production sink.
 * Returns the teardown so app shutdown (and tests) can unmount them.
 *
 * One call mounts both on purpose: a bootstrap that mounted only one would give
 * a launchpad a fail-closed refusal that reads like a locker outage, and the
 * two lanes are always available or unavailable together.
 */
export function mountLaunchImageByteResolver(): () => void {
  registerLaunchImageByteResolver(resolveLockerImageBytesForLaunch);
  registerLaunchImageOnchainByteResolver(resolveLockerImageOnchainBytesForLaunch);
  return () => {
    resetLaunchImageByteResolver();
    resetLaunchImageOnchainByteResolver();
  };
}
