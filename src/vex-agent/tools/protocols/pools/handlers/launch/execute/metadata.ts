/**
 * Fetching the metadata document a launch would pin - verifier point 7's input.
 *
 * WHY IT IS FETCHED AT ALL. The metadata is what the world sees: the token's
 * name, its symbol, its deployer, its fee recipient and its picture. It is also
 * where the provider's image trap lives (`image` in the request is accepted and
 * silently dropped; only `imageUrl` lands), so a launch can otherwise succeed
 * and produce a permanently blank token. The verifier compares the document
 * against what was requested, and this module is the only thing that goes and
 * gets it.
 *
 * BOUNDED, because it is a third-party document reached over a public gateway:
 * a timeout, a byte cap, and a JSON parse that cannot throw. `null` means NOT
 * PROVEN - never "the metadata is fine". The verifier turns that into a refusal,
 * which is the right answer: signing a launch whose published identity could not
 * be read would be committing to text nobody checked.
 *
 * The document is UNTRUSTED INPUT and is returned as a bag of `unknown` fields,
 * exactly as `PoolsMetadataDocument` declares them; nothing here decides what
 * any of it means.
 *
 * The gateways are tried in order, the pinning gateway first - measured by the
 * image-contract probe (`agents_dm/pools-fun-live/image-contract-probe.ts`),
 * which read these same documents back over exactly these two hosts.
 */

import { fetchWithTimeout } from "@utils/http.js";
import logger from "@utils/logger.js";
import type { PoolsMetadataDocument } from "@tools/pools-fun/launch/verify-calldata.js";

/** The pinning gateway first, then a public fallback. */
const IPFS_GATEWAYS = [
  "https://peach-quiet-cat-229.mypinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
] as const;

/** A launch metadata document is a few hundred bytes. This is a wide ceiling, not a target. */
const MAX_METADATA_BYTES = 64 * 1024;

const METADATA_TIMEOUT_MS = 10_000;

export async function fetchLaunchMetadata(
  metadataUri: string,
  signal?: AbortSignal | undefined,
): Promise<PoolsMetadataDocument | null> {
  for (const url of resolveUrls(metadataUri)) {
    const document = await readOne(url, signal);
    if (document !== null) return document;
  }
  return null;
}

/** Every URL this URI can be read from, in order. An unusable URI yields none. */
function resolveUrls(metadataUri: string): readonly string[] {
  const trimmed = metadataUri.trim();
  if (trimmed.startsWith("ipfs://")) {
    const cid = trimmed.slice("ipfs://".length);
    if (cid === "") return [];
    return IPFS_GATEWAYS.map((gateway) => `${gateway}${cid}`);
  }
  // An already-HTTP metadata URI is read directly. Anything else (a bare CID, a
  // data URI, an unknown scheme) is NOT guessed at: an unreadable document is a
  // refusal, and inventing a URL for it would be inventing the document.
  return trimmed.startsWith("https://") ? [trimmed] : [];
}

async function readOne(
  url: string,
  signal: AbortSignal | undefined,
): Promise<PoolsMetadataDocument | null> {
  try {
    const response = await fetchWithTimeout(url, {
      timeoutMs: METADATA_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > MAX_METADATA_BYTES) {
      logger.warn("pools.launch.metadata_too_large", { bytes: text.length });
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as PoolsMetadataDocument;
  } catch (err) {
    // The host, not the URL: a gateway error can carry query strings and headers.
    logger.warn("pools.launch.metadata_unreadable", {
      error: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}
