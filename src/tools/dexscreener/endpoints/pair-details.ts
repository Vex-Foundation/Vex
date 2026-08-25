/**
 * The pair-details endpoint: audits, holders, liquidity locks, supply, chain
 * authority and listing identity for one pair.
 *
 * `GET https://io.dexscreener.com/dex/pair-details/v4/{chain}/{id}[?inverted=1]`
 *
 * Plain JSON, not protobuf and not Avro. 4-15 KB, `cache-control: public,
 * max-age=60`. The WHOLE path is lowercased (measured), and the id slot accepts
 * a pair address or a token address.
 *
 * FIVE MEASURED FACTS THIS MODULE IS BUILT AROUND, each one a rule-90 hazard if
 * it is not honoured:
 *
 *  1. PERCENTAGE UNITS DIFFER BY SOURCE AND DIFFER BY 100x. GoPlus emits
 *     FRACTIONS (`percent: "0.086817222047280560"` is 8.68 percent) while the
 *     DexScreener `holders` block emits PERCENTAGES (`percentage: 4.65` is 4.65
 *     percent). Every percentage here therefore travels as
 *     `{raw, normalizedPct, unit}`: the provider's own string, the value in
 *     percent, and which unit the provider used. Nothing in this module ever
 *     adds two percentages that did not declare the same unit.
 *  2. HTTP 200 WITH EVERY BLOCK NULL IS A REAL ANSWER AND IT MEANS "NOT
 *     INDEXED", NOT "CLEAN". The provider serves a well-formed document whose
 *     every key is null for a pair it has not analysed. That renders as
 *     `unavailable` with reason `not_indexed_yet`. Reporting it as a pass would
 *     be the single most dangerous thing this surface could do.
 *  3. ROUTE-KEYED CACHES DIVERGE, USUALLY IN AGE. The pair-id route and the
 *     token-id route hold separate cache entries. Two independent
 *     re-measurements found the same holder counts and the same non-null block
 *     set on both routes while their underlying analyses were 32 minutes and
 *     4 hours 45 minutes apart, and the block SET present has been measured
 *     flapping between entries as well. Once, at the extreme, the two routes
 *     really did disagree: 8,483 holders against 351, for six minutes. So the
 *     routine hazard is two plausible reports of different age rather than two
 *     contradictory ones. The answer names the route it used; a reader
 *     comparing two reports can see whether they even asked the same question.
 *  4. COVERAGE COMES FROM THE RESPONSE, NEVER FROM THE CATALOG. The chains
 *     catalog lists a GoPlus integration on 56 chains while pair-details was
 *     measured answering with a GoPlus block on 21. Presence of an integration
 *     key is not proof the block answers, so `coverage` is derived here from
 *     what actually arrived.
 *  5. COVERAGE IS ONE CACHE ENTRY'S POINT-IN-TIME STATE, AND BLOCKS FLAP. The
 *     same subject five minutes apart returned different non-null block sets:
 *     `raw-eth-usdcweth-plain` (a Cloudflare HIT, age 14) carried NO `cg`
 *     while a MISS on the same base token carried one, and the mixed-case and
 *     lowercased spellings of one Solana pair URL answered with different sets
 *     (`cg` and `su` present only on the second). So a block reported absent
 *     may be an artefact of WHICH cache entry answered. `coverage` is an
 *     observation of this response, never a statement that the provider has
 *     nothing, and the handler says so in the envelope rather than letting a
 *     reader infer permanence.
 *
 * This module OWNS provider units and provider block identity. Field-group
 * selection, concentration arithmetic over the returned rows and the model-
 * visible envelope belong to the handler.
 */

import {
  DexScreenerSiteErrorCodes,
  isDexScreenerSiteError,
  siteError,
} from "../site-errors.js";
import type { DexScreenerTransport } from "../transport.js";
import {
  isJsonNumber,
  parseJsonPreservingNumbers,
  rawJsonByteLength,
} from "../codec/json-lexemes.js";

/** The site host that serves pair details. */
export const DEXSCREENER_PAIR_DETAILS_ORIGIN = "https://io.dexscreener.com";

/**
 * Byte ceiling for one pair-details document.
 *
 * Measured 3,918 to 12,502 bytes across three chain classes. Two megabytes
 * leaves room for a contract with a very large `suspiciousFunctions` body and
 * still bounds the read; over-cap is a typed rejection naming the cap.
 */
export const PAIR_DETAILS_MAX_BYTES = 2_000_000;

/** Which route the document was fetched on. Route-keyed caches diverge. */
export type PairDetailsRoute = "pair_id" | "token_id";

/** How a provider expressed a percentage, so two of them are never added blindly. */
/**
 * The scale a provider's percentage arrives on.
 *
 * `unverified` is a real third state, not a placeholder: it means the unit
 * could not be discriminated against live bytes, so the raw value is shipped
 * with `normalizedPct: null` rather than a number that might be 100x wrong.
 * Asserting a unit that was never measured is exactly the defect that made a
 * 4 percent buy tax read as 0.04 percent.
 */
export type PercentUnit = "fraction" | "percent" | "unverified";

/**
 * One percentage, carrying its provider form and its normalized value.
 *
 * `normalizedPct` is ALWAYS in percent (0-100). `raw` is exactly what the
 * provider sent, as a string, so a reader can audit the conversion and so a
 * decimal value never passes through binary floating point on its way to the
 * model.
 */
export interface NormalizedPercent {
  readonly raw: string;
  readonly normalizedPct: number | null;
  readonly unit: PercentUnit;
}

/** A tax value. Same discipline: the provider's string plus a normalized percent. */
export interface TaxValue extends NormalizedPercent {
  /** Which provider stated it, because GoPlus and QuickIntel disagree. */
  readonly source: "goplus" | "quickintel";
}

/** One holder row, from whichever block supplied it. */
export interface HolderRow {
  readonly address: string;
  /** Base-token amount as the provider wrote it. A decimal string, never a float. */
  readonly balance: string | null;
  readonly share: NormalizedPercent | null;
  /**
   * The provider's classification of the address, when it gave one.
   *
   * Null means UNCLASSIFIED, not "an ordinary wallet". The distinction is what
   * makes `unclassifiedPct` a real number instead of a silent zero.
   */
  readonly tag: string | null;
  readonly isContract: boolean | null;
  readonly isLocked: boolean | null;
}

/** One venue GoPlus saw the token trading on. */
export interface VenueRow {
  readonly name: string | null;
  readonly liquidityUsd: string | null;
  readonly pairAddress: string | null;
}

/** One liquidity lock row. */
export interface LiquidityLockRow {
  readonly tag: string | null;
  /**
   * The provider's own lock reference, VERBATIM, and NOT an address.
   *
   * Measured 2026-08-25 on ethereum FLOKI (`0xcf0C122c...`): the provider sent
   * `"1-0x663a5c229c09b049e36dcc11a9b0d4a8eb9db2"`, a chain-id-prefixed string
   * whose hex body is TRUNCATED to two characters short of an address, while
   * the same document's `gp.lpHolders[0].address` carried the real locker
   * `0x663a5c229c09b049e36dcc11a9b0d4a8eb9db214`. The provider is keeping a
   * 42-character field width and losing the last two hex digits to the `1-`
   * prefix. It was previously emitted to the model as `address`; a model that
   * pastes that value into an explorer or a transfer resolves a DIFFERENT
   * identity or none, which on a money path is not an approximation. So the
   * field is named for what it is and `address` is derived separately, present
   * only when the value really is one.
   */
  readonly providerLockRef: string | null;
  /**
   * The lock holder's address, or null when the provider's reference is not one.
   *
   * Set only when `providerLockRef` matches a full EVM address or a base58
   * account of Solana length. Null means "the provider did not give a usable
   * address here", never "the lock has no holder".
   */
  readonly address: string | null;
  readonly amount: string | null;
  readonly share: NormalizedPercent | null;
  readonly url: string | null;
}

/** The GoPlus block, as it arrived. Every field nullable: coverage is per-field. */
export interface GoPlusBlock {
  readonly dataStatus: string | null;
  readonly isHoneypot: boolean | null;
  readonly isOpenSource: boolean | null;
  readonly isProxy: boolean | null;
  readonly isMintable: boolean | null;
  readonly isBlacklisted: boolean | null;
  readonly isWhitelisted: boolean | null;
  readonly transferPausable: boolean | null;
  readonly hiddenOwner: boolean | null;
  readonly canTakeBackOwnership: boolean | null;
  readonly cannotSellAll: boolean | null;
  readonly slippageModifiable: boolean | null;
  readonly isAntiWhale: boolean | null;
  readonly antiWhaleModifiable: boolean | null;
  readonly tradingCooldown: boolean | null;
  readonly externalCall: boolean | null;
  readonly trustList: boolean | null;
  readonly buyTax: TaxValue | null;
  readonly sellTax: TaxValue | null;
  readonly ownerAddress: string | null;
  readonly ownerBalance: string | null;
  readonly ownerShare: NormalizedPercent | null;
  readonly creatorAddress: string | null;
  readonly creatorBalance: string | null;
  readonly creatorShare: NormalizedPercent | null;
  readonly holderCount: number | null;
  readonly holders: readonly HolderRow[];
  readonly lpHolderCount: number | null;
  readonly lpHolders: readonly HolderRow[];
  readonly lpTotalSupply: string | null;
  readonly totalSupply: string | null;
  readonly venues: readonly VenueRow[];
  /**
   * The token GoPlus says it analysed, from `gp.tokenName`/`gp.tokenSymbol`.
   *
   * `address` is always null here: GoPlus states a name and a symbol on this
   * endpoint and no address, so the identity is checkable by SYMBOL only.
   * QuickIntel's `auditedToken` is the one that carries an address.
   */
  readonly auditedToken: AnalyzedTokenIdentity | null;
  readonly analyzedAtMs: number | null;
  /** Field names present in the provider block that this projection does not carry. */
  readonly unprojectedKeys: readonly string[];
}

/**
 * The token a provider states it analysed.
 *
 * `source` names WHICH provider said so, because the two do not always agree
 * about spelling or casing and neither is authority over the other.
 */
export interface AnalyzedTokenIdentity {
  /** Verbatim, CASE-PRESERVED. Never re-cased: a re-cased address is a different string. */
  readonly address: string | null;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly source: "goplus" | "quickintel";
}

/** The QuickIntel block. */
export interface QuickIntelBlock {
  readonly contractVerified: boolean | null;
  readonly isScam: boolean | null;
  readonly contractRenounced: boolean | null;
  readonly hiddenOwner: boolean | null;
  readonly isProxy: boolean | null;
  readonly canMint: boolean | null;
  readonly canBurn: boolean | null;
  readonly canBlacklist: boolean | null;
  readonly canWhitelist: boolean | null;
  readonly canPauseTrading: boolean | null;
  readonly canUpdateFees: boolean | null;
  readonly canUpdateMaxWallet: boolean | null;
  readonly canUpdateMaxTx: boolean | null;
  readonly canUpdateWallets: boolean | null;
  readonly hasTradingCooldown: boolean | null;
  readonly hasSuspiciousFunctions: boolean | null;
  readonly hasExternalFunctions: boolean | null;
  readonly hasModifiedTransferWarning: boolean | null;
  readonly hasScams: boolean | null;
  /**
   * The four `quickiAudit` risk flags that were arriving and being DROPPED.
   *
   * Measured 2026-08-25: `parseQuickIntel` computed `unprojectedKeys` over the
   * ROOT keys only, so every field of the three nested objects was invisible
   * and `qi.unprojectedKeys` read `[]` on all 13 live documents while 24
   * nested fields were silently discarded. These four are safety signals of
   * exactly the class this tool exists to report, so they are projected rather
   * than merely named. Null is UNKNOWN: QuickIntel emits each one only on the
   * chains and contract kinds where it evaluated it.
   */
  readonly hasFeeWarning: boolean | null;
  readonly hasExternalContractRisk: boolean | null;
  readonly hasGeneralVulnerabilities: boolean | null;
  readonly hasObfuscatedAddressRisk: boolean | null;
  /** Whether the owner can blacklist many addresses in one call. */
  readonly canMultiBlacklist: boolean | null;
  /**
   * The implementation contract behind a proxy, when QuickIntel resolved one.
   *
   * Non-null means the audited address delegates its logic elsewhere, so the
   * flags above describe the proxy and the implementation can be replaced.
   */
  readonly proxyImplementation: string | null;
  /**
   * The per-transaction size limit the contract enforces, in whole tokens.
   *
   * A money-path fact for a buy decision: a limit smaller than an intended
   * order makes the order revert. A decimal string exactly as sent.
   */
  readonly maxTransaction: string | null;
  /**
   * `maxTransaction` as a share, UNIT NOT DISCRIMINATED.
   *
   * Measured `"0.1"` beside `maxTransaction "100000000"` on Saitama, which is
   * consistent with either 0.1 percent or a 10 percent fraction, so the scale
   * is not asserted. `maxTransaction` is the unambiguous figure.
   */
  readonly maxTransactionPercent: NormalizedPercent | null;
  /**
   * QuickIntel's own modelled price impact, UNIT NOT DISCRIMINATED.
   *
   * Measured `"15.8"` on FLOKI and `"0.0"` on USDC and HEX; the sibling tax
   * fields on the same object are percent-scaled, but that is corroboration
   * rather than measurement and this is the same class of field that was 100x
   * wrong on the GoPlus side.
   */
  readonly priceImpact: NormalizedPercent | null;
  /**
   * Token AMOUNT burned, not a share. A decimal string, never a float.
   *
   * Named separately from `lpBurnedPct` because they measure different things:
   * this is supply removed from circulation, that is the LP position burned.
   */
  readonly tokenSupplyBurned: string | null;
  /**
   * WHICH TOKEN THE PROVIDER SAYS IT ANALYSED, from `qi.tokenAddress`.
   *
   * The whole document is a report about one token, and until now nothing in
   * the pipeline could check that token against the one the caller believes it
   * asked about: the subject's base or quote side is resolved on a DIFFERENT
   * endpoint. Measured on the USDC/WETH v3 pool: the plain route answers
   * `0xC02aaA39...` (WETH) and `?inverted=1` answers `0xA0b86991...` (USDC),
   * so the provider states its own subject and it is checkable. On a money
   * path, a safety report whose subject cannot be verified is one orientation
   * bug away from being about the wrong contract.
   */
  readonly auditedToken: AnalyzedTokenIdentity | null;
  readonly isHoneypot: boolean | null;
  readonly buyTax: TaxValue | null;
  readonly sellTax: TaxValue | null;
  readonly transferTax: TaxValue | null;
  readonly lpBurnedPct: NormalizedPercent | null;
  readonly contractOwner: string | null;
  readonly contractCreator: string | null;
  readonly contractName: string | null;
  readonly tokenDecimals: number | null;
  readonly tokenSupply: string | null;
  readonly tokenCreatedAtMs: number | null;
  /**
   * `tokenDynamicDetails.problem`.
   *
   * Reported verbatim and NEVER merged into a verdict: the captured SEMI
   * response set it true while the same block's own flags reported no issue.
   */
  readonly problem: boolean | null;
  /** Verbatim Solidity the provider flagged. Large; opt-in at the handler. */
  readonly suspiciousFunctions: readonly string[];
  readonly externalFunctions: readonly string[];
  readonly onlyOwnerFunctions: readonly string[];
  readonly functions: readonly string[];
  readonly analyzedAtMs: number | null;
  readonly unprojectedKeys: readonly string[];
}

/** The DexScreener-native holder distribution block (measured on Solana). */
export interface HoldersBlock {
  readonly holderCount: number | null;
  readonly totalSupply: string | null;
  readonly rows: readonly HolderRow[];
}

/** Chain-native authority flags. */
export interface TokenAuthorityBlock {
  readonly solanaMintable: boolean | null;
  readonly solanaFreezable: boolean | null;
  readonly solanaBridgeMintOnly: boolean | null;
  readonly solanaMintableReason: string | null;
}

/** Circulating and total supply. */
export interface SupplyBlock {
  readonly circulatingSupply: string | null;
  readonly totalSupply: string | null;
}

/** Liquidity locks. */
export interface LiquidityLocksBlock {
  readonly totalShare: NormalizedPercent | null;
  readonly rows: readonly LiquidityLockRow[];
}

/** One issuer-published link. */
export interface ProfileLink {
  readonly label: string | null;
  readonly type: string | null;
  readonly url: string;
}

/** The DexScreener CMS profile: issuer-authored, untrusted by contract. */
export interface ProfileBlock {
  readonly chainId: string | null;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly address: string | null;
  readonly description: string | null;
  readonly links: readonly ProfileLink[];
  readonly iconId: string | null;
  readonly headerId: string | null;
  readonly metaIds: readonly string[];
  readonly createdAtMs: number | null;
  readonly updatedAtMs: number | null;
  /**
   * Keys the provider sent on this block that nothing above reads.
   *
   * Same mechanism `parseListing` already uses, added here because the CMS
   * block was the one place on this document where fields were dropped with
   * NOTHING naming them: `claims` and `pairAddresses` were measured arriving
   * and vanishing. A dropped field a reader can see the name of is a declared
   * omission; one nobody can see is an undeclared gap.
   */
  readonly unprojectedKeys: readonly string[];
}

/**
 * One link a listing venue publishes for the token.
 *
 * `label` is the venue's own caption when it sent one (CoinGecko sends
 * `{label, url}` rows; CoinMarketCap sends bare url strings grouped by kind),
 * and `kind` names the group the url came from. Both are issuer- or
 * venue-authored text and are sanitized before they are emitted.
 */
export interface ListingLink {
  readonly url: string;
  readonly label: string | null;
  /** The url group: `website`, `twitter`, `chat`, `explorer` and so on. */
  readonly kind: string | null;
}

/** One category or tag a listing venue assigned. */
export interface ListingCategory {
  readonly name: string;
  /** The venue's machine slug, when it sent one. CoinGecko sends names only. */
  readonly slug: string | null;
  /** CoinMarketCap groups its tags (`INDUSTRY`, `PLATFORM`, `CATEGORY`). */
  readonly group: string | null;
}

/**
 * Supply as the listing VENUE states it.
 *
 * Kept separate from the `su` block and never merged with it: a venue's
 * self-reported supply and the chain-derived supply have been measured
 * disagreeing, and both are decimal strings exactly as sent.
 */
export interface ListingSupplies {
  readonly maxSupply: string | null;
  readonly totalSupply: string | null;
  readonly circulatingSupply: string | null;
  /** CoinMarketCap only, and self-reported by the issuer rather than measured. */
  readonly selfReportedCirculatingSupply: string | null;
  readonly infiniteSupply: boolean | null;
}

/** A CoinGecko or CoinMarketCap identity. */
export interface ListingBlock {
  readonly venue: "coingecko" | "coinmarketcap";
  readonly id: string | null;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly description: string | null;
  readonly venueUrl: string | null;
  readonly categories: readonly ListingCategory[];
  readonly websites: readonly ListingLink[];
  readonly socials: readonly ListingLink[];
  /** Explorer, source-code and documentation links: neither a site nor a social. */
  readonly otherLinks: readonly ListingLink[];
  readonly supplies: ListingSupplies;
  readonly listedAtMs: number | null;
  /** Field names the venue sent that this projection does not carry. */
  readonly unprojectedKeys: readonly string[];
}

/** Why a block is not present. */
export type BlockAbsenceReason =
  /** The provider has not analysed this pair at all: every block was null. */
  | "not_indexed_yet"
  /** This provider is not integrated for this chain, or returned nothing for it. */
  | "provider_did_not_answer";

/**
 * A root block the provider POPULATED that this projection does not carry.
 *
 * The honest middle between projecting a shape that has never been measured
 * and hiding data the provider sent. `hpi` (honeypot.is) and `ti` were
 * recorded null across every capture, so their real field layout is unknown
 * here; a populated one used to be counted toward "the document is an answer"
 * while contributing nothing to the report, which is how a populated
 * honeypot.is block produced "0 of 9 blocks answered" with `isHoneypot` and
 * both taxes inside it. Now it is named, measured and never counted as
 * answered.
 */
export interface UnprojectedBlock {
  /** The provider's own root key, so a follow-up capture knows what to fetch. */
  readonly key: string;
  /** What the key is known to carry, when recon named a source for it. */
  readonly source: string | null;
  /** Byte size of the block as the provider sent it. */
  readonly rawBytes: number;
  /** Its top-level field names, when it is an object. Empty for a scalar or array. */
  readonly keys: readonly string[];
  /** Why this projection does not carry it. */
  readonly reason: "shape_never_measured" | "projection_returned_nothing";
}

/** Per-block coverage, derived from the response and never from the catalog. */
export interface BlockCoverage {
  readonly block: string;
  readonly present: boolean;
  readonly reason: BlockAbsenceReason | null;
}

/** One parsed pair-details document. */
export interface PairDetailsDocument {
  readonly goPlus: GoPlusBlock | null;
  readonly quickIntel: QuickIntelBlock | null;
  readonly holders: HoldersBlock | null;
  /**
   * The LP-token holder distribution, in the same shape as `holders`.
   *
   * Recorded as always-null by the first recon pass across eight samples; a
   * later live capture returned 30 rows with a 98.13 percent top holder that
   * the `ll` block names as a Raydium burn-and-earn lock. So it is projected:
   * an "always null" observation over eight documents is not a contract, and
   * an unprojected populated block is an undeclared depth gap.
   */
  readonly lpHolders: HoldersBlock | null;
  readonly tokenAuthority: TokenAuthorityBlock | null;
  readonly supply: SupplyBlock | null;
  readonly liquidityLocks: LiquidityLocksBlock | null;
  readonly profile: ProfileBlock | null;
  readonly listings: readonly ListingBlock[];
  /**
   * Root blocks the provider populated that this projection does not carry.
   *
   * Never empty-by-construction: it is derived from the document, and an entry
   * here is a declared depth gap rather than a silent drop.
   */
  readonly presentButUnprojected: readonly UnprojectedBlock[];
  readonly coverage: readonly BlockCoverage[];
  /**
   * True when the provider answered 200 with EVERY block null.
   *
   * A well-formed document that says nothing. It renders `unavailable` with
   * reason `not_indexed_yet` and must never render as a clean report.
   */
  readonly allBlocksNull: boolean;
  /** Which route served this document. Route-keyed caches diverge. */
  readonly route: PairDetailsRoute;
  /** Whether the report is about the quote token instead of the base token. */
  readonly inverted: boolean;
  readonly url: string;
  readonly fetchedAtMs: number;
  readonly bytes: number;
  /** `max-age` from the response, when the provider sent one. Measured at 60 s. */
  readonly cacheMaxAgeSeconds: number | null;
  /** `age` from the response, when the provider sent one. */
  readonly cacheAgeSeconds: number | null;
}

export interface PairDetailsOptions {
  readonly transport: DexScreenerTransport;
  readonly chainId: string;
  /** A pair address or a token address. Which one it is decides `route`. */
  readonly identifier: string;
  readonly route: PairDetailsRoute;
  readonly inverted: boolean;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Build the request URL. The WHOLE path is lowercased: measured requirement. */
export function pairDetailsUrl(
  chainId: string,
  identifier: string,
  inverted: boolean
): string {
  const path =
    `/dex/pair-details/v4/${encodeURIComponent(chainId)}/${encodeURIComponent(identifier)}`.toLowerCase();
  return `${DEXSCREENER_PAIR_DETAILS_ORIGIN}${path}${inverted ? "?inverted=1" : ""}`;
}

/** Fetch and parse one pair-details document. */
export async function fetchPairDetails(
  options: PairDetailsOptions
): Promise<PairDetailsDocument> {
  const url = pairDetailsUrl(
    options.chainId,
    options.identifier,
    options.inverted
  );
  const response = await options.transport.httpGet(url, {
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    accept: "application/json",
    maxBytes: PAIR_DETAILS_MAX_BYTES,
  });
  if (response.status === 404) {
    throw siteError(
      DexScreenerSiteErrorCodes.PAIR_DETAILS_UNKNOWN,
      `DexScreener has no pair-details document for ${options.chainId}:${options.identifier}`,
      "Check the chain slug against dexscreener__chains_list and the address against dexscreener__pairs_search. A 404 here means the provider does not know this identity on this chain; it is not a statement about the contract."
    );
  }
  if (response.status !== 200) {
    throw siteError(
      DexScreenerSiteErrorCodes.PAIR_DETAILS_INVALID,
      `The DexScreener pair-details endpoint answered HTTP ${response.status} for ${options.chainId}:${options.identifier}`,
      "Retry once. A non-200 here is a transport or endpoint problem and is NOT evidence that the token is safe or unsafe."
    );
  }

  const parsed = parsePairDetails(response.body, {
    route: options.route,
    inverted: options.inverted,
  });
  return {
    ...parsed,
    url,
    fetchedAtMs: Date.now(),
    bytes: response.body.byteLength,
    cacheMaxAgeSeconds: readMaxAge(response.headers.get("cache-control")),
    cacheAgeSeconds: readInteger(response.headers.get("age")),
  };
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/** Fields of the document this projection reads. Anything else is reported, not dropped silently. */
const KNOWN_ROOT_KEYS: readonly string[] = [
  "gp",
  "qi",
  "holders",
  "lpHolders",
  "ta",
  "ll",
  "su",
  "cms",
  "cg",
  "cmc",
  "ts",
  "ti",
  "hpi",
];

type Json = Record<string, unknown>;

/**
 * Parse one pair-details body.
 *
 * Exported without the transport so the projection has a testable owner, the
 * same shape every sibling endpoint module uses.
 *
 * TOLERANT FOR DISPLAY, STRICT FOR DECISIONS. A missing or wrong-typed display
 * field becomes null. A percentage whose unit cannot be established does NOT
 * become a number: it keeps its raw string with `normalizedPct: null`, because
 * a percentage read in the wrong unit is wrong by 100x and would reach a
 * pre-trade decision as a fact.
 */
export function parsePairDetails(
  body: Uint8Array,
  context: { readonly route: PairDetailsRoute; readonly inverted: boolean }
): Omit<
  PairDetailsDocument,
  "url" | "fetchedAtMs" | "bytes" | "cacheMaxAgeSeconds" | "cacheAgeSeconds"
> {
  let root: Json;
  try {
    // NOT `JSON.parse`: numbers keep their exact provider lexemes here. See
    // `codec/json-lexemes.ts` for why a double is not an acceptable amount.
    const parsed: unknown = parseJsonPreservingNumbers(
      new TextDecoder().decode(body)
    );
    const asObject = object(parsed);
    if (asObject === null) throw new Error("not an object");
    root = asObject;
  } catch {
    throw siteError(
      DexScreenerSiteErrorCodes.PAIR_DETAILS_INVALID,
      `${body.byteLength} bytes from /dex/pair-details/v4 did not parse as a JSON document`,
      "The endpoint's shape may have changed. Re-capture the fixture before trusting this channel; nothing here is evidence about the token."
    );
  }

  const goPlus = parseGoPlus(object(root["gp"]));
  const quickIntel = parseQuickIntel(object(root["qi"]));
  const holders = parseHolders(object(root["holders"]));
  const lpHolders = parseHolders(object(root["lpHolders"]));
  const tokenAuthority = parseAuthority(object(root["ta"]));
  const supply = parseSupply(object(root["su"]));
  const liquidityLocks = parseLocks(object(root["ll"]));
  const profile = parseProfile(object(root["cms"]));
  const listings = [
    parseListing(object(root["cg"]), "coingecko"),
    parseListing(object(root["cmc"]), "coinmarketcap"),
  ].filter((entry): entry is ListingBlock => entry !== null);

  // Root keys this projection reads, mapped to whether the projection got
  // anything out of them. A key the provider POPULATED that produced nothing
  // is a depth gap and is reported as one; it is never counted as answered.
  const projectedRoots: readonly (readonly [string, boolean, string | null])[] = [
    ["gp", goPlus !== null, "GoPlus"],
    ["qi", quickIntel !== null, "QuickIntel"],
    ["holders", holders !== null, "DexScreener holder distribution"],
    ["lpHolders", lpHolders !== null, "DexScreener LP holder distribution"],
    ["ta", tokenAuthority !== null, "chain authority"],
    ["su", supply !== null, "supply"],
    ["ll", liquidityLocks !== null, "liquidity locks"],
    ["cms", profile !== null, "DexScreener profile"],
    ["cg", listings.some((entry) => entry.venue === "coingecko"), "CoinGecko"],
    ["cmc", listings.some((entry) => entry.venue === "coinmarketcap"), "CoinMarketCap"],
  ];
  const presentButUnprojected = unprojectedBlocks(root, projectedRoots);

  // "Every value null" is decided over the KNOWN keys the provider ships, so a
  // document that carries only a key we do not project still counts as an
  // answer rather than as "not indexed".
  const allBlocksNull = KNOWN_ROOT_KEYS.every(
    (key) => root[key] === null || root[key] === undefined
  );
  const reason: BlockAbsenceReason = allBlocksNull
    ? "not_indexed_yet"
    : "provider_did_not_answer";

  const coverage: readonly BlockCoverage[] = [
    cover("security.goplus", goPlus !== null, reason),
    cover("security.quickintel", quickIntel !== null, reason),
    // Holder coverage is stated PER SOURCE. The two are different blocks with
    // different units and different row counts, and a single `holders` row was
    // measured reporting "absent" on a response that carried ten GoPlus holder
    // rows. A reader must be able to tell which block answered.
    cover("holders.native", holders !== null, reason),
    cover("holders.goplus", (goPlus?.holders.length ?? 0) > 0, reason),
    cover("lpHolders.native", lpHolders !== null, reason),
    cover("lpHolders.goplus", (goPlus?.lpHolders.length ?? 0) > 0, reason),
    cover("tokenAuthority", tokenAuthority !== null, reason),
    cover("supply", supply !== null, reason),
    cover("liquidityLocks", liquidityLocks !== null, reason),
    cover("profile", profile !== null, reason),
    cover("listings", listings.length > 0, reason),
  ];

  return {
    goPlus,
    quickIntel,
    holders,
    lpHolders,
    tokenAuthority,
    supply,
    liquidityLocks,
    profile,
    listings,
    presentButUnprojected,
    coverage,
    allBlocksNull,
    route: context.route,
    inverted: context.inverted,
  };
}

/**
 * Blocks the provider populated that this projection does not carry.
 *
 * Two kinds, distinguished because the fix differs: a key whose SHAPE was
 * never measured (`hpi`, `ti`, `ts`, or a key the provider added after this
 * projection was written), and a key this projection reads but got nothing out
 * of, which means the provider changed a shape we thought we knew.
 */
function unprojectedBlocks(
  root: Json,
  projectedRoots: readonly (readonly [string, boolean, string | null])[]
): readonly UnprojectedBlock[] {
  const projected = new Map(
    projectedRoots.map(([key, produced, source]) => [key, { produced, source }])
  );
  const rows: UnprojectedBlock[] = [];
  for (const [key, value] of Object.entries(root)) {
    if (value === null || value === undefined) continue;
    const known = projected.get(key);
    if (known !== undefined && known.produced) continue;
    const asObject = object(value);
    rows.push({
      key,
      source: known?.source ?? KNOWN_UNPROJECTED_SOURCES[key] ?? null,
      rawBytes: rawJsonByteLength(value),
      keys: asObject === null ? [] : Object.keys(asObject).sort(),
      reason:
        known === undefined ? "shape_never_measured" : "projection_returned_nothing",
    });
  }
  return rows.sort((left, right) => left.key.localeCompare(right.key));
}

/** What recon recorded a never-projected root key as carrying. */
const KNOWN_UNPROJECTED_SOURCES: Readonly<Record<string, string>> = {
  hpi: "honeypot.is",
  ti: "token info",
  ts: "TokenSniffer",
};

function cover(
  block: string,
  present: boolean,
  reason: BlockAbsenceReason
): BlockCoverage {
  return { block, present, reason: present ? null : reason };
}

/* --- GoPlus --------------------------------------------------------- */

/** Keys of the GoPlus block this projection reads. The rest are named, not dropped. */
const GOPLUS_PROJECTED: ReadonlySet<string> = new Set([
  "dataStatus", "isHoneypot", "isOpenSource", "isProxy", "isMintable",
  "isBlacklisted", "isWhitelisted", "transferPausable", "hiddenOwner",
  "canTakeBackOwnership", "cannotSellAll", "slippageModifiable", "isAntiWhale",
  "antiWhaleModifiable", "tradingCooldown", "externalCall", "trustList",
  "buyTax", "sellTax", "ownerAddress", "ownerBalance", "ownerPercent",
  "creatorAddress", "creatorBalance", "creatorPercent", "holderCount",
  "holders", "lpHolderCount", "lpHolders", "lpTotalSupply", "totalSupply",
  "dex", "updatedAt", "tokenName", "tokenSymbol",
]);

function parseGoPlus(source: Json | null): GoPlusBlock | null {
  if (source === null) return null;
  return {
    dataStatus: text(source["dataStatus"]),
    isHoneypot: flag(source["isHoneypot"]),
    isOpenSource: flag(source["isOpenSource"]),
    isProxy: flag(source["isProxy"]),
    isMintable: flag(source["isMintable"]),
    isBlacklisted: flag(source["isBlacklisted"]),
    isWhitelisted: flag(source["isWhitelisted"]),
    transferPausable: flag(source["transferPausable"]),
    hiddenOwner: flag(source["hiddenOwner"]),
    canTakeBackOwnership: flag(source["canTakeBackOwnership"]),
    cannotSellAll: flag(source["cannotSellAll"]),
    slippageModifiable: flag(source["slippageModifiable"]),
    isAntiWhale: flag(source["isAntiWhale"]),
    antiWhaleModifiable: flag(source["antiWhaleModifiable"]),
    tradingCooldown: flag(source["tradingCooldown"]),
    externalCall: flag(source["externalCall"]),
    trustList: flag(source["trustList"]),
    // GoPlus TAX values are already percent-scaled ("0" and "5" mean 0 and 5
    // percent), unlike its HOLDER shares, which are fractions. Measured on the
    // captured documents; the two families are normalized separately and each
    // one declares its own unit.
    // GoPlus states TAX as a FRACTION, like every other percentage it sends.
    //
    // The previous comment here claimed "already percent-scaled ... Measured on
    // the captured documents", but every captured document in that measurement
    // carried a tax of 0 or null, which cannot discriminate a fraction from a
    // percent. Discriminated live 2026-08-24 on Saitama v1
    // (ethereum:0xCE3f08e664693ca792caCE4af1364D5e220827B2): GoPlus sent
    // buyTax "0.04" for the same tax QuickIntel sent as "4.0", and the same
    // document's `lpHolders[].percent` is "0.999999999995383976" for a holder
    // of essentially the whole pool. Reporting the GoPlus figure as a percent
    // understated a real 4 percent tax by 100x, in the direction that makes a
    // taxed token look clean, on the money path.
    buyTax: tax(source["buyTax"], "fraction", "goplus"),
    sellTax: tax(source["sellTax"], "fraction", "goplus"),
    ownerAddress: text(source["ownerAddress"]),
    ownerBalance: text(source["ownerBalance"]),
    ownerShare: percent(source["ownerPercent"], "fraction"),
    creatorAddress: text(source["creatorAddress"]),
    creatorBalance: text(source["creatorBalance"]),
    creatorShare: percent(source["creatorPercent"], "fraction"),
    holderCount: integer(source["holderCount"]),
    holders: goPlusHolders(source["holders"]),
    lpHolderCount: integer(source["lpHolderCount"]),
    lpHolders: goPlusHolders(source["lpHolders"]),
    lpTotalSupply: text(source["lpTotalSupply"]),
    totalSupply: text(source["totalSupply"]),
    venues: venues(source["dex"]),
    auditedToken: analyzedToken(
      null,
      text(source["tokenName"]),
      text(source["tokenSymbol"]),
      "goplus"
    ),
    analyzedAtMs: epochMs(source["updatedAt"]),
    unprojectedKeys: Object.keys(source)
      .filter((key) => !GOPLUS_PROJECTED.has(key))
      .sort(),
  };
}

function goPlusHolders(value: unknown): readonly HolderRow[] {
  return array(value).flatMap((entry) => {
    const row = object(entry);
    if (row === null) return [];
    const address = text(row["address"]);
    if (address === null) return [];
    return [
      {
        address,
        balance: text(row["balance"]),
        // GoPlus shares are FRACTIONS. This is the 100x hazard.
        share: percent(row["percent"], "fraction"),
        tag: text(row["tag"]),
        isContract: flag(row["isContract"]),
        isLocked: flag(row["isLocked"]),
      },
    ];
  });
}

function venues(value: unknown): readonly VenueRow[] {
  return array(value).flatMap((entry) => {
    const row = object(entry);
    if (row === null) return [];
    return [
      {
        name: text(row["name"]),
        liquidityUsd: text(row["liquidity"]),
        pairAddress: text(row["pair"]),
      },
    ];
  });
}

/* --- QuickIntel ----------------------------------------------------- */

function parseQuickIntel(source: Json | null): QuickIntelBlock | null {
  if (source === null) return null;
  const details = object(source["tokenDetails"]) ?? {};
  const dynamic = object(source["tokenDynamicDetails"]) ?? {};
  const audit = object(source["quickiAudit"]) ?? {};
  return {
    contractVerified: flag(source["contractVerified"]),
    isScam: flag(source["isScam"]),
    contractRenounced: flag(audit["contractRenounced"]),
    hiddenOwner: flag(audit["hiddenOwner"]),
    isProxy: flag(audit["isProxy"]),
    canMint: flag(audit["canMint"]),
    canBurn: flag(audit["canBurn"]),
    canBlacklist: flag(audit["canBlacklist"]),
    canWhitelist: flag(audit["canWhitelist"]),
    canPauseTrading: flag(audit["canPauseTrading"]),
    canUpdateFees: flag(audit["canUpdateFees"]),
    canUpdateMaxWallet: flag(audit["canUpdateMaxWallet"]),
    canUpdateMaxTx: flag(audit["canUpdateMaxTx"]),
    canUpdateWallets: flag(audit["canUpdateWallets"]),
    hasTradingCooldown: flag(audit["hasTradingCooldown"]),
    hasSuspiciousFunctions: flag(audit["hasSuspiciousFunctions"]),
    hasExternalFunctions: flag(audit["hasExternalFunctions"]),
    hasModifiedTransferWarning: flag(audit["hasModifiedTransferWarning"]),
    hasScams: flag(audit["hasScams"]),
    hasFeeWarning: flag(audit["hasFeeWarning"]),
    hasExternalContractRisk: flag(audit["hasExternalContractRisk"]),
    hasGeneralVulnerabilities: flag(audit["hasGeneralVulnerabilities"]),
    hasObfuscatedAddressRisk: flag(audit["hasObfuscatedAddressRisk"]),
    canMultiBlacklist: flag(audit["canMultiBlacklist"]),
    proxyImplementation: text(audit["proxyImplementation"]),
    maxTransaction: text(dynamic["maxTransaction"]),
    // Scale never discriminated: see the field's own JSDoc. Raw only.
    maxTransactionPercent: percent(dynamic["maxTransactionPercent"], "unverified"),
    priceImpact: percent(dynamic["priceImpact"], "unverified"),
    tokenSupplyBurned: text(dynamic["tokenSupplyBurned"]),
    auditedToken: analyzedToken(
      // CASE-PRESERVED on purpose. The provider's spelling is the identity, and
      // a re-cased EVM or base58 address is a different string to every
      // downstream comparison this document feeds.
      text(source["tokenAddress"]),
      text(details["tokenName"]),
      text(details["tokenSymbol"]),
      "quickintel"
    ),
    isHoneypot: flag(dynamic["isHoneypot"]),
    // QuickIntel taxes are percent-scaled decimal strings ("0.0" is 0 percent).
    buyTax: tax(dynamic["buyTax"], "percent", "quickintel"),
    sellTax: tax(dynamic["sellTax"], "percent", "quickintel"),
    transferTax: tax(dynamic["transferTax"], "percent", "quickintel"),
    // UNIT NOT DISCRIMINATED. QuickIntel's sibling fields on the same object
    // are unambiguously percent-scaled (buyTax "4.0" for a 4 percent tax), but
    // that is corroboration, not measurement, and this is the same class of
    // field that was 100x wrong on the GoPlus side. Four live documents were
    // probed on 2026-08-24 looking for a partial burn to discriminate against
    // the GoPlus LP holder list (Saitama v1 on ethereum, three bsc pools); every
    // one carried "0.00" or null, so none of them separates a fraction from a
    // percent. The raw value ships with no normalized figure until a document
    // with a real partial burn is measured.
    lpBurnedPct: percent(dynamic["lpBurnedPercent"], "unverified"),
    contractOwner: text(audit["contractOwner"]),
    contractCreator: text(audit["contractCreator"]),
    contractName: text(audit["contractName"]),
    tokenDecimals: integer(details["tokenDecimals"]),
    tokenSupply: text(details["tokenSupply"]),
    tokenCreatedAtMs: epochMs(details["tokenCreatedDate"]),
    problem: flag(dynamic["problem"]),
    suspiciousFunctions: strings(audit["suspiciousFunctions"]),
    externalFunctions: strings(audit["externalFunctions"]),
    onlyOwnerFunctions: strings(audit["onlyOwnerFunctions"]),
    functions: strings(audit["functions"]),
    analyzedAtMs:
      epochMs(dynamic["lastUpdatedTimestamp"]) ?? epochMs(source["updatedAt"]),
    unprojectedKeys: quickIntelUnprojectedKeys(source),
  };
}

/** Root keys of the QuickIntel block this projection reads or descends into. */
const QUICKINTEL_ROOT_PROJECTED: ReadonlySet<string> = new Set([
  "contractVerified", "isScam", "tokenDetails", "tokenDynamicDetails",
  "quickiAudit", "chainId", "tokenAddress", "updatedAt",
]);

/** Keys of `qi.tokenDetails` this projection reads. */
const QUICKINTEL_DETAILS_PROJECTED: ReadonlySet<string> = new Set([
  "tokenDecimals", "tokenSupply", "tokenCreatedDate", "tokenName", "tokenSymbol",
]);

/** Keys of `qi.tokenDynamicDetails` this projection reads. */
const QUICKINTEL_DYNAMIC_PROJECTED: ReadonlySet<string> = new Set([
  "isHoneypot", "buyTax", "sellTax", "transferTax", "lpBurnedPercent",
  "problem", "lastUpdatedTimestamp", "maxTransaction", "maxTransactionPercent",
  "priceImpact", "tokenSupplyBurned",
]);

/** Keys of `qi.quickiAudit` this projection reads. */
const QUICKINTEL_AUDIT_PROJECTED: ReadonlySet<string> = new Set([
  "contractRenounced", "hiddenOwner", "isProxy", "canMint", "canBurn",
  "canBlacklist", "canWhitelist", "canPauseTrading", "canUpdateFees",
  "canUpdateMaxWallet", "canUpdateMaxTx", "canUpdateWallets",
  "hasTradingCooldown", "hasSuspiciousFunctions", "hasExternalFunctions",
  "hasModifiedTransferWarning", "hasScams", "contractOwner", "contractCreator",
  "contractName", "suspiciousFunctions", "externalFunctions",
  "onlyOwnerFunctions", "functions", "hasFeeWarning",
  "hasExternalContractRisk", "hasGeneralVulnerabilities",
  "hasObfuscatedAddressRisk", "canMultiBlacklist", "proxyImplementation",
]);

/**
 * QuickIntel field names this projection does not carry, ONE LEVEL DEEP.
 *
 * The QuickIntel payload is three nested objects, and computing this over
 * `Object.keys(source)` alone reported `[]` on every live document while 24
 * nested fields were dropped invisibly, including four risk flags and a
 * per-trade size limit. Nested entries are reported as `path.key`
 * (`quickiAudit.hiddenOwnerModifiers`) so a follow-up capture knows exactly
 * where to look. The three nested container keys themselves are not listed:
 * they ARE read, and naming them as unprojected would be false.
 */
function quickIntelUnprojectedKeys(source: Json): readonly string[] {
  const nested: readonly (readonly [string, ReadonlySet<string>])[] = [
    ["tokenDetails", QUICKINTEL_DETAILS_PROJECTED],
    ["tokenDynamicDetails", QUICKINTEL_DYNAMIC_PROJECTED],
    ["quickiAudit", QUICKINTEL_AUDIT_PROJECTED],
  ];
  const keys = Object.keys(source).filter(
    (key) => !QUICKINTEL_ROOT_PROJECTED.has(key)
  );
  for (const [path, projected] of nested) {
    const block = object(source[path]);
    if (block === null) continue;
    for (const key of Object.keys(block)) {
      if (!projected.has(key)) keys.push(`${path}.${key}`);
    }
  }
  return keys.sort();
}

/**
 * A provider's statement of which token it analysed, or null when it made none.
 *
 * Null and not an all-null object: "the provider did not say" and "the provider
 * said nothing useful" are the same fact here, and an object of nulls would
 * read as a subject that had been checked.
 */
function analyzedToken(
  address: string | null,
  name: string | null,
  symbol: string | null,
  source: AnalyzedTokenIdentity["source"]
): AnalyzedTokenIdentity | null {
  if (address === null && name === null && symbol === null) return null;
  return { address, name, symbol, source };
}

/* --- The remaining blocks ------------------------------------------- */

function parseHolders(source: Json | null): HoldersBlock | null {
  if (source === null) return null;
  return {
    holderCount: integer(source["count"]),
    totalSupply: text(source["totalSupply"]),
    rows: array(source["holders"]).flatMap((entry) => {
      const row = object(entry);
      if (row === null) return [];
      const address = text(row["id"]) ?? text(row["address"]);
      if (address === null) return [];
      return [
        {
          address,
          balance: text(row["balance"]),
          // The DexScreener-native block emits PERCENTAGES, not fractions.
          share: percent(row["percentage"], "percent"),
          tag: text(row["tag"]) ?? text(row["label"]),
          isContract: flag(row["isContract"]),
          isLocked: flag(row["isLocked"]),
        },
      ];
    }),
  };
}

function parseAuthority(source: Json | null): TokenAuthorityBlock | null {
  if (source === null) return null;
  const solana = object(source["solana"]);
  if (solana === null) return null;
  return {
    solanaMintable: flag(solana["isMintable"]),
    solanaFreezable: flag(solana["isFreezable"]),
    solanaBridgeMintOnly: flag(solana["bridgeMintOnly"]),
    solanaMintableReason: text(solana["mintableReason"]),
  };
}

function parseSupply(source: Json | null): SupplyBlock | null {
  if (source === null) return null;
  return {
    circulatingSupply: text(source["circulatingSupply"]),
    totalSupply: text(source["totalSupply"]),
  };
}

function parseLocks(source: Json | null): LiquidityLocksBlock | null {
  if (source === null) return null;
  return {
    totalShare: percent(source["totalPercentage"], "percent"),
    rows: array(source["locks"]).flatMap((entry) => {
      const row = object(entry);
      if (row === null) return [];
      const providerLockRef = text(row["address"]);
      return [
        {
          tag: text(row["tag"]),
          providerLockRef,
          address: usableAddress(providerLockRef),
          amount: text(row["amount"]),
          share: percent(row["percentage"], "percent"),
          url: text(row["url"]),
        },
      ];
    }),
  };
}

/**
 * A provider string re-emitted as an `address` only when it really is one.
 *
 * A full 40-hex EVM address, or a base58 string of Solana account length. The
 * measured failure this exists for: a chain-id-prefixed, two-characters-short
 * hex string was being handed to the model under the name `address`. Anything
 * this cannot recognise stays available verbatim on `providerLockRef`, so
 * nothing is dropped; only the CLAIM that it is an address is withdrawn.
 */
function usableAddress(value: string | null): string | null {
  if (value === null) return null;
  if (/^0x[0-9a-fA-F]{40}$/u.test(value)) return value;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(value)) return value;
  return null;
}

function parseProfile(source: Json | null): ProfileBlock | null {
  if (source === null) return null;
  return {
    chainId: text(source["chainId"]),
    name: text(source["name"]),
    symbol: text(source["symbol"]),
    address: text(source["address"]),
    description: text(source["description"]),
    links: array(source["links"]).flatMap((entry) => {
      const row = object(entry);
      if (row === null) return [];
      const url = text(row["url"]);
      if (url === null) return [];
      return [{ label: text(row["label"]), type: text(row["type"]), url }];
    }),
    iconId: text(object(source["icon"])?.["id"]),
    headerId: text(object(source["header"])?.["id"]),
    metaIds: strings(source["metaIds"]),
    createdAtMs: epochMs(source["createdAt"]),
    updatedAtMs: epochMs(source["updatedAt"]),
    unprojectedKeys: Object.keys(source)
      .filter((key) => !PROFILE_PROJECTED.has(key))
      .sort(),
  };
}

/** Keys of the CMS profile block this projection reads. The rest are NAMED. */
const PROFILE_PROJECTED: ReadonlySet<string> = new Set([
  "chainId", "name", "symbol", "address", "description", "links",
  "icon", "header", "metaIds", "createdAt", "updatedAt",
]);

/** Keys of a listing block this projection reads. The rest are NAMED, not dropped. */
const LISTING_PROJECTED: ReadonlySet<string> = new Set([
  "id", "name", "symbol", "description", "url", "categories", "tags",
  "websites", "social", "urls", "maxSupply", "totalSupply",
  "circulatingSupply", "selfReportedCirculatingSupply", "infiniteSupply",
  "dateLaunched",
]);

/**
 * CoinMarketCap url groups that are the project's own presence, not its site.
 *
 * Everything not in this set and not `website` lands in `otherLinks` with its
 * group name, so a new group the venue adds is emitted rather than dropped.
 */
const CMC_SOCIAL_URL_KINDS: ReadonlySet<string> = new Set([
  "twitter", "chat", "reddit", "message_board", "announcement", "facebook",
]);

/**
 * Parse one listing-venue identity.
 *
 * MEASURED SHAPES, both of them (2026-08-24 captures):
 *  - CoinGecko sends `websites: [{label, url}]` and `social: [{type, url}]`.
 *  - CoinMarketCap sends `tags: [{slug, name, group}]` and groups its links
 *    under `urls: {website: [...], twitter: [...], explorer: [...]}`.
 *
 * The previous projection accepted STRING arrays only, so all three arrived
 * empty and the report showed a listed token as having published nothing. Both
 * the object form and the string form are read here, because a venue that
 * changes back must not silently empty the block again.
 */
function parseListing(
  source: Json | null,
  venue: ListingBlock["venue"]
): ListingBlock | null {
  if (source === null) return null;
  const urls = object(source["urls"]);
  const groupedLinks = urls === null ? [] : urlGroups(urls);
  return {
    venue,
    id: text(source["id"]),
    name: text(source["name"]),
    symbol: text(source["symbol"]),
    description: text(source["description"]),
    venueUrl: text(source["url"]),
    categories: categories(source["categories"]).concat(categories(source["tags"])),
    websites: links(source["websites"], "website").concat(
      groupedLinks.filter((link) => link.kind === "website")
    ),
    socials: links(source["social"], null).concat(
      groupedLinks.filter(
        (link) => link.kind !== null && CMC_SOCIAL_URL_KINDS.has(link.kind)
      )
    ),
    otherLinks: groupedLinks.filter(
      (link) =>
        link.kind !== "website"
        && (link.kind === null || !CMC_SOCIAL_URL_KINDS.has(link.kind))
    ),
    supplies: {
      maxSupply: text(source["maxSupply"]),
      totalSupply: text(source["totalSupply"]),
      circulatingSupply: text(source["circulatingSupply"]),
      selfReportedCirculatingSupply: text(source["selfReportedCirculatingSupply"]),
      infiniteSupply: flag(source["infiniteSupply"]),
    },
    listedAtMs: epochMs(source["dateLaunched"]),
    unprojectedKeys: Object.keys(source)
      .filter((key) => !LISTING_PROJECTED.has(key))
      .sort(),
  };
}

/** Categories from either the plain-string form or the `{slug, name, group}` form. */
function categories(value: unknown): readonly ListingCategory[] {
  return array(value).flatMap((entry) => {
    if (typeof entry === "string") {
      return entry === "" ? [] : [{ name: entry, slug: null, group: null }];
    }
    const row = object(entry);
    if (row === null) return [];
    const name = text(row["name"]) ?? text(row["slug"]);
    if (name === null) return [];
    return [{ name, slug: text(row["slug"]), group: text(row["group"]) }];
  });
}

/** Links from either the plain-string form or the `{label|type, url}` form. */
function links(value: unknown, defaultKind: string | null): readonly ListingLink[] {
  return array(value).flatMap((entry) => {
    if (typeof entry === "string") {
      return entry === "" ? [] : [{ url: entry, label: null, kind: defaultKind }];
    }
    const row = object(entry);
    if (row === null) return [];
    const url = text(row["url"]);
    if (url === null) return [];
    return [
      {
        url,
        label: text(row["label"]),
        kind: text(row["type"]) ?? defaultKind,
      },
    ];
  });
}

/** Every url in a CoinMarketCap-style `urls` map, tagged with its group name. */
function urlGroups(urls: Json): readonly ListingLink[] {
  return Object.entries(urls).flatMap(([kind, value]) =>
    links(value, kind).map((link) => ({ ...link, kind: link.kind ?? kind }))
  );
}

/* ------------------------------------------------------------------ */
/* Value readers                                                       */
/* ------------------------------------------------------------------ */

function object(value: unknown): Json | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  // A parsed NUMBER is an object at runtime here (it carries its lexeme), and
  // walking into one as if it were a provider-sent map would invent fields
  // that do not exist. Identity, not shape, is what separates the two.
  if (isJsonNumber(value)) return null;
  return value as Json;
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): readonly string[] {
  if (typeof value === "string") return value === "" ? [] : [value];
  return array(value).filter((entry): entry is string => typeof entry === "string");
}

/**
 * A provider value as a string, LOSSLESSLY.
 *
 * A JSON number returns its exact source lexeme, never `String(double)`. This
 * is the whole money-path guarantee for supply, balances and lock amounts: the
 * measured defect was a `su` lexeme of `12345678901234567890.123456789`
 * emitted as `12345678901234567000` under a note promising the provider's own
 * digits.
 */
function text(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (isJsonNumber(value)) return value.lexeme;
  return null;
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * A bounded COUNT as a number.
 *
 * Counts (holders, LP holders) are cardinalities, not amounts: they are used
 * for arithmetic and comparison and are far below the safe-integer bound in
 * every capture. A count outside that bound is refused rather than rounded,
 * because a rounded count is a wrong count.
 */
function integer(value: unknown): number | null {
  if (!isJsonNumber(value)) return null;
  const parsed = value.toNumber();
  if (!Number.isFinite(parsed)) return null;
  const truncated = Math.trunc(parsed);
  return Number.isSafeInteger(truncated) ? truncated : null;
}

/** Epoch milliseconds from either an ISO string or a numeric millisecond value. */
function epochMs(value: unknown): number | null {
  if (isJsonNumber(value)) {
    const parsed = value.toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Read a percentage in a KNOWN provider unit.
 *
 * The unit is a property of the SOURCE FIELD, established by measurement, and
 * is passed in by the caller rather than guessed from the value. Guessing is
 * exactly the defect this guards: `0.09` is 9 percent from GoPlus and 0.09
 * percent from the holders block, and nothing about the number says which.
 *
 * A value that is neither a finite number nor a numeric string keeps its raw
 * form with `normalizedPct: null`, so an unreadable percentage is visibly
 * absent instead of silently zero.
 */
function percent(value: unknown, unit: PercentUnit): NormalizedPercent | null {
  if (value === null || value === undefined) return null;
  const raw = typeof value === "string" ? value : isJsonNumber(value) ? value.lexeme : null;
  if (raw === null) return null;
  if (unit === "unverified") return { raw, normalizedPct: null, unit };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return { raw, normalizedPct: null, unit };
  return {
    raw,
    normalizedPct: unit === "fraction" ? parsed * 100 : parsed,
    unit,
  };
}

function tax(
  value: unknown,
  unit: PercentUnit,
  source: TaxValue["source"]
): TaxValue | null {
  const parsed = percent(value, unit);
  return parsed === null ? null : { ...parsed, source };
}

/** `max-age` in seconds from a cache-control header. */
function readMaxAge(header: string | undefined): number | null {
  if (header === undefined) return null;
  const match = /max-age=(\d+)/i.exec(header);
  return match === null ? null : Number(match[1]);
}

function readInteger(header: string | undefined): number | null {
  if (header === undefined) return null;
  const parsed = Number(header);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/** Re-export so callers distinguish our typed failures without a second import. */
export { isDexScreenerSiteError };
