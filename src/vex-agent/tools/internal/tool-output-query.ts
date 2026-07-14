/**
 * Pure query primitives over an already-fetched overflowed tool-output blob
 * (E8). No DB, no session awareness — every function operates on the verbatim
 * blob snapshot (or its lazily-parsed JSON) so `tool_output_read` can SEARCH
 * and QUERY spilled payloads instead of blind byte-slicing.
 *
 * The production incident these serve: the model could not find coin "CASHCAT"
 * (~element 231 of a 90 KB markets JSON) because it could only read the first
 * byte slice, concluded the market did not exist, and wasted web calls.
 *
 * Design constraints (coordinator + Codex design review):
 *   - `search` is a case-insensitive SUBSTRING scan only. No regex — a
 *     model-supplied regex over a large blob is a ReDoS vector that a between-
 *     chunk time budget cannot interrupt mid-evaluation.
 *   - The path parser is deliberately tiny: dot + `[index]` only, own-property
 *     access (never the prototype chain — a prototype-pollution guard), and a
 *     hard token cap. No wildcards, recursive descent, or expressions.
 *   - `where` / `sort_by` operate only on SCALAR item fields.
 *   - Byte accounting happens DURING projection so the result stays under the
 *     caller's budget by construction and never re-overflows into a new blob.
 *
 * All model-supplied inputs are untrusted; these functions never throw on bad
 * input — they return a discriminated result the handler renders cleanly.
 */

// ── Constants ────────────────────────────────────────────────────

/** Chars of context captured on each side of a search match. */
const SEARCH_CONTEXT_RADIUS = 100;
/**
 * Hard cap on how many occurrences we count. We still report the cap so the
 * model knows the count is a floor, not exact.
 */
const SEARCH_MAX_TOTAL = 10_000;
/** Max path tokens — caps both length and nesting depth. */
const MAX_PATH_TOKENS = 10;

// ── Search (case-insensitive substring only) ─────────────────────

export interface BlobSearchMatch {
  /** UTF-8 byte offset of the match start — usable as a byte-mode `offset`. */
  offset: number;
  /** Bounded context window (~200 chars) around the match, with ellipses. */
  context: string;
}

export interface BlobSearchOutcome {
  matches: BlobSearchMatch[];
  /** Total occurrences found (capped at SEARCH_MAX_TOTAL). */
  matchedCount: number;
  /** Matches actually returned (after limit + byte budget). */
  returnedCount: number;
  /** True when some occurrences were not returned (limit, byte cap, or count cap). */
  truncated: boolean;
  /** True when `matchedCount` reached the scan cap and may undercount. */
  countCapped: boolean;
}

/** Bounded context window (offset + text) for a match at char `start`. */
function makeMatch(text: string, start: number, length: number): BlobSearchMatch {
  const end = start + length;
  const ctxStart = Math.max(0, start - SEARCH_CONTEXT_RADIUS);
  const ctxEnd = Math.min(text.length, end + SEARCH_CONTEXT_RADIUS);
  const prefix = ctxStart > 0 ? "…" : "";
  const suffix = ctxEnd < text.length ? "…" : "";
  return {
    offset: Buffer.byteLength(text.slice(0, start), "utf8"),
    context: `${prefix}${text.slice(ctxStart, ctxEnd)}${suffix}`,
  };
}

/**
 * Case-insensitive substring scan over the RAW blob text (shape-agnostic).
 * Cheap and linear (`indexOf`). Collects matches until either `limit` or the
 * byte `budget` is reached, while counting all occurrences.
 */
export function searchOverflowBlob(
  text: string,
  query: string,
  opts: { limit: number; budgetBytes: number },
): BlobSearchOutcome {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const matches: BlobSearchMatch[] = [];
  let matchedCount = 0;
  let countCapped = false;
  let byteCapped = false;
  let bytes = 2; // for the enclosing "[]"
  let from = 0;

  // `needle` is non-empty (Zod min(1)), so each hit advances by >= 1.
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    matchedCount += 1;
    if (matches.length < opts.limit && !byteCapped) {
      const match = makeMatch(text, idx, query.length);
      const serialized = Buffer.byteLength(JSON.stringify(match), "utf8") + (matches.length > 0 ? 1 : 0);
      if (bytes + serialized > opts.budgetBytes) {
        byteCapped = true;
      } else {
        matches.push(match);
        bytes += serialized;
      }
    }
    from = idx + needle.length;
    if (matchedCount >= SEARCH_MAX_TOTAL) {
      countCapped = true;
      break;
    }
  }

  const returnedCount = matches.length;
  const truncated = byteCapped || countCapped || matchedCount > returnedCount;
  return { matches, matchedCount, returnedCount, truncated, countCapped };
}

// ── Path resolution (hardened, tiny) ─────────────────────────────

export type PathResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * Parse a dot/bracket path (`meta.universe`, `contexts[1]`, `meta.universe[230]`)
 * into tokens. Dot keys and `[index]` brackets only — no wildcards, recursive
 * descent, or expressions. Returns null on malformed input or when the token
 * count exceeds MAX_PATH_TOKENS. A leading `$` / `$.` root marker is accepted
 * and ignored.
 */
export function parseJsonPath(path: string): Array<string | number> | null {
  const tokens: Array<string | number> = [];
  const n = path.length;
  let i = 0;
  if (path.startsWith("$")) {
    i = 1;
    if (path[i] === ".") i += 1;
  }
  while (i < n) {
    if (tokens.length >= MAX_PATH_TOKENS) return null;
    if (path[i] === "[") {
      const close = path.indexOf("]", i);
      if (close === -1) return null;
      const inner = path.slice(i + 1, close);
      if (!/^\d+$/.test(inner)) return null;
      tokens.push(Number(inner));
      i = close + 1;
      if (i < n && path[i] === ".") i += 1;
      continue;
    }
    let j = i;
    while (j < n && path[j] !== "." && path[j] !== "[") j += 1;
    const key = path.slice(i, j);
    if (key.length === 0) return null;
    tokens.push(key);
    i = j;
    if (i < n && path[i] === ".") i += 1;
  }
  return tokens.length > 0 && tokens.length <= MAX_PATH_TOKENS ? tokens : null;
}

/**
 * Resolve a parsed path against already-parsed JSON. Object keys are read with
 * `Object.hasOwn` — the prototype chain is never walked, so `__proto__`,
 * `constructor`, and `prototype` resolve to a clean miss, not injected state.
 * Never throws.
 */
export function resolveJsonPath(root: unknown, path: string): PathResult {
  const tokens = parseJsonPath(path);
  if (!tokens) {
    return { ok: false, error: `malformed or too-deep path \`${path}\` (max ${MAX_PATH_TOKENS} segments, dot/[index] only)` };
  }

  let current: unknown = root;
  for (const token of tokens) {
    if (typeof token === "number") {
      if (!Array.isArray(current)) {
        return { ok: false, error: `expected an array before index [${token}] in \`${path}\`` };
      }
      if (token >= current.length) {
        return { ok: false, error: `index [${token}] out of range (length ${current.length}) in \`${path}\`` };
      }
      current = current[token];
    } else {
      if (!isRecord(current)) {
        return { ok: false, error: `expected an object before key \`${token}\` in \`${path}\`` };
      }
      if (!Object.hasOwn(current, token)) {
        return { ok: false, error: `no own key \`${token}\` in \`${path}\`` };
      }
      current = current[token];
    }
  }
  return { ok: true, value: current };
}

/** Human-readable hint listing the top-level shape for a failed path. */
export function describeTopLevel(root: unknown): string {
  if (Array.isArray(root)) return `top-level value is an array of length ${root.length}`;
  if (isRecord(root)) return `top-level keys: [${Object.keys(root).join(", ")}]`;
  return `top-level value is a ${typeof root}`;
}

// ── Array query (filter → sort → paginate → project) ─────────────

export interface WhereClause {
  field: string;
  contains?: string;
  equals?: string | number | boolean;
}

export interface ArrayQueryOptions {
  where?: WhereClause;
  sortBy?: string;
  order: "asc" | "desc";
  itemOffset: number;
  limit: number;
  budgetBytes: number;
}

export interface ArrayQueryOutcome {
  /** The projected page items that fit within the byte budget. */
  items: unknown[];
  /** JSON serialization of `items`, guaranteed within `budgetBytes`. */
  itemsText: string;
  /** Items after `where` filtering, before pagination. */
  matchedCount: number;
  /** Items actually returned (after pagination + byte budget). */
  returnedCount: number;
  /** True when more items exist than were returned (page or byte cap). */
  truncated: boolean;
}

export type ArrayQueryResult =
  | { ok: true; value: ArrayQueryOutcome }
  | { ok: false; error: string };

/** Filter → sort → paginate → byte-bounded project. Pure; never throws. */
export function queryJsonArray(arr: readonly unknown[], opts: ArrayQueryOptions): ArrayQueryResult {
  if (opts.where) {
    const scalarError = assertScalarField(arr, opts.where.field);
    if (scalarError) return { ok: false, error: scalarError };
  }
  if (opts.sortBy !== undefined) {
    const scalarError = assertScalarField(arr, opts.sortBy);
    if (scalarError) return { ok: false, error: scalarError };
  }

  const filtered = opts.where
    ? arr.filter((item) => matchesWhere(item, opts.where as WhereClause))
    : arr.slice();
  const matchedCount = filtered.length;

  const sorted = opts.sortBy !== undefined
    ? sortByScalarField(filtered, opts.sortBy, opts.order)
    : filtered;

  const page = sorted.slice(opts.itemOffset, opts.itemOffset + opts.limit);
  const projected = projectWithinBudget(page, opts.budgetBytes);

  const returnedCount = projected.items.length;
  const truncated = projected.byteCapped || opts.itemOffset + returnedCount < matchedCount;
  return {
    ok: true,
    value: {
      items: projected.items,
      itemsText: projected.text,
      matchedCount,
      returnedCount,
      truncated,
    },
  };
}

function fieldValue(item: unknown, field: string): unknown {
  return isRecord(item) && Object.hasOwn(item, field) ? item[field] : undefined;
}

function isScalarOrNullish(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** Returns an error string if any item's `field` value is a non-scalar object/array. */
function assertScalarField(arr: readonly unknown[], field: string): string | null {
  for (const item of arr) {
    const value = fieldValue(item, field);
    if (!isScalarOrNullish(value)) {
      return `field \`${field}\` has a non-scalar (object/array) value; where/sort_by work only on string/number/boolean fields`;
    }
  }
  return null;
}

function matchesWhere(item: unknown, where: WhereClause): boolean {
  const value = fieldValue(item, where.field);
  if (where.contains !== undefined) {
    if (value === null || value === undefined) return false;
    return String(value).toLowerCase().includes(where.contains.toLowerCase());
  }
  if (where.equals !== undefined) {
    return value === where.equals;
  }
  return false;
}

/**
 * Sort by a scalar field. Numbers compare numerically, strings by
 * `localeCompare`; null/undefined and values whose type differs from the
 * first present value sort LAST regardless of `order`. Stable — ties and
 * trailing values keep their original array index order.
 */
function sortByScalarField(items: readonly unknown[], field: string, order: "asc" | "desc"): unknown[] {
  const indexed = items.map((item, index) => ({ item, index, value: fieldValue(item, field) }));

  let expectedType: string | null = null;
  for (const entry of indexed) {
    if (entry.value !== null && entry.value !== undefined) {
      expectedType = typeof entry.value;
      break;
    }
  }

  const dir = order === "asc" ? 1 : -1;
  const isTrailing = (v: unknown): boolean =>
    v === null || v === undefined || (expectedType !== null && typeof v !== expectedType);

  indexed.sort((a, b) => {
    const aLast = isTrailing(a.value);
    const bLast = isTrailing(b.value);
    if (aLast || bLast) {
      if (aLast && bLast) return a.index - b.index;
      return aLast ? 1 : -1;
    }
    let cmp: number;
    if (typeof a.value === "number" && typeof b.value === "number") {
      cmp = a.value - b.value;
    } else {
      cmp = String(a.value).localeCompare(String(b.value));
    }
    return cmp !== 0 ? dir * cmp : a.index - b.index;
  });

  return indexed.map((entry) => entry.item);
}

interface ProjectedItems {
  items: unknown[];
  text: string;
  byteCapped: boolean;
}

/**
 * Serialize items into a JSON array, accounting bytes AS items are added so
 * the result stays within `budgetBytes` by construction. Stops (setting
 * `byteCapped`) rather than emitting a giant string that would re-overflow.
 */
function projectWithinBudget(items: readonly unknown[], budgetBytes: number): ProjectedItems {
  const kept: unknown[] = [];
  const parts: string[] = [];
  let bytes = 2; // for the enclosing "[]"
  let byteCapped = false;

  for (const item of items) {
    const serialized = JSON.stringify(item) ?? "null";
    const add = Buffer.byteLength(serialized, "utf8") + (parts.length > 0 ? 1 : 0);
    if (bytes + add > budgetBytes) {
      byteCapped = true;
      break;
    }
    kept.push(item);
    parts.push(serialized);
    bytes += add;
  }

  return { items: kept, text: `[${parts.join(",")}]`, byteCapped };
}

// ── Scalar / object sub-value bounding (path mode, non-array) ────

export interface BoundedValue {
  text: string;
  truncated: boolean;
}

/**
 * Serialize a non-array sub-value within `budgetBytes`. Strings are truncated
 * by content (staying valid JSON); oversized objects collapse to a keys
 * summary so the model can drill in with a more specific path. Never emits a
 * partially-serialized giant JSON blob.
 */
export function serializeValueBounded(value: unknown, budgetBytes: number): BoundedValue {
  const json = JSON.stringify(value) ?? "null";
  if (Buffer.byteLength(json, "utf8") <= budgetBytes) {
    return { text: json, truncated: false };
  }

  if (typeof value === "string") {
    const marker = "…[truncated]";
    const budget = Math.max(0, budgetBytes - Buffer.byteLength(`""${marker}`, "utf8"));
    return { text: JSON.stringify(`${sliceByBytes(value, budget)}${marker}`), truncated: true };
  }

  if (isRecord(value)) {
    const summary = {
      _truncated: true,
      _hint: "value too large to inline; query a more specific path",
      keys: Object.keys(value),
    };
    return { text: serializeSummaryBounded(summary, budgetBytes), truncated: true };
  }

  // Numbers/booleans/null are always within budget; this is a defensive fallback.
  return { text: JSON.stringify(sliceByBytes(json, budgetBytes)), truncated: true };
}

function serializeSummaryBounded(
  summary: { _truncated: boolean; _hint: string; keys: string[] },
  budgetBytes: number,
): string {
  let keys = summary.keys;
  let text = JSON.stringify({ ...summary, keys });
  while (keys.length > 0 && Buffer.byteLength(text, "utf8") > budgetBytes) {
    keys = keys.slice(0, keys.length - 1);
    text = JSON.stringify({ ...summary, keys });
  }
  return text;
}

function sliceByBytes(value: string, budgetBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > budgetBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return value.slice(0, end);
}

// ── Shared ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
