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
  KhalaniToken,
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
      // TOKEN decimals stay TOLERANT (`asNumber`), while `chain.nativeCurrency
      // .decimals` above is STRICT (`asTokenDecimals`). That asymmetry is
      // deliberate; do not "fix" it into consistency.
      //
      // REACHABILITY is the difference. Anyone can mint a token and airdrop it
      // into a wallet, so `token.decimals` is ATTACKER-CONTROLLED input arriving
      // at scale. Rejecting it here throws away the WHOLE chain's token list
      // (`validateTokensResponse` is `raw.map(parseToken)`), so one hostile
      // token would blank a funded wallet: a denial of service bought for the
      // price of an airdrop. Nobody can add an entry to Khalani's own chain
      // registry, so a poisoned NATIVE decimals is a provider defect that
      // SHOULD fail loudly instead of degrading quietly.
      //
      // The invariant is not dropped, it MOVES to the projection seam, where a
      // bad value costs one row instead of a wallet: `projectBalanceRow`
      // (`@vex-agent/tools/protocols/amount-display.ts`) validates with
      // `isTokenDecimals` and emits the row with its identity and `balanceRaw`
      // intact, `balance: null`, `valueUsd: null` and a named
      // `unprojectableReason` (frozen contract C1.2). `heldUsd` in
      // `internal/wallet/read.ts` carries the same guard, because `formatUnits`
      // THROWS on a non-integer scale.
      //
      // Making this boundary strict AND keeping every row is WP10, which needs
      // the validators to return rejected entries alongside valid ones and so
      // changes `TokenBalanceScanResult`.
      decimals: asNumber("token.decimals"),
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
