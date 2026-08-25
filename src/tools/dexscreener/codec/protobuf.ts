/**
 * Protobuf decoding for the DexScreener site surface.
 *
 * The site ships its own schemas inside its JS bundle. We do not hand-write
 * parsers: `descriptors.ts` carries the extracted `FileDescriptorSet` and this
 * module turns it into a runtime registry once, then decodes by message name.
 *
 * Three properties are contract, not implementation detail:
 *
 *  1. ALLOWLIST. Only the message names in `DEXSCREENER_MESSAGES` may be
 *     decoded. The descriptor set carries 109 messages, most of them internal
 *     request/filter types; an endpoint module must not be able to decode an
 *     arbitrary name it computed from provider input.
 *  2. BYTE CAP BEFORE DECODE. `maxBytes` is required and caller-supplied.
 *     There is no default, because a default here would be an invisible policy
 *     over someone else's budget. Over-cap bytes are REJECTED by a typed error
 *     naming the cap; nothing is ever decoded partially and presented as
 *     whole.
 *  3. 64-BIT SAFETY. protobuf-es keeps int64/uint64/sint64/fixed64 as `bigint`
 *     in decoded messages and as decimal STRINGS in the JSON view. Neither
 *     path goes through `Number`, so block numbers, timestamps and token
 *     amounts survive exactly.
 */

import {
  createFileRegistry,
  fromBinary,
  toJson,
  type DescMessage,
  type FileRegistry,
  type JsonValue,
  type Message,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import {
  DexScreenerSiteErrorCodes,
  siteError,
} from "../site-errors.js";
import { DEXSCREENER_DESCRIPTOR_SET_BASE64 } from "./descriptors.js";

/**
 * The messages a caller may decode, by fully qualified protobuf name.
 *
 * Adding a name here is a deliberate widening of what provider bytes can be
 * turned into: do it when a tool needs it, with a fixture that proves the
 * shape.
 */
export const DEXSCREENER_MESSAGES = [
  /** Screener channel frame: `pairs` or `latestBlock` (WS). */
  "dex_screener.PairsChannelMessage",
  /**
   * Token-grouped screener channel frame: `pairs` or `latestBlock` (WS).
   * Same oneof shape and the same `dex_screener_schema.Pair` rows as the pair
   * channel, one row per base token. Fixture:
   * `screener-tokens-solana-volume-h24`.
   */
  "dex_screener.TokensChannelMessage",
  /** Single-pair channel frame (WS). */
  "dex_screener.PairChannelMessage",
  /**
   * The v8 explicit-identity pairs channel: the subscribe COMMAND the client
   * sends and the frame the channel answers with (WS). Same oneof shape and
   * the same `dex_screener_schema.Pair` rows as the screener channel, but the
   * membership is the caller's own `{chainId, id}` list rather than a filter.
   * Fixtures: `v8-batch-known-three` (command and frame) and
   * `v8-batch-invalid-and-duplicate` (command and frame).
   */
  "dex_screener.PairsSearchChannelCommand",
  "dex_screener.PairsSearchChannelMessage",
  /** `/dex/search/v12/pairs` response (HTTP). */
  "dex_search.SearchPairsResponse",
  /** `/dex/spotlight/*` response (HTTP). */
  "dex_search.SpotlightResponse",
  /** Connect-RPC trade history request and response. */
  "dex_feed.GetTransactionsRequest",
  "dex_feed.GetTransactionsResponse",
  /**
   * Connect-RPC trending request and response.
   *
   * KEPT WITH NO PRODUCTION CALLER (S8 / A3 decision), for the reason written
   * out in full on `TRENDING_PAIR` in `dsavro-schemas.ts`: the trending
   * endpoints are the independent oracle for the homepage-ordering claim that
   * `dexscreener__pairs_trending_list` makes and cannot verify from its own
   * screener board. Proven live-correct by
   * `protobuf-decode.test.ts` against the committed
   * `connect-trending-solana-h24` capture. Same removal condition.
   */
  "dex_trending.GetTrendingPairsRequest",
  "dex_trending.GetTrendingPairsResponse",
  /** The pair feed WebSocket command and frame envelopes. */
  "dex_feed.WSCommand",
  "dex_feed.WSMessage",
] as const;

/** A message name a caller is allowed to decode. */
export type DexScreenerMessageName = (typeof DEXSCREENER_MESSAGES)[number];

const ALLOWED: ReadonlySet<string> = new Set(DEXSCREENER_MESSAGES);

let registryMemo: FileRegistry | null = null;

/**
 * The descriptor registry, built once per process.
 *
 * The emitted descriptor set is already topologically ordered by
 * `generate-descriptors.mjs`; the bundle's own descriptors carry no
 * `dependency` lists, and `createFileRegistry` resolves type references
 * against what it has already added, so order is what makes this load at all.
 */
export function getDexScreenerProtoRegistry(): FileRegistry {
  if (registryMemo !== null) return registryMemo;
  const bytes = base64ToBytes(DEXSCREENER_DESCRIPTOR_SET_BASE64);
  const set = fromBinary(FileDescriptorSetSchema, bytes);
  registryMemo = createFileRegistry(set);
  return registryMemo;
}

/** Resolve an allowlisted name to its descriptor, or throw a typed refusal. */
export function getDexScreenerMessageDescriptor(
  name: DexScreenerMessageName
): DescMessage {
  if (!ALLOWED.has(name)) {
    throw siteError(
      DexScreenerSiteErrorCodes.DECODE_MESSAGE_NOT_ALLOWED,
      `"${name}" is not a DexScreener message this build may decode`,
      `Allowed message names: ${DEXSCREENER_MESSAGES.join(", ")}.`
    );
  }
  const descriptor = getDexScreenerProtoRegistry().getMessage(name);
  if (descriptor === undefined) {
    throw siteError(
      DexScreenerSiteErrorCodes.DECODE_FAILED,
      `"${name}" is allowlisted but absent from the checked-in descriptor set`,
      "Regenerate the descriptors from the current site bundle (see generate-descriptors.mjs) and re-run the drift test."
    );
  }
  return descriptor;
}

export interface DecodeOptions {
  /**
   * Byte ceiling the caller accepts for this decode. Required and without a
   * default: over-cap input is rejected by name, never trimmed.
   */
  readonly maxBytes: number;
}

/**
 * Decode provider bytes as an allowlisted message.
 *
 * 64-bit fields come back as `bigint`. The returned value is UNVALIDATED
 * provider data: it satisfies the wire schema and nothing more. Projection
 * modules validate the fields they actually use.
 */
export function decodeDexScreenerMessage(
  name: DexScreenerMessageName,
  bytes: Uint8Array,
  options: DecodeOptions
): Message {
  const descriptor = getDexScreenerMessageDescriptor(name);
  assertWithinCap(name, bytes, options.maxBytes);
  try {
    return fromBinary(descriptor, bytes);
  } catch (error) {
    throw siteError(
      DexScreenerSiteErrorCodes.DECODE_FAILED,
      `${bytes.byteLength} bytes did not decode as ${name}: ${describeCause(error)}`,
      "The endpoint's wire format may have changed. Re-run the descriptor drift test before trusting this endpoint."
    );
  }
}

/**
 * Decode and render as protobuf JSON.
 *
 * The JSON view is what fixtures and snapshots compare against: 64-bit values
 * are decimal strings and enums are their names, so a diff reads as a contract
 * change rather than as float noise.
 */
export function decodeDexScreenerMessageToJson(
  name: DexScreenerMessageName,
  bytes: Uint8Array,
  options: DecodeOptions
): JsonValue {
  const descriptor = getDexScreenerMessageDescriptor(name);
  const message = decodeDexScreenerMessage(name, bytes, options);
  return toJson(descriptor, message, { registry: getDexScreenerProtoRegistry() });
}

function assertWithinCap(
  name: string,
  bytes: Uint8Array,
  maxBytes: number
): void {
  if (bytes.byteLength > maxBytes) {
    throw siteError(
      DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP,
      `${bytes.byteLength} bytes of ${name} exceed the caller's cap of ${maxBytes} bytes; nothing was decoded`,
      "Raise maxBytes for this call or request a narrower window. The bytes were rejected whole, not truncated."
    );
  }
}

/** The decoder's own message, never provider payload text. */
function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : "unknown decode failure";
}

function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}
