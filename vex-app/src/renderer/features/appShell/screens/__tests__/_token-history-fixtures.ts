/**
 * Shared token-history DTO fixtures for the TokenHistoryScreen suites.
 *
 * Extracted when the 722-line screen suite was split by the same seams as the
 * screen itself (gate vs. rows) — the `_appshell-render.tsx` precedent: the
 * fixture factories move here, while each test file keeps its OWN `vi.mock()`
 * calls and its own dynamic `import("../ShellScreens.js")`, because mocks
 * must register before the component module loads and therefore cannot be
 * shared.
 *
 * These are DTO shapes only — no assertions, no rendering. A change to
 * `shared/schemas/token-history.ts` should break compilation here first,
 * which is the point: one place to update when the contract moves.
 */

import type {
  TokenHistoryDto,
  TokenHistoryEntry,
} from "@shared/schemas/token-history.js";
import type { Result } from "@shared/ipc/result.js";
import type {
  ShellRoute,
  ShellRouteReturnTo,
} from "../../../../stores/uiStore.js";

export const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const TX_HASH = "0xabc123def456";

export const ROUTE_TOKEN = {
  chainId: 8453,
  tokenAddress: USDC_BASE,
  symbol: "USDC",
  tokenName: "USD Coin",
} as const;

/**
 * `returnTo` is an OBJECT since the session-scope round (C4): the `assets`
 * return carries the scope the register was in, so a session-scoped
 * All-assets screen comes back session-scoped.
 */
export function tokenHistoryRoute(
  returnTo: ShellRouteReturnTo,
): ShellRoute {
  return {
    kind: "tokenHistory",
    origin: null,
    token: ROUTE_TOKEN,
    returnTo,
  };
}

export function swapEntry(
  overrides: Partial<Extract<TokenHistoryEntry, { kind: "swap" }>> & {
    readonly id: string;
  },
): TokenHistoryEntry {
  return {
    kind: "swap",
    createdAt: "2026-07-01T10:21:00+00:00",
    chain: "base",
    venue: "kyberswap",
    tradeSide: "buy",
    productType: "spot_swap",
    // The canonical vocabulary the badge reads. `productType`/`tradeSide`
    // above are still on the DTO but have no renderer consumer — a fixture
    // that keeps them proves exactly that.
    activityKind: "swap",
    eventRole: "swap",
    input: {
      token: "0x1111111111111111111111111111111111111111",
      symbol: "TOKA",
      localSymbol: null,
      amount: { value: "1.5", unitProvenance: "human" },
      valueUsd: { value: "25.00", usdProvenance: "recorded" },
    },
    output: {
      token: USDC_BASE,
      symbol: "TOKB",
      localSymbol: null,
      amount: { value: "25100000", unitProvenance: "unknown" },
      valueUsd: { value: "25.10", usdProvenance: "recorded" },
    },
    unitPriceUsd: "0.52",
    captureStatus: "executed",
    status: null,
    failureCode: null,
    txRefs: [{ chainId: 8453, ref: TX_HASH }],
    ...overrides,
  };
}

export function bridgeEntry(
  overrides: Partial<Extract<TokenHistoryEntry, { kind: "bridge" }>> & {
    readonly id: string;
  },
): TokenHistoryEntry {
  return {
    kind: "bridge",
    createdAt: "2026-07-20T08:00:00+00:00",
    originChain: "base",
    destinationChain: "arbitrum",
    venue: "khalani",
    activityKind: "bridge",
    eventRole: "bridge_fill_expected",
    input: {
      token: null,
      symbol: "USDC",
      localSymbol: null,
      amount: { value: "2.0", unitProvenance: "human" },
      valueUsd: { value: "2.00", usdProvenance: "estimated" },
    },
    output: {
      token: null,
      symbol: "USDC",
      localSymbol: null,
      amount: { value: "2.0", unitProvenance: "human" },
      valueUsd: { value: "2.00", usdProvenance: "estimated" },
    },
    captureStatus: null,
    txRefs: [],
    status: null,
    failureCode: null,
    providerOrderId: "ord_1",
    amountBasis: "estimated",
    legs: [],
    // Freshly checked by default so a pending bridge reads "settling"; the
    // tracking-delay test overrides this with a long-past timestamp.
    lastCheckedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function availablePage(
  entries: readonly TokenHistoryEntry[],
  options?: {
    readonly hasMore?: boolean;
  },
): Result<TokenHistoryDto> {
  return {
    ok: true,
    data: {
      status: "available",
      entries: [...entries],
      nextCursor:
        options?.hasMore === true
          ? { createdAt: "2026-07-01T10:21:00.000000Z", sourceRank: 1, sourceId: "1" }
          : null,
      hasMore: options?.hasMore === true,
    },
  };
}
