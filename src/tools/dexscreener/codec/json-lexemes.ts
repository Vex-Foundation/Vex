/**
 * JSON parsing that keeps every NUMBER's exact source lexeme.
 *
 * WHY THIS EXISTS. `JSON.parse` converts a JSON number to an IEEE-754 double
 * before any code can see it, and that conversion is lossy for values the
 * providers actually send. Measured: the pair-details `su` block states supply
 * as a bare JSON number, and a provider lexeme of
 * `12345678901234567890.123456789` came back out of the previous projection as
 * `12345678901234567000` while the emitted note claimed the value was carried
 * "as the provider wrote" and "never floating-point". Rule 90's money-path
 * discipline forbids exactly that: raw amounts travel with their units and
 * never through binary floating point.
 *
 * WHAT IT DOES. It uses the standard parser and the standard reviver, with the
 * ECMAScript source-text-access reviver context (`context.source`, the
 * `JSON.parse` source access proposal, shipped in V8 12.4 and present in every
 * runtime this repository targets). Structure, escaping, duplicate keys and
 * every syntax decision remain owned by the engine's own JSON parser; the only
 * change is that a number arrives as a {@link JsonNumber} carrying its exact
 * source characters instead of as a lossy double.
 *
 * IT FAILS CLOSED. If the runtime does not provide the reviver context, this
 * module throws rather than silently returning rounded amounts. A wrong supply
 * that looks exact is worse than no supply at all, and the alternative -
 * degrading quietly - is the defect this module was written to remove.
 *
 * The caller decides what each number MEANS. A lexeme is a string of digits;
 * turning it into a percentage, an integer count or a token amount is the
 * projection's job, and the projection is where the unit is known.
 */

/**
 * One JSON number, as the provider wrote it.
 *
 * A class rather than a plain object so that a structural check ("is this an
 * object I should walk into?") can reject it by identity. A plain wrapper
 * would be indistinguishable from a provider-sent object and would be walked
 * into as one.
 */
export class JsonNumber {
  /** The exact source characters of the number, unrounded and unreformatted. */
  readonly lexeme: string;

  constructor(lexeme: string) {
    this.lexeme = lexeme;
    Object.freeze(this);
  }

  /**
   * The double this number would have become under a plain `JSON.parse`.
   *
   * Lossy by definition. Use it only where a bounded integer or a derived
   * display value is wanted, never as the amount that reaches a decision.
   */
  toNumber(): number {
    return Number(this.lexeme);
  }

  toString(): string {
    return this.lexeme;
  }
}

/** True when this value is a number that kept its lexeme. */
export function isJsonNumber(value: unknown): value is JsonNumber {
  return value instanceof JsonNumber;
}

/**
 * A reviver that also receives the primitive's source text.
 *
 * Declared locally because the repository's configured `lib` (ES2022) predates
 * the source-access signature. The single cast below is the whole boundary
 * escape, and {@link probeSourceAccess} verifies at load time that the runtime
 * really behaves this way rather than trusting the declaration.
 */
type SourceTextReviver = (
  this: unknown,
  key: string,
  value: unknown,
  context?: { readonly source?: string }
) => unknown;

const parseWithSourceText = JSON.parse as unknown as (
  text: string,
  reviver: SourceTextReviver
) => unknown;

function probeSourceAccess(): boolean {
  // A value whose double representation is NOT its source text, so a runtime
  // that merely re-stringifies the parsed number cannot pass this probe.
  const exact = "1.0000000000000000001";
  try {
    const seen = parseWithSourceText(`{"n":${exact}}`, (_key, value, context) =>
      typeof value === "number" ? (context?.source ?? null) : value
    ) as { readonly n: unknown };
    return seen.n === exact;
  } catch {
    return false;
  }
}

/**
 * Whether the runtime hands the reviver the source text of a primitive.
 *
 * Probed once, and declared AFTER the machinery it probes: a `const` read
 * before its own initializer runs is a temporal-dead-zone error, which the
 * probe's own `catch` would have swallowed into a permanent "unsupported".
 */
export const JSON_SOURCE_ACCESS_SUPPORTED: boolean = probeSourceAccess();

/**
 * Parse a JSON document, keeping every number's exact source lexeme.
 *
 * Throws `TypeError` when the runtime cannot provide source text, and
 * propagates the engine's own `SyntaxError` for malformed input. Both are
 * failures the caller must translate into its own typed error; neither is ever
 * an approximate answer.
 */
export function parseJsonPreservingNumbers(text: string): unknown {
  if (!JSON_SOURCE_ACCESS_SUPPORTED) {
    throw new TypeError(
      "This runtime's JSON.parse does not expose primitive source text, so provider amounts cannot be read without binary floating point. Refusing to parse rather than emit rounded amounts."
    );
  }
  return parseWithSourceText(text, (_key, value, context) => {
    if (typeof value !== "number") return value;
    const source = context?.source;
    // Unreachable while the probe above holds; kept because the alternative to
    // throwing here would be a silently rounded amount.
    if (typeof source !== "string") {
      throw new TypeError(
        "JSON.parse reviver received a number without its source text"
      );
    }
    return new JsonNumber(source);
  });
}

/**
 * Serialize a value parsed by {@link parseJsonPreservingNumbers} back to JSON.
 *
 * Numbers are written from their lexemes, so the output is byte-comparable to
 * the provider's own text modulo whitespace and key order. Used to MEASURE a
 * block this projection does not understand: reporting "present, 412 raw
 * bytes, keys [...]" is what keeps an unprojected block visible instead of
 * hidden.
 */
export function stringifyPreservingNumbers(value: unknown): string {
  if (isJsonNumber(value)) return value.lexeme;
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stringifyPreservingNumbers(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stringifyPreservingNumbers(entry)}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Byte length of a parsed sub-document, for reporting an unprojected block's size. */
export function rawJsonByteLength(value: unknown): number {
  return new TextEncoder().encode(stringifyPreservingNumbers(value)).byteLength;
}
