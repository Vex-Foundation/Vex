/**
 * Shared Agent Scan fixtures + jsdom geometry for the AgentScanScreen suites.
 *
 * Extracted when the 579-line screen suite was split by the same seams as the
 * screen itself (filters/states, rows+virtualization, session preset) — the
 * `_token-history-fixtures.ts` precedent: the DTO factories and the jsdom
 * measurement stubs move here, while each test file keeps its OWN `vi.mock()`
 * calls and its own dynamic `import("../AgentScanScreen.js")`, because mocks
 * must register before the component module loads and therefore cannot be
 * shared.
 *
 * No assertions and no rendering live here. The geometry helpers are written
 * WITHOUT `vitest` spies (plain save/restore) so this module stays a fixture
 * module rather than a second test harness.
 */

import type {
  AgentScanActivityEntry,
  AgentScanDto,
  AgentScanEntry,
} from "@shared/schemas/agent-scan-feed.js";
import type { AgentScanLighterFillEntry } from "@shared/schemas/agent-scan-lighter-entry.js";
import type { Result } from "@shared/ipc/result.js";
import type { AgentScanRouteScope } from "../../../../stores/uiStore/shell-route.js";

/** The three scope presets the screen can be opened with. */
export const GLOBAL_SCOPE: AgentScanRouteScope = { kind: "global" };
export const SCOPE_SESSION_ID = "00000000-0000-4000-8000-0000000000ac";
export const SCOPE_PROJECT_ID = "00000000-0000-4000-8000-0000000000b7";
export const SESSION_SCOPE: AgentScanRouteScope = {
  kind: "session",
  sessionId: SCOPE_SESSION_ID,
};
export const PROJECT_SCOPE: AgentScanRouteScope = {
  kind: "project",
  projectId: SCOPE_PROJECT_ID,
};

/** The project name the mocked `useProject` resolves for `PROJECT_SCOPE`. */
export const PROJECT_NAME = "Trading";

export function entry(
  overrides: Partial<AgentScanActivityEntry> & { readonly id: string },
): AgentScanActivityEntry {
  return {
    // The ledger discriminator. Required, not defaulted: both sides of the IPC
    // ship in one build, and a fixture that could omit it would let a consumer
    // forget to switch on it.
    source: "agent_activity",
    createdAt: "2026-07-20T10:21:00+00:00",
    activityKind: "swap",
    eventRole: "swap",
    status: "confirmed",
    protocol: "kyberswap",
    chainId: 8453,
    chainFamily: "eip155",
    chainSlug: "base",
    fromChain: null,
    toChain: null,
    input: {
      address: "0x1111111111111111111111111111111111111111",
      symbol: "USDC",
      displaySymbol: "USDC",
      decimals: 6,
      amountHuman: "50",
      amountRaw: "50000000",
      executedAmountHuman: "50",
      executedAmountRaw: "50000000",
      displayAmount: "50",
      usdEst: "50.00",
    },
    output: {
      address: "0x2222222222222222222222222222222222222222",
      symbol: "WETH",
      displaySymbol: "WETH",
      decimals: 18,
      amountHuman: "0.02",
      amountRaw: "20000000000000000",
      executedAmountHuman: "0.02",
      executedAmountRaw: "20000000000000000",
      displayAmount: "0.02",
      usdEst: "49.80",
    },
    amountBasis: null,
    vexFee: null,
    usdFeeEst: null,
    failureCode: null,
    failureReason: null,
    txHash: "0xabc",
    explorerUrl: "https://basescan.org/tx/0xabc",
    providerOrderId: null,
    legs: [],
    lastCheckedAt: null,
    // Wave P — DERIVED, never a stored status. Default is a row we have had no
    // trouble verifying.
    stalledVerification: false,
    stalledReason: null,
    // The CONCLUSIVE half (migration 067). Required and nullable on the DTO, so
    // the fixture must carry it explicitly — an optional field here would be
    // `string | null | undefined`, which the strict entry type does not admit.
    pendingReason: null,
    ...overrides,
  };
}

/**
 * ONE LIGHTER FILL, fully populated - the ETH example from the plan: a 0.0050
 * ETH buy at 2,598.09 that OPENED a 10x position, with the Vex fee still only
 * ESTIMATED (charged is unproven, not zero), the exchange fee likewise, and a
 * position observation taken after the fill.
 *
 * Every optional fact is present here on purpose, so a test that wants an
 * absence states it as an override and the absence is visible in the test
 * itself rather than hidden in this factory.
 */
export function lighterFill(
  overrides: Partial<AgentScanLighterFillEntry> & { readonly id: string },
): AgentScanLighterFillEntry {
  return {
    source: "lighter_fill",
    createdAt: "2026-07-20T10:21:00+00:00",
    observedAt: "2026-07-20T10:21:04+00:00",
    environment: "core",
    marketIndex: 1,
    marketSymbol: "ETH-USD",
    spot: false,
    side: "buy",
    tradeType: "trade",
    positionEffect: "open",
    baseSize: "0.0050",
    price: "2598.09",
    quoteNotional: "12.990450",
    usdAmount: "12.990450",
    blockHeight: "18412771",
    baseAsset: { symbol: "ETH", decimals: 18 },
    quoteAsset: { symbol: "USDG", decimals: 6 },
    positionSizeBefore: "0",
    entryQuoteBefore: "0",
    accountPnl: "0",
    leverage: { initialMarginFraction: 1000, display: "10.00" },
    feeSide: "taker",
    integratorFee: {
      charged: null,
      estimate: {
        raw: "12990",
        symbol: "USDG",
        decimals: 6,
        basis: "quote_notional",
        tickSource: "observed",
        usd: "0.012990",
      },
      tickObserved: 1000,
      tickAuthorized: 1000,
    },
    exchangeFee: {
      charged: null,
      estimatedUsd: "0.004546",
      tickObserved: 350,
    },
    providerTradeId: "884412",
    providerOrderId: "771203",
    intentId: "lighter-exec-00000000-0000-4000-8000-0000000000f1",
    positionNow: {
      observedAt: "2026-07-20T16:49:00+00:00",
      open: true,
      position: {
        size: "0.0050",
        entryPrice: "2598.09",
        unrealizedPnl: "-0.0077",
        realizedPnl: "0",
        liquidationPrice: "2365.93",
        leverage: { initialMarginFraction: 1000, display: "10.00" },
        marginMode: "isolated",
      },
    },
    ...overrides,
  };
}

export function availablePage(
  entries: readonly AgentScanEntry[],
  options?: { readonly hasMore?: boolean },
): Result<AgentScanDto> {
  return {
    ok: true,
    data: {
      status: "available",
      entries: [...entries],
      nextCursor:
        options?.hasMore === true
          ? {
              createdAt: "2026-07-20T10:21:00.000000Z",
              sourceId: "1",
              // The ARM the boundary row came from, now that the cursor spans
              // two ledgers (`(cursor_ts DESC, source_rank DESC, id DESC)`).
              sourceRank: 0,
            }
          : null,
      hasMore: options?.hasMore === true,
    },
  };
}

/** A timed-out page — the degradation the feed must never render as "empty". */
export const UNAVAILABLE_PAGE: Result<AgentScanDto> = {
  ok: true,
  data: { status: "unavailable", reason: "query_timeout" },
};

// Real geometry. jsdom reports zero for every measurement, and a zero-height
// scroll viewport makes the virtualizer render NOTHING at all (virtual-core
// nulls the range when `outerSize === 0`), so the windowing would be untested
// rather than tested. The two stubs mirror what the library actually reads:
//   - the SCROLL viewport through `offsetHeight`/`offsetWidth` (`getRect`),
//   - each ROW through `getBoundingClientRect` (`measureElement`).
export const ROW_PX = 48;
export const VIEWPORT_PX = 480;

const originalOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight",
);
const originalOffsetWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetWidth",
);
const originalGetBoundingClientRect =
  Element.prototype.getBoundingClientRect;

export function installJsdomGeometry(): void {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => VIEWPORT_PX,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 800,
  });
  Element.prototype.getBoundingClientRect = function getRect(): DOMRect {
    return {
      width: 800,
      height: ROW_PX,
      top: 0,
      left: 0,
      right: 800,
      bottom: ROW_PX,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

export function restoreJsdomGeometry(): void {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  if (originalOffsetHeight !== undefined) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetHeight",
      originalOffsetHeight,
    );
  }
  if (originalOffsetWidth !== undefined) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetWidth",
      originalOffsetWidth,
    );
  }
}
