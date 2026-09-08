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
 * ONE LANE. There were two: this one, handing out the stored ORIGINAL that
 * pools.fun uploads to its off-chain host, and a second that handed out the
 * derived small copy under Trench Express's ON-CHAIN budget, because a Trench
 * launch carried the image bytes inside the create transaction. Migration 108
 * retired that protocol, so nothing signs over image bytes any more and the
 * second resolver had no caller left. The derivative itself survives - it is
 * the locker grid's thumbnail (`locker.readLockerImageOnchainBytes`) - but it
 * is no longer on a signing path.
 */

import type {
  LaunchImageByteResolver,
  LaunchImageBytes,
} from "@vex-agent/tools/protocols/shared/launch-image-byte-resolver.js";
import {
  registerLaunchImageByteResolver,
  resetLaunchImageByteResolver,
} from "@vex-agent/tools/protocols/shared/launch-image-byte-resolver.js";
import { log } from "../logger/index.js";
import { digestOf, readImageBytes } from "./byte-store.js";
import { getLockerImage } from "./locker.js";

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
 * Mount the resolver into the agent runtime. Called once from main's agent
 * bootstrap, mirroring how `setBugReportSink` mounts its production sink.
 * Returns the teardown so app shutdown (and tests) can unmount it.
 */
export function mountLaunchImageByteResolver(): () => void {
  registerLaunchImageByteResolver(resolveLockerImageBytesForLaunch);
  return resetLaunchImageByteResolver;
}
