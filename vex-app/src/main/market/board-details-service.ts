/**
 * BOARD DETAILS SERVICE - the main-process owner of the contract-safety,
 * holder and liquidity-lock read behind every board surface.
 *
 * ONE READ, FOUR CONSUMERS. The chat card needs counts ("3 clean checks - 2
 * high risk"), the grid needs a chip per card, the spotlight needs the Holders
 * row, the Liquidity Locked bar and the Safety chip, and the sidebar needs the
 * same verdict again. All four read the SAME typed bundle from the same cache
 * entry: four independent reads would be four chances for one surface to say
 * clean while another says flagged about the same token in the same second.
 *
 * WHAT IT DOES NOT DO. It does not decide safety. The verdict is the pure
 * shared classifier's (`shared/board/safety-classifier.ts`), which both this
 * process and the renderer run over this bundle, so the counters on the chat
 * card and the chip in the modal are the same function over the same evidence.
 * This file's whole job is to turn one provider document into that evidence,
 * honestly, once.
 *
 * THE IDENTITY IS RESOLVED, NOT ASSUMED. The audit providers state which token
 * they analysed, and that claim is only worth checking against the pair's REAL
 * base token, which the details document does not carry. So the subject is
 * resolved through the surface's own canonical `resolvePairSubject` - the same
 * subject bars, trades and top traders route on - and cached beside the
 * document. Without it, `auditedTokenCheck` would be a comparison with nothing,
 * and a report about a copycat token would read as a report about this one.
 *
 * TWO CLOCKS, AND THEY ARE NOT THE SAME CLOCK (probe C4).
 *
 *  - `bundle.expiresAtMs` is the PROVIDER'S freshness edge: `max-age` minus the
 *    `age` the response already had. It is what the classifier's `stale` row
 *    reads and what the surface dates its figures by. When the provider sends
 *    no `age` header - measured on ethereum - the freshness is treated as fully
 *    CONSUMED, because an unknown age is not a young one.
 *  - The CACHE entry lives for at least {@link CACHE_FLOOR_MS} regardless. That
 *    floor exists to serve the burst of eight cards mounting in one tick, and
 *    it is deliberately five seconds rather than the full sixty: a document
 *    that arrived 59 seconds stale must not be served for another minute as if
 *    it were fresh.
 *
 * A 404 IS A SETTLED ABSENCE AND A 200-WITH-NOTHING IS NOT. "The provider does
 * not know this pair" and "the provider knows it and has analysed nothing" are
 * different facts, and the second one is a real document with real clocks that
 * the classifier must see as evidence. So `unknown_pair` is an absence and
 * `allBlocksNull` crosses as a bundle whose coverage state says `not_indexed`.
 */

import {
  fetchPairDetails,
  type GoPlusBlock,
  type LiquidityLocksBlock,
  type NormalizedPercent,
  type PairDetailsDocument,
  type QuickIntelBlock,
} from "@tools/dexscreener/endpoints/pair-details.js";
import {
  resolvePairSubject,
  type PairSubject,
} from "@tools/dexscreener/endpoints/pair-subject.js";
import { DexScreenerSiteErrorCodes } from "@tools/dexscreener/site-errors.js";
import { getDexScreenerTransport } from "@tools/dexscreener/transport.js";
import type {
  BoardDetailsBundle,
  BoardDetailsOutcome,
  BoardDetailsSubject,
  BoardGoPlusFlags,
  BoardLiquidityLocks,
  BoardPercent,
  BoardQuickIntelFlags,
  BoardSafetyConflict,
} from "@shared/schemas/board-details.js";
import { boardPoolKey } from "@shared/schemas/board-details.js";
import { log } from "../logger/index.js";
import {
  createBoardReadCache,
  type BoardReadCache,
} from "./board-read-cache.js";

/**
 * Minimum life of a CACHE entry, in milliseconds.
 *
 * Not a freshness claim. It is the width of the burst this cache exists to
 * absorb: a board mounts up to eight cards in one tick and each asks for its
 * own pool, and the same pool can be named by a card, the chat counter and the
 * spotlight within the same second.
 */
export const CACHE_FLOOR_MS = 5_000;

/** Deadline for ONE provider exchange. The details document is a single GET. */
const FETCH_TIMEOUT_MS = 12_000;

/** Distinct pools read at once. Board reads yield the pipe to the agent. */
const MAX_CONCURRENT_READS = 2;

/** Waiting distinct pools. Past this a caller is refused rather than queued. */
const QUEUE_MAX = 16;

/** Settled bundles held. Two boards' worth, which is the realistic working set. */
const CACHE_CAPACITY = 24;

/**
 * The hard flags the two audit providers can contradict each other ON.
 *
 * A disagreement here is its own classifier state, because "one of our two
 * auditors says this is a honeypot" is neither a clean result nor a flagged
 * one, and resolving it would mean picking a winner silently. Both have been
 * measured wrong.
 */
const HARD_CONFLICT_FIELDS: ReadonlySet<string> = new Set(["isHoneypot"]);

export interface BoardDetailsService {
  /** One pool. Cached, single-flighted, and safe to call from a burst. */
  read(
    subject: BoardDetailsSubject,
    signal?: AbortSignal,
  ): Promise<BoardDetailsOutcome>;
  /**
   * Every pool of one board, for the chat card's counters.
   *
   * Sequential by construction through the shared read cache's concurrency
   * ceiling, so a prefetch never becomes a burst of its own against the
   * provider. Pools that could not be read still produce a typed outcome, so
   * the caller's count covers the whole board.
   */
  prefetch(
    subjects: readonly BoardDetailsSubject[],
    signal?: AbortSignal,
  ): Promise<readonly { readonly key: string; readonly subject: BoardDetailsSubject; readonly outcome: BoardDetailsOutcome }[]>;
  /** Idempotent. Closes admission, aborts in flight, drains, clears. */
  dispose(): Promise<void>;
}

export interface BoardDetailsServiceDeps {
  readonly resolveSubject: (args: {
    readonly chainId: string;
    readonly pairAddress: string;
    readonly signal: AbortSignal;
  }) => Promise<PairSubject>;
  readonly fetchDetails: (args: {
    readonly chainId: string;
    readonly pairAddress: string;
    readonly signal: AbortSignal;
  }) => Promise<PairDetailsDocument>;
  readonly now: () => number;
}

/* ------------------------------------------------------------------ */
/* Projection - one provider document into the typed bundle            */
/* ------------------------------------------------------------------ */

/** A provider percent as the wire contract carries it, or null. */
function percent(value: NormalizedPercent | null): BoardPercent | null {
  if (value === null) return null;
  return {
    // The provider's own spelling is kept so a reader can see what was sent;
    // it is bounded here because it crosses to a renderer.
    raw: value.raw.length > 64 ? value.raw.slice(0, 64) : value.raw,
    normalizedPct: value.normalizedPct,
    unit: value.unit,
  };
}

function goPlusFlags(block: GoPlusBlock | null): BoardGoPlusFlags | null {
  if (block === null) return null;
  return {
    isHoneypot: block.isHoneypot,
    isOpenSource: block.isOpenSource,
    isProxy: block.isProxy,
    isMintable: block.isMintable,
    isBlacklisted: block.isBlacklisted,
    transferPausable: block.transferPausable,
    hiddenOwner: block.hiddenOwner,
    canTakeBackOwnership: block.canTakeBackOwnership,
    cannotSellAll: block.cannotSellAll,
    slippageModifiable: block.slippageModifiable,
    buyTaxPct: percent(block.buyTax),
    sellTaxPct: percent(block.sellTax),
    ownerShare: percent(block.ownerShare),
    creatorShare: percent(block.creatorShare),
  };
}

function quickIntelFlags(block: QuickIntelBlock | null): BoardQuickIntelFlags | null {
  if (block === null) return null;
  return {
    contractVerified: block.contractVerified,
    isScam: block.isScam,
    isHoneypot: block.isHoneypot,
    isProxy: block.isProxy,
    hiddenOwner: block.hiddenOwner,
    canMint: block.canMint,
    canBlacklist: block.canBlacklist,
    canPauseTrading: block.canPauseTrading,
    hasFeeWarning: block.hasFeeWarning,
    hasExternalContractRisk: block.hasExternalContractRisk,
    hasGeneralVulnerabilities: block.hasGeneralVulnerabilities,
    hasObfuscatedAddressRisk: block.hasObfuscatedAddressRisk,
    buyTaxPct: percent(block.buyTax),
    sellTaxPct: percent(block.sellTax),
    transferTaxPct: percent(block.transferTax),
    lpBurnedPct: percent(block.lpBurnedPct),
  };
}

/**
 * The lock block, rows and tags kept VERBATIM.
 *
 * The provider's lock index treats a burn as the strongest lock there is, and
 * on both chains that answered the only row was tagged `Burned` with
 * `lockedPct` exactly equal to it (probe C2). Dropping burn rows would report
 * "0 percent locked" for a pool whose LP can never be pulled, which is the
 * more dangerous of the two readings, so the tag is exposed and the surface
 * renders "Locked 99.99% - Burned".
 *
 * `quickintel.lpBurnedPct` is NEVER substituted here for a missing lock share.
 * It is a different provider's different field, it travels on the safety block
 * for honesty, and it is the one field measured arriving `unverified`.
 */
function liquidityLocks(block: LiquidityLocksBlock | null): BoardLiquidityLocks | null {
  if (block === null) return null;
  return {
    // The plan calls this `totalShare`; the endpoint module spells it
    // `totalShare` and the agent-facing envelope spells the same projection
    // `lockedPct`. The wire contract takes the envelope's name, which is the
    // one the probe archive records.
    lockedPct: percent(block.totalShare),
    rows: block.rows.slice(0, 50).map((row) => ({
      tag: row.tag === null ? null : row.tag.slice(0, 120),
      share: percent(row.share),
    })),
  };
}

/**
 * Where the two providers disagree, and whether the field is a hard one.
 *
 * Only fields BOTH answered are compared: one provider's silence is not a
 * disagreement, and nothing here decides which is right. The comparison set
 * mirrors the agent-facing report's, so the two surfaces cannot start
 * disagreeing about what a disagreement is.
 */
function conflicts(
  goPlus: GoPlusBlock | null,
  quickIntel: QuickIntelBlock | null,
): readonly BoardSafetyConflict[] {
  if (goPlus === null || quickIntel === null) return [];
  const comparisons: readonly {
    readonly field: string;
    readonly goplus: boolean | null;
    readonly quickintel: boolean | null;
  }[] = [
    { field: "isHoneypot", goplus: goPlus.isHoneypot, quickintel: quickIntel.isHoneypot },
    { field: "isProxy", goplus: goPlus.isProxy, quickintel: quickIntel.isProxy },
    { field: "hiddenOwner", goplus: goPlus.hiddenOwner, quickintel: quickIntel.hiddenOwner },
    { field: "canMint", goplus: goPlus.isMintable, quickintel: quickIntel.canMint },
    {
      field: "canPauseTrading",
      goplus: goPlus.transferPausable,
      quickintel: quickIntel.canPauseTrading,
    },
    {
      field: "canBlacklist",
      goplus: goPlus.isBlacklisted,
      quickintel: quickIntel.canBlacklist,
    },
  ];
  const rows: BoardSafetyConflict[] = [];
  for (const entry of comparisons) {
    if (entry.goplus === null || entry.quickintel === null) continue;
    if (entry.goplus === entry.quickintel) continue;
    rows.push({
      field: entry.field,
      goplus: entry.goplus,
      quickintel: entry.quickintel,
      hard: HARD_CONFLICT_FIELDS.has(entry.field),
    });
  }
  return rows;
}

/**
 * The audit provider's own subject, checked against the pair's real base token.
 *
 * A comparison ignores case and nothing else; both addresses are otherwise the
 * providers' own spellings. Null on either side is an UNVERIFIED subject, not a
 * verified one, which the classifier reads as such.
 */
function auditedTokenCheck(
  document: PairDetailsDocument,
  subject: PairSubject,
): BoardDetailsBundle["auditedTokenCheck"] {
  const quickIntel = document.quickIntel?.auditedToken ?? null;
  const goPlus = document.goPlus?.auditedToken ?? null;
  const providerAddress = quickIntel?.address ?? null;
  const addressesAgree =
    providerAddress === null
      ? null
      : providerAddress.toLowerCase() === subject.baseTokenAddress.toLowerCase();
  const providerSymbol = quickIntel?.symbol ?? goPlus?.symbol ?? null;
  const symbolsAgree =
    providerSymbol === null || subject.baseTokenSymbol === null
      ? null
      : providerSymbol.toLowerCase() === subject.baseTokenSymbol.toLowerCase();
  return {
    auditedTokenAddress: providerAddress,
    auditedTokenSymbol: providerSymbol,
    addressesAgree,
    symbolsAgree,
    mismatch: addressesAgree === false || symbolsAgree === false,
  };
}

/**
 * The holder count with the SOURCE that reported it and the unit its per-holder
 * shares are in.
 *
 * Measured present on all four probed chains from two different sources
 * (`goplus` on three, DexScreener's own index on solana), whose share units
 * differ by 100x. The source travels so nothing downstream sums two
 * percentages that are not on the same scale.
 */
function holders(document: PairDetailsDocument): BoardDetailsBundle["holders"] {
  const native = document.holders;
  const goPlus = document.goPlus;
  if (native !== null && native.holderCount !== null) {
    return {
      count: native.holderCount,
      source: "dexscreener",
      shareUnit: native.rows[0]?.share?.unit ?? null,
    };
  }
  if (goPlus !== null && goPlus.holderCount !== null) {
    return {
      count: goPlus.holderCount,
      source: "goplus",
      shareUnit: goPlus.holders[0]?.share?.unit ?? null,
    };
  }
  // A source that answered and reported no count, versus nothing answering at
  // all, are different facts and the surface says which.
  if (native !== null) return { count: null, source: "dexscreener", shareUnit: null };
  if (goPlus !== null) return { count: null, source: "goplus", shareUnit: null };
  return { count: null, source: null, shareUnit: null };
}

/**
 * The provider's freshness edge for one document.
 *
 * `max-age` minus `age`, floored at the fetch instant. An ABSENT `age` header -
 * measured on ethereum - is treated as fully consumed freshness rather than as
 * a fresh document, because an unknown age is not a young one (probe C4).
 */
export function providerFreshnessEdgeMs(document: PairDetailsDocument): number {
  const maxAge = document.cacheMaxAgeSeconds;
  if (maxAge === null) return document.fetchedAtMs;
  const age = document.cacheAgeSeconds;
  if (age === null) return document.fetchedAtMs;
  const remainingSeconds = Math.max(0, maxAge - age);
  return document.fetchedAtMs + remainingSeconds * 1_000;
}

/** One provider document and its resolved subject as the typed bundle. */
export function projectBoardDetails(args: {
  readonly subject: BoardDetailsSubject;
  readonly pairSubject: PairSubject;
  readonly document: PairDetailsDocument;
}): BoardDetailsBundle {
  const { document, pairSubject } = args;
  const present = document.coverage.filter((entry) => entry.present);
  const absent = document.coverage.filter((entry) => !entry.present);
  return {
    subject: args.subject,
    baseTokenAddress: pairSubject.baseTokenAddress,
    baseTokenSymbol: pairSubject.baseTokenSymbol,
    holders: holders(document),
    liquidityLocks: liquidityLocks(document.liquidityLocks),
    safety: {
      coverage: {
        // A 200 with every block empty is a well-formed document that says
        // nothing. It is never a clean result and never an absence either.
        state: document.allBlocksNull
          ? "not_indexed"
          : absent.length === 0
            ? "complete"
            : "partial",
        presentBlocks: present.map((entry) => entry.block),
        absentBlocks: absent.map((entry) => entry.block),
      },
      goplus: goPlusFlags(document.goPlus),
      quickintel: quickIntelFlags(document.quickIntel),
      tokenAuthority:
        document.tokenAuthority === null
          ? null
          : {
              solanaMintable: document.tokenAuthority.solanaMintable,
              solanaFreezable: document.tokenAuthority.solanaFreezable,
              solanaBridgeMintOnly: document.tokenAuthority.solanaBridgeMintOnly,
            },
      conflicts: [...conflicts(document.goPlus, document.quickIntel)],
    },
    auditedTokenCheck: auditedTokenCheck(document, pairSubject),
    providerWindow: {
      cacheMaxAgeSeconds: document.cacheMaxAgeSeconds,
      cacheAgeSeconds: document.cacheAgeSeconds,
    },
    fetchedAtMs: document.fetchedAtMs,
    expiresAtMs: providerFreshnessEdgeMs(document),
    // The narrative JOIN KEY. An empty array is the COMMON case (both probed
    // memecoin subjects returned []) and renders as a designed "no narrative"
    // state, never as a missing element.
    metaIds: (document.profile?.metaIds ?? []).slice(0, 32),
  };
}

/* ------------------------------------------------------------------ */
/* Failure classification                                              */
/* ------------------------------------------------------------------ */

function siteCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * One failure as an outcome.
 *
 * `unknown_pair` is the provider's settled answer that it does not know this
 * identity on this chain, and it is the only failure that is CACHEABLE: asking
 * again in the next five seconds would answer the same way. Everything else
 * says nothing about the pool and is never remembered.
 */
function classifyFailure(error: unknown): {
  readonly outcome: BoardDetailsOutcome;
  readonly cacheable: boolean;
} {
  const code = siteCodeOf(error);
  if (code === DexScreenerSiteErrorCodes.PAIR_DETAILS_UNKNOWN) {
    return { outcome: { kind: "absent", reason: "unknown_pair" }, cacheable: true };
  }
  if (
    code === DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE ||
    code === DexScreenerSiteErrorCodes.TRANSPORT_HOST_NOT_ALLOWED
  ) {
    return { outcome: { kind: "unavailable", reason: "not_mounted" }, cacheable: false };
  }
  if (code === DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT) {
    return { outcome: { kind: "unavailable", reason: "transport" }, cacheable: false };
  }
  return { outcome: { kind: "unavailable", reason: "provider" }, cacheable: false };
}

/* ------------------------------------------------------------------ */
/* The service                                                         */
/* ------------------------------------------------------------------ */

const defaultDeps: BoardDetailsServiceDeps = {
  resolveSubject: async (args) =>
    resolvePairSubject({
      transport: getDexScreenerTransport(),
      chainId: args.chainId,
      pairAddress: args.pairAddress,
      timeoutMs: FETCH_TIMEOUT_MS,
      signal: args.signal,
    }),
  fetchDetails: async (args) =>
    fetchPairDetails({
      transport: getDexScreenerTransport(),
      chainId: args.chainId,
      identifier: args.pairAddress,
      // The pair-id and token-id routes are cached SEPARATELY on the provider
      // and have been measured disagreeing. A board always names a pool, so it
      // always takes the pair route.
      route: "pair_id",
      inverted: false,
      timeoutMs: FETCH_TIMEOUT_MS,
      signal: args.signal,
    }),
  now: Date.now,
};

export function createBoardDetailsService(
  overrides: Partial<BoardDetailsServiceDeps> = {},
): BoardDetailsService {
  const deps: BoardDetailsServiceDeps = { ...defaultDeps, ...overrides };
  const cache: BoardReadCache<BoardDetailsOutcome> = createBoardReadCache({
    capacity: CACHE_CAPACITY,
    maxConcurrent: MAX_CONCURRENT_READS,
    queueMax: QUEUE_MAX,
    now: deps.now,
    refusal: (reason) => ({ kind: "unavailable", reason }),
  });

  async function load(
    subject: BoardDetailsSubject,
    signal: AbortSignal,
  ): Promise<{ readonly value: BoardDetailsOutcome; readonly expiresAtMs: number | null }> {
    try {
      // The subject first: without the pair's real base token the audit
      // provider's claim about which token it analysed has nothing to be
      // checked against.
      const pairSubject = await deps.resolveSubject({
        chainId: subject.chain,
        pairAddress: subject.pairAddress,
        signal,
      });
      const document = await deps.fetchDetails({
        chainId: subject.chain,
        pairAddress: subject.pairAddress,
        signal,
      });
      const bundle = projectBoardDetails({ subject, pairSubject, document });
      return {
        value: { kind: "details", bundle },
        // The cache floor is a burst absorber, never a freshness claim: the
        // bundle carries the provider's own edge and the classifier reads that.
        expiresAtMs: Math.max(bundle.expiresAtMs, document.fetchedAtMs + CACHE_FLOOR_MS),
      };
    } catch (error) {
      const { outcome, cacheable } = classifyFailure(error);
      log.info(
        `[board-details] ${outcome.kind}` +
          (outcome.kind === "details" ? "" : ` reason=${outcome.reason}`),
      );
      return {
        value: outcome,
        expiresAtMs: cacheable ? deps.now() + CACHE_FLOOR_MS : null,
      };
    }
  }

  return {
    async read(subject, signal): Promise<BoardDetailsOutcome> {
      return cache.read(
        boardPoolKey(subject),
        (readSignal) => load(subject, readSignal),
        signal,
      );
    },

    async prefetch(subjects, signal) {
      const entries: {
        key: string;
        subject: BoardDetailsSubject;
        outcome: BoardDetailsOutcome;
      }[] = [];
      for (const subject of subjects) {
        // A cancelled prefetch reports what it HAS rather than throwing: the
        // chat card's counter is better honest and partial than absent, and the
        // pools that were not read are counted as unchecked by the classifier.
        if (signal?.aborted === true) {
          entries.push({
            key: boardPoolKey(subject),
            subject,
            outcome: { kind: "unavailable", reason: "cancelled" },
          });
          continue;
        }
        const outcome = await cache.read(
          boardPoolKey(subject),
          (readSignal) => load(subject, readSignal),
          signal,
        );
        entries.push({ key: boardPoolKey(subject), subject, outcome });
      }
      return entries;
    },

    dispose: cache.dispose,
  };
}

/* ------------------------------------------------------------------ */
/* The mounted instance                                                */
/* ------------------------------------------------------------------ */

let mounted: BoardDetailsService | null = null;

/**
 * Mount the one production instance and return its teardown.
 *
 * THE TEARDOWN IS ASYNC AND ITS PROMISE IS THE POINT, for the same reason the
 * icon service's is: the reads it drains run on the DexScreener bridge's
 * transport, and dropping this promise would let that bridge be disposed
 * underneath them.
 */
export function mountBoardDetailsService(
  overrides: Partial<BoardDetailsServiceDeps> = {},
): () => Promise<void> {
  const service = createBoardDetailsService(overrides);
  mounted = service;
  return async () => {
    if (mounted === service) mounted = null;
    await service.dispose();
  };
}

/** The mounted service, or null when the app never started one. */
export function getBoardDetailsService(): BoardDetailsService | null {
  return mounted;
}

/** Test-only: release the process slot between cases. */
export function __resetBoardDetailsServiceForTests(): void {
  mounted = null;
}
