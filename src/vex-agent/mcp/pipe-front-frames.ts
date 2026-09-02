/**
 * THE INTERNAL main<->front WIRE, as bytes.
 *
 * Normative specification and rationale:
 * `src/vex-agent/tools/tool-surface-spec/studio-mcp/pipe-front-protocol.md`.
 * Golden vectors, run by this codec AND by the independent Go codec in
 * `bridge/internal/front/frames/` from the same path with no copy:
 * `src/vex-agent/tools/tool-surface-spec/studio-mcp/pipe-front-vectors.json`.
 *
 * This module is PURE. It encodes and decodes frames and validates the header,
 * the per-plane sequence and the per-type payload layout. It does NOT track
 * connections, credit, admission, `END` ordering or write windows: those are
 * relay state with a different lifetime, a different owner and a different test
 * surface (protocol section 11.3). A codec that owned them would be the relay.
 *
 * The decoder's retention is bounded BY CONSTRUCTION: the header is validated
 * in full, including the plane's payload bound, before one payload byte is
 * retained, so the pending buffer never exceeds `28 + the plane's bound` -
 * 4124 bytes on a control plane, 32796 on a data plane.
 */

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

export const PIPE_FRONT_PROTOCOL_VERSION = 1;

/** `0x46584556`. On the wire the bytes are `56 45 58 46`, ASCII `VEXF`. */
export const PIPE_FRONT_MAGIC = 0x46584556;

export const PIPE_FRONT_HEADER_BYTES = 28;
export const PIPE_FRONT_CONTROL_PAYLOAD_MAX_BYTES = 4096;
export const PIPE_FRONT_DATA_PAYLOAD_MAX_BYTES = 32768;

/**
 * 2^64-1 is never emitted and never accepted. A wrap would silently reissue
 * sequence 1 and hand a decoder a valid-looking replay.
 */
export const PIPE_FRONT_SEQUENCE_EXHAUSTED = 18446744073709551615n;

export const PIPE_FRONT_PLANE = {
  /** main -> front control. */
  controlDown: 3,
  /** front -> main control. */
  controlUp: 4,
  /** main -> front data. */
  dataDown: 5,
  /** front -> main data. */
  dataUp: 6,
} as const;

export type PipeFrontPlane =
  (typeof PIPE_FRONT_PLANE)[keyof typeof PIPE_FRONT_PLANE];

export const PIPE_FRONT_MAIN_TO_FRONT_CONTROL_TYPES = {
  HELLO: 0x01,
  ADMIT: 0x02,
  REFUSE: 0x03,
  CREDIT: 0x04,
  PAUSE: 0x05,
  RESUME: 0x06,
  CLOSE: 0x07,
  LOCK: 0x08,
  QUIT: 0x09,
  PING: 0x0a,
} as const;

export const PIPE_FRONT_FRONT_TO_MAIN_CONTROL_TYPES = {
  HELLO_ACK: 0x41,
  BOUND: 0x42,
  OPEN: 0x43,
  WRITE_DONE: 0x44,
  PEER_CLOSED: 0x45,
  LOCK_ACK: 0x46,
  QUIT_ACK: 0x47,
  PONG: 0x48,
  ERROR: 0x49,
} as const;

export const PIPE_FRONT_DATA_TYPES = {
  DATA: 0x81,
  END: 0x82,
} as const;

export const PIPE_FRONT_FRAME_TYPES = {
  ...PIPE_FRONT_MAIN_TO_FRONT_CONTROL_TYPES,
  ...PIPE_FRONT_FRONT_TO_MAIN_CONTROL_TYPES,
  ...PIPE_FRONT_DATA_TYPES,
} as const;

export type PipeFrontFrameTypeName = keyof typeof PIPE_FRONT_FRAME_TYPES;

export const PIPE_FRONT_PEER_CLOSED_REASONS = {
  peer_eof: 1,
  io_error: 2,
  commanded_close: 3,
} as const;

export type PipeFrontPeerClosedReason =
  keyof typeof PIPE_FRONT_PEER_CLOSED_REASONS;

export const PIPE_FRONT_BOUND_FLAGS = {
  rejectRemote: 0x01,
  firstInstance: 0x02,
  messageMode: 0x04,
} as const;

const BOUND_FLAGS_MASK = 0x07;

/** The only SDDL policy v1 defines: owner+SYSTEM protected allow-list. */
export const PIPE_FRONT_SDDL_KIND = 1;

const TYPE_NAME_BY_ID = new Map<number, PipeFrontFrameTypeName>(
  Object.entries(PIPE_FRONT_FRAME_TYPES).map(
    ([name, id]) => [id, name as PipeFrontFrameTypeName] as const,
  ),
);

const CONNECTION_MUST_BE_ZERO: ReadonlySet<PipeFrontFrameTypeName> = new Set([
  "HELLO", "LOCK", "QUIT", "PING",
  "HELLO_ACK", "BOUND", "LOCK_ACK", "QUIT_ACK", "PONG", "ERROR",
]);

function planeCarries(
  plane: PipeFrontPlane,
  type: PipeFrontFrameTypeName,
): boolean {
  if (plane === PIPE_FRONT_PLANE.controlDown) {
    return type in PIPE_FRONT_MAIN_TO_FRONT_CONTROL_TYPES;
  }
  if (plane === PIPE_FRONT_PLANE.controlUp) {
    return type in PIPE_FRONT_FRONT_TO_MAIN_CONTROL_TYPES;
  }
  return type in PIPE_FRONT_DATA_TYPES;
}

/** The payload bound of a plane. Control planes 4096, data planes 32768. */
export function pipeFrontPayloadBound(plane: PipeFrontPlane): number {
  return plane === PIPE_FRONT_PLANE.controlDown ||
    plane === PIPE_FRONT_PLANE.controlUp
    ? PIPE_FRONT_CONTROL_PAYLOAD_MAX_BYTES
    : PIPE_FRONT_DATA_PAYLOAD_MAX_BYTES;
}

/** The most a decoder for this plane ever retains: header plus the bound. */
export function pipeFrontRetentionBound(plane: PipeFrontPlane): number {
  return PIPE_FRONT_HEADER_BYTES + pipeFrontPayloadBound(plane);
}

// ---------------------------------------------------------------- frames

interface PipeFrontEnvelope {
  readonly plane: PipeFrontPlane;
  readonly generation: number;
  readonly connection: number;
  readonly sequence: bigint;
}

export type PipeFrontBody =
  | {
      readonly type: "HELLO";
      readonly protocolVersion: number;
      readonly sddlKind: number;
      readonly maxRaw: number;
      readonly creditBytes: number;
      readonly chunkBytes: number;
      readonly handshakeDeadlineMs: number;
      readonly pipeName: string;
      readonly timeoutRefusalBytes: string;
    }
  | { readonly type: "ADMIT"; readonly admissionEpoch: number }
  | { readonly type: "REFUSE"; readonly bytes: string }
  | { readonly type: "CREDIT"; readonly bytes: number }
  | { readonly type: "PAUSE" }
  | { readonly type: "RESUME" }
  | { readonly type: "CLOSE" }
  | { readonly type: "LOCK"; readonly admissionEpoch: number }
  | { readonly type: "QUIT"; readonly deadlineMs: number }
  | { readonly type: "PING"; readonly nonce: bigint }
  | {
      readonly type: "HELLO_ACK";
      readonly protocolVersion: number;
      /**
       * The fresh non-zero generation the front chose. NAMED APART from the
       * envelope's `generation`, which is still the bootstrap `0` on this one
       * frame: one name for both would silently lose the header's value when
       * the body is spread onto the envelope.
       */
      readonly announcedGeneration: number;
      readonly pid: number;
      readonly frontVersion: string;
      readonly buildHash: string;
    }
  | { readonly type: "BOUND"; readonly flagsApplied: number; readonly pipeName: string }
  | { readonly type: "OPEN" }
  | { readonly type: "WRITE_DONE"; readonly throughSequence: bigint }
  | {
      readonly type: "PEER_CLOSED";
      readonly reason: PipeFrontPeerClosedReason;
      readonly throughDataSequence: bigint;
    }
  | {
      readonly type: "LOCK_ACK";
      readonly admissionEpoch: number;
      readonly closedCount: number;
    }
  | { readonly type: "QUIT_ACK" }
  | { readonly type: "PONG"; readonly nonce: bigint }
  | { readonly type: "ERROR"; readonly code: number; readonly count: number }
  | { readonly type: "DATA"; readonly payload: Uint8Array }
  | { readonly type: "END" };

export type PipeFrontFrame = PipeFrontEnvelope & PipeFrontBody;

export type PipeFrontMalformedReason =
  | "bad_magic"
  | "flags_set"
  | "reserved_set"
  | "unknown_type"
  | "type_not_on_plane"
  | "bad_generation"
  | "sequence_exhausted"
  | "sequence_gap"
  | "length_over_bound"
  | "connection_zero"
  | "connection_not_zero"
  | "empty_data"
  | "payload_length_mismatch"
  | "string_over_payload"
  | "invalid_utf8"
  | "generation_zero"
  | "sddl_kind"
  | "peer_closed_reason"
  | "bound_flags_reserved";

/**
 * What the structural log records. The PAYLOAD is deliberately absent: it is
 * peer content, and protocol section 10 permits the plane, the type, the
 * length, the sequence and the reason.
 */
export interface PipeFrontMalformed {
  readonly reason: PipeFrontMalformedReason;
  readonly plane: PipeFrontPlane;
  readonly type: number;
  readonly connection: number;
  readonly sequence: bigint;
  readonly length: number;
}

export type PipeFrontDecodeEvent =
  | { readonly kind: "frame"; readonly frame: PipeFrontFrame }
  | { readonly kind: "malformed"; readonly malformed: PipeFrontMalformed };

/**
 * An ENCODER refusal. It is always a bug in this process (protocol section 9:
 * "a refusal that would not fit is a host bug reported loudly, never
 * truncated"), so it throws rather than returning a result: there is no caller
 * that can sensibly continue.
 */
export class PipeFrontEncodeError extends Error {
  public constructor(public readonly reason: string, detail: string) {
    super(`pipe-front encode refused (${reason}): ${detail}`);
    this.name = "PipeFrontEncodeError";
  }
}

// ---------------------------------------------------------------- encoding

class PayloadWriter {
  private readonly parts: Uint8Array[] = [];
  private total = 0;

  public u8(value: number): void {
    this.push(new Uint8Array([value & 0xff]));
  }

  public u16(value: number): void {
    const buffer = new Uint8Array(2);
    new DataView(buffer.buffer).setUint16(0, value & 0xffff, true);
    this.push(buffer);
  }

  public u32(value: number): void {
    const buffer = new Uint8Array(4);
    new DataView(buffer.buffer).setUint32(0, value >>> 0, true);
    this.push(buffer);
  }

  public u64(value: bigint): void {
    const buffer = new Uint8Array(8);
    new DataView(buffer.buffer).setBigUint64(0, value, true);
    this.push(buffer);
  }

  public str(value: string, field: string): void {
    const bytes = textEncoder.encode(value);
    if (bytes.length > 0xffff) {
      throw new PipeFrontEncodeError(
        "string_too_long",
        `${field} is ${bytes.length} bytes; the u16 length prefix holds 65535`,
      );
    }
    this.u16(bytes.length);
    this.push(bytes);
  }

  public bytes(value: Uint8Array): void {
    this.push(value);
  }

  public finish(): Uint8Array {
    const out = new Uint8Array(this.total);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  private push(part: Uint8Array): void {
    this.parts.push(part);
    this.total += part.length;
  }
}

function requireU32(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new PipeFrontEncodeError("field_range", `${field} = ${value}`);
  }
  return value;
}

function requireU16(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new PipeFrontEncodeError("field_range", `${field} = ${value}`);
  }
  return value;
}

function requireU8(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new PipeFrontEncodeError("field_range", `${field} = ${value}`);
  }
  return value;
}

function encodeBody(frame: PipeFrontFrame): Uint8Array {
  const writer = new PayloadWriter();
  switch (frame.type) {
    case "HELLO":
      writer.u16(requireU16(frame.protocolVersion, "protocolVersion"));
      writer.u8(requireU8(frame.sddlKind, "sddlKind"));
      writer.u16(requireU16(frame.maxRaw, "maxRaw"));
      writer.u32(requireU32(frame.creditBytes, "creditBytes"));
      writer.u32(requireU32(frame.chunkBytes, "chunkBytes"));
      writer.u32(requireU32(frame.handshakeDeadlineMs, "handshakeDeadlineMs"));
      writer.str(frame.pipeName, "pipeName");
      writer.str(frame.timeoutRefusalBytes, "timeoutRefusalBytes");
      break;
    case "ADMIT":
    case "LOCK":
      writer.u32(requireU32(frame.admissionEpoch, "admissionEpoch"));
      break;
    case "REFUSE":
      writer.str(frame.bytes, "bytes");
      break;
    case "CREDIT":
      writer.u32(requireU32(frame.bytes, "bytes"));
      break;
    case "PAUSE":
    case "RESUME":
    case "CLOSE":
    case "OPEN":
    case "QUIT_ACK":
    case "END":
      break;
    case "QUIT":
      writer.u32(requireU32(frame.deadlineMs, "deadlineMs"));
      break;
    case "PING":
    case "PONG":
      writer.u64(frame.nonce);
      break;
    case "HELLO_ACK":
      writer.u16(requireU16(frame.protocolVersion, "protocolVersion"));
      if (frame.announcedGeneration === 0) {
        throw new PipeFrontEncodeError(
          "generation_zero",
          "HELLO_ACK must carry a fresh non-zero generation",
        );
      }
      writer.u32(requireU32(frame.announcedGeneration, "announcedGeneration"));
      writer.u32(requireU32(frame.pid, "pid"));
      writer.str(frame.frontVersion, "frontVersion");
      writer.str(frame.buildHash, "buildHash");
      break;
    case "BOUND":
      if ((requireU8(frame.flagsApplied, "flagsApplied") & ~BOUND_FLAGS_MASK) !== 0) {
        throw new PipeFrontEncodeError(
          "bound_flags_reserved",
          `flagsApplied = ${frame.flagsApplied}`,
        );
      }
      writer.u8(frame.flagsApplied);
      writer.str(frame.pipeName, "pipeName");
      break;
    case "WRITE_DONE":
      writer.u64(frame.throughSequence);
      break;
    case "PEER_CLOSED":
      writer.u8(PIPE_FRONT_PEER_CLOSED_REASONS[frame.reason]);
      writer.u64(frame.throughDataSequence);
      break;
    case "LOCK_ACK":
      writer.u32(requireU32(frame.admissionEpoch, "admissionEpoch"));
      writer.u32(requireU32(frame.closedCount, "closedCount"));
      break;
    case "ERROR":
      writer.u16(requireU16(frame.code, "code"));
      writer.u32(requireU32(frame.count, "count"));
      break;
    case "DATA":
      if (frame.payload.length === 0) {
        throw new PipeFrontEncodeError("empty_data", "DATA carries no bytes");
      }
      writer.bytes(frame.payload);
      break;
    default: {
      const exhaustive: never = frame;
      throw new PipeFrontEncodeError(
        "unknown_type",
        JSON.stringify(exhaustive),
      );
    }
  }
  return writer.finish();
}

/**
 * Encode one frame. THROWS on anything the protocol forbids, including a
 * refusal string that would not fit the control bound: the host encoder is the
 * enforcement point named in protocol section 9.
 */
export function encodePipeFrontFrame(frame: PipeFrontFrame): Uint8Array {
  if (!planeCarries(frame.plane, frame.type)) {
    throw new PipeFrontEncodeError(
      "type_not_on_plane",
      `${frame.type} on plane ${frame.plane}`,
    );
  }
  const bootstrap = frame.type === "HELLO" || frame.type === "HELLO_ACK";
  requireU32(frame.generation, "generation");
  if (bootstrap ? frame.generation !== 0 : frame.generation === 0) {
    throw new PipeFrontEncodeError(
      "bad_generation",
      `${frame.type} carries generation ${frame.generation}`,
    );
  }
  requireU32(frame.connection, "connection");
  const mustBeZero = CONNECTION_MUST_BE_ZERO.has(frame.type);
  if (mustBeZero && frame.connection !== 0) {
    throw new PipeFrontEncodeError(
      "connection_not_zero",
      `${frame.type} carries connection ${frame.connection}`,
    );
  }
  if (!mustBeZero && frame.connection === 0) {
    throw new PipeFrontEncodeError("connection_zero", frame.type);
  }
  if (frame.sequence < 1n || frame.sequence >= PIPE_FRONT_SEQUENCE_EXHAUSTED) {
    throw new PipeFrontEncodeError(
      "sequence_range",
      `sequence = ${frame.sequence}`,
    );
  }

  const body = encodeBody(frame);
  const bound = pipeFrontPayloadBound(frame.plane);
  if (body.length > bound) {
    throw new PipeFrontEncodeError(
      "length_over_bound",
      `${frame.type} payload is ${body.length} bytes; plane ${frame.plane} bounds it at ${bound}`,
    );
  }

  const out = new Uint8Array(PIPE_FRONT_HEADER_BYTES + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, PIPE_FRONT_MAGIC, true);
  view.setUint32(4, frame.generation, true);
  view.setUint32(8, frame.connection, true);
  view.setBigUint64(12, frame.sequence, true);
  view.setUint8(20, PIPE_FRONT_FRAME_TYPES[frame.type]);
  view.setUint8(21, 0);
  view.setUint16(22, 0, true);
  view.setUint32(24, body.length, true);
  out.set(body, PIPE_FRONT_HEADER_BYTES);
  return out;
}

// ---------------------------------------------------------------- decoding

class PayloadReader {
  private offset = 0;

  public constructor(private readonly bytes: Uint8Array) {}

  public get remaining(): number {
    return this.bytes.length - this.offset;
  }

  public u8(): number {
    return this.bytes[this.offset++]!;
  }

  public u16(): number {
    const value = this.view().getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  public u32(): number {
    const value = this.view().getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  public u64(): bigint {
    const value = this.view().getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  /** Raw bytes of a `str` field, or `null` when the length runs past the payload. */
  public strBytes(): Uint8Array | null {
    if (this.remaining < 2) {
      return null;
    }
    const length = this.u16();
    if (this.remaining < length) {
      return null;
    }
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  private view(): DataView {
    return new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    );
  }
}

interface ParsedHeader {
  readonly generation: number;
  readonly connection: number;
  readonly sequence: bigint;
  readonly type: number;
  readonly flags: number;
  readonly reserved: number;
  readonly length: number;
}

function parseHeader(bytes: Uint8Array): ParsedHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    generation: view.getUint32(4, true),
    connection: view.getUint32(8, true),
    sequence: view.getBigUint64(12, true),
    type: view.getUint8(20),
    flags: view.getUint8(21),
    reserved: view.getUint16(22, true),
    length: view.getUint32(24, true),
  };
}

function magicOf(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    0,
    true,
  );
}

export interface PipeFrontDecoderOptions {
  readonly plane: PipeFrontPlane;
  /** The negotiated generation, or `0` while the bootstrap pair is expected. */
  readonly generation: number;
  /** The sequence the next frame must carry. Defaults to `1`. */
  readonly sequence?: bigint;
}

/**
 * An incremental decoder for ONE plane.
 *
 * Bytes may arrive in any chunking, including one byte at a time, and the
 * decoder retains at most `pipeFrontRetentionBound(plane)` bytes because the
 * header - the plane's payload bound included - is validated in full before a
 * payload byte is kept.
 *
 * A malformed frame is TERMINAL, matching protocol section 10: the position in
 * the stream is unknown after a framing fault, so the decoder latches the
 * failure, drops its buffer, and returns nothing from every later `push`. The
 * caller kills the front (main's side) or exits (the front's side); there is no
 * resynchronisation to offer.
 */
export class PipeFrontFrameDecoder {
  private readonly plane: PipeFrontPlane;
  private readonly bound: number;
  private generation: number;
  private expected: bigint;
  private pending = new Uint8Array(0);
  private latched: PipeFrontMalformed | null = null;

  public constructor(options: PipeFrontDecoderOptions) {
    this.plane = options.plane;
    this.bound = pipeFrontPayloadBound(options.plane);
    this.generation = options.generation;
    this.expected = options.sequence ?? 1n;
  }

  /** The malformed frame that ended this decoder, or `null` while it is live. */
  public get failure(): PipeFrontMalformed | null {
    return this.latched;
  }

  /** Bytes of an incomplete frame currently held. Never above the retention bound. */
  public get retainedBytes(): number {
    return this.pending.length;
  }

  /** The sequence the next frame must carry. */
  public get expectedSequence(): bigint {
    return this.expected;
  }

  /**
   * Adopt the generation `HELLO_ACK` announced. Every later frame on this plane
   * must carry it, and the bootstrap generation `0` becomes invalid.
   */
  public adoptGeneration(generation: number): void {
    this.generation = generation;
  }

  public push(chunk: Uint8Array): readonly PipeFrontDecodeEvent[] {
    if (this.latched !== null || chunk.length === 0) {
      return [];
    }
    const merged = new Uint8Array(this.pending.length + chunk.length);
    merged.set(this.pending, 0);
    merged.set(chunk, this.pending.length);
    this.pending = merged;

    const events: PipeFrontDecodeEvent[] = [];
    for (;;) {
      if (this.pending.length < PIPE_FRONT_HEADER_BYTES) {
        return events;
      }
      const header = parseHeader(
        this.pending.subarray(0, PIPE_FRONT_HEADER_BYTES),
      );
      const headerFault = this.validateHeader(
        magicOf(this.pending.subarray(0, PIPE_FRONT_HEADER_BYTES)),
        header,
      );
      if (headerFault !== null) {
        events.push(this.fail(headerFault, header));
        return events;
      }
      const total = PIPE_FRONT_HEADER_BYTES + header.length;
      if (this.pending.length < total) {
        return events;
      }
      const payload = this.pending.subarray(PIPE_FRONT_HEADER_BYTES, total);
      const decoded = decodeBody(header, payload);
      if (typeof decoded === "string") {
        events.push(this.fail(decoded, header));
        return events;
      }
      this.pending = this.pending.slice(total);
      this.expected = header.sequence + 1n;
      if (decoded.type === "HELLO_ACK") {
        // A plane 4 reader LEARNS the generation here (protocol section 4);
        // planes 3, 5 and 6 are told it by their owner through
        // `adoptGeneration`.
        this.generation = decoded.announcedGeneration;
      }
      events.push({
        kind: "frame",
        frame: {
          plane: this.plane,
          generation: header.generation,
          connection: header.connection,
          sequence: header.sequence,
          ...decoded,
        } as PipeFrontFrame,
      });
    }
  }

  /** Protocol section 10.1: the header phase, in its frozen order. */
  private validateHeader(
    magic: number,
    header: ParsedHeader,
  ): PipeFrontMalformedReason | null {
    if (magic !== PIPE_FRONT_MAGIC) {
      return "bad_magic";
    }
    if (header.flags !== 0) {
      return "flags_set";
    }
    if (header.reserved !== 0) {
      return "reserved_set";
    }
    const type = TYPE_NAME_BY_ID.get(header.type);
    if (type === undefined) {
      return "unknown_type";
    }
    if (!planeCarries(this.plane, type)) {
      return "type_not_on_plane";
    }
    // The bootstrap pair is legal ONLY while this decoder is still at
    // generation 0. Once a generation is adopted a further HELLO / HELLO_ACK
    // is bad_generation, so a second bootstrap frame can never re-point a live
    // reader at a new generation.
    if (type === "HELLO" || type === "HELLO_ACK") {
      if (this.generation !== 0 || header.generation !== 0) {
        return "bad_generation";
      }
    } else if (this.generation === 0 || header.generation !== this.generation) {
      return "bad_generation";
    }
    if (header.sequence >= PIPE_FRONT_SEQUENCE_EXHAUSTED) {
      return "sequence_exhausted";
    }
    if (header.sequence !== this.expected) {
      return "sequence_gap";
    }
    if (header.length > this.bound) {
      return "length_over_bound";
    }
    if (CONNECTION_MUST_BE_ZERO.has(type)) {
      return header.connection === 0 ? null : "connection_not_zero";
    }
    return header.connection === 0 ? "connection_zero" : null;
  }

  private fail(
    reason: PipeFrontMalformedReason,
    header: ParsedHeader,
  ): PipeFrontDecodeEvent {
    this.latched = {
      reason,
      plane: this.plane,
      type: header.type,
      connection: header.connection,
      sequence: header.sequence,
      length: header.length,
    };
    this.pending = new Uint8Array(0);
    return { kind: "malformed", malformed: this.latched };
  }
}

function decodeString(
  reader: PayloadReader,
): { readonly value: string } | PipeFrontMalformedReason {
  const bytes = reader.strBytes();
  if (bytes === null) {
    return "string_over_payload";
  }
  try {
    return { value: textDecoder.decode(bytes) };
  } catch {
    return "invalid_utf8";
  }
}

/** Protocol section 10.1: the payload phase, in its frozen order. */
function decodeBody(
  header: ParsedHeader,
  payload: Uint8Array,
): PipeFrontBody | PipeFrontMalformedReason {
  const type = TYPE_NAME_BY_ID.get(header.type)!;
  if (type === "DATA") {
    return payload.length === 0
      ? "empty_data"
      : { type, payload: payload.slice() };
  }

  const fixed: Record<string, number> = {
    HELLO: 17, ADMIT: 4, REFUSE: 2, CREDIT: 4, PAUSE: 0, RESUME: 0, CLOSE: 0,
    LOCK: 4, QUIT: 4, PING: 8,
    HELLO_ACK: 10, BOUND: 3, OPEN: 0, WRITE_DONE: 8, PEER_CLOSED: 9,
    LOCK_ACK: 8, QUIT_ACK: 0, PONG: 8, ERROR: 6,
    END: 0,
  };
  if (payload.length < fixed[type]!) {
    return "payload_length_mismatch";
  }

  const reader = new PayloadReader(payload);
  let body: PipeFrontBody;
  switch (type) {
    case "HELLO": {
      const protocolVersion = reader.u16();
      const sddlKind = reader.u8();
      const maxRaw = reader.u16();
      const creditBytes = reader.u32();
      const chunkBytes = reader.u32();
      const handshakeDeadlineMs = reader.u32();
      const pipeName = decodeString(reader);
      if (typeof pipeName === "string") {
        return pipeName;
      }
      const timeoutRefusalBytes = decodeString(reader);
      if (typeof timeoutRefusalBytes === "string") {
        return timeoutRefusalBytes;
      }
      if (reader.remaining !== 0) {
        return "payload_length_mismatch";
      }
      if (sddlKind !== PIPE_FRONT_SDDL_KIND) {
        return "sddl_kind";
      }
      return {
        type, protocolVersion, sddlKind, maxRaw, creditBytes, chunkBytes,
        handshakeDeadlineMs,
        pipeName: pipeName.value,
        timeoutRefusalBytes: timeoutRefusalBytes.value,
      };
    }
    case "ADMIT":
    case "LOCK":
      body = { type, admissionEpoch: reader.u32() };
      break;
    case "REFUSE": {
      const bytes = decodeString(reader);
      if (typeof bytes === "string") {
        return bytes;
      }
      body = { type, bytes: bytes.value };
      break;
    }
    case "CREDIT":
      body = { type, bytes: reader.u32() };
      break;
    case "QUIT":
      body = { type, deadlineMs: reader.u32() };
      break;
    case "PING":
    case "PONG":
      body = { type, nonce: reader.u64() };
      break;
    case "HELLO_ACK": {
      const protocolVersion = reader.u16();
      const announcedGeneration = reader.u32();
      const pid = reader.u32();
      const frontVersion = decodeString(reader);
      if (typeof frontVersion === "string") {
        return frontVersion;
      }
      const buildHash = decodeString(reader);
      if (typeof buildHash === "string") {
        return buildHash;
      }
      if (reader.remaining !== 0) {
        return "payload_length_mismatch";
      }
      if (announcedGeneration === 0) {
        return "generation_zero";
      }
      return {
        type, protocolVersion, announcedGeneration, pid,
        frontVersion: frontVersion.value,
        buildHash: buildHash.value,
      };
    }
    case "BOUND": {
      const flagsApplied = reader.u8();
      const pipeName = decodeString(reader);
      if (typeof pipeName === "string") {
        return pipeName;
      }
      if (reader.remaining !== 0) {
        return "payload_length_mismatch";
      }
      if ((flagsApplied & ~BOUND_FLAGS_MASK) !== 0) {
        return "bound_flags_reserved";
      }
      return { type, flagsApplied, pipeName: pipeName.value };
    }
    case "WRITE_DONE":
      body = { type, throughSequence: reader.u64() };
      break;
    case "PEER_CLOSED": {
      const raw = reader.u8();
      const throughDataSequence = reader.u64();
      if (reader.remaining !== 0) {
        return "payload_length_mismatch";
      }
      const reason = pipeFrontPeerClosedReasonName(raw);
      if (reason === null) {
        return "peer_closed_reason";
      }
      return { type, reason, throughDataSequence };
    }
    case "LOCK_ACK":
      body = {
        type,
        admissionEpoch: reader.u32(),
        closedCount: reader.u32(),
      };
      break;
    case "ERROR":
      body = { type, code: reader.u16(), count: reader.u32() };
      break;
    case "PAUSE":
    case "RESUME":
    case "CLOSE":
    case "OPEN":
    case "QUIT_ACK":
    case "END":
      body = { type };
      break;
    default:
      return "unknown_type";
  }
  return reader.remaining === 0 ? body : "payload_length_mismatch";
}

/** The `PEER_CLOSED` reason name for a wire value, or `null` when undefined. */
export function pipeFrontPeerClosedReasonName(
  value: number,
): PipeFrontPeerClosedReason | null {
  for (const [name, id] of Object.entries(PIPE_FRONT_PEER_CLOSED_REASONS)) {
    if (id === value) {
      return name as PipeFrontPeerClosedReason;
    }
  }
  return null;
}
