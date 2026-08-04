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
  AgentScanDto,
  AgentScanEntry,
} from "@shared/schemas/agent-scan-feed.js";
import type { Result } from "@shared/ipc/result.js";

export function entry(
  overrides: Partial<AgentScanEntry> & { readonly id: string },
): AgentScanEntry {
  return {
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
          ? { createdAt: "2026-07-20T10:21:00.000000Z", sourceId: "1" }
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
