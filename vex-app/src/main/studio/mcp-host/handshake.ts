/**
 * The Vex Studio bridge HANDSHAKE, host side.
 *
 * One line in, one ack line out, then MCP. The frozen wire is in
 * `studio-mcp/bridge-endpoint-contract.md`; this module is its host-side
 * parser and encoder, and it is pure: it reads bytes and returns a decision,
 * it never touches a socket, a database or a project.
 *
 * ## Remainder-preserving, deliberately
 *
 * A conforming bridge waits for the ack before forwarding a byte of MCP. A
 * non-conforming one may write `handshake\n` and `initialize\n` into the same
 * TCP segment, and the host must not lose the second frame. So the parser
 * returns everything after the handshake newline and the caller hands those
 * bytes to the transport as its starting buffer. That is the whole reason
 * `remainder` exists, and the socket-level contract test exercises exactly
 * this coalescing case.
 *
 * ## The version rule
 *
 * `v` is a MAJOR. An unknown major is `incompatible_version` and the refusal
 * NAMES the supported value, so an outdated bridge can say something useful
 * instead of "connection closed".
 */

/** The one protocol major this host speaks. */
export const STUDIO_BRIDGE_PROTOCOL_VERSION = 1;

/** The contract's handshake line bound. */
export const STUDIO_HANDSHAKE_MAX_BYTES = 4096;

/** The contract's handshake deadline. A socket silent this long is dropped. */
export const STUDIO_HANDSHAKE_DEADLINE_MS = 5_000;

/** The typed refusal codes. Closed set: A4c's Go bridge switches on them. */
export type StudioHandshakeRefusalCode =
  | "unknown_project"
  | "incompatible_version"
  | "locked"
  | "at_capacity"
  | "malformed";

export interface StudioHandshakeAccepted {
  readonly kind: "accepted";
  readonly projectId: string;
  /** Bytes that followed the handshake newline in the same buffer. */
  readonly remainder: Buffer;
}

export interface StudioHandshakeRefused {
  readonly kind: "refused";
  readonly code: StudioHandshakeRefusalCode;
  readonly message: string;
}

/** The line is not complete yet, and is still within the byte bound. */
export interface StudioHandshakePending {
  readonly kind: "pending";
}

export type StudioHandshakeParse =
  | StudioHandshakeAccepted
  | StudioHandshakeRefused
  | StudioHandshakePending;

/** A `projectId` is a UUID. Checked here so a malformed one never reaches SQL. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function malformed(detail: string): StudioHandshakeRefused {
  return {
    kind: "refused",
    code: "malformed",
    message:
      `The Vex Studio handshake is malformed: ${detail}. Send one line of `
      + `{"v":${String(STUDIO_BRIDGE_PROTOCOL_VERSION)},"projectId":"<uuid>"} `
      + "and wait for the ack before forwarding MCP.",
  };
}

/**
 * Parse the buffered bytes of a connection that has not handshaken yet.
 *
 * Returns `pending` while no newline has arrived and the bound still holds.
 * The caller owns the 5 s deadline; a parser cannot see time.
 */
export function parseStudioHandshake(buffered: Buffer): StudioHandshakeParse {
  const newline = buffered.indexOf(0x0a);
  if (newline === -1) {
    if (buffered.length > STUDIO_HANDSHAKE_MAX_BYTES) {
      return malformed(
        `no newline within ${String(STUDIO_HANDSHAKE_MAX_BYTES)} bytes`,
      );
    }
    return { kind: "pending" };
  }
  const line = buffered.subarray(0, newline);
  const remainder = Buffer.from(buffered.subarray(newline + 1));
  if (line.length > STUDIO_HANDSHAKE_MAX_BYTES) {
    return malformed(
      `the line is ${String(line.length)} bytes, over the `
      + `${String(STUDIO_HANDSHAKE_MAX_BYTES)}-byte limit`,
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(line.toString("utf8"));
  } catch {
    return malformed("the line is not JSON");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return malformed("the line is not a JSON object");
  }
  const record = decoded as Record<string, unknown>;

  const version = record["v"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return malformed('"v" must be an integer major version');
  }
  if (version !== STUDIO_BRIDGE_PROTOCOL_VERSION) {
    return {
      kind: "refused",
      code: "incompatible_version",
      message:
        `This Vex speaks Studio bridge protocol v${String(STUDIO_BRIDGE_PROTOCOL_VERSION)} `
        + `and the bridge asked for v${String(version)}. Update whichever of the two `
        + "is older. Nothing was executed.",
    };
  }

  const projectId = record["projectId"];
  if (typeof projectId !== "string" || !UUID_RE.test(projectId)) {
    return malformed('"projectId" must be a UUID string');
  }

  return { kind: "accepted", projectId, remainder };
}

export interface StudioHandshakeAck {
  readonly ok: boolean;
  readonly code?: StudioHandshakeRefusalCode;
  readonly message?: string;
}

/** The ack line, newline included. Success carries no message. */
export function encodeStudioHandshakeAck(ack: StudioHandshakeAck): string {
  if (ack.ok) return `${JSON.stringify({ ok: true })}\n`;
  return `${JSON.stringify({
    ok: false,
    code: ack.code ?? "malformed",
    message: ack.message ?? "",
  })}\n`;
}

/** The refusal for a project the host cannot find. NON-AUTHORITATIVE by design. */
export function unknownProjectRefusal(): StudioHandshakeRefused {
  return {
    kind: "refused",
    code: "unknown_project",
    message:
      "That Vex project does not exist. It was deleted, or the bridge was "
      + "configured with a project id from another Vex installation. Open Vex "
      + "and re-add the MCP server for a project that exists.",
  };
}

/** The refusal for a locked or not-yet-ready Vex. */
export function lockedRefusal(cause: string): StudioHandshakeRefused {
  return { kind: "refused", code: "locked", message: cause };
}

/**
 * The refusal for a peer that never sent its handshake line.
 *
 * ONE AUTHOR, TWO TRANSPORTS. On the direct-socket path `StudioConnection`'s
 * own 5 s timer writes it. On the Windows front path the FRONT owns that timer,
 * because the front is the process that accepts and the deadline is measured
 * from `Accept` (`pipe-front-protocol.md` section 9) - so main hands it these
 * exact bytes in `HELLO`'s `timeoutRefusalBytes` and the front relays them
 * verbatim. Main authors every refusal line the external peer sees, and this
 * function is where that promise is kept for the one line main cannot write
 * itself.
 */
export function handshakeTimeoutRefusal(): StudioHandshakeRefused {
  return {
    kind: "refused",
    code: "malformed",
    message:
      `No Vex Studio handshake arrived within ${String(STUDIO_HANDSHAKE_DEADLINE_MS)} ms. `
      + "Send the handshake line first and wait for the ack.",
  };
}

/** The refusal for connection 17, and for handshake-pending socket 5. */
export function atCapacityRefusal(limit: number, what: string): StudioHandshakeRefused {
  return {
    kind: "refused",
    code: "at_capacity",
    message:
      `Vex Studio already has ${String(limit)} ${what} and refuses more rather `
      + "than dropping one that may be waiting on a human decision. Close an "
      + "unused MCP client and connect again. Nothing was executed.",
  };
}
