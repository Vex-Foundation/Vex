/**
 * What the four deep-dive handlers share: the subject, the chain gate, the
 * shaping vocabulary, and the failure wrapper.
 *
 * The subject is the reason this module exists. Three of the four tools are
 * keyed by an AMM id and a quote token that the caller never supplies and must
 * not: a wrong AMM id answers HTTP 200 with zero rows and a wrong quote token
 * returns a silently inverted series. Resolving it once, in one place, is what
 * makes it impossible for one of the three to be pointed at the wrong series
 * while the other two are right.
 */

import {
  fetchChainsCatalog,
  resolveChainSlugs,
  assertChainSlugsResolved,
} from "@tools/dexscreener/endpoints/chains-catalog.js";
import {
  resolvePairSubject,
  type PairSubject,
} from "@tools/dexscreener/endpoints/pair-subject.js";
import type { SourceObservation } from "@tools/dexscreener/screen-core/envelope.js";
import { readCacheObservation } from "@tools/dexscreener/screen-core/envelope.js";
import {
  DexScreenerSiteErrorCodes,
  isDexScreenerSiteError,
  siteError,
} from "@tools/dexscreener/site-errors.js";
import {
  getDexScreenerTransport,
  type DexScreenerTransport,
} from "@tools/dexscreener/transport.js";
import { fail, num, ok, str } from "../../../handler-helpers.js";
import type { ProtocolHandler } from "../../../types.js";

/** Deadline for one plain HTTP read on these channels. */
export const HTTP_TIMEOUT_MS = 20_000;
/** Deadline for one WebSocket exchange. */
export const CHANNEL_TIMEOUT_MS = 25_000;
/** The catalog is a 63 KB document behind a long cache. */
export const CATALOG_TIMEOUT_MS = 15_000;

/** Resolve one chain slug against the catalog, or refuse by name. */
export async function assertChain(
  chain: string,
  transport: DexScreenerTransport,
  signal: AbortSignal | undefined
): Promise<string> {
  if (chain === "") {
    throw siteError(
      DexScreenerSiteErrorCodes.CHAIN_SLUG_UNKNOWN,
      '"chain" is required: a pair or token address is only unique within one chain',
      "Call dexscreener__chains_list for the accepted slugs."
    );
  }
  const catalog = await fetchChainsCatalog({
    transport,
    timeoutMs: CATALOG_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });
  const resolution = resolveChainSlugs(catalog, [chain]);
  assertChainSlugsResolved(resolution);
  const resolved = resolution.valid[0];
  if (resolved === undefined) {
    throw siteError(
      DexScreenerSiteErrorCodes.CHAIN_SLUG_UNKNOWN,
      `"${chain}" did not resolve to a chain in the DexScreener catalog`,
      "Call dexscreener__chains_list for the accepted slugs."
    );
  }
  return resolved;
}

/** Read the identity params and resolve the pool, its AMM id and its quote token. */
export async function readSubject(
  params: Record<string, unknown>,
  signal: AbortSignal | undefined
): Promise<{ readonly transport: DexScreenerTransport; readonly subject: PairSubject }> {
  const transport = getDexScreenerTransport();
  const chain = await assertChain(str(params, "chain"), transport, signal);
  const pairAddress = str(params, "pairAddress");
  const tokenAddress = str(params, "tokenAddress");
  const subject = await resolvePairSubject({
    transport,
    chainId: chain,
    ...(pairAddress === "" ? {} : { pairAddress }),
    ...(tokenAddress === "" ? {} : { tokenAddress }),
    timeoutMs: CHANNEL_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });
  return { transport, subject };
}

/**
 * The `subject` block every deep-dive answer carries.
 *
 * It exists so a reader can tell WHAT was measured before reading any number:
 * which pool, which side of it, how the pool was arrived at, and what the
 * resolved routing keys were. Two reports that disagree are then comparable as
 * two questions rather than as two contradictory facts.
 */
export function subjectBlock(
  subject: PairSubject,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    chain: subject.chainId,
    pairAddress: subject.pairAddress,
    baseTokenAddress: subject.baseTokenAddress,
    baseTokenSymbol: subject.baseTokenSymbol,
    quoteTokenAddress: subject.quoteTokenAddress,
    quoteTokenSymbol: subject.quoteTokenSymbol,
    dexId: subject.dexId,
    // The routing key every deep-dive channel is keyed by. Reported because a
    // wrong one answers with zero rows rather than an error.
    ammId: subject.ammId,
    resolutionBasis: subject.resolutionBasis,
    ...(subject.resolvedFromToken === null
      ? {}
      : {
          resolvedFromToken: subject.resolvedFromToken,
          resolutionNote:
            `Deepest among the ${subject.searchWindowSize ?? 0} pools in the provider's bounded search window, which returns at most 30 pools and offers no continuation. This is not a claim about every pool this token trades in; call dexscreener__token_pairs_list for the pool list.`,
        }),
    quoteResolution:
      "The quote token was read from the pair itself, not from a parameter. A wrong quote returns a silently INVERTED series that is indistinguishable from a correct one, so it is never left to the caller.",
    ...extra,
  };
}

/**
 * The `sourceObservation` for one answer.
 *
 * `headers` are the response headers of the HTTP request that produced it, when
 * there was one. Pass them: the edge's `cf-cache-status` and `age` are the only
 * evidence of how stale an answer is, and a literal `"not_cached"` was measured
 * asserting freshness for documents Cloudflare had held for up to 25 s. Omit
 * them ONLY for a WebSocket channel, where no cache sits between a frame and
 * its socket and `not_cached` is the truth.
 */
export function observation(
  transport: DexScreenerTransport,
  fetchedAtMs: number,
  headers?: ReadonlyMap<string, string>
): SourceObservation {
  return {
    transport: transport.name,
    fetchedAtMs,
    ...readCacheObservation(headers),
  };
}

/* ------------------------------------------------------------------ */
/* Shaping                                                             */
/* ------------------------------------------------------------------ */

/**
 * Parse a comma-separated `fields` value against a closed group vocabulary.
 *
 * An unknown group is REFUSED by name rather than ignored, because silently
 * dropping it would ship the default projection while the agent believed it
 * had asked for more.
 */
export function readFieldGroups<T extends string>(
  params: Record<string, unknown>,
  vocabulary: readonly T[],
  fallback: readonly T[],
  always: readonly T[] = []
): readonly T[] {
  const raw = str(params, "fields");
  if (raw.trim() === "") return dedupe([...always, ...fallback], vocabulary);
  const requested = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const unknown = requested.filter((part) => !vocabulary.includes(part as T));
  if (unknown.length > 0) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_FIELD_GROUP_UNKNOWN,
      `"fields" named ${unknown.length === 1 ? "a field group" : "field groups"} that does not exist on this row: ${unknown.join(", ")}`,
      `"fields" takes field GROUPS, not individual field names. Supported groups: ${vocabulary.join(", ")}.`
    );
  }
  return dedupe([...always, ...(requested as T[])], vocabulary);
}

function dedupe<T extends string>(
  values: readonly T[],
  vocabulary: readonly T[]
): readonly T[] {
  const selected = new Set(values);
  return vocabulary.filter((group) => selected.has(group));
}

/** Read a closed-vocabulary string param, or refuse by name. */
export function readEnum<T extends string>(
  params: Record<string, unknown>,
  key: string,
  vocabulary: readonly T[],
  fallback: T
): T {
  const raw = str(params, key);
  if (raw === "") return fallback;
  if (!vocabulary.includes(raw as T)) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_SHAPING_VALUE_INVALID,
      `"${key}" must be one of the values this tool accepts; received "${raw}"`,
      `Accepted values: ${vocabulary.join(", ")}.`
    );
  }
  return raw as T;
}

/** Read a bounded whole number, or refuse with the range. */
export function readBoundedInteger(
  params: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback: number,
  hint: string
): number {
  const raw = num(params, key);
  if (raw === undefined) return fallback;
  if (!Number.isInteger(raw) || raw < min || raw > max) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_SHAPING_VALUE_INVALID,
      `"${key}" must be a whole number from ${min} to ${max}; received ${String(raw)}`,
      hint
    );
  }
  return raw;
}

/** Read an epoch-millisecond instant, or refuse. Undefined when absent. */
export function readInstantMs(
  params: Record<string, unknown>,
  key: string
): number | undefined {
  const raw = num(params, key);
  if (raw === undefined) return undefined;
  if (!Number.isFinite(raw) || raw < 0) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_SHAPING_VALUE_INVALID,
      `"${key}" must be a non-negative epoch time in MILLISECONDS; received ${String(raw)}`,
      "Epoch milliseconds, not seconds: a seconds value lands in 1970 and returns an empty or wrong window."
    );
  }
  return raw;
}

/**
 * Read a decimal amount that must stay a STRING.
 *
 * Token amounts never round-trip through binary floating point, so a numeric
 * form is accepted only because a JSON tool call makes it natural, and it is
 * re-rendered exactly rather than being arithmetically transformed.
 */
export function readDecimalString(
  params: Record<string, unknown>,
  key: string
): string | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") {
    if (!/^\d+(\.\d+)?$/u.test(value.trim())) {
      throw siteError(
        DexScreenerSiteErrorCodes.SCREEN_SHAPING_VALUE_INVALID,
        `"${key}" must be a non-negative decimal amount written as a plain string; received "${value}"`,
        // The refusal stands; its old stated REASON did not. "The provider does
        // not accept it" was never measured on this channel, and on the sibling
        // screener endpoint the same claim was measured FALSE (`1e6` passes the
        // provider's own validation there). The real reason is local and is
        // enough on its own: this value is a token amount that travels to the
        // wire verbatim, and an exponent lexeme is not a form this module can
        // re-render without deciding a digit count for the caller.
        "Write it in full decimal form, for example \"1000.5\". Exponent notation is refused HERE, not by the provider: this bound is a token amount that is forwarded verbatim, and expanding \"1e6\" would mean this tool choosing a digit count on your behalf."
      );
    }
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return String(value);
  }
  throw siteError(
    DexScreenerSiteErrorCodes.SCREEN_SHAPING_VALUE_INVALID,
    `"${key}" must be a non-negative decimal amount; received ${typeof value}`,
    "Pass it as a decimal string, for example \"1000.5\"."
  );
}

/* ------------------------------------------------------------------ */
/* Failure wrapper                                                     */
/* ------------------------------------------------------------------ */

/**
 * Wrap a tool so a typed site failure reaches the agent as its real cause and
 * remedy rather than as an unhandled throw. Only OUR typed failures are
 * converted; anything else keeps propagating so a defect stays visible.
 */
export function guarded(
  publicName: string,
  run: (
    params: Record<string, unknown>,
    signal: AbortSignal | undefined
  ) => Promise<ReturnType<typeof ok>>
): ProtocolHandler {
  return async (params, context) => {
    try {
      return await run(params, context.abortSignal);
    } catch (error) {
      if (isDexScreenerSiteError(error)) {
        return fail(
          `${publicName}: ${error.message}${error.hint === undefined ? "" : ` ${error.hint}`}`
        );
      }
      throw error;
    }
  };
}
