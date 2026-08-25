/**
 * THE CLOSED VOCABULARY OF VEX STUDIO WIRE ERRORS.
 *
 * Everything that crosses the socket is peer-controlled, including the text of
 * the errors it provokes: `JSON.parse` quotes the input it choked on, and an
 * SDK schema rejection embeds the value it rejected. Both used to reach the
 * host's `error.message` log line, which made Vex's log file writable by
 * anything that could open the endpoint.
 *
 * So the wire has a vocabulary instead. This module owns it, separately from
 * the transport, because the HOST also classifies errors it receives from the
 * SDK and both sides must agree on exactly one closed set.
 */

/**
 * Why a line was not a JSON-RPC frame, as a CLOSED value.
 *
 * `JSON.parse`'s own error text quotes the input ("Unexpected token X in JSON
 * at position N"), so it is peer-controlled bytes. It used to travel into the
 * `Error` this transport hands to `onerror`, which the SDK forwards to the
 * host, which logs `error.message` - untrusted wire bytes in Vex's log file.
 * Two enum members carry everything the peer or the log actually needs.
 */
export type InvalidJsonReason = "unparseable" | "not_an_object";

/**
 * The CLOSED set of codes a transport-produced error may carry.
 *
 * `sdk_wire_error` is the catch-all for an error the SDK raised on this wire:
 * its message can quote the offending payload (a schema rejection embeds the
 * value it rejected), so the code is what the owner logs and the message is
 * discarded. Nothing here is derived from anything the peer sent.
 */
export const STUDIO_WIRE_ERROR_CODES = [
  "line_too_long",
  "invalid_json",
  "queue_overflow",
  "socket_error",
  "sdk_wire_error",
] as const;

export type StudioWireErrorCode = (typeof STUDIO_WIRE_ERROR_CODES)[number];

/**
 * Classify an error that arrived on this wire into one of the closed codes.
 *
 * The transport labels its own errors with the code and nothing else, so a
 * recognized message IS the code. Everything else came from the SDK and is
 * reported as `sdk_wire_error` WITHOUT its text: an unrecognized message is
 * exactly the case where the payload could be quoted inside it.
 */
export function studioWireErrorCode(error: Error): StudioWireErrorCode {
  const found = STUDIO_WIRE_ERROR_CODES.find((code) => code === error.message);
  return found ?? "sdk_wire_error";
}
