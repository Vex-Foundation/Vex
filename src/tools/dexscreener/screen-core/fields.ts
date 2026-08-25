/**
 * The `fields` vocabulary for the screening surface, and the row shaper.
 *
 * `fields` selects row field GROUPS, the repository convention
 * (`conventions.ts`), not arbitrary field names. Groups exist because the
 * provider sends far more per row than any one question needs, and because two
 * of the groups are heavy enough that shipping them by default would spend the
 * agent's context on data it did not ask for. Those two are named in the param
 * description, the github-mcp pattern: `profile` and `allWindows`.
 *
 * WHAT EACH GROUP IS FOR
 *
 *  - `core` (always on): what every screening answer needs. Identity, the
 *    selected window's prices and metrics, the counts, liquidity, market cap,
 *    age, boosts, and every derived metric. The derived metrics are in the
 *    default deliberately: they are the reason this surface exists, they are
 *    computed from fields already in hand, and a ratio the agent has to compute
 *    itself in prose is a ratio computed wrong.
 *  - `flow`: the raw buy/sell VOLUME split the derived shares are built from,
 *    for a caller that wants to check the arithmetic or bucket it differently.
 *  - `reserves`: the pool's two token reserves (`liquidity.base` and
 *    `liquidity.quote`). The USD liquidity in `core` values both sides
 *    together, so it cannot show a LOPSIDED pool; only the reserves can, and a
 *    lopsided pool is what an exit-liquidity question is actually about.
 *    Measured live 2026-08-25: present on 100 of 100 rows of a solana v7 pairs
 *    page and on 100 of 100 rows of a v2 tokens page, including rows served
 *    with `liquidity.usd` of 0 and a non-zero base reserve. Cheap: two doubles.
 *  - `allWindows`: every metric on all four windows instead of the one
 *    `window` selects. HEAVY: it is four times the per-row metric payload.
 *  - `profile`: the issuer-authored description and links. HEAVY and untrusted;
 *    sanitized and labelled by `./profile.ts`.
 *  - `launchpad`: bonding-curve progress, creator and migration venue. Present
 *    only on launchpad pairs; null elsewhere rather than zero.
 *  - `identity`: the values OTHER tools take as input (AMM id, quote token
 *    address, decimals, creation timestamp) plus the quote-denominated price.
 *    Asked for when the agent is about to make a second call, not when it is
 *    reading a leaderboard.
 *
 * WHAT `missingInputs` COVERS, EXACTLY. A DERIVATION INPUT that the provider
 * omitted is null with its name in `missingInputs`, never zero, and the
 * derived metric that needed it is named in `derivedUnavailable`. That
 * contract belongs to `./project.ts`; this module only decides what ships.
 *
 * It does NOT cover every null on a row, and the difference was measured on a
 * quiet pool: a pair doing one trade a day came back with `priceChange` as an
 * empty object and no token `decimals`, so `priceChangePct` and the decimals
 * projected as null while `missingInputs` named neither. They are DIRECT
 * provider fields rather than inputs to an arithmetic, so nothing derived from
 * them was suppressed and nothing was computed on a substituted value. The
 * honest reading of a null on this surface is therefore: the provider did not
 * send it, whether or not it appears in `missingInputs`; a name in
 * `missingInputs` additionally means a derived metric was withheld because of
 * it. {@link ABSENT_PROVIDER_FIELDS_NOTE} says that to the model.
 */

import { sanitizeIssuerField } from "../sanitize.js";
import { DexScreenerSiteErrorCodes, siteError } from "../site-errors.js";
import type { ProjectedPairRow, ProjectedDerivedMetrics } from "./project.js";
import type { ProjectedProfile } from "./profile.js";
import type { ScreenWindow } from "./request.js";

/* ------------------------------------------------------------------ */
/* Group vocabulary                                                    */
/* ------------------------------------------------------------------ */

export const SCREEN_FIELD_GROUPS = [
  "core",
  "flow",
  "reserves",
  "allWindows",
  "profile",
  "launchpad",
  "identity",
] as const;

export type ScreenFieldGroup = (typeof SCREEN_FIELD_GROUPS)[number];

const GROUPS: ReadonlySet<string> = new Set(SCREEN_FIELD_GROUPS);

/**
 * The reply-level sentence that keeps a null honest.
 *
 * One sentence per reply rather than a per-row list of absent field names: the
 * rows already carry the nulls, the sparse row is the normal shape on a quiet
 * pool rather than an exception worth enumerating 100 times, and a per-row
 * list would cost more bytes than the rows it describes.
 */
export const ABSENT_PROVIDER_FIELDS_NOTE =
  "A null on a row means the provider did not send that field for that pair, and quiet pools send fewer fields: a pool measured at one trade a day returned no priceChange and no token decimals at all. missingInputs is NARROWER than that. It names only the inputs a DERIVED metric needed and did not get, which is why derivedUnavailable sits beside it; a direct provider field that is simply absent is null here and is not listed there. Neither kind of null is a zero, and no figure on these rows was computed on a substituted value.";

/** What ships when the caller says nothing. */
export const SCREEN_FIELD_GROUPS_DEFAULT: readonly ScreenFieldGroup[] = ["core"];

/**
 * The two groups whose cost the param description must name.
 *
 * `allWindows` multiplies the per-row metric payload by four; `profile` adds
 * free-form issuer prose of unbounded length. Naming them is what lets an agent
 * decide, rather than discovering the cost after the response arrives.
 */
export const SCREEN_HEAVIEST_FIELD_GROUPS: readonly ScreenFieldGroup[] = [
  "profile",
  "allWindows",
];

/**
 * Parse the comma-separated `fields` value into groups.
 *
 * `core` is always included, whatever the caller wrote, because a row without
 * its identity is not a row. An unknown group is REFUSED by name with the full
 * vocabulary rather than ignored: silently dropping it would ship the default
 * projection while the agent believed it had asked for more, and the response
 * would look successful.
 */
/**
 * Resolve the requested row field groups.
 *
 * `alwaysInclude` is the board's own floor. `core` is on it for every board;
 * a board whose entire reason to exist is one non-core group adds that group
 * too, because a default that hides the answer is not a default. Measured:
 * the launchpad board ranks by bonding progress and returned no progress, no
 * creator and no migration dex at all unless the caller guessed
 * `fields: "core,launchpad"`, which no description named.
 */
export function parseScreenFieldGroups(
  raw: string | undefined | null,
  alwaysInclude: readonly ScreenFieldGroup[] = SCREEN_FIELD_GROUPS_DEFAULT
): readonly ScreenFieldGroup[] {
  if (raw === undefined || raw === null || raw.trim() === "") {
    return SCREEN_FIELD_GROUPS.filter((group) => alwaysInclude.includes(group));
  }

  const requested = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");

  const unknown = requested.filter((part) => !GROUPS.has(part));
  if (unknown.length > 0) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_FIELD_GROUP_UNKNOWN,
      `"fields" named ${unknown.length === 1 ? "a row field group" : "row field groups"} that does not exist: ${unknown.join(", ")}`,
      `"fields" takes row field GROUPS, not individual field names. Supported groups: ${SCREEN_FIELD_GROUPS.join(", ")}. The two heaviest are ${SCREEN_HEAVIEST_FIELD_GROUPS.join(" and ")}.`
    );
  }

  const selected = new Set<ScreenFieldGroup>(alwaysInclude);
  selected.add("core");
  for (const part of requested) selected.add(part as ScreenFieldGroup);
  // Emitted in the declared vocabulary order so the echo is stable and
  // diffable regardless of the order the caller wrote them in.
  return SCREEN_FIELD_GROUPS.filter((group) => selected.has(group));
}

/* ------------------------------------------------------------------ */
/* Shaped row                                                          */
/* ------------------------------------------------------------------ */

/** One window's metrics, as the `allWindows` group reports them. */
export interface ShapedWindowMetrics {
  readonly priceChangePct: number | null;
  readonly volumeUsd: number | null;
  readonly volumeBuyUsd: number | null;
  readonly volumeSellUsd: number | null;
  readonly buys: string | null;
  readonly sells: string | null;
  readonly buyers: string | null;
  readonly sellers: string | null;
  readonly makers: string | null;
  readonly derived: ProjectedDerivedMetrics;
}

export interface ShapedPairRow {
  /* --- core ------------------------------------------------------- */
  /**
   * The row's 1-based position in the order the provider served, offset
   * included. Present only where the ordering itself is the provider's opaque
   * decision and the agent may need to cite a position it cannot recompute.
   */
  readonly providerRank?: number;
  readonly chainId: string;
  readonly dexId: string;
  readonly labels: readonly string[];
  readonly pairAddress: string;
  readonly baseTokenAddress: string;
  readonly baseTokenName: string | null;
  readonly baseTokenSymbol: string | null;
  readonly quoteTokenSymbol: string | null;
  readonly priceUsd: string | null;
  /** The window every metric below was read from. */
  readonly window: ScreenWindow;
  readonly priceChangePct: number | null;
  readonly volumeUsd: number | null;
  readonly liquidityUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly fdvUsd: number | null;
  readonly pairAgeSeconds: number | null;
  readonly buys: string | null;
  readonly sells: string | null;
  readonly buyers: string | null;
  readonly sellers: string | null;
  readonly makers: string | null;
  readonly boostsActive: number | null;
  readonly derived: ProjectedDerivedMetrics;
  readonly missingInputs: readonly string[];
  /**
   * Inputs this row cannot have, as opposed to inputs the provider omitted.
   * Bonding-curve rows carry `liquidityUsd` here: they have no pool, so the
   * value is not applicable rather than unreported.
   */
  readonly notApplicableInputs?: readonly string[];
  readonly derivedUnavailable: readonly string[];

  /* --- optional groups -------------------------------------------- */
  /** `flow`: the raw split the derived shares are computed from. */
  readonly volumeBuyUsd?: number | null;
  readonly volumeSellUsd?: number | null;
  /**
   * `reserves`: the pool's two sides in TOKENS, not dollars. Null on a row
   * that carries no pool at all (every bonding-curve row), exactly like
   * `liquidityUsd`.
   */
  readonly liquidityBaseTokens?: number | null;
  readonly liquidityQuoteTokens?: number | null;
  /** `allWindows`: every metric on all four windows. */
  readonly windows?: Readonly<Record<ScreenWindow, ShapedWindowMetrics>>;
  /** `profile`: issuer-authored text, sanitized. Null when the token has none. */
  readonly profile?: ProjectedProfile | null;
  /** `launchpad`: bonding-curve state. Null when the pair is not on one. */
  readonly launchpad?: ProjectedPairRow["launchpad"];
  /** `identity`: the values another call takes as input. */
  readonly ammId?: string | null;
  readonly quoteTokenAddress?: string;
  readonly baseTokenDecimals?: number | null;
  readonly quoteTokenDecimals?: number | null;
  readonly pairCreatedAtMs?: number | null;
  readonly priceNative?: string | null;
}

export interface ShapePairRowInput {
  /** The projection for the selected window. */
  readonly row: ProjectedPairRow;
  /**
   * The projections for every window, keyed by window. Required exactly when
   * `allWindows` was requested; the caller produces them by projecting the same
   * provider row once per window, which reuses the one projection contract
   * rather than growing a second reader for the same fields.
   */
  readonly perWindow?: Readonly<Record<ScreenWindow, ProjectedPairRow>>;
  /** The sanitized profile block. Required exactly when `profile` was requested. */
  readonly profile?: ProjectedProfile | null;
  readonly groups: readonly ScreenFieldGroup[];
  /** The row's 1-based position in the provider's order. Omit when unranked. */
  readonly providerRank?: number;
  /**
   * The caller's accumulator of field paths whose invisible characters were
   * removed, shared across every row of the response.
   *
   * The token NAME and SYMBOL are sanitized here rather than in `./project.ts`:
   * they are issuer-authored, they are the single most likely place to hide a
   * smuggled instruction (a ticker is short, quoted everywhere, and nobody
   * inspects its code points), and `project.ts` states in its own header that it
   * strips nothing. Doing it at the shaping boundary keeps that contract intact
   * and still guarantees no unsanitized issuer text leaves this surface.
   */
  readonly sanitized: Set<string>;
}

/**
 * Shape one projected row to the requested groups.
 *
 * Optional groups are OMITTED, not nulled: a key that is absent says "you did
 * not ask for this", while a key present and null says "you asked and the
 * provider had none". Collapsing the two would make an unrequested field
 * indistinguishable from a missing one.
 */
export function shapePairRow(input: ShapePairRowInput): ShapedPairRow {
  const { row, groups, sanitized } = input;
  const has = (group: ScreenFieldGroup): boolean => groups.includes(group);
  const clean = (value: string | null, field: string): string | null =>
    sanitizeIssuerField(value, field, sanitized);

  return {
    ...(input.providerRank === undefined
      ? {}
      : { providerRank: input.providerRank }),
    chainId: row.chainId,
    dexId: row.dexId,
    labels: row.labels,
    pairAddress: row.pairAddress,
    baseTokenAddress: row.baseToken.address,
    baseTokenName: clean(row.baseToken.name, "baseTokenName"),
    baseTokenSymbol: clean(row.baseToken.symbol, "baseTokenSymbol"),
    quoteTokenSymbol: clean(row.quoteToken.symbol, "quoteTokenSymbol"),
    priceUsd: row.priceUsd,
    window: row.window,
    priceChangePct: row.priceChangePct,
    volumeUsd: row.volumeUsd,
    liquidityUsd: row.liquidityUsd,
    marketCapUsd: row.marketCapUsd,
    fdvUsd: row.fdvUsd,
    pairAgeSeconds: row.pairAgeSeconds,
    buys: row.buys,
    sells: row.sells,
    buyers: row.buyers,
    sellers: row.sellers,
    makers: row.makers,
    boostsActive: row.boostsActive,
    derived: row.derived,
    missingInputs: row.missingInputs,
    ...(row.notApplicableInputs === undefined
      ? {}
      : { notApplicableInputs: row.notApplicableInputs }),
    derivedUnavailable: row.derivedUnavailable,

    ...(has("flow")
      ? { volumeBuyUsd: row.volumeBuyUsd, volumeSellUsd: row.volumeSellUsd }
      : {}),
    ...(has("reserves")
      ? {
          liquidityBaseTokens: row.liquidityBaseTokens,
          liquidityQuoteTokens: row.liquidityQuoteTokens,
        }
      : {}),
    ...(has("allWindows") && input.perWindow !== undefined
      ? { windows: toWindowMetrics(input.perWindow) }
      : {}),
    ...(has("profile") ? { profile: input.profile ?? null } : {}),
    ...(has("launchpad") ? { launchpad: row.launchpad } : {}),
    ...(has("identity")
      ? {
          ammId: row.ammId,
          quoteTokenAddress: row.quoteToken.address,
          baseTokenDecimals: row.baseToken.decimals,
          quoteTokenDecimals: row.quoteToken.decimals,
          pairCreatedAtMs: row.pairCreatedAtMs,
          priceNative: row.priceNative,
        }
      : {}),
  };
}

function toWindowMetrics(
  perWindow: Readonly<Record<ScreenWindow, ProjectedPairRow>>
): Readonly<Record<ScreenWindow, ShapedWindowMetrics>> {
  const one = (window: ScreenWindow): ShapedWindowMetrics => {
    const row = perWindow[window];
    return {
      priceChangePct: row.priceChangePct,
      volumeUsd: row.volumeUsd,
      volumeBuyUsd: row.volumeBuyUsd,
      volumeSellUsd: row.volumeSellUsd,
      buys: row.buys,
      sells: row.sells,
      buyers: row.buyers,
      sellers: row.sellers,
      makers: row.makers,
      derived: row.derived,
    };
  };
  return { m5: one("m5"), h1: one("h1"), h6: one("h6"), h24: one("h24") };
}

/**
 * Every row field path that carries issuer-authored text, given the groups
 * that shipped.
 *
 * The envelope's `externalContentFields` must name what is actually in the
 * response: labelling `profile.description` as untrusted when the profile group
 * was not requested tells the agent to distrust a field it cannot see, and
 * omitting it when the group WAS requested is the failure that matters.
 */
export function externalContentFieldsFor(
  groups: readonly ScreenFieldGroup[],
  rowFields: readonly string[],
  profileFields: readonly string[]
): readonly string[] {
  const shaped = rowFields
    .map(toShapedFieldPath)
    .filter((path): path is string => path !== null);
  return groups.includes("profile") ? [...shaped, ...profileFields] : shaped;
}

/**
 * Translate a projection field path to the shaped row's own spelling, or null
 * when the shaped row does not carry that field at all.
 *
 * `project.ts` nests the tokens (`baseToken.name`); the shaped row flattens
 * them (`baseTokenName`) so a leaderboard row is one level deep. The envelope
 * must name the path the agent can actually SEE in the response: labelling a
 * field that is not there tells the agent to distrust something it cannot find.
 * `quoteToken.name` is projected but never shaped, so it maps to null.
 */
function toShapedFieldPath(path: string): string | null {
  switch (path) {
    case "baseToken.name":
      return "baseTokenName";
    case "baseToken.symbol":
      return "baseTokenSymbol";
    case "quoteToken.symbol":
      return "quoteTokenSymbol";
    case "quoteToken.name":
      return null;
    default:
      return path;
  }
}
