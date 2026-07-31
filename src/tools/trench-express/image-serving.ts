/**
 * Trench Express token-image URL helper.
 *
 * The launchpad stores the image bytes on-chain inside `create()` and its
 * backend derives an `imageCid` (64 lowercase hex, sha256-family) that it serves
 * as a webp from Cloudflare R2. The derivation is NOT sha256/keccak of the raw
 * bytes and is otherwise unknown, so the CID is ALWAYS read from the API
 * response — it is never computed locally. This helper only turns a
 * provider-supplied CID into its public URL; it invents nothing.
 */

import { TRENCH_IMAGE_R2_BASE } from "./constants.js";

/** A Trench `imageCid` is 64 lowercase hex characters, no `0x` prefix. */
const IMAGE_CID_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Build the public webp URL for a token's `imageCid`, or `null` when the CID is
 * absent or malformed. The pattern check keeps a hostile/garbage CID from being
 * concatenated into a URL — the value originates from an untrusted provider.
 */
export function trenchImageUrl(imageCid: string | null | undefined): string | null {
  if (typeof imageCid !== "string" || !IMAGE_CID_PATTERN.test(imageCid)) {
    return null;
  }
  return `${TRENCH_IMAGE_R2_BASE}/tokens/${imageCid}.webp`;
}
