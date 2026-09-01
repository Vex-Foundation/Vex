/**
 * Khalani chains + tokens validators (codex-002 Phase 2).
 *
 * `parseChain` / `parseToken` are the strict per-entry parsers reused by the
 * chains, tokens, token-search, and autocomplete validators. Moved verbatim
 * from the original `validation.ts`; identical messages, coercions, and the
 * same chain-family skip behaviour in `validateChainsResponse`.
 */

import { z } from "zod";
import { VexError, ErrorCodes } from "../../../errors.js";
import type {
  AutocompleteResponse,
  KhalaniChain,
  KhalaniRejectedTokenBalanceEntry,
  KhalaniToken,
  KhalaniTokenBalancesResponse,
  TokenSearchResponse,
} from "../types.js";
import {
  asNumber,
  asTokenDecimals,
  asOptionalString,
  asString,
  isRecordValue,
  optionalRecord,
  parseOrThrow,
} from "./_shared.js";

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

/**
 * nativeCurrency: original coerces a non-record to `{}`, then `name` falls back
 * to `symbol` when `name` is absent/empty (live Solana omits it). `symbol` and
 * `decimals` are required. We model the fallback with a transform that reads
 * the already-normalised `symbol`.
 */
const nativeCurrencySchema = z
  .preprocess(
    (v) => (isRecordValue(v) ? v : {}),
    z.object({
      // Read raw name/symbol/decimals; symbol+decimals required, name optional.
      name: asOptionalString,
      symbol: asString("chain.nativeCurrency.symbol"),
      decimals: asTokenDecimals("chain.nativeCurrency.decimals"),
    }),
  )
  .transform((nc) => ({
    name: nc.name && nc.name.length > 0 ? nc.name : nc.symbol,
    symbol: nc.symbol,
    decimals: nc.decimals,
  }));

/**
 * The original `parseChain` short-circuits:
 *   1. non-record  -> "chain must be an object"
 *   2. type missing/empty -> "missing chain.type"   (asString)
 *   3. type not in {eip155,solana} -> "unsupported chain type <type>"
 * `z.enum` cannot distinguish (2) from (3), so the `type` check stays explicit
 * to preserve both exact messages; the remaining fields go through Zod.
 */
export function parseChain(raw: unknown): KhalaniChain {
  if (!isRecordValue(raw)) {
    throw new VexError(ErrorCodes.KHALANI_API_ERROR, "Invalid Khalani response: chain must be an object");
  }
  const type = parseOrThrow(asString("chain.type"), raw.type);
  if (type !== "eip155" && type !== "solana") {
    throw new VexError(ErrorCodes.KHALANI_API_ERROR, `Invalid Khalani response: unsupported chain type ${type}`);
  }

  // Original evaluation order in parseChain's return literal: id, name, then
  // nativeCurrency. Preserve it so multi-failure inputs surface the SAME first
  // message (e.g. missing id wins over a missing nativeCurrency.symbol).
  const rest = parseOrThrow(
    z.object({
      id: asNumber("chain.id"),
      name: asString("chain.name"),
      rpcUrls: optionalRecord,
      blockExplorers: optionalRecord,
    }),
    raw,
  );
  const nativeCurrency = parseOrThrow(nativeCurrencySchema, raw.nativeCurrency);

  return {
    type,
    id: rest.id,
    name: rest.name,
    nativeCurrency,
    rpcUrls: rest.rpcUrls as KhalaniChain["rpcUrls"],
    blockExplorers: rest.blockExplorers as KhalaniChain["blockExplorers"],
  };
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

const tokenSchema: z.ZodType<KhalaniToken> = z
  .object(
    {
      address: asString("token.address"),
      chainId: asNumber("token.chainId"),
      name: asString("token.name"),
      symbol: asString("token.symbol"),
      // TOKEN decimals are STRICT here (`asTokenDecimals`), exactly as
      // `chain.nativeCurrency.decimals` above and the WALLET-BALANCES boundary
      // below. The three differ only in what a FAILURE costs.
      //
      // REACHABILITY is what decides that, and this schema serves only the
      // CURATED surfaces: `/v1/tokens` (top), token search, and autocomplete.
      // Nobody can add an entry to those, so they stay ALL-OR-NOTHING: a
      // malformed entry is a provider defect, and the caller learns about it by
      // the REQUEST failing rather than by reasoning over a scale nothing can
      // convert from (`Infinity`, a fraction, a negative). The wallet-balances
      // array is the opposite case - anyone can mint a token and airdrop it
      // into a wallet, so failing whole there is a denial of service for the
      // price of an airdrop - and it gets its own per-entry boundary in
      // `validateTokenBalancesResponse`, which admits only strict decimals and
      // REPORTS every entry it refuses instead of failing the chain.
      //
      // `projectBalanceRow` (`@vex-agent/tools/protocols/amount-display.ts`)
      // stays defensive for rows reaching it from OUTSIDE this boundary
      // (frozen contract C1.2): it keeps identity and `balanceRaw`, emits
      // `balance: null`, `valueUsd: null` and a named `unprojectableReason`.
      // That is a second line, not this one's substitute.
      decimals: asTokenDecimals("token.decimals"),
      logoURI: asOptionalString,
      extensions: optionalRecord,
    },
    { message: "Invalid Khalani response: token must be an object" },
  )
  .transform((t) => ({
    address: t.address,
    chainId: t.chainId,
    name: t.name,
    symbol: t.symbol,
    decimals: t.decimals,
    logoURI: t.logoURI,
    extensions: t.extensions as KhalaniToken["extensions"],
  }));

export function parseToken(raw: unknown): KhalaniToken {
  return parseOrThrow(tokenSchema, raw);
}

// ---------------------------------------------------------------------------
// Wallet-balances boundary (strict decimals, per-entry rejection)
// ---------------------------------------------------------------------------

/**
 * Everything a balance entry must have BESIDES `decimals`.
 *
 * Field order matches {@link tokenSchema} so a structurally broken entry
 * surfaces the SAME first-issue message it always did (address, chainId, name,
 * symbol). `logoURI` and `extensions` never throw.
 */
const tokenBalanceIdentitySchema = z.object(
  {
    address: asString("token.address"),
    chainId: asNumber("token.chainId"),
    name: asString("token.name"),
    symbol: asString("token.symbol"),
    logoURI: asOptionalString,
    extensions: optionalRecord,
  },
  { message: "Invalid Khalani response: token must be an object" },
);

const balanceDecimalsSchema = asTokenDecimals("token.decimals");

/** An atomic amount is EXACT only as an unsigned decimal integer string. */
const EXACT_ATOMIC_AMOUNT = /^\d+$/;

/**
 * The provider's raw balance for an entry, but only when it is an EXACT integer.
 *
 * A float, a hex string, a JS number (already through `JSON.parse`, so already
 * lossy above 2^53) or an absent value all yield `null`. Frozen contract C1.3:
 * a raw amount is never reconstructed from an inexact value.
 */
function exactBalanceRaw(extensions: Record<string, unknown> | undefined): string | null {
  const balance = extensions?.balance;
  if (typeof balance !== "string" || !EXACT_ATOMIC_AMOUNT.test(balance)) return null;
  return balance;
}

type TokenBalanceEntry =
  | { kind: "token"; token: KhalaniToken }
  | { kind: "rejected"; entry: KhalaniRejectedTokenBalanceEntry };

/**
 * Parse ONE wallet-balance entry.
 *
 * Throws (failing the whole chain) for any identity or structural defect, which
 * is a provider-shape problem no consumer can act on. Returns a REJECTION when
 * the entry is otherwise well formed and its `decimals` alone fail the strict
 * rule: that entry keeps its identity and its exact `balanceRaw`, and the
 * invalid scale is neither echoed nor guessed.
 */
function parseTokenBalanceEntry(raw: unknown, entryIndex: number): TokenBalanceEntry {
  const identity = parseOrThrow(tokenBalanceIdentitySchema, raw);
  const extensions = identity.extensions as KhalaniToken["extensions"];
  const decimals = balanceDecimalsSchema.safeParse(
    isRecordValue(raw) ? raw.decimals : undefined,
  );

  if (decimals.success) {
    return {
      kind: "token",
      token: {
        address: identity.address,
        chainId: identity.chainId,
        name: identity.name,
        symbol: identity.symbol,
        decimals: decimals.data,
        logoURI: identity.logoURI,
        extensions,
      },
    };
  }

  return {
    kind: "rejected",
    entry: {
      entryIndex,
      chainId: identity.chainId,
      address: identity.address,
      name: identity.name,
      symbol: identity.symbol,
      balanceRaw: exactBalanceRaw(identity.extensions),
      reason: "token_decimals_invalid",
    },
  };
}

// ---------------------------------------------------------------------------
// Exported validators
// ---------------------------------------------------------------------------

export function validateChainsResponse(raw: unknown): KhalaniChain[] {
  if (!Array.isArray(raw)) {
    throw new VexError(ErrorCodes.KHALANI_API_ERROR, "Invalid Khalani response: expected chains array");
  }
  // Khalani's /v1/chains serves chain families Vex does not support (e.g. tron
  // / flow / hyperevm — the API returns more `type` values than its own schema
  // doc admits). Skip a foreign family instead of throwing, so a single tron
  // entry can't fail the whole periodic balances sync. Only a NON-EMPTY,
  // unsupported STRING type is skipped: missing/empty/non-string `type` still
  // throws "missing chain.type", non-objects still throw "chain must be an
  // object", and malformed eip155/solana entries still throw — all via
  // `parseChain`, which stays strict (it is also used by the autocomplete
  // validator, where an unsupported chain must still be rejected).
  const chains: KhalaniChain[] = [];
  for (const entry of raw) {
    if (isRecordValue(entry)) {
      const type = entry.type;
      if (
        typeof type === "string" &&
        type.length > 0 &&
        type !== "eip155" &&
        type !== "solana"
      ) {
        continue;
      }
    }
    chains.push(parseChain(entry));
  }
  return chains;
}

export function validateTokensResponse(raw: unknown): KhalaniToken[] {
  if (!Array.isArray(raw)) {
    throw new VexError(ErrorCodes.KHALANI_API_ERROR, "Invalid Khalani response: expected token array");
  }
  return raw.map(parseToken);
}

/**
 * Wallet balances: STRICT per entry, all-or-nothing only for identity.
 *
 * Every admitted token is guaranteed `Number.isInteger(decimals) && 0 <=
 * decimals <= 36`, so downstream conversion (`formatUnits`, which THROWS on a
 * non-integer scale) is total on `tokens`. Entries refused for their decimals
 * alone are returned in `rejectedEntries` with identity and exact `balanceRaw`,
 * so nothing is silently dropped (output-envelope spec, section 4).
 */
export function validateTokenBalancesResponse(raw: unknown): KhalaniTokenBalancesResponse {
  if (!Array.isArray(raw)) {
    throw new VexError(ErrorCodes.KHALANI_API_ERROR, "Invalid Khalani response: expected token array");
  }

  const tokens: KhalaniToken[] = [];
  const rejectedEntries: KhalaniRejectedTokenBalanceEntry[] = [];
  raw.forEach((entry, entryIndex) => {
    const parsed = parseTokenBalanceEntry(entry, entryIndex);
    if (parsed.kind === "token") {
      tokens.push(parsed.token);
    } else {
      rejectedEntries.push(parsed.entry);
    }
  });
  return { tokens, rejectedEntries };
}

export function validateTokenSearchResponse(raw: unknown): TokenSearchResponse {
  if (!isRecordValue(raw) || !Array.isArray(raw.data)) {
    throw new VexError(ErrorCodes.KHALANI_API_ERROR, "Invalid Khalani response: expected token search wrapper");
  }
  return { data: raw.data.map(parseToken) };
}

export function validateAutocompleteResponse(raw: unknown): AutocompleteResponse {
  if (!isRecordValue(raw) || !Array.isArray(raw.data)) {
    throw new VexError(ErrorCodes.KHALANI_API_ERROR, "Invalid Khalani response: expected autocomplete wrapper");
  }

  return {
    data: raw.data.map((entry) => {
      if (!isRecordValue(entry)) {
        throw new VexError(ErrorCodes.KHALANI_API_ERROR, "Invalid Khalani response: autocomplete entry must be an object");
      }
      return {
        description: parseOrThrow(asString("autocomplete.description"), entry.description),
        chain: parseChain(entry.chain),
        token: parseToken(entry.token),
        amount: parseOrThrow(asOptionalString, entry.amount),
        usdAmount: parseOrThrow(asOptionalString, entry.usdAmount),
      };
    }),
    parsed: isRecordValue(raw.parsed) ? raw.parsed : undefined,
    nextSlots: Array.isArray(raw.nextSlots)
      ? raw.nextSlots.filter((slot): slot is string => typeof slot === "string")
      : undefined,
  };
}
