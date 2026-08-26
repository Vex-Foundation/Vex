/**
 * The canonical projection of ONE raw DexScreener pair row into the board's
 * hydrated row.
 *
 * WHY THIS IS ITS OWN MODULE, and it is a correctness boundary rather than
 * tidiness. Two paths now turn provider rows into the figures a reader sees on
 * a card: compose-time hydration (`./hydrate.ts`), which writes the durable
 * board, and the desktop app's live poll, which refreshes the same card
 * metrics in place while the user holds a board LIVE. If those two projections
 * could ever disagree - a different rounding, a different null policy, one of
 * them forgetting the issuer-text sanitizer or the nsfw icon gate - a card
 * would change its numbers when the toggle flipped without any market having
 * moved, and neither number would be identifiable as the wrong one. There is
 * therefore exactly ONE projector, it is pure, and both callers use it.
 *
 * The three policies it carries, unchanged from where they were written:
 *
 *  - MONEY IS TEXT. Provider decimal strings are forwarded verbatim; provider
 *    doubles are rendered to a plain decimal string without exponent notation.
 *    Nothing here is added, scaled or rounded.
 *  - PROVIDER TEXT IS UNTRUSTED. Issuer-authored names and symbols pass
 *    through the surface's `sanitizeIssuerField`, and every touched field path
 *    is recorded into the caller's set so the provenance sentence can name it.
 *  - A FLAGGED PROFILE HAS NO ICON. `cmsProfile.nsfw === true` yields a null
 *    `iconId`, decided at the stamp so no durable row, cache or IPC caller can
 *    ever reach one.
 *
 * Pure by contract: no clock of its own (the caller passes `nowMs`), no
 * transport, no I/O. `sanitizedFieldPaths` is the one mutable argument and it
 * is the caller's accumulator.
 */

import { projectPairRow } from "@tools/dexscreener/screen-core/project.js";
import { sanitizeIssuerField } from "@tools/dexscreener/sanitize.js";
import {
  BOARD_ICON_ID_PATTERN,
  type BoardHydratedRow,
} from "../../../../lib/board/index.js";

/**
 * The window the batch channel is asked to rank by, for BOTH board paths.
 *
 * Rows are matched back by identity, so the ranking does not decide what a
 * board shows - but it does decide what the provider's grammar accepts, and a
 * hand-spelled enum member is exactly the defect rule 10 exists for. This
 * spelling is the one the archived live run
 * (`board-v2-probes/live-poll.json`, 25/25 polls) actually sent.
 *
 * Compose-time hydration and the live poll share this constant so the live
 * refresh cannot drift onto a different ranking than the snapshot it replaces.
 */
export const BOARD_BATCH_RANK_KEY = "RANK_BY_KEY_VOLUME";

/** Shape a decimal string must have to be storable. Mirrors the spec's own. */
const DECIMAL_PATTERN = /^[0-9]+(\.[0-9]+)?$/;
const SIGNED_DECIMAL_PATTERN = /^-?[0-9]+(\.[0-9]+)?$/;

/**
 * Render a provider double as a plain decimal string.
 *
 * `toLocaleString` with grouping off is used rather than `String(value)`
 * because the latter emits exponent form at both ends of the range
 * (`1e+21`, `1e-7`), and an exponent is not a decimal string. Twenty
 * fraction digits is the maximum the formatter accepts and is far past any
 * figure this surface reports.
 *
 * Returns null for a value the schema could not hold anyway (not finite, or
 * negative where the field is unsigned). A null here means "no figure", which
 * is exactly what the row's nullable money fields mean.
 */
export function decimalFromNumber(
  value: number | null,
  signed: boolean,
): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (!signed && value < 0) return null;
  const rendered = value.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits: 20,
  });
  const pattern = signed ? SIGNED_DECIMAL_PATTERN : DECIMAL_PATTERN;
  return pattern.test(rendered) ? rendered : null;
}

/** A provider decimal string, forwarded verbatim or refused. Never reshaped. */
export function decimalFromProvider(value: string | null): string | null {
  if (value === null) return null;
  return DECIMAL_PATTERN.test(value) ? value : null;
}

/** A provider uint64 count as an exact integer, or null when it is not one. */
export function countFromProvider(value: string | null): number | null {
  if (value === null) return null;
  if (!/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Non-empty sanitized issuer text, bounded to what the row schema holds. */
function issuerText(
  value: string | null,
  fieldPath: string,
  sanitized: Set<string>,
): string | null {
  const clean = sanitizeIssuerField(value, fieldPath, sanitized);
  if (clean === null) return null;
  const trimmed = clean.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The base token's CMS icon handle for one raw batch row, or null.
 *
 * WHERE IT COMES FROM. `cmsProfile` rides the raw v8 batch row and is read
 * here with the same access pattern `screen-core/profile.ts` uses for the same
 * block. Measured 2026-08-25 on the live channel (probe archive
 * `board-v2-probes/{live-poll.json,base-orient.json}`): `cmsProfile.iconId` is
 * present on profiled pairs and is the icon of the BASE token in the
 * provider's canonical orientation, which is the same orientation this row's
 * `baseTokenSymbol` comes from. The logo and the symbol on a card therefore
 * always name the same token. Roughly half of solana pairs carry no profile at
 * all, so null is the ORDINARY answer here, not a failure.
 *
 * THE NSFW POLICY, and it is a policy rather than a filter: when the provider
 * flags the profile `nsfw`, this returns null and the board renders its
 * monogram placeholder. Flagged issuer artwork is never fetched and never
 * rendered. Deciding it HERE, at the stamp, rather than in the renderer or the
 * fetcher is what makes it structural: a flagged id is never written into the
 * durable document, so no later reader, cache, or IPC caller can reach one.
 * Nothing about the card is otherwise suppressed - the pool, its figures and
 * the agent's caption are facts and still shown.
 *
 * Anything malformed (absent block, non-string id, an id outside the contract's
 * character class) is null. This never throws: an unreadable icon reference is
 * a missing picture, not a reason to refuse a board of real market figures.
 *
 * Exported because it is a pure decision over a provider row, and the policy it
 * carries deserves a table test driven by real row shapes rather than an
 * assertion made through a whole network-shaped hydration.
 */
export function boardIconIdFromRow(source: unknown): string | null {
  if (typeof source !== "object" || source === null) return null;
  const profile = (source as Record<string, unknown>)["cmsProfile"];
  if (typeof profile !== "object" || profile === null) return null;
  const block = profile as Record<string, unknown>;
  if (block["nsfw"] === true) return null;
  const iconId = block["iconId"];
  if (typeof iconId !== "string") return null;
  return BOARD_ICON_ID_PATTERN.test(iconId) ? iconId : null;
}

export interface ProjectBoardRowArgs {
  /**
   * The raw `dex_screener_schema.Pair` row as the batch channel returned it.
   * Typed `unknown` on purpose: it has crossed the wire and is parsed by the
   * surface's own projector, never by a cast here.
   */
  readonly source: unknown;
  /**
   * Clock the window arithmetic (pair age, percentage windows) is taken
   * against. Passed in so this module is pure and both callers can be tested
   * deterministically.
   */
  readonly nowMs: number;
  /**
   * Field-path prefix for the provenance record, e.g. `pools[2]`. Both callers
   * use the same shape so a sanitized path means the same thing whichever path
   * produced it.
   */
  readonly fieldPathPrefix: string;
  /**
   * The caller's accumulator of issuer-text field paths that needed cleaning.
   * Mutated: every path this projection sanitizes is added.
   */
  readonly sanitizedFieldPaths: Set<string>;
}

/**
 * One raw provider row as the board's hydrated row.
 *
 * Never throws and never refuses: an unreadable figure becomes null, which is
 * what the row's nullable fields mean. Refusing a whole board because a pool
 * did not resolve is the CALLER's decision (compose fails closed; the live
 * loop rejects the tick), and it is taken before this function is reached.
 */
export function projectBoardRow(args: ProjectBoardRowArgs): BoardHydratedRow {
  const h24 = projectPairRow(args.source, { window: "h24", nowMs: args.nowMs });
  const h1 = projectPairRow(args.source, { window: "h1", nowMs: args.nowMs });
  const path = args.fieldPathPrefix;
  const sanitized = args.sanitizedFieldPaths;
  return {
    baseTokenSymbol: issuerText(
      h24.baseToken.symbol,
      `${path}.baseToken.symbol`,
      sanitized,
    ),
    baseTokenName: issuerText(h24.baseToken.name, `${path}.baseToken.name`, sanitized),
    quoteTokenSymbol: issuerText(
      h24.quoteToken.symbol,
      `${path}.quoteToken.symbol`,
      sanitized,
    ),
    chainId: h24.chainId,
    dexId: h24.dexId,
    priceUsd: decimalFromProvider(h24.priceUsd),
    priceChange: {
      h1: decimalFromNumber(h1.priceChangePct, true),
      h24: decimalFromNumber(h24.priceChangePct, true),
    },
    liquidityUsd: decimalFromNumber(h24.liquidityUsd, false),
    volumeH24Usd: decimalFromNumber(h24.volumeUsd, false),
    txns: {
      buys: countFromProvider(h24.buys),
      sells: countFromProvider(h24.sells),
    },
    pairAgeSeconds:
      h24.pairAgeSeconds === null ? null : Math.max(0, Math.floor(h24.pairAgeSeconds)),
    // Always emitted, null included: the schema reads the key as optional
    // only so boards persisted before this field existed still parse.
    iconId: boardIconIdFromRow(args.source),
  };
}
