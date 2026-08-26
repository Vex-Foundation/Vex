/**
 * `token_price` wake watch - wake the session EARLY when a token it is sleeping
 * on crosses a price it named.
 *
 * ## Why this evaluator exists
 *
 * "Re-check the price in ten minutes" is a timer sized for a guess. The agent
 * either sleeps through the move or wakes fifty times to find nothing. The watch
 * removes the guess from the good case WITHOUT removing the timer: the deferred
 * wake still fires at `due_at`, and a crossed threshold only ever moves that
 * deadline EARLIER (`promotePendingWake` is a `LEAST(due_at, NOW())`).
 *
 * ## Everything expensive resolves ONCE, here
 *
 * Chain slug, address bounds, threshold decimal, budget admission and one
 * provider call that proves the token HAS a price all happen at validation. The
 * trigger predicate is then pure and allocation-free-ish, which matters because
 * the poller runs it for every pending watch on every 3 s tick.
 *
 * ## EVM-only in v1 (owner decision)
 *
 * The chain must resolve through the EVM chain registry and the token must be a
 * 0x 20-byte address. Solana is a NAMED rejection, not a silent failure: a
 * Solana mint would sail through a permissive slug check and then quietly never
 * fire, which is the worst possible outcome for a wait.
 *
 * ## Three outcomes, and only one of them cancels the sleep
 *
 * An unusable condition is REJECTED BY NAME and the defer still parks on its
 * timer (see `watch-registry.ts` for why a rejected watch must never fail the
 * defer). A condition that is ALREADY TRUE is different: sleeping on it would be
 * a straight loss, so it throws `WakeWatchSatisfiedError` and `LoopDefer`
 * declines to park at all.
 */

import { z } from "zod";

import { describeFailureForAgent } from "@utils/error-summary.js";
import type { DexPair } from "@tools/dexscreener/types.js";
import {
  compareBoundedDecimals,
  formatBoundedDecimal,
  isPositiveDecimal,
  parseBoundedDecimal,
  selectTokenWatchPrice,
  type BoundedDecimal,
} from "@tools/dexscreener/token-watch-price.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import {
  addressShapeHint,
  familyForSlug,
  isValidAddressForFamily,
  normalizeAddressForFamily,
  resolveWatchChain,
  type ResolvedWatchChain,
  type TokenPriceChainFamily,
} from "./token-price/chain-domain.js";
import {
  WakeWatchSatisfiedError,
  type WakeWatchCondition,
  type WakeWatchEvaluator,
  type WakeWatchSignal,
} from "../watch-registry.js";

export const TOKEN_PRICE_WATCH_TYPE = "token_price";

/**
 * How many distinct (chain, token) pairs may be watched process-wide.
 *
 * Every watched pair is one DexScreener request per poll tick, shared with every
 * other consumer of the same per-process rate budget. Admission here is
 * BEST-EFFORT: counting and enqueueing are not one transaction, so a race can
 * transiently admit a thirteenth. The HARD bound lives in the poller, which
 * processes at most this many pairs per tick regardless.
 */
export const TOKEN_PRICE_WATCH_BUDGET = 12;

/** The shape a resolved slug has, either family. */
const CHAIN_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Loose enough to accept BOTH families; the family check is the real gate. */
const ANY_TOKEN_ADDRESS = /^[0-9A-Za-z]{32,44}$|^0x[0-9a-fA-F]{40}$/;
const CHAIN_MAX_CHARS = 40;
const PRICE_MAX_CHARS = 64;

const CHAIN_DOMAIN_NOTE =
  "token_price watch covers EVM chains (slug or numeric id, e.g. base or 8453, with a 0x 20-byte "
  + "token address) and solana (with a base58 mint address). Other chain families are not "
  + "supported yet.";

const TokenPriceInput = z.object({
  type: z.literal(TOKEN_PRICE_WATCH_TYPE),
  chain: z
    .string({ error: "chain is required (an EVM chain slug or numeric chain id)" })
    .min(1, { message: "chain must be a non-empty string" })
    .max(CHAIN_MAX_CHARS, { message: `chain must be at most ${CHAIN_MAX_CHARS} chars` }),
  tokenAddress: z
    .string({ error: "tokenAddress is required (the token address or mint to watch)" })
    .regex(ANY_TOKEN_ADDRESS, { message: CHAIN_DOMAIN_NOTE }),
  direction: z.enum(["above", "below"], {
    error: "direction must be \"above\" or \"below\"",
  }),
  priceUsd: z
    .string({ error: "priceUsd is required as a decimal STRING, e.g. \"0.0125\"" })
    .min(1, { message: "priceUsd must be a non-empty decimal string" })
    .max(PRICE_MAX_CHARS, { message: `priceUsd must be at most ${PRICE_MAX_CHARS} chars` }),
});

export type TokenPriceDirection = "above" | "below";

/**
 * The fields the TRIGGER path needs, and the only ones it will act on.
 *
 * Separate from the full persisted shape because the two are read under
 * different trust: the canonical object below is what WE write, while this is
 * what a later process READS back out of JSONB and must re-prove.
 */
export interface ArmedTokenPriceCondition extends WakeWatchCondition {
  readonly type: typeof TOKEN_PRICE_WATCH_TYPE;
  /** Resolved EVM chain slug, as DexScreener spells it. */
  readonly chain: string;
  /** Lowercase 0x address. Lowercase, not checksummed, because every compare is. */
  readonly tokenAddress: string;
  readonly direction: TokenPriceDirection;
  /** Canonical decimal string of the threshold. */
  readonly priceUsd: string;
}

/** The canonical shape persisted in `loop_wake_requests.payload.conditions`. */
export interface TokenPriceCondition extends ArmedTokenPriceCondition {
  /** The normalized price observed while arming - makes drift diagnosable. */
  readonly referencePriceUsd: string;
  /** Pools the provider held for this token when the watch was armed. */
  readonly poolCount: number;
}

export interface TokenPriceWatchPair {
  readonly chain: string;
  readonly tokenAddress: string;
}

export interface TokenPriceDeps {
  readonly getTokenPairs: (chainSlug: string, tokenAddress: string) => Promise<DexPair[]>;
  /** (chain, token) pairs already carried by PENDING watches, for admission. */
  readonly listPendingPriceWatchPairs: () => Promise<readonly TokenPriceWatchPair[]>;
}

/**
 * The provider read this watch arms on, and the one the poller must agree with.
 *
 * Exported so the DEFAULT wiring is testable end to end rather than only the
 * injected one: the pool list decides which price a session wakes to trade at,
 * so "which rows reach `selectTokenWatchPrice`" is part of this module's
 * observable contract, not an implementation detail of its default argument.
 */
export async function readWatchedTokenPools(
  chainSlug: string,
  tokenAddress: string,
): Promise<DexPair[]> {
  const { readTokenPools } = await import("@tools/dexscreener/price-read.js");
  return readTokenPools(chainSlug, tokenAddress);
}

async function defaultListPendingPairs(): Promise<readonly TokenPriceWatchPair[]> {
  const { getPendingWithWatchType } = await import("@vex-agent/db/repos/loop-wake.js");
  const rows = await getPendingWithWatchType(TOKEN_PRICE_WATCH_TYPE);
  return rows.flatMap((row) => readTokenPriceConditions(row.payload));
}

/**
 * Re-prove one persisted condition, or `null`.
 *
 * The payload is JSONB written by an earlier process version, so nothing in it
 * is believed on the strength of having the right key. `chain` reaches a
 * provider URL and `priceUsd` reaches the comparison that decides whether a
 * session wakes to trade, so each field must match the exact shape THIS module
 * produces - not merely be a string of plausible length. The result is
 * CONSTRUCTED field by field rather than cast, so an extra or drifted property
 * cannot ride along into the trigger path.
 */
function parseArmedCondition(raw: unknown): ArmedTokenPriceCondition | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.type !== TOKEN_PRICE_WATCH_TYPE) return null;

  const { chain, tokenAddress, direction, priceUsd } = candidate;
  if (typeof chain !== "string" || !CHAIN_SLUG.test(chain)) return null;
  // Membership, not just shape: a slug-shaped chain outside the closed set
  // ("bitcoin") must not survive read-back, or the poller would ask the
  // provider for a chain no evaluator could ever have armed. The persisted
  // spelling must BE the canonical slug this module writes, so a resolvable
  // alias that is not the stored form is refused too.
  const resolved = resolveWatchChain(chain);
  if (resolved === null || resolved.slug !== chain) return null;
  const family = resolved.family;
  if (typeof tokenAddress !== "string") return null;
  if (!isValidAddressForFamily(family, tokenAddress)) return null;
  if (direction !== "above" && direction !== "below") return null;
  if (typeof priceUsd !== "string") return null;

  const threshold = parseBoundedDecimal(priceUsd);
  if (threshold === null || !isPositiveDecimal(threshold)) return null;

  return {
    type: TOKEN_PRICE_WATCH_TYPE,
    chain,
    tokenAddress: normalizeAddressForFamily(family, tokenAddress),
    direction,
    priceUsd,
  };
}

/**
 * The usable armed conditions of one wake row's payload.
 *
 * Shared with the poller, which needs the same read and must not grow its own
 * copy of the parsing rule. A malformed condition is SKIPPED, never coerced:
 * the wake it belongs to still fires on its timer.
 */
export function readTokenPriceConditions(
  payload: Record<string, unknown> | null,
): ArmedTokenPriceCondition[] {
  const conditions = payload?.conditions;
  if (!Array.isArray(conditions)) return [];
  const parsed: ArmedTokenPriceCondition[] = [];
  for (const raw of conditions) {
    const condition = parseArmedCondition(raw);
    if (condition !== null) parsed.push(condition);
  }
  return parsed;
}

/** Has `observed` reached the threshold in `direction`? Touching counts. */
export function hasCrossedThreshold(
  observed: BoundedDecimal,
  threshold: BoundedDecimal,
  direction: TokenPriceDirection,
): boolean {
  const comparison = compareBoundedDecimals(observed, threshold);
  return direction === "above" ? comparison >= 0 : comparison <= 0;
}

function resolveWatchedChain(chain: string): ResolvedWatchChain {
  const resolved = resolveWatchChain(chain);
  if (resolved === null) {
    throw new Error(`chain "${chain}" is not a supported chain. ${CHAIN_DOMAIN_NOTE}`);
  }
  return resolved;
}

/**
 * The address must fit the family of the chain the model named. Refused with
 * the shape THAT chain expects: a 0x address sent with `chain: "solana"` is the
 * mistake a model actually makes, and "invalid address" would not correct it.
 */
function normalizeWatchedAddress(
  family: TokenPriceChainFamily,
  chainSlug: string,
  rawAddress: string,
): string {
  if (!isValidAddressForFamily(family, rawAddress)) {
    throw new Error(
      `tokenAddress "${rawAddress}" is not a valid address on ${chainSlug}: `
      + `${addressShapeHint(family)}.`,
    );
  }
  return normalizeAddressForFamily(family, rawAddress);
}

function parseThreshold(priceUsd: string): BoundedDecimal {
  const threshold = parseBoundedDecimal(priceUsd);
  if (threshold === null) {
    throw new Error(
      `priceUsd "${priceUsd}" is not a plain decimal number. Write it as digits with an optional `
      + "decimal point, e.g. \"0.0125\" or \"1850\" - no exponent, no currency symbol, no commas.",
    );
  }
  if (!isPositiveDecimal(threshold)) {
    throw new Error("priceUsd must be greater than zero; a price can never cross a zero threshold.");
  }
  return threshold;
}

async function assertWithinBudget(
  candidate: TokenPriceWatchPair,
  deps: TokenPriceDeps,
): Promise<void> {
  const pending = await deps.listPendingPriceWatchPairs();
  const watched = new Set(pending.map((pair) => `${pair.chain}:${pair.tokenAddress}`));
  const key = `${candidate.chain}:${candidate.tokenAddress}`;
  if (watched.has(key) || watched.size < TOKEN_PRICE_WATCH_BUDGET) return;
  throw new Error(
    `the price-watch budget of ${TOKEN_PRICE_WATCH_BUDGET} distinct tokens is already in use across `
    + "active sessions. Defer on your timer and re-check this token when you wake, or watch it "
    + "after one of the existing watches fires.",
  );
}

export function createTokenPriceEvaluator(
  deps: TokenPriceDeps = {
    getTokenPairs: readWatchedTokenPools,
    listPendingPriceWatchPairs: defaultListPendingPairs,
  },
): WakeWatchEvaluator {
  return {
    type: TOKEN_PRICE_WATCH_TYPE,

    async validate(
      condition: WakeWatchCondition,
      _context: InternalToolContext,
    ): Promise<WakeWatchCondition> {
      const parsed = TokenPriceInput.safeParse(condition);
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message ?? "invalid token_price condition");
      }
      const { chain, direction } = parsed.data;
      const { slug: chainSlug, family } = resolveWatchedChain(chain);
      const tokenAddress = normalizeWatchedAddress(family, chainSlug, parsed.data.tokenAddress);
      const threshold = parseThreshold(parsed.data.priceUsd);

      let pairs: DexPair[];
      try {
        pairs = await deps.getTokenPairs(chainSlug, tokenAddress);
      } catch (error) {
        // The REAL cause, secret-redacted and URL-stripped: a model told only
        // "lookup failed" retries blind, and a raw provider body is a leak.
        const detail = describeFailureForAgent(error);
        throw new Error(
          `could not read this token's pools to arm the watch: ${detail}. The price source may be `
          + "rate limited or down; try again, or defer on your timer alone.",
        );
      }

      const selected = selectTokenWatchPrice(pairs, {
        chainSlug,
        tokenAddress,
        caseSensitiveAddress: family === "solana",
      });
      if (selected === null) {
        throw new Error(
          `no priced pool for ${tokenAddress} on ${chainSlug} that we would act on, so there is no `
          + "price to watch. Check the address and chain with TokenFind, or watch a token that "
          + "trades on a DEX this price source indexes.",
        );
      }

      if (hasCrossedThreshold(selected.price, threshold, direction)) {
        throw new WakeWatchSatisfiedError(
          `the price is ALREADY ${direction} your threshold: ${tokenAddress} on ${chainSlug} is at `
          + `${selected.priceUsd} USD against a threshold of ${formatBoundedDecimal(threshold)}. `
          + "Act on it now instead of waiting for it.",
        );
      }

      // Budget LAST, and deliberately so. It bounds the number of ACTIVE
      // watches, i.e. the per-tick provider cost; a condition that is already
      // true never becomes one, so refusing it for budget would answer "come
      // back later" to a model whose move is available right now. One extra
      // provider call for an over-budget arming attempt is the price of that,
      // and it is the same call the model would otherwise make by hand.
      await assertWithinBudget({ chain: chainSlug, tokenAddress }, deps);

      const canonical: TokenPriceCondition = {
        type: TOKEN_PRICE_WATCH_TYPE,
        chain: chainSlug,
        tokenAddress,
        direction,
        priceUsd: formatBoundedDecimal(threshold),
        referencePriceUsd: selected.priceUsd,
        poolCount: selected.poolCount,
      };
      return canonical;
    },

    isTriggered(condition: WakeWatchCondition, signal: WakeWatchSignal): boolean {
      if (signal.type !== TOKEN_PRICE_WATCH_TYPE) return false;

      const { chain, tokenAddress, direction, priceUsd } = condition;
      if (typeof chain !== "string" || typeof tokenAddress !== "string") return false;
      if (direction !== "above" && direction !== "below") return false;
      if (chain.toLowerCase() !== (signal.values.chain ?? "").toLowerCase()) return false;
      // Address identity is per family: EVM folds case, base58 does not.
      const family = familyForSlug(chain);
      const signalled = signal.values.tokenAddress ?? "";
      if (normalizeAddressForFamily(family, tokenAddress)
        !== normalizeAddressForFamily(family, signalled)) {
        return false;
      }

      const threshold = typeof priceUsd === "string" ? parseBoundedDecimal(priceUsd) : null;
      const observed = parseBoundedDecimal(signal.values.priceUsd);
      if (threshold === null || observed === null) return false;
      if (!isPositiveDecimal(threshold) || !isPositiveDecimal(observed)) return false;

      return hasCrossedThreshold(observed, threshold, direction);
    },
  };
}
