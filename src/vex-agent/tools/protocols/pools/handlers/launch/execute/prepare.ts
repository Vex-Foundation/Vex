/**
 * The provider half of a pools.fun launch: the image, and the prepare call.
 *
 * ONE UPLOAD, EVER. The upload endpoint is rate limited to roughly one call a
 * minute, so the bytes go up once and the returned URL is reused for any
 * reprepare. The caller therefore passes an already-uploaded URL back in rather
 * than letting this module upload again.
 *
 * `imageUrl`, NOT `image`. Sending `image` returns HTTP 200 and is SILENTLY
 * DROPPED: no image key in the pinned metadata, `discover.imageUri` null, and a
 * token that renders blank forever. That is what happened to the first funded
 * launch; six request shapes were probed and exactly one landed
 * (`agents_dm/pools-fun-live/artifacts/image-contract-probe.json`). The
 * verifier's point 7 fails loudly if a requested image is missing from the
 * metadata, so a regression cannot ship as a blank token.
 *
 * A PREPARE IS NOT SIDE-EFFECT FREE. Nothing touches the chain, but each call
 * pins a persistent IPFS metadata object through the provider's account and
 * mines a NEW salt - which is why `pools.launch_preview` never calls it, and why
 * a reprepare is only ever deliberate and only ever BEFORE an authorization
 * exists.
 */

import type { Address } from "viem";

import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import type {
  PoolsLaunchConfig,
  PoolsPrepareFeeRecipient,
  PoolsPrepareResponse,
} from "@tools/pools-fun/types.js";
import {
  LaunchImageResolverUnavailableError,
  resolveLaunchImageBytes,
} from "../../../../shared/launch-image-byte-resolver.js";
import { poolsFailureDetail } from "../../failure.js";

const TOOL_ID = "pools.launch_execute";

/**
 * The locker's byte seam lives under `trench/` because Trench launches needed it
 * first; it is launchpad-neutral in everything but its path, and the desktop app
 * registers exactly one implementation of it at startup. Moving it under
 * `shared/` would be the honest home and is a coordinator-level change: 14 call
 * sites, several of them in `vex-app/`, which this lane does not own.
 */

/** Where the picture came from, already narrowed by the caller. */
export type PoolsLaunchImageSource =
  | { readonly kind: "locker"; readonly imageId: string }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "none" };

export interface PoolsPrepareInput {
  readonly name: string;
  readonly symbol: string;
  readonly pairedAsset: "weth" | "usdg";
  /**
   * Explicit, always. Never left to the provider's default (owner decision 3).
   *
   * Already in the launchpad's own `{type, value}` form: `{type: "wallet"}` on
   * every agent launch and on a manual launch where the user typed an address,
   * `{type: "x"}` on a manual launch that named a HANDLE, which only the
   * launchpad can resolve - the resolved address comes back on the response, is
   * sanity-checked, is bound into the tuple the user confirms, and is what the
   * fingerprint covers. See `resolveFeeRecipientExpectation` in the plan builder.
   */
  readonly feeRecipient: PoolsPrepareFeeRecipient;
  readonly launcher: Address;
  readonly image: PoolsLaunchImageSource;
  /** A NATIVE prebuy in HUMAN ETH, or `null`. USDG prebuys are manual-form only in P3. */
  readonly devBuyEth: string | null;
  readonly tweetUrl?: string | undefined;
  readonly websiteUrl?: string | undefined;
  /** Reused across a reprepare so the rate-limited upload happens once. */
  readonly uploadedImageUrl?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Why the provider half could not be completed. Each maps to a distinct refusal. */
export type PoolsPrepareRefusalCode =
  | "image_store_unavailable"
  | "image_not_found"
  | "image_upload_failed"
  | "config_unreadable"
  | "prepare_failed";

export interface PoolsPreparedCalldata {
  readonly response: PoolsPrepareResponse;
  readonly config: PoolsLaunchConfig;
  /** The URL that was sent as `imageUrl`, or `null` when no image was requested. */
  readonly imageUrl: string | null;
}

export type PoolsPrepareResult =
  | { readonly ok: true; readonly value: PoolsPreparedCalldata }
  | { readonly ok: false; readonly code: PoolsPrepareRefusalCode; readonly reason: string };

export async function preparePoolsLaunchCalldata(
  input: PoolsPrepareInput,
): Promise<PoolsPrepareResult> {
  const client = getPoolsFunClient();
  const options = input.signal === undefined ? {} : { signal: input.signal };

  const image = await resolveImageUrl(input, options);
  if (!image.ok) return image;

  // The fee is DYNAMIC (measured moving 4x inside 24 hours), so it is read fresh
  // here and proven against the contract's own value at the anchored block. The
  // version travels with it: the prepare request declares which gateway code the
  // calldata is built for.
  let config: PoolsLaunchConfig;
  try {
    config = await client.launchConfig(options);
  } catch (err) {
    return {
      ok: false,
      code: "config_unreadable",
      reason:
        "Refusing to launch: the launchpad's current deployment fee could not be read, so the amount to "
        + `send is unknown (${poolsFailureDetail(TOOL_ID, err)}). Nothing was signed.`,
    };
  }

  try {
    const response = await client.prepareLaunch(
      {
        tokenName: input.name,
        tokenSymbol: input.symbol,
        pairedAsset: input.pairedAsset,
        expectedDeploymentFeeWei: config.deploymentFeeWei,
        expectedGatewayVersion: config.gatewayVersion,
        creatorAddress: input.launcher,
        feeRecipient: input.feeRecipient,
        ...(image.url === null ? {} : { imageUrl: image.url }),
        ...(input.tweetUrl === undefined ? {} : { tweetUrl: input.tweetUrl }),
        ...(input.websiteUrl === undefined ? {} : { websiteUrl: input.websiteUrl }),
        ...(input.devBuyEth === null ? {} : { devBuyEth: input.devBuyEth }),
      },
      options,
    );
    return { ok: true, value: { response, config, imageUrl: image.url } };
  } catch (err) {
    return {
      ok: false,
      code: "prepare_failed",
      reason:
        `Refusing to launch: the launchpad could not prepare this launch (${poolsFailureDetail(TOOL_ID, err)}). `
        + "Nothing was signed.",
    };
  }
}

/** The `imageUrl` to send, uploading the locker bytes at most once. */
async function resolveImageUrl(
  input: PoolsPrepareInput,
  options: { readonly signal?: AbortSignal | undefined },
): Promise<{ ok: true; url: string | null } | { ok: false; code: PoolsPrepareRefusalCode; reason: string }> {
  if (input.uploadedImageUrl !== undefined) return { ok: true, url: input.uploadedImageUrl };
  if (input.image.kind === "none") return { ok: true, url: null };
  if (input.image.kind === "url") return { ok: true, url: input.image.url };

  let bytes: Uint8Array;
  try {
    const resolved = await resolveLaunchImageBytes(input.image.imageId);
    if (resolved === null) {
      return {
        ok: false,
        code: "image_not_found",
        reason:
          `Refusing to launch: no image with id "${input.image.imageId}" is in the image locker. Upload one `
          + "on the right, or name an image that is already there. Nothing was signed.",
      };
    }
    bytes = resolved.bytes;
  } catch (err) {
    if (err instanceof LaunchImageResolverUnavailableError) {
      return { ok: false, code: "image_store_unavailable", reason: err.message };
    }
    throw err;
  }

  // The content type is SNIFFED from the bytes, not assumed. The locker stores
  // bytes and a digest, not a MIME type, and labelling a JPEG as a PNG is the
  // kind of small lie that ends in a token whose picture never renders. An
  // unrecognised format refuses rather than guessing.
  const contentType = sniffImageContentType(bytes);
  if (contentType === null) {
    return {
      ok: false,
      code: "image_upload_failed",
      reason:
        "Refusing to launch: the locker image is not a PNG, JPEG, GIF or WebP - its bytes match no format "
        + "the launchpad accepts, and uploading it under a guessed type would produce a token whose picture "
        + "never renders. Nothing was signed.",
    };
  }

  try {
    const upload = await getPoolsFunClient().uploadLaunchImage(
      {
        bytes,
        fileName: `${input.symbol.toLowerCase()}.${contentType.extension}`,
        contentType: contentType.mime,
      },
      options,
    );
    return { ok: true, url: upload.url };
  } catch (err) {
    return {
      ok: false,
      code: "image_upload_failed",
      reason:
        `Refusing to launch: the token's image could not be uploaded (${poolsFailureDetail(TOOL_ID, err)}), and launching `
        + "without it would produce a permanently blank token. Nothing was signed.",
    };
  }
}

/** The formats the launchpad renders, identified by their magic bytes. */
const IMAGE_SIGNATURES: readonly {
  readonly mime: string;
  readonly extension: string;
  readonly matches: (bytes: Uint8Array) => boolean;
}[] = [
  {
    mime: "image/png",
    extension: "png",
    matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { mime: "image/jpeg", extension: "jpg", matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { mime: "image/gif", extension: "gif", matches: (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]) },
  {
    mime: "image/webp",
    extension: "webp",
    // RIFF....WEBP - the four size bytes in between are content, not signature.
    matches: (b) =>
      startsWith(b, [0x52, 0x49, 0x46, 0x46])
      && b.length >= 12
      && [0x57, 0x45, 0x42, 0x50].every((byte, i) => b[8 + i] === byte),
  },
];

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/** The image's real type, or `null` when the bytes match nothing we can name. */
export function sniffImageContentType(
  bytes: Uint8Array,
): { readonly mime: string; readonly extension: string } | null {
  const match = IMAGE_SIGNATURES.find((candidate) => candidate.matches(bytes));
  return match === undefined ? null : { mime: match.mime, extension: match.extension };
}
