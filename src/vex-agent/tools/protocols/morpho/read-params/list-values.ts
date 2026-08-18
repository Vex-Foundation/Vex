/**
 * List-shaped and raw-integer FILTER readers, shared by the three discover-style
 * Morpho read contracts.
 *
 * WHY A SEPARATE FILE RATHER THAN MORE OF `./_primitives.ts`. Those primitives
 * are the ones EVERY Morpho param contract needs; these are the list and
 * raw-integer shapes only the three discover-style tools need, and they were
 * added together as the 2026-08-18 depth surface. Splitting them keeps each
 * file owning one reason to change.
 *
 * ONE RULE THEY ALL SHARE, and it is not optional polish: a list param accepts a
 * comma string AND a real array. `readAddressCsv` used to accept only the string
 * form, so `tokenAddress: [USDC]` read as NO filter at all and a funded wallet
 * was reported as holding nothing (live audit, 2026-08-18). Every reader below
 * has the array branch from the start, and an array member gets exactly the same
 * validation and the same by-name refusal as a CSV token.
 *
 * Every reader here obeys the same contract as the rest of the lane: a value
 * outside the accepted domain is REFUSED BY NAME with the accepted set spelled
 * out, never dropped and never clamped. A dropped screening filter is worse than
 * an error, because the agent then believes it filtered.
 */

import { MORPHO_ASSET_TAGS } from "@tools/morpho/request.js";
import {
  ADDRESS_PATTERN,
  MARKET_ID_PATTERN,
  MAX_CSV_ENTRIES,
  readOptionalString,
  reject,
  type MorphoParams,
} from "./_primitives.js";

/** A whole non-negative integer written as a decimal string. No `0x`, no decimal point. */
const RAW_INTEGER_PATTERN = /^[0-9]+$/;

/**
 * Split a param that may arrive as a comma string OR a string array.
 *
 * Both forms are documented by every manifest that declares `acceptsStringArray`,
 * and a model that has seen either in an example will send either.
 */
function splitTokens(raw: unknown, param: string): MorphoParams<string[] | undefined> {
  const tokens: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") {
        return reject(param, `\`${param}\` array entries must be strings. Received ${JSON.stringify(entry)}.`);
      }
      // A comma inside an array entry is split too, matching `readAddressCsv`:
      // a model that has seen both forms documented sometimes mixes them.
      tokens.push(...entry.split(","));
    }
  } else {
    const value = readOptionalString(raw);
    if (value === undefined) return { ok: true, value: undefined };
    tokens.push(...value.split(","));
  }

  const trimmed = tokens.map((token) => token.trim()).filter((token) => token.length > 0);
  if (trimmed.length === 0) return { ok: true, value: undefined };
  if (trimmed.length > MAX_CSV_ENTRIES) {
    return reject(
      param,
      `\`${param}\` accepts at most ${MAX_CSV_ENTRIES} entries; ${trimmed.length} were supplied. `
      + "Narrow the list and retry - Vex will not silently drop the extras.",
    );
  }
  return { ok: true, value: trimmed };
}

/** EVM addresses, lowercased and de-duplicated. Accepts a comma string or an array. */
export function readAddressList(raw: unknown, param: string): MorphoParams<string[] | undefined> {
  const tokens = splitTokens(raw, param);
  if (!tokens.ok) return tokens;
  if (tokens.value === undefined) return { ok: true, value: undefined };

  const out: string[] = [];
  for (const token of tokens.value) {
    if (!ADDRESS_PATTERN.test(token)) {
      return reject(
        param,
        `\`${param}\` contains "${token}", which is not a 0x-prefixed 40-hex EVM address.`
        + (MARKET_ID_PATTERN.test(token) ? " That is a 64-hex MARKET id, not a contract address." : ""),
      );
    }
    const lower = token.toLowerCase();
    if (!out.includes(lower)) out.push(lower);
  }
  return { ok: true, value: out };
}

/** 64-hex Morpho Blue market ids, lowercased. An address here is named as one. */
export function readMarketIdList(raw: unknown, param: string): MorphoParams<string[] | undefined> {
  const tokens = splitTokens(raw, param);
  if (!tokens.ok) return tokens;
  if (tokens.value === undefined) return { ok: true, value: undefined };

  const out: string[] = [];
  for (const token of tokens.value) {
    if (!MARKET_ID_PATTERN.test(token)) {
      return reject(
        param,
        `\`${param}\` contains "${token}", which is not a 0x-prefixed 64-hex market id.`
        + (ADDRESS_PATTERN.test(token) ? " That is a 20-byte contract ADDRESS, not a market id." : "")
        + " Read one from morpho.markets.discover.",
      );
    }
    const lower = token.toLowerCase();
    if (!out.includes(lower)) out.push(lower);
  }
  return { ok: true, value: out };
}

/**
 * Morpho asset tags, matched case-insensitively against the captured vocabulary.
 *
 * The canonical spelling is Morpho's own, so a caller who sends `"LST"` gets
 * `"lst"` on the wire; the server's comparison is exact and the wrong case would
 * match nothing.
 */
export function readAssetTagList(raw: unknown, param: string): MorphoParams<string[] | undefined> {
  const tokens = splitTokens(raw, param);
  if (!tokens.ok) return tokens;
  if (tokens.value === undefined) return { ok: true, value: undefined };

  const out: string[] = [];
  for (const token of tokens.value) {
    const match = MORPHO_ASSET_TAGS.find((tag) => tag.toLowerCase() === token.toLowerCase());
    if (match === undefined) {
      return reject(
        param,
        `\`${param}\` contains "${token}", which is not a Morpho asset tag. Accepted: `
        + `${MORPHO_ASSET_TAGS.join(", ")}. An unknown tag is not an error to Morpho - it is a predicate that `
        + "matches nothing, so the empty page would read as 'no such markets exist'.",
      );
    }
    if (!out.includes(match)) out.push(match);
  }
  return { ok: true, value: out };
}

/**
 * A `BigInt` filter bound: a whole number of RAW base units as a decimal string.
 *
 * A human decimal is refused rather than rounded. `"0.5"` and `"500000"` are
 * different kinds of number and guessing between them moves the floor by six
 * orders of magnitude on a USDC market.
 */
export function readRawIntegerBound(raw: unknown, param: string): MorphoParams<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw === "number") {
    return reject(
      param,
      `\`${param}\` must be a STRING of raw base units, not a number - a JSON number cannot carry a token amount `
      + "at full precision. Send it quoted, for example \"1000000\".",
    );
  }
  const value = readOptionalString(raw);
  if (value === undefined) return { ok: true, value: undefined };
  if (!RAW_INTEGER_PATTERN.test(value)) {
    return reject(
      param,
      `\`${param}\` must be a whole number of RAW base units as a string, for example "1000000" for 1 USDC at 6 `
      + `decimals. Received "${value}". A human decimal amount is refused rather than rounded, because the two are `
      + "different kinds of number and guessing between them can move a thousandfold wrong floor.",
    );
  }
  return { ok: true, value };
}
