/**
 * Decoder for DexScreener's non-standard Avro dialect.
 *
 * The site serializes several endpoints (`/dex/chart/*`, `/dex/log/*`,
 * `/dex/trending/v6`, `/metas/*`) with a hand-rolled writer that resembles
 * Avro but is not Avro. The dialect was read out of the site bundle
 * (`js/pages_catch-all.*.js`) and verified byte-exact against 9 captured
 * responses: every field, no leftovers.
 *
 * | type    | wire form                                                  |
 * |---------|------------------------------------------------------------|
 * | string  | zigzag-varint byte length, then UTF-8                       |
 * | double  | 8 bytes, little-endian IEEE-754                             |
 * | boolean | 1 byte, non-zero is true                                    |
 * | long    | zigzag varint                                              |
 * | enum    | written as a plain STRING, not an Avro enum index           |
 * | record  | fields in declaration order, no framing                     |
 * | union   | zigzag branch index, then that branch                      |
 * | array   | zigzag COUNT then that many items, NO terminating block     |
 * | map     | zigzag COUNT then that many (key, value) pairs              |
 *
 * Two divergences from real Avro matter and are why a library cannot be used:
 * collections carry a plain count with no terminating zero block, and what the
 * schema calls a `long` is frequently written as a `double` (so the schema
 * tables in `dsavro-schemas.ts` say `dsDouble()` where the site's own schema
 * says long).
 *
 * Fail-closed by construction: a decode that does not consume the buffer
 * EXACTLY is a typed error, not a warning. Under a fixed-order format, leftover
 * or missing bytes mean the schema no longer matches the writer, and every
 * field after the divergence is garbage that would otherwise be reported as
 * market data.
 */

import { DexScreenerSiteErrorCodes, siteError } from "../site-errors.js";

/** A decodable type in the dialect. `T` is what it yields. */
export interface DsAvroType<T> {
  /** Name used in decode-failure messages. */
  readonly label: string;
  read(reader: DsAvroReader): T;
}

/** What `T` a schema yields. */
export type DsAvroValue<S> = S extends DsAvroType<infer T> ? T : never;

export interface DsAvroDecodeResult<T> {
  readonly value: T;
  readonly bytesConsumed: number;
  readonly bytesTotal: number;
}

/**
 * Decode `bytes` as `schema`.
 *
 * Throws `DEXSCREENER_DECODE_FAILED` when the buffer runs out, when a count or
 * length is not representable, or when the decode does not land exactly on the
 * end of the buffer.
 */
export function decodeDsAvro<S extends DsAvroType<unknown>>(
  schema: S,
  bytes: Uint8Array
): DsAvroDecodeResult<DsAvroValue<S>> {
  const reader = new DsAvroReader(bytes);
  const value = schema.read(reader) as DsAvroValue<S>;
  if (reader.position !== bytes.byteLength) {
    throw decodeError(
      `decoding ${schema.label} consumed ${reader.position} of ${bytes.byteLength} bytes`,
      "The writer's field order no longer matches this schema table. Nothing decoded past that point can be trusted; update the table against a fresh capture."
    );
  }
  return {
    value,
    bytesConsumed: reader.position,
    bytesTotal: bytes.byteLength,
  };
}

function decodeError(message: string, hint: string): Error {
  return siteError(
    DexScreenerSiteErrorCodes.DECODE_FAILED,
    `DexScreener Avro dialect: ${message}`,
    hint
  );
}

/** Cursor over the response bytes. Owns nothing but its own offset. */
export class DsAvroReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  /** Zigzag varint as `bigint`: never routed through `Number`. */
  readLong(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.offset >= this.bytes.byteLength) {
        throw decodeError(
          `a varint runs past the end of the buffer at offset ${this.offset}`,
          "The response is truncated or the schema table is wrong."
        );
      }
      const byte = this.bytes[this.offset] as number;
      this.offset += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
      if (shift > 70n) {
        throw decodeError(
          `a varint at offset ${this.offset} is longer than 10 bytes`,
          "The bytes are not this dialect, or the schema table is out of step with the writer."
        );
      }
    }
    return (result >> 1n) ^ -(result & 1n);
  }

  /**
   * A varint used as a byte length, an item count or a union branch index.
   *
   * Bounded twice: it must be non-negative, and it cannot exceed the bytes that
   * remain, since every item and every byte of a string costs at least one
   * byte. A negative count is where REAL Avro would put a block-size prefix;
   * this dialect never writes one, so a negative value means the assumption
   * broke and we fail closed instead of silently returning an empty array.
   */
  readCount(what: string): number {
    const raw = this.readLong();
    if (raw < 0n) {
      throw decodeError(
        `${what} is negative (${raw.toString()}) at offset ${this.offset}`,
        "This dialect writes plain counts with no block framing; a negative count means the bytes are not what the schema table expects."
      );
    }
    if (raw > BigInt(this.remaining)) {
      throw decodeError(
        `${what} is ${raw.toString()} but only ${this.remaining} bytes remain`,
        "The response is truncated or the schema table is wrong."
      );
    }
    return Number(raw);
  }

  readString(): string {
    const length = this.readCount("a string length");
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return DECODER.decode(slice);
  }

  readDouble(): number {
    if (this.remaining < 8) {
      throw decodeError(
        `a double needs 8 bytes but ${this.remaining} remain at offset ${this.offset}`,
        "The response is truncated or the schema table is wrong."
      );
    }
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      8
    );
    this.offset += 8;
    return view.getFloat64(0, true);
  }

  readBoolean(): boolean {
    if (this.remaining < 1) {
      throw decodeError(
        `a boolean needs 1 byte but the buffer ends at offset ${this.offset}`,
        "The response is truncated or the schema table is wrong."
      );
    }
    const byte = this.bytes[this.offset] as number;
    this.offset += 1;
    return byte !== 0;
  }
}

/**
 * `subarray` above hands `TextDecoder` a view over the caller's buffer; the
 * decoder copies, so nothing retains it. `fatal: false` keeps issuer-authored
 * token names decodable when they carry invalid UTF-8: the replacement
 * character is visible in the output, whereas throwing would lose the whole
 * page of market data over one bad symbol. Invisible and BiDi characters are a
 * separate concern, handled by the sanitizer on the projection path.
 */
const DECODER = new TextDecoder("utf-8", { fatal: false });

/* ------------------------------------------------------------------ */
/* Type constructors                                                    */
/* ------------------------------------------------------------------ */

export function dsString(): DsAvroType<string> {
  return { label: "string", read: (r) => r.readString() };
}

/** An enum: the site writes the member NAME as a plain string. */
export function dsEnum(): DsAvroType<string> {
  return { label: "enum", read: (r) => r.readString() };
}

export function dsDouble(): DsAvroType<number> {
  return { label: "double", read: (r) => r.readDouble() };
}

export function dsBoolean(): DsAvroType<boolean> {
  return { label: "boolean", read: (r) => r.readBoolean() };
}

/** A true zigzag-varint long, kept as `bigint`. */
export function dsLong(): DsAvroType<bigint> {
  return { label: "long", read: (r) => r.readLong() };
}

export function dsNull(): DsAvroType<null> {
  return { label: "null", read: () => null };
}

/**
 * `union[null, T]`, which the site's schema builder emits for `.optional()`.
 * Branch 0 is null, branch 1 is the value; any other index fails closed.
 */
export function dsOptional<T>(inner: DsAvroType<T>): DsAvroType<T | null> {
  return {
    label: `optional(${inner.label})`,
    read: (r) => {
      const branch = r.readCount(`a union branch index for optional(${inner.label})`);
      if (branch === 0) return null;
      if (branch === 1) return inner.read(r);
      throw decodeError(
        `union branch ${branch} is out of range for optional(${inner.label})`,
        "The writer emitted a branch this schema table does not know; update the table against a fresh capture."
      );
    },
  };
}

/** An explicit union: a zigzag branch index selects one of `branches`. */
export function dsUnion<T>(branches: readonly DsAvroType<T>[]): DsAvroType<T> {
  const label = `union(${branches.map((b) => b.label).join("|")})`;
  return {
    label,
    read: (r) => {
      const index = r.readCount(`a union branch index for ${label}`);
      const branch = branches[index];
      if (branch === undefined) {
        throw decodeError(
          `union branch ${index} is out of range for ${label}`,
          "The writer emitted a branch this schema table does not know; update the table against a fresh capture."
        );
      }
      return branch.read(r);
    },
  };
}

/** Count followed by that many items. No terminating block: that is the dialect. */
export function dsArray<T>(item: DsAvroType<T>): DsAvroType<T[]> {
  return {
    label: `array(${item.label})`,
    read: (r) => {
      const count = r.readCount(`an array count for array(${item.label})`);
      const out: T[] = [];
      for (let i = 0; i < count; i += 1) out.push(item.read(r));
      return out;
    },
  };
}

/** Count followed by that many (string key, value) pairs. */
export function dsMap<T>(value: DsAvroType<T>): DsAvroType<Record<string, T>> {
  return {
    label: `map(${value.label})`,
    read: (r) => {
      const count = r.readCount(`a map count for map(${value.label})`);
      const out: Record<string, T> = {};
      for (let i = 0; i < count; i += 1) {
        const key = r.readString();
        out[key] = value.read(r);
      }
      return out;
    },
  };
}

/** Field shapes of a record, in declaration order. */
export type DsAvroFields = Readonly<Record<string, DsAvroType<unknown>>>;

export type DsAvroRecordValue<F extends DsAvroFields> = {
  -readonly [K in keyof F]: DsAvroValue<F[K]>;
};

/**
 * A record: its fields, in DECLARATION ORDER, with nothing framing them.
 *
 * Order is the whole contract here, so the object literal's key order is the
 * wire order. JavaScript preserves insertion order for string keys but moves
 * integer-like keys to the front, which would silently reorder the read; such
 * a key is rejected at construction rather than producing shifted market data.
 */
export function dsRecord<F extends DsAvroFields>(
  fields: F
): DsAvroType<DsAvroRecordValue<F>> {
  const entries = Object.entries(fields) as [keyof F & string, DsAvroType<unknown>][];
  for (const [name] of entries) {
    if (/^(0|[1-9][0-9]*)$/.test(name)) {
      throw new Error(
        `dsRecord field "${name}" is an integer-like key, which JavaScript would reorder; rename it`
      );
    }
  }
  return {
    label: "record",
    read: (r) => {
      const out: Record<string, unknown> = {};
      for (const [name, type] of entries) out[name] = type.read(r);
      return out as DsAvroRecordValue<F>;
    },
  };
}

/**
 * Append fields to an existing record schema, preserving order (base fields
 * first). The site does this itself: the trending-meta record is the plain meta
 * record with market columns appended.
 */
export function dsExtendRecord<A extends DsAvroFields, B extends DsAvroFields>(
  base: A,
  extra: B
): DsAvroType<DsAvroRecordValue<A & B>> {
  return dsRecord({ ...base, ...extra } as A & B);
}
