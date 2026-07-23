/**
 * DB parameter helpers for Postgres-specific value boundaries.
 *
 * Repos should use these helpers when binding JSONB values so arrays/objects
 * are consistently serialized before they cross into node-postgres.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function jsonb(value: unknown): string {
  assertJsonSerializable(value, "$", new WeakSet<object>());
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("jsonb: value is not JSON serializable");
  }
  return encoded;
}

export function nullableJsonb(value: unknown | null): string | null {
  return value === null ? null : jsonb(value);
}

/**
 * Measure the serialized JSONB size of a value in bytes. Lives here — not in
 * a repo — because JSONB serialization is centralized in db/params (pinned by
 * src/__tests__/vex-agent/db/jsonb-boundary.test.ts); repos needing a size
 * cap (e.g. the sanitized intent-params echo) call this instead of
 * JSON.stringify-ing themselves.
 */
export function jsonbByteLength(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("jsonbByteLength: value is not JSON serializable");
  }
  return Buffer.byteLength(encoded, "utf8");
}

export function jsonbPlaceholder(index: number): string {
  if (!Number.isInteger(index) || index <= 0) {
    throw new Error(`jsonbPlaceholder: index must be a positive integer, got ${index}`);
  }
  return `$${index}::jsonb`;
}

/**
 * Normalize a value for an intentional JSONB persistence boundary.
 *
 * This keeps jsonb() strict while giving capture/audit code an explicit way to
 * handle JavaScript's optional-field `undefined` convention without dropping an
 * entire protocol execution.
 */
export function sanitizeJsonbValue(value: unknown): JsonValue {
  return sanitizeJsonbValueAt(value, "$", new WeakSet<object>());
}

function assertJsonSerializable(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null) return;

  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`jsonb: non-finite number at ${path}`);
      }
      return;
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw new Error(`jsonb: unsupported ${typeof value} at ${path}`);
    case "object":
      assertJsonObject(value, path, seen);
      return;
  }
}

function assertJsonObject(value: object, path: string, seen: WeakSet<object>): void {
  const withToJson = value as { toJSON?: unknown };
  if (typeof withToJson.toJSON === "function") {
    assertJsonSerializable(withToJson.toJSON(), `${path}.toJSON()`, seen);
    return;
  }

  if (seen.has(value)) {
    throw new Error(`jsonb: circular reference at ${path}`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => assertJsonSerializable(entry, `${path}[${index}]`, seen));
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`jsonb: unsupported object type at ${path}`);
    }

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertJsonSerializable(entry, `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function sanitizeJsonbValueAt(value: unknown, path: string, seen: WeakSet<object>): JsonValue {
  if (value === undefined || value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`jsonb: non-finite number at ${path}`);
      }
      return value;
    case "function":
    case "symbol":
    case "bigint":
      throw new Error(`jsonb: unsupported ${typeof value} at ${path}`);
    case "object":
      return sanitizeJsonObject(value, path, seen);
    case "undefined":
      return null;
  }
  throw new Error(`jsonb: unsupported value at ${path}`);
}

function sanitizeJsonObject(value: object, path: string, seen: WeakSet<object>): JsonValue {
  const withToJson = value as { toJSON?: unknown };
  if (typeof withToJson.toJSON === "function") {
    return sanitizeJsonbValueAt(withToJson.toJSON(), `${path}.toJSON()`, seen);
  }

  if (seen.has(value)) {
    throw new Error(`jsonb: circular reference at ${path}`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        entry === undefined ? null : sanitizeJsonbValueAt(entry, `${path}[${index}]`, seen),
      );
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`jsonb: unsupported object type at ${path}`);
    }

    const sanitized: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      sanitized[key] = sanitizeJsonbValueAt(entry, `${path}.${key}`, seen);
    }
    return sanitized;
  } finally {
    seen.delete(value);
  }
}
