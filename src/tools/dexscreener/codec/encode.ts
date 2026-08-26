/**
 * Protobuf ENCODING for the DexScreener site surface.
 *
 * Separate module from `./protobuf.ts` on purpose. That module's contract is
 * "provider bytes in, validated-shape JSON out", and every property it states
 * (allowlist, byte cap before decode, 64-bit safety) is about reading bytes we
 * did not write. Encoding is the opposite direction and has its own hazard:
 * the bytes we produce are a COMMAND that changes what a provider socket sends
 * back, so the risk is a malformed or over-broad command, not an oversized
 * response.
 *
 * Three channels need bytes we author rather than a query string:
 *
 *  - the pair FEED socket (`dex_feed.WSCommand`), for the optional token
 *    insight;
 *  - the v8 explicit-identity pairs channel
 *    (`dex_screener.PairsSearchChannelCommand`), whose subscription IS the
 *    caller's `{chainId, id}` list and cannot be expressed in a URL;
 *  - the Connect trade-history RPC (`dex_feed.GetTransactionsRequest`), whose
 *    whole filter set travels as urlsafe base64 in one `message` query
 *    parameter of a GET.
 *
 * ALLOWLIST, SAME DISCIPLINE AS DECODING. Only the command messages above
 * may be encoded, resolved through `getDexScreenerMessageDescriptor` so the
 * name a caller passes is checked against the same table. A module must not be
 * able to serialize an arbitrary message name it computed.
 *
 * WHY `fromJson` AND NOT A HAND-BUILT MESSAGE. The JSON form is the same view
 * the fixtures and snapshots are written in, so a captured command and a
 * command we build are directly comparable, and an unknown or misspelled field
 * is REJECTED by protobuf-es rather than silently dropped. A silently dropped
 * filter would mean asking for a narrower set than the agent requested and
 * reporting the wider answer as if it were the narrow one.
 */

import { fromJson, toBinary, type JsonValue } from "@bufbuild/protobuf";
import {
  DexScreenerSiteErrorCodes,
  siteError,
} from "../site-errors.js";
import {
  getDexScreenerMessageDescriptor,
  getDexScreenerProtoRegistry,
  type DexScreenerMessageName,
} from "./protobuf.js";

/** The command messages a caller may encode. */
export const DEXSCREENER_COMMAND_MESSAGES = [
  "dex_feed.WSCommand",
  "dex_screener.PairsSearchChannelCommand",
  // The Connect trade-history request. Its encoded bytes are the `message`
  // query parameter of a GET, so this is a command in exactly the sense above:
  // bytes we author that change what the provider sends back.
  "dex_feed.GetTransactionsRequest",
] as const;

/** A message name this module is allowed to serialize. */
export type DexScreenerCommandName =
  (typeof DEXSCREENER_COMMAND_MESSAGES)[number];

const ENCODABLE: ReadonlySet<string> = new Set(DEXSCREENER_COMMAND_MESSAGES);

/**
 * Encode one command message from its protobuf-JSON form.
 *
 * Throws a typed refusal when the name is not an encodable command, or when
 * the JSON does not satisfy the schema. Both are OUR defects rather than
 * provider behaviour, and they are named as such: a command that would go on
 * the wire malformed is never sent.
 */
export function encodeDexScreenerCommand(
  name: DexScreenerCommandName,
  value: JsonValue
): Uint8Array {
  if (!ENCODABLE.has(name)) {
    throw siteError(
      DexScreenerSiteErrorCodes.ENCODE_MESSAGE_NOT_ALLOWED,
      `"${name}" is not a DexScreener command this build may encode`,
      `Encodable command names: ${DEXSCREENER_COMMAND_MESSAGES.join(", ")}.`
    );
  }
  const descriptor = getDexScreenerMessageDescriptor(
    name as DexScreenerMessageName
  );
  try {
    const message = fromJson(descriptor, value, {
      registry: getDexScreenerProtoRegistry(),
    });
    return toBinary(descriptor, message);
  } catch (error) {
    throw siteError(
      DexScreenerSiteErrorCodes.ENCODE_FAILED,
      `A ${name} command could not be built: ${describeCause(error)}`,
      "This is a defect in how the command was assembled, not a provider failure. Nothing was sent."
    );
  }
}

/** Our own message, never provider payload text. */
function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : "unknown encoding failure";
}
