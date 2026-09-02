/**
 * The internal main<->front wire, executed against the GOLDEN VECTORS.
 *
 * `pipe-front-vectors.json` is the one fixture both codecs agree on: this suite
 * runs it against the TypeScript codec and `bridge/internal/front/frames` runs
 * the SAME FILE, by path, against the Go one. Neither shares a line with the
 * other, so a drift shows up as a red test on one side rather than as a front
 * that relays nothing.
 *
 * Every vector is proven BOTH WAYS where it is a valid frame - bytes decode to
 * the named fields, and those fields encode back to exactly those bytes - and
 * decode-only where it is malformed, because a malformed frame has no encoder
 * that would produce it.
 *
 * The split-boundary suite is the reason an incremental decoder exists at all:
 * a pipe hands over whatever the OS had, so every frame boundary in the fixture
 * is also fed one byte at a time and under a seeded pseudo-random chunking.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  encodePipeFrontFrame,
  PipeFrontFrameDecoder,
  PIPE_FRONT_BOUND_FLAGS,
  PIPE_FRONT_CONTROL_PAYLOAD_MAX_BYTES,
  PIPE_FRONT_DATA_PAYLOAD_MAX_BYTES,
  PIPE_FRONT_DATA_TYPES,
  PIPE_FRONT_ERROR_CODES,
  PIPE_FRONT_FRONT_TO_MAIN_CONTROL_TYPES,
  PIPE_FRONT_HEADER_BYTES,
  PIPE_FRONT_MAGIC,
  PIPE_FRONT_MAIN_TO_FRONT_CONTROL_TYPES,
  PIPE_FRONT_PEER_CLOSED_REASONS,
  PIPE_FRONT_PLANE,
  PIPE_FRONT_PROTOCOL_VERSION,
  pipeFrontPayloadBound,
  pipeFrontRetentionBound,
  type PipeFrontFrame,
  type PipeFrontPeerClosedReason,
  type PipeFrontPlane,
} from "@vex-agent/mcp/pipe-front-frames.js";

interface ExpectedFrame {
  readonly kind: "frame";
  readonly type: string;
  readonly generation: number;
  readonly connection: number;
  readonly sequence: string;
  readonly payload: Record<string, unknown>;
}

interface ExpectedMalformed {
  readonly kind: "malformed";
  readonly reason: string;
}

/**
 * A multi-fault row: bytes that violate BOTH named steps of the frozen
 * validation order, whose single expected reason is the EARLIER one.
 */
interface PrecedenceClaim {
  readonly earlier: string;
  readonly later: string;
}

interface FrameVector {
  readonly name: string;
  readonly plane: PipeFrontPlane;
  readonly expectedGeneration: number;
  readonly expectedSequence: string;
  readonly hex: string;
  readonly expect: ExpectedFrame | ExpectedMalformed;
  readonly precedence?: PrecedenceClaim;
  readonly note?: string;
}

interface StreamVector {
  readonly name: string;
  readonly plane: PipeFrontPlane;
  readonly expectedGeneration: number;
  readonly startSequence: string;
  readonly hex: string;
  readonly frames: readonly ExpectedFrame[];
}

interface Vectors {
  readonly protocolVersion: number;
  readonly header: {
    readonly bytes: number;
    readonly magic: number;
    readonly magicWireBytes: string;
    readonly fields: readonly {
      readonly name: string;
      readonly offset: number;
      readonly size: number;
    }[];
  };
  readonly planes: Record<string, number>;
  readonly limits: Record<string, number>;
  readonly types: {
    readonly mainToFrontControl: Record<string, number>;
    readonly frontToMainControl: Record<string, number>;
    readonly data: Record<string, number>;
  };
  readonly connectionRule: {
    readonly mustBeZero: readonly string[];
    readonly mustBeNonZero: readonly string[];
  };
  readonly peerClosedReasons: Record<string, number>;
  readonly boundFlags: Record<string, number>;
  readonly errorCodes: Record<string, number>;
  readonly malformedReasons: readonly string[];
  readonly validationOrder: readonly string[];
  readonly validationOrderReasons: Record<string, readonly string[]>;
  readonly validationOrderUnsatisfiablePairs: readonly {
    readonly earlier: string;
    readonly later: string;
    /** The step the earlier one is proven against instead, or `null`. */
    readonly provenAgainst: string | null;
    readonly why: string;
  }[];
  readonly frames: readonly FrameVector[];
  readonly streams: readonly StreamVector[];
}

const VECTORS_PATH = path.resolve(
  __dirname,
  "..", "..", "..",
  "vex-agent", "tools", "tool-surface-spec", "studio-mcp",
  "pipe-front-vectors.json",
);

const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as Vectors;

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * The value, or a failure that NAMES what was missing. Every optional the
 * fixture or the decoder hands back is narrowed through here, so a fixture row
 * that disappeared or an event the decoder did not emit fails as itself instead
 * of as a downstream property read on undefined.
 */
function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${what} is missing`);
  }
  return value;
}

/** Rebuild the codec's frame object from a fixture row, with no codec help. */
function frameFromVector(vector: FrameVector, expected: ExpectedFrame): PipeFrontFrame {
  const p = expected.payload;
  const envelope = {
    plane: vector.plane,
    generation: expected.generation,
    connection: expected.connection,
    sequence: BigInt(expected.sequence),
  };
  switch (expected.type) {
    case "HELLO":
      return { ...envelope, type: "HELLO",
        protocolVersion: p["protocolVersion"] as number,
        sddlKind: p["sddlKind"] as number,
        maxRaw: p["maxRaw"] as number,
        creditBytes: p["creditBytes"] as number,
        chunkBytes: p["chunkBytes"] as number,
        handshakeDeadlineMs: p["handshakeDeadlineMs"] as number,
        initialAdmissionEpoch: p["initialAdmissionEpoch"] as number,
        pipeName: p["pipeName"] as string,
        timeoutRefusalBytes: p["timeoutRefusalBytes"] as string };
    case "ADMIT":
      return { ...envelope, type: "ADMIT", admissionEpoch: p["admissionEpoch"] as number };
    case "REFUSE":
      return { ...envelope, type: "REFUSE", bytes: p["bytes"] as string };
    case "CREDIT":
      return { ...envelope, type: "CREDIT", bytes: p["bytes"] as number };
    case "PAUSE":
      return { ...envelope, type: "PAUSE" };
    case "RESUME":
      return { ...envelope, type: "RESUME" };
    case "CLOSE":
      return { ...envelope, type: "CLOSE" };
    case "LOCK":
      return { ...envelope, type: "LOCK", admissionEpoch: p["admissionEpoch"] as number };
    case "QUIT":
      return { ...envelope, type: "QUIT", deadlineMs: p["deadlineMs"] as number };
    case "PING":
      return { ...envelope, type: "PING", nonce: BigInt(p["nonce"] as string) };
    case "HELLO_ACK":
      return { ...envelope, type: "HELLO_ACK",
        protocolVersion: p["protocolVersion"] as number,
        announcedGeneration: p["announcedGeneration"] as number,
        pid: p["pid"] as number,
        frontVersion: p["frontVersion"] as string,
        buildHash: p["buildHash"] as string };
    case "BOUND":
      return { ...envelope, type: "BOUND",
        flagsApplied: p["flagsApplied"] as number,
        pipeName: p["pipeName"] as string };
    case "OPEN":
      return { ...envelope, type: "OPEN" };
    case "WRITE_DONE":
      return { ...envelope, type: "WRITE_DONE",
        ackThroughSequence: BigInt(p["ackThroughSequence"] as string) };
    case "PEER_CLOSED":
      return { ...envelope, type: "PEER_CLOSED",
        reason: reasonName(p["reason"] as number),
        throughDataSequence: BigInt(p["throughDataSequence"] as string) };
    case "LOCK_ACK":
      return { ...envelope, type: "LOCK_ACK",
        admissionEpoch: p["admissionEpoch"] as number,
        closedCount: p["closedCount"] as number };
    case "QUIT_ACK":
      return { ...envelope, type: "QUIT_ACK" };
    case "PONG":
      return { ...envelope, type: "PONG", nonce: BigInt(p["nonce"] as string) };
    case "ERROR":
      return { ...envelope, type: "ERROR",
        code: p["code"] as number, count: p["count"] as number };
    case "DATA":
      return { ...envelope, type: "DATA", payload: bytesOf(p["payloadHex"] as string) };
    case "END":
      return { ...envelope, type: "END" };
    default:
      throw new Error(`the fixture names a type this test cannot build: ${expected.type}`);
  }
}

function reasonName(value: number): PipeFrontPeerClosedReason {
  const found = Object.entries(PIPE_FRONT_PEER_CLOSED_REASONS).find(
    ([, id]) => id === value,
  );
  if (found === undefined) {
    throw new Error(`the fixture names an undefined PEER_CLOSED reason: ${value}`);
  }
  return found[0] as PipeFrontPeerClosedReason;
}

/** The decoded frame, flattened into the fixture's own vocabulary. */
function payloadOf(frame: PipeFrontFrame): Record<string, unknown> {
  const {
    plane: _plane, generation: _generation, connection: _connection,
    sequence: _sequence, type: _type, ...rest
  } = frame as PipeFrontFrame & Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (typeof value === "bigint") {
      out[key] = String(value);
    } else if (value instanceof Uint8Array) {
      out["payloadHex"] = hexOf(value);
    } else if (key === "reason" && frame.type === "PEER_CLOSED") {
      out[key] = PIPE_FRONT_PEER_CLOSED_REASONS[value as PipeFrontPeerClosedReason];
    } else {
      out[key] = value;
    }
  }
  return out;
}

function decoderFor(vector: FrameVector | StreamVector, sequence: string): PipeFrontFrameDecoder {
  return new PipeFrontFrameDecoder({
    plane: vector.plane,
    generation: vector.expectedGeneration,
    sequence: BigInt(sequence),
  });
}

describe("pipe-front frames: the fixture is this codec's contract", () => {
  it("is the protocol version this codec speaks", () => {
    expect(vectors.protocolVersion).toBe(PIPE_FRONT_PROTOCOL_VERSION);
  });

  it("pins the header layout", () => {
    expect(vectors.header.bytes).toBe(PIPE_FRONT_HEADER_BYTES);
    expect(vectors.header.magic).toBe(PIPE_FRONT_MAGIC);
    // The magic read as ASCII off the wire, little-endian, is "VEXF".
    expect(Buffer.from(vectors.header.magicWireBytes, "hex").toString("ascii")).toBe("VEXF");
    const layout = vectors.header.fields.map((field) => `${field.name}@${field.offset}+${field.size}`);
    expect(layout).toEqual([
      "magic@0+4", "generation@4+4", "connection@8+4", "sequence@12+8",
      "type@20+1", "flags@21+1", "reserved@22+2", "length@24+4",
    ]);
    const last = present(
      vectors.header.fields[vectors.header.fields.length - 1],
      "the last header field",
    );
    expect(last.offset + last.size).toBe(PIPE_FRONT_HEADER_BYTES);
  });

  it("pins the planes, the type ids and the enums", () => {
    expect(vectors.planes).toEqual({
      controlDown: PIPE_FRONT_PLANE.controlDown,
      controlUp: PIPE_FRONT_PLANE.controlUp,
      dataDown: PIPE_FRONT_PLANE.dataDown,
      dataUp: PIPE_FRONT_PLANE.dataUp,
    });
    expect(vectors.types.mainToFrontControl).toEqual(PIPE_FRONT_MAIN_TO_FRONT_CONTROL_TYPES);
    expect(vectors.types.frontToMainControl).toEqual(PIPE_FRONT_FRONT_TO_MAIN_CONTROL_TYPES);
    expect(vectors.types.data).toEqual(PIPE_FRONT_DATA_TYPES);
    expect(vectors.peerClosedReasons).toEqual(PIPE_FRONT_PEER_CLOSED_REASONS);
    expect(vectors.boundFlags).toEqual(PIPE_FRONT_BOUND_FLAGS);
    // The front's structural codes are a CLOSED set: main resolves every code
    // it logs, and an undefined one is a malformed frame.
    expect(vectors.errorCodes).toEqual(PIPE_FRONT_ERROR_CODES);
  });

  it("pins the bounds", () => {
    expect(vectors.limits["controlPayloadMaxBytes"]).toBe(PIPE_FRONT_CONTROL_PAYLOAD_MAX_BYTES);
    expect(vectors.limits["dataPayloadMaxBytes"]).toBe(PIPE_FRONT_DATA_PAYLOAD_MAX_BYTES);
    expect(vectors.limits["maxRetainedPartialControlFrameBytes"]).toBe(
      pipeFrontRetentionBound(PIPE_FRONT_PLANE.controlDown),
    );
    expect(vectors.limits["maxRetainedPartialDataFrameBytes"]).toBe(
      pipeFrontRetentionBound(PIPE_FRONT_PLANE.dataUp),
    );
    // The aggregate main retains from plane 6: every raw connection's full
    // credit window plus one decoder's maximum partial frame.
    expect(vectors.limits["aggregateFrontToMainRetainedBytes"]).toBe(
      present(vectors.limits["maxRawConnections"], "limits.maxRawConnections") *
        present(vectors.limits["creditBytesPerConnection"], "limits.creditBytesPerConnection") +
        pipeFrontRetentionBound(PIPE_FRONT_PLANE.dataUp),
    );
  });

  it("covers every frame type in both directions", () => {
    const covered = new Set(
      vectors.frames
        .filter((vector) => vector.expect.kind === "frame")
        .map((vector) => (vector.expect as ExpectedFrame).type),
    );
    const declared = [
      ...Object.keys(vectors.types.mainToFrontControl),
      ...Object.keys(vectors.types.frontToMainControl),
      ...Object.keys(vectors.types.data),
    ];
    expect([...declared].filter((type) => !covered.has(type))).toEqual([]);
  });

  it("covers every malformed reason the protocol names", () => {
    const covered = new Set(
      vectors.frames
        .filter((vector) => vector.expect.kind === "malformed")
        .map((vector) => (vector.expect as ExpectedMalformed).reason),
    );
    expect(vectors.malformedReasons.filter((reason) => !covered.has(reason))).toEqual([]);
  });

  it("proves every adjacent pair of the frozen validation order", () => {
    // Protocol section 10.1: two codecs that checked the same rules in
    // different orders would report DIFFERENT reasons for the same bytes, and
    // the reason is what an operator reads. Every adjacent pair therefore has a
    // frame that violates both, expecting the earlier one - so moving a check
    // turns this red rather than drifting the two implementations apart.
    const order = vectors.validationOrder;
    expect(order.length).toBeGreaterThan(1);
    const rank = new Map(order.map((step, index) => [step, index] as const));

    const covered = new Set<string>();
    for (const vector of vectors.frames) {
      const claim = vector.precedence;
      if (claim === undefined) {
        continue;
      }
      const earlier = present(rank.get(claim.earlier), `order step ${claim.earlier}`);
      const later = present(rank.get(claim.later), `order step ${claim.later}`);
      expect(earlier).toBeLessThan(later);
      expect(vector.expect.kind).toBe("malformed");
      if (vector.expect.kind !== "malformed") {
        continue;
      }
      // The row expects a reason the EARLIER step is able to produce.
      expect(
        present(
          vectors.validationOrderReasons[claim.earlier],
          `the reasons of order step ${claim.earlier}`,
        ),
      ).toContain(vector.expect.reason);
      covered.add(`${claim.earlier}>${claim.later}`);
    }

    const unsatisfiable = new Set(
      vectors.validationOrderUnsatisfiablePairs.map(
        (pair) => `${pair.earlier}>${pair.later}`,
      ),
    );
    const missing = order
      .slice(0, -1)
      .map((step, index) => `${step}>${present(order[index + 1], "the next step")}`)
      .filter((pair) => !covered.has(pair) && !unsatisfiable.has(pair));
    expect(missing).toEqual([]);

    // A pair declared unsatisfiable still has to say how its earlier step is
    // pinned - against another later step, or as the later half of its own
    // predecessor's pair - so the declaration cannot become a way to drop a
    // step from the order entirely.
    for (const pair of vectors.validationOrderUnsatisfiablePairs) {
      expect(rank.get(pair.earlier)).toBeLessThan(
        present(rank.get(pair.later), `order step ${pair.later}`),
      );
      const discharged =
        pair.provenAgainst === null
          ? [...covered].some((claim) => claim.endsWith(`>${pair.earlier}`))
          : covered.has(`${pair.earlier}>${pair.provenAgainst}`);
      expect(discharged).toBe(true);
    }
  });

  it("agrees with the codec about which types name a connection", () => {
    for (const type of vectors.connectionRule.mustBeZero) {
      expect(vectors.connectionRule.mustBeNonZero).not.toContain(type);
    }
    const all = [
      ...vectors.connectionRule.mustBeZero,
      ...vectors.connectionRule.mustBeNonZero,
    ].sort();
    const declared = [
      ...Object.keys(vectors.types.mainToFrontControl),
      ...Object.keys(vectors.types.frontToMainControl),
      ...Object.keys(vectors.types.data),
    ].sort();
    expect(all).toEqual(declared);
  });
});

describe("pipe-front frames: decode", () => {
  it.each(vectors.frames)("$name", (vector) => {
    const decoder = decoderFor(vector, vector.expectedSequence);
    const events = decoder.push(bytesOf(vector.hex));
    expect(events).toHaveLength(1);
    const event = present(events[0], "the decoded event");

    if (vector.expect.kind === "malformed") {
      expect(event.kind).toBe("malformed");
      if (event.kind !== "malformed") {
        return;
      }
      expect(event.malformed.reason).toBe(vector.expect.reason);
      expect(event.malformed.plane).toBe(vector.plane);
      // A malformed frame is TERMINAL: the decoder drops its buffer and
      // returns nothing ever again, and it never reports the payload.
      expect(decoder.retainedBytes).toBe(0);
      expect(decoder.push(bytesOf(vector.hex))).toEqual([]);
      expect(decoder.failure).toEqual(event.malformed);
      expect(Object.keys(event.malformed)).toEqual(
        expect.arrayContaining(["reason", "plane", "type", "connection", "sequence", "length"]),
      );
      expect(Object.keys(event.malformed)).not.toContain("payload");
      return;
    }

    expect(event.kind).toBe("frame");
    if (event.kind !== "frame") {
      return;
    }
    const expected = vector.expect;
    expect(event.frame.type).toBe(expected.type);
    expect(event.frame.plane).toBe(vector.plane);
    expect(event.frame.generation).toBe(expected.generation);
    expect(event.frame.connection).toBe(expected.connection);
    expect(event.frame.sequence).toBe(BigInt(expected.sequence));
    expect(payloadOf(event.frame)).toEqual(expected.payload);
    expect(decoder.retainedBytes).toBe(0);
    expect(decoder.expectedSequence).toBe(BigInt(expected.sequence) + 1n);
  });
});

describe("pipe-front frames: encode", () => {
  const valid = vectors.frames.filter((vector) => vector.expect.kind === "frame");

  it.each(valid)("$name encodes back to exactly the fixture bytes", (vector) => {
    const frame = frameFromVector(vector, vector.expect as ExpectedFrame);
    expect(hexOf(encodePipeFrontFrame(frame))).toBe(vector.hex);
  });

  it("refuses a refusal line that would not fit the control bound", () => {
    // Protocol section 9: a refusal that would not fit is a HOST BUG reported
    // loudly, never truncated. One byte past the bound is the boundary case.
    const overBound: PipeFrontFrame = {
      plane: PIPE_FRONT_PLANE.controlDown,
      generation: 0x2a7f1c04,
      connection: 8,
      sequence: 1n,
      type: "REFUSE",
      bytes: "R".repeat(PIPE_FRONT_CONTROL_PAYLOAD_MAX_BYTES - 1),
    };
    expect(() => encodePipeFrontFrame(overBound)).toThrowError(/length_over_bound/);
  });

  it("refuses a data payload past the chunk bound", () => {
    const overBound: PipeFrontFrame = {
      plane: PIPE_FRONT_PLANE.dataDown,
      generation: 0x2a7f1c04,
      connection: 7,
      sequence: 1n,
      type: "DATA",
      payload: new Uint8Array(PIPE_FRONT_DATA_PAYLOAD_MAX_BYTES + 1),
    };
    expect(() => encodePipeFrontFrame(overBound)).toThrowError(/length_over_bound/);
  });

  it("refuses a type on the wrong plane and a connection rule violation", () => {
    expect(() =>
      encodePipeFrontFrame({
        plane: PIPE_FRONT_PLANE.controlUp,
        generation: 0x2a7f1c04, connection: 7, sequence: 1n,
        type: "ADMIT", admissionEpoch: 1,
      }),
    ).toThrowError(/type_not_on_plane/);
    expect(() =>
      encodePipeFrontFrame({
        plane: PIPE_FRONT_PLANE.controlDown,
        generation: 0x2a7f1c04, connection: 5, sequence: 1n,
        type: "LOCK", admissionEpoch: 1,
      }),
    ).toThrowError(/connection_not_zero/);
    expect(() =>
      encodePipeFrontFrame({
        plane: PIPE_FRONT_PLANE.dataUp,
        generation: 0x2a7f1c04, connection: 0, sequence: 1n,
        type: "DATA", payload: Uint8Array.from([1]),
      }),
    ).toThrowError(/connection_zero/);
  });

  it("refuses a u64 field outside u64, which setBigUint64 would silently wrap", () => {
    // `DataView.setBigUint64` accepts -1n and 2^64 alike and writes eight
    // perfectly well-formed bytes for each, so a relay bug would reach the peer
    // as a plausible nonce or sequence rather than as a fault in this process.
    const base = {
      plane: PIPE_FRONT_PLANE.controlDown,
      generation: 0x2a7f1c04,
      connection: 0,
      sequence: 1n,
    } as const;
    expect(() =>
      encodePipeFrontFrame({ ...base, type: "PING", nonce: -1n }),
    ).toThrowError(/field_range.*nonce/);
    expect(() =>
      encodePipeFrontFrame({ ...base, type: "PING", nonce: 2n ** 64n }),
    ).toThrowError(/field_range.*nonce/);

    const upstream = {
      plane: PIPE_FRONT_PLANE.controlUp,
      generation: 0x2a7f1c04,
      connection: 7,
      sequence: 1n,
    } as const;
    expect(() =>
      encodePipeFrontFrame({
        ...upstream, type: "WRITE_DONE", ackThroughSequence: -1n,
      }),
    ).toThrowError(/field_range.*ackThroughSequence/);
    expect(() =>
      encodePipeFrontFrame({
        ...upstream, type: "WRITE_DONE", ackThroughSequence: 2n ** 64n,
      }),
    ).toThrowError(/field_range.*ackThroughSequence/);
    expect(() =>
      encodePipeFrontFrame({
        ...upstream, type: "PEER_CLOSED",
        reason: "peer_eof", throughDataSequence: -1n,
      }),
    ).toThrowError(/field_range.*throughDataSequence/);

    // The boundary itself still encodes: 2^64-1 is a legal payload value even
    // though it is an illegal HEADER sequence.
    expect(() =>
      encodePipeFrontFrame({
        ...upstream, type: "WRITE_DONE", ackThroughSequence: 2n ** 64n - 1n,
      }),
    ).not.toThrow();
  });

  it("refuses an ERROR code outside the frozen closed set", () => {
    const errorFrame = (code: number): PipeFrontFrame => ({
      plane: PIPE_FRONT_PLANE.controlUp,
      generation: 0x2a7f1c04,
      connection: 0,
      sequence: 1n,
      type: "ERROR",
      code,
      count: 1,
    });
    expect(() => encodePipeFrontFrame(errorFrame(0))).toThrowError(/error_code/);
    expect(() => encodePipeFrontFrame(errorFrame(0x1007))).toThrowError(/error_code/);
    expect(() =>
      encodePipeFrontFrame(errorFrame(PIPE_FRONT_ERROR_CODES.plane_read_failed)),
    ).not.toThrow();
  });

  it("refuses a non-bootstrap frame with generation zero", () => {
    expect(() =>
      encodePipeFrontFrame({
        plane: PIPE_FRONT_PLANE.controlDown,
        generation: 0, connection: 0, sequence: 1n,
        type: "PING", nonce: 1n,
      }),
    ).toThrowError(/bad_generation/);
  });
});

describe("pipe-front frames: streams and split boundaries", () => {
  it.each(vectors.streams)("$name decodes in one push", (stream) => {
    const decoder = decoderFor(stream, stream.startSequence);
    const events = decoder.push(bytesOf(stream.hex));
    expect(events.map((event) => (event.kind === "frame" ? event.frame.type : "malformed")))
      .toEqual(stream.frames.map((frame) => frame.type));
    events.forEach((event, index) => {
      if (event.kind !== "frame") {
        throw new Error("a stream vector produced a malformed event");
      }
      const expected = present(stream.frames[index], `the expected frame at index ${index}`);
      expect(event.frame.connection).toBe(expected.connection);
      expect(event.frame.sequence).toBe(BigInt(expected.sequence));
      expect(payloadOf(event.frame)).toEqual(expected.payload);
    });
    expect(decoder.retainedBytes).toBe(0);
  });

  it.each(vectors.streams)("$name decodes one byte at a time", (stream) => {
    const bytes = bytesOf(stream.hex);
    const decoder = decoderFor(stream, stream.startSequence);
    const seen: string[] = [];
    for (const byte of bytes) {
      for (const event of decoder.push(Uint8Array.from([byte]))) {
        if (event.kind !== "frame") {
          throw new Error(`byte-at-a-time feeding produced ${event.malformed.reason}`);
        }
        seen.push(event.frame.type);
      }
      expect(decoder.retainedBytes).toBeLessThanOrEqual(pipeFrontRetentionBound(stream.plane));
    }
    expect(seen).toEqual(stream.frames.map((frame) => frame.type));
    expect(decoder.retainedBytes).toBe(0);
  });

  it.each(vectors.streams)("$name decodes under pseudo-random chunking", (stream) => {
    const bytes = bytesOf(stream.hex);
    // A seeded xorshift, so a failure is reproducible rather than a flake.
    for (let seed = 1; seed <= 8; seed += 1) {
      let state = seed * 2654435761;
      const next = (): number => {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        return Math.abs(state);
      };
      const decoder = decoderFor(stream, stream.startSequence);
      const seen: string[] = [];
      let offset = 0;
      while (offset < bytes.length) {
        const size = 1 + (next() % 5000);
        const chunk = bytes.subarray(offset, Math.min(offset + size, bytes.length));
        offset += chunk.length;
        for (const event of decoder.push(chunk)) {
          if (event.kind !== "frame") {
            throw new Error(`seed ${seed} produced ${event.malformed.reason}`);
          }
          seen.push(event.frame.type);
        }
        expect(decoder.retainedBytes).toBeLessThanOrEqual(pipeFrontRetentionBound(stream.plane));
      }
      expect(seen).toEqual(stream.frames.map((frame) => frame.type));
    }
  });

  it("holds a partial frame without emitting anything, and never past the bound", () => {
    const vector = present(
      vectors.frames.find(
        (candidate) => candidate.name === "data at the data payload bound",
      ),
      "the fixture row 'data at the data payload bound'",
    );
    const bytes = bytesOf(vector.hex);
    const decoder = decoderFor(vector, vector.expectedSequence);
    expect(decoder.push(bytes.subarray(0, bytes.length - 1))).toEqual([]);
    expect(decoder.retainedBytes).toBe(bytes.length - 1);
    expect(decoder.retainedBytes).toBeLessThanOrEqual(
      pipeFrontRetentionBound(PIPE_FRONT_PLANE.dataDown),
    );
    const events = decoder.push(bytes.subarray(bytes.length - 1));
    expect(events).toHaveLength(1);
    expect(decoder.retainedBytes).toBe(0);
  });

  it("rejects an over-bound length from the header alone, retaining no payload", () => {
    // The retention bound is only real because the plane's payload bound is
    // enforced at header parse. Feed the 28 header bytes and nothing else.
    const vector = present(
      vectors.frames.find(
        (candidate) => candidate.name === "data length over bound",
      ),
      "the fixture row 'data length over bound'",
    );
    const header = bytesOf(vector.hex);
    expect(header).toHaveLength(PIPE_FRONT_HEADER_BYTES);
    const decoder = decoderFor(vector, vector.expectedSequence);
    const events = decoder.push(header);
    expect(events).toHaveLength(1);
    expect(present(events[0], "the header-only event").kind).toBe("malformed");
    expect(decoder.retainedBytes).toBe(0);
    expect(pipeFrontPayloadBound(PIPE_FRONT_PLANE.dataDown)).toBe(
      PIPE_FRONT_DATA_PAYLOAD_MAX_BYTES,
    );
  });

  it("never exceeds the retention bound DURING a push, not merely after one", () => {
    // The guarantee this measures is the PEAK, which the previous "retained
    // bytes after the call" assertions could not see: a decoder that merged
    // the caller's chunk first would hold all three frames at once here and
    // still report 0 retained on the way out.
    const generation = 0x2a7f1c04;
    const bound = pipeFrontRetentionBound(PIPE_FRONT_PLANE.dataUp);
    const chunk = Buffer.concat(
      [1n, 2n, 3n].map((sequence) =>
        Buffer.from(
          encodePipeFrontFrame({
            plane: PIPE_FRONT_PLANE.dataUp,
            generation,
            connection: 7,
            sequence,
            type: "DATA",
            payload: new Uint8Array(PIPE_FRONT_DATA_PAYLOAD_MAX_BYTES).fill(0x41),
          }),
        ),
      ),
    );
    expect(chunk.length).toBe(3 * bound);

    const decoder = new PipeFrontFrameDecoder({
      plane: PIPE_FRONT_PLANE.dataUp,
      generation,
      sequence: 1n,
    });
    const events = decoder.push(Uint8Array.from(chunk));
    expect(events).toHaveLength(3);
    expect(decoder.retainedBytes).toBe(0);
    expect(decoder.peakRetainedBytes).toBe(bound);
  });

  it("allocates nothing for a body a malformed header declares", () => {
    // A hostile push: 28 bytes claiming 4 GiB, followed by a real megabyte of
    // body in the SAME chunk. The header phase completes first, so the decoder
    // never sizes a buffer from the sender's number.
    const vector = present(
      vectors.frames.find((candidate) => candidate.name === "data length over bound"),
      "the fixture row 'data length over bound'",
    );
    const decoder = decoderFor(vector, vector.expectedSequence);
    const hostile = Buffer.concat([
      Buffer.from(bytesOf(vector.hex)),
      Buffer.alloc(1024 * 1024, 0x42),
    ]);
    const events = decoder.push(Uint8Array.from(hostile));
    expect(events).toHaveLength(1);
    expect(present(events[0], "the hostile-push event").kind).toBe("malformed");
    expect(decoder.retainedBytes).toBe(0);
    expect(decoder.peakRetainedBytes).toBe(PIPE_FRONT_HEADER_BYTES);
  });

  it("adopts a generation ONCE, and never the bootstrap zero", () => {
    const decoder = new PipeFrontFrameDecoder({
      plane: PIPE_FRONT_PLANE.dataUp,
      generation: 0,
    });
    expect(() => decoder.adoptGeneration(0)).toThrowError(/adopt_generation_zero/);
    decoder.adoptGeneration(0x2a7f1c04);
    // A second adoption is the very re-pointing protocol section 4 forbids.
    expect(() => decoder.adoptGeneration(0x2a7f1c05)).toThrowError(
      /adopt_generation_twice/,
    );

    // A decoder constructed with a generation has already spent its adoption.
    const live = new PipeFrontFrameDecoder({
      plane: PIPE_FRONT_PLANE.dataDown,
      generation: 0x2a7f1c04,
    });
    expect(() => live.adoptGeneration(0x2a7f1c05)).toThrowError(
      /adopt_generation_twice/,
    );

    // And so has one that learned it from HELLO_ACK.
    const helloAck = present(
      vectors.frames.find((candidate) => candidate.name === "hello_ack"),
      "the fixture row 'hello_ack'",
    );
    const learned = decoderFor(helloAck, helloAck.expectedSequence);
    expect(learned.push(bytesOf(helloAck.hex))).toHaveLength(1);
    expect(() => learned.adoptGeneration(0x2a7f1c05)).toThrowError(
      /adopt_generation_twice/,
    );
  });

  it("adopts the generation HELLO_ACK announced, then refuses every other one", () => {
    // The plane 4 stream is the bootstrap in miniature: HELLO_ACK under
    // generation 0, then four frames under the announced one. A decoder that
    // did not adopt would call frame 2 bad_generation.
    // The BOOTSTRAP stream: plane 4 read from generation 0. Other plane 4
    // streams start after the generation is already negotiated.
    const stream = present(
      vectors.streams.find(
        (candidate) =>
          candidate.plane === PIPE_FRONT_PLANE.controlUp &&
          candidate.expectedGeneration === 0,
      ),
      "the bootstrap plane 4 stream vector",
    );
    const decoder = decoderFor(stream, stream.startSequence);
    const events = decoder.push(bytesOf(stream.hex));
    expect(events).toHaveLength(stream.frames.length);
    expect(events.every((event) => event.kind === "frame")).toBe(true);

    const first = present(events[0], "the first plane 4 event");
    if (first.kind !== "frame" || first.frame.type !== "HELLO_ACK") {
      throw new Error("the plane 4 stream does not start with HELLO_ACK");
    }
    const announced = first.frame.announcedGeneration;
    // The header of HELLO_ACK is STILL the bootstrap 0 while its payload names
    // the new generation. One name for both would have lost the header's.
    expect(first.frame.generation).toBe(0);
    expect(announced).not.toBe(0);

    // A frame from the front main just killed carries the OLD generation.
    const stale = encodePipeFrontFrame({
      plane: PIPE_FRONT_PLANE.controlUp,
      generation: announced + 1,
      connection: 0,
      sequence: decoder.expectedSequence,
      type: "PONG",
      nonce: 7n,
    });
    const staleEvents = decoder.push(stale);
    expect(staleEvents).toHaveLength(1);
    const staleEvent = present(staleEvents[0], "the stale-generation event");
    expect(staleEvent.kind === "malformed" && staleEvent.malformed.reason).toBe(
      "bad_generation",
    );
  });

  it("refuses a second bootstrap frame once a generation is adopted", () => {
    const helloAck = present(
      vectors.frames.find((candidate) => candidate.name === "hello_ack"),
      "the fixture row 'hello_ack'",
    );
    const bytes = bytesOf(helloAck.hex);
    const decoder = decoderFor(helloAck, helloAck.expectedSequence);
    expect(decoder.push(bytes)).toHaveLength(1);
    // The same bytes again: a live reader must never be re-pointed at a new
    // generation by a second HELLO_ACK.
    const second = new PipeFrontFrameDecoder({
      plane: PIPE_FRONT_PLANE.controlUp,
      generation: 0x2a7f1c04,
      sequence: 1n,
    });
    const events = second.push(bytes);
    expect(events).toHaveLength(1);
    const event = present(events[0], "the second-bootstrap event");
    expect(event.kind === "malformed" && event.malformed.reason).toBe("bad_generation");
  });
});
