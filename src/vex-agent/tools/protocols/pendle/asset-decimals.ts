/**
 * The decimals a raw Pendle READ amount needs before an agent may see it.
 *
 * ── WHY THIS IS A SEAM AND NOT A FUNCTION ──────────────────────────
 * Three of the new read tools receive raw base-unit u256 strings from Pendle:
 * order-book sizes (the market's PY unit) and merkle reward amounts (arbitrary
 * reward tokens), plus the per-leg identity `pendle.market.get` reports. NONE of
 * the endpoints behind them carries decimals, and neither does the documented
 * market catalogue `/v2/markets/all` — verified against the recorded live body,
 * whose `pt`/`yt`/`sy` legs are bare `chainId-address` strings.
 *
 * The ONLY catalogue in this repository that carries `decimals` is the per-chain
 * `/v1/{chainId}/assets/all` read behind `market-lookup.ts`'s `buildAssetMap`,
 * which is on this tranche's frozen money path and outside this card's file
 * scope. So the lookup is INJECTED, and injected as a REQUIRED argument: a
 * wiring step cannot forget to decide, because the compiler will not let it.
 *
 * Two implementations are expected:
 *   - {@link PENDLE_READ_NO_ASSET_FACTS} — the honest degradation. Amounts ship
 *     raw, `decimals: null`, `exact: null`, `unreadable: true`, and the tool
 *     says so in words. `"1047061"` is 1.05 at six decimals and 0.00105 at nine;
 *     rules/90 records what guessing that cost, so this never guesses.
 *   - a catalogue-backed lookup (`buildAssetMap`, as `pendle.position.value`
 *     already does for exactly this purpose) — wired when the read lane is
 *     allowed to reach that module.
 *
 * Nothing here fetches anything. It is the shape of the answer plus the two pure
 * functions that turn it into output, so the handlers stay one-responsibility.
 */

import { amountTriplet, type PendleAmount } from "./money-format.js";
import { trustedAddress, trustedText } from "./trusted-fields.js";

/** What a token contributes to a read output: how to name it, how to read it. */
export interface PendleReadAssetFacts {
  symbol: string | null;
  decimals: number | null;
}

/** Keyed by BARE LOWERCASE address, because that is what every read validator emits. */
export type PendleReadAssetFactsByAddress = ReadonlyMap<string, PendleReadAssetFacts>;

/** Resolve one chain's asset facts. Injected — see the module header. */
export type PendleReadAssetFactsLookup = (chainId: number) => Promise<PendleReadAssetFactsByAddress>;

const EMPTY_FACTS: PendleReadAssetFactsByAddress = new Map();

/**
 * The no-catalogue lookup: every amount comes back explicitly UNREADABLE.
 *
 * This is a real product state, not a placeholder — it is what the read lane can
 * honestly say while the only decimals source sits behind a frozen module — and
 * it is asserted in the handler tests so the degraded shape can never drift into
 * an assumed-18 fabrication.
 */
export const PENDLE_READ_NO_ASSET_FACTS: PendleReadAssetFactsLookup = () => Promise.resolve(EMPTY_FACTS);

/**
 * Run the injected lookup without letting its failure take the whole read down.
 *
 * The failure is RETURNED rather than swallowed: a caller that cannot resolve
 * decimals still answers, but it must say why its amounts are unreadable —
 * "Pendle does not publish decimals" and "the catalogue read failed" are
 * different facts, and a bare empty map cannot tell them apart.
 */
export async function resolveAssetFacts(
  lookup: PendleReadAssetFactsLookup,
  chainId: number,
): Promise<{ facts: PendleReadAssetFactsByAddress; failure: unknown | null }> {
  try {
    return { facts: await lookup(chainId), failure: null };
  } catch (err) {
    return { facts: EMPTY_FACTS, failure: err };
  }
}

/** A contract as a read tool reports it: address, plus what is known about it. */
export interface PendleReadToken {
  address: string;
  symbol: string | null;
  decimals: number | null;
}

/**
 * Project a contract address into a read-output token.
 *
 * Returns `null` for an address that does not survive the trusted-fields
 * boundary — a leg we cannot address is a leg we must not name.
 */
export function readToken(address: string | null, facts: PendleReadAssetFactsByAddress): PendleReadToken | null {
  const checked = trustedAddress(address);
  if (checked === null) return null;
  const known = facts.get(checked);
  return {
    address: checked,
    symbol: trustedText(known?.symbol ?? null),
    decimals: known?.decimals ?? null,
  };
}

/**
 * A raw base-unit amount plus, when the decimals were resolvable, the exact
 * human figure. `unreadable` is present ONLY when they were not, so its presence
 * is the signal: the number is real, but nobody may size a decision on it
 * without resolving decimals first.
 */
export interface PendleReadAmount extends PendleAmount {
  unreadable?: true;
}

/** Build the output amount for a raw base-unit string at (possibly unknown) decimals. */
export function readableAmount(raw: string, decimals: number | null): PendleReadAmount {
  const triplet = amountTriplet(raw, decimals);
  return triplet.exact === null ? { ...triplet, unreadable: true } : triplet;
}

/** Sentence a tool prints once when any of its amounts came back unreadable. */
export const PENDLE_UNREADABLE_AMOUNT_NOTE =
  "Some amounts below are RAW base units with no decimals: this Pendle endpoint does not publish them and Vex could " +
  "not resolve them from the chain's asset catalogue. They are flagged `unreadable` and MUST NOT be read as human " +
  "amounts — the same digits mean a thousandfold different quantity at 6 versus 9 decimals.";
