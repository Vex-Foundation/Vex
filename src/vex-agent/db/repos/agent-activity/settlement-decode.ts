/**
 * `route_provenance.settlementDecode` (R1 Step 5a) — the decode inputs a venue
 * handler ALREADY HOLDS at intent time, persisted so a later settlement decode
 * does not have to rediscover or guess them.
 *
 * WHY IT LIVES IN `route_provenance` AND NOT IN A NEW COLUMN. Token identities,
 * decimals, chain id and tx hash are already columns on the row. What is missing
 * is only the small set of facts that identify HOW to read the receipt: which
 * decoder, against which verified router, and — for a native-input swap — the
 * value the signed transaction itself declared. That is a handful of fields on
 * an existing JSONB, not a schema change.
 *
 * WHY A DISCRIMINATED UNION AND NOT ONE OPTIONAL BAG. `route_provenance` is
 * `Record<string, unknown>`: reading it is a boundary, and an optional bag makes
 * the illegal combinations representable — a `kyberswap` hint with no router is
 * exactly the shape that would send a decoder at the wrong contract. Keyed on
 * `decoder`, a variant either carries what its decoder needs or does not parse.
 *
 * OPTIONAL ACCELERATOR, NEVER A SOURCE OF TRUTH. Every row written before this
 * step — including the owner's own swap — has no `settlementDecode` at all. A
 * reader that cannot find one falls back to the row's own columns and the venue
 * implied by `protocol`; if that is not enough to decode SAFELY it leaves the
 * row alone and records why. A missing hint must never become a guessed decode.
 */

import { z } from "zod";

/** Bumped only when a variant's MEANING changes; readers reject what they do not know. */
export const SETTLEMENT_DECODE_VERSION = 1;

const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x EVM address");
/** Atomic units, decimal digits only — never a float, never a human string. */
const rawAmount = z.string().regex(/^[0-9]+$/, "expected an atomic amount in decimal digits");

/**
 * The router the transaction was actually sent to, as VERIFIED by the handler's
 * own deployment/allowlist check — not a value echoed back from a provider
 * response. A decoder matching logs against a router address it did not verify
 * would be trusting the provider to name its own contract.
 */
const routedVariant = z.object({
  v: z.literal(SETTLEMENT_DECODE_VERSION),
  chainId: z.number().int().positive(),
  routerAddress: evmAddress,
  /** The signed transaction's own `value`, present only when the INPUT is native. */
  declaredValueRaw: rawAmount.optional(),
  /** The wrapped-native contract, present only when the OUT leg is native. */
  wrappedNativeAddress: evmAddress.optional(),
});

/**
 * A launch has no router to match and no input token to value: the token being
 * launched does not exist yet when the intent row is written. Its decoder works
 * from the receipt's own logs, so the hint carries the chain and nothing else —
 * and requiring more of it would make the union lie about what the decode needs.
 */
const launchVariant = z.object({
  v: z.literal(SETTLEMENT_DECODE_VERSION),
  chainId: z.number().int().positive(),
});

export const settlementDecodeSchema = z.discriminatedUnion("decoder", [
  routedVariant.extend({ decoder: z.literal("kyberswap") }),
  routedVariant.extend({ decoder: z.literal("uniswap") }),
  routedVariant.extend({ decoder: z.literal("pendle") }),
  routedVariant.extend({ decoder: z.literal("trench_trade") }),
  launchVariant.extend({ decoder: z.literal("trench_launch") }),
]);

export type SettlementDecodeHint = z.infer<typeof settlementDecodeSchema>;

/**
 * Read the hint off a row's `route_provenance`, or `null` when there is none
 * this build can trust.
 *
 * A malformed or unknown-version hint reads as ABSENT rather than throwing: the
 * consumer's contract is already "decode without a hint, or decline", so the
 * safe degradation exists and a throw would only turn a missing accelerator into
 * a failed repair pass. It is not silent — the caller is told `null` and takes
 * its own no-hint path.
 */
export function readSettlementDecodeHint(
  routeProvenance: Record<string, unknown> | null,
): SettlementDecodeHint | null {
  if (routeProvenance === null) return null;
  const parsed = settlementDecodeSchema.safeParse(routeProvenance.settlementDecode);
  return parsed.success ? parsed.data : null;
}

/**
 * Build the hint for a handler's `routeProvenance` at intent time. Returns the
 * object to SPREAD, so a venue that has nothing to add contributes nothing:
 * an absent hint is a supported state, and writing a half-filled one would give
 * a decoder a router address it could not rely on.
 */
export function settlementDecodeProvenance(
  hint: SettlementDecodeHintInput,
): { settlementDecode: SettlementDecodeHint } {
  return { settlementDecode: { ...hint, v: SETTLEMENT_DECODE_VERSION } };
}

/**
 * The hint a caller supplies: every variant minus the version, which this module
 * stamps so no call site can write a version it did not mean.
 *
 * The omit must DISTRIBUTE over the union — a plain `Omit<Union, "v">` collapses
 * to the members' common keys and would silently reject `routerAddress`.
 */
export type SettlementDecodeHintInput =
  SettlementDecodeHint extends infer T
    ? T extends SettlementDecodeHint ? Omit<T, "v"> : never
    : never;
