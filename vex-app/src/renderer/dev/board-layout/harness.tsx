/**
 * BOARD LAYOUT HARNESS - the page `e2e/board-layout.spec.ts` drives.
 *
 * DEV SCAFFOLDING, NEVER A SHIPPED SURFACE. Nothing in `src/renderer/main.tsx`
 * imports this module and `vite.renderer.config.ts` has a single rollup input
 * (`src/renderer/index.html`), so no byte of this file can reach a packaged
 * build. It exists because board geometry is decided by the renderer's own
 * container queries and can only be MEASURED in a real engine at real widths;
 * the Electron smoke fixture cannot reach the board modal at all (its head
 * note: everything past SystemCheck needs a live Docker daemon and an
 * unlocked vault).
 *
 * IT MOUNTS THE REAL THING. The real `BoardModalHost`, the real `BoardGrid`,
 * the real `TokenCardV3`, and `styles/globals.css` verbatim. What is faked is
 * exactly the process boundary: `window.vex`, which in the product is the
 * preload bridge. Faking anything above it would prove a layout the product
 * does not have.
 *
 * THE CONTROL SURFACE. The URL decides the board (`?board=realistic|extreme`,
 * `?pools=N`), which view is mounted (`?view=grid|spotlight`) and, for the
 * seam matrix, the EXACT inline size of a query container (`?plate=C`,
 * `?spotlightPlate=C`). `window.__vexBoardLayoutHarness` decides what changes
 * DURING a test: the drawer, and the moment the safety read settles. The async
 * verdict case is the whole reason the settle is a control rather than a
 * fixture - a verdict that lands late is the layout event the production
 * screenshot caught mid-flight.
 *
 * WHY THE CONTAINER IS DRIVEN DIRECTLY AND NOT THROUGH THE VIEWPORT. Every
 * threshold in `global-css/board-layout.css` is a question about a container's
 * inline size, and the chain from a viewport width to that number runs through
 * the dialog's `min(94vw, ...)` cap, the modal body and two paddings. A seam
 * case has to land ON the number - 727.98px, not "whatever 1100px of window
 * happened to leave" - so `?plate=` pins the container's CONTENT box with
 * `box-sizing: content-box`, which is the box `container-type: inline-size`
 * measures. Nothing but the width is overridden: the padding, the border and
 * every rule under test are the product's own.
 */

import { StrictMode, useEffect, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  BoardHydratedRow,
  BoardPoolInput,
  BoardSpecV1,
} from "@vex-lib/board/index.js";
import { BOARD_STALE_AFTER_MS } from "@vex-lib/board/index.js";
import { BoardGrid } from "../../features/appShell/Board/BoardGrid.js";
import { BoardModalHost } from "../../features/appShell/Board/BoardModalHost.js";
import { BoardSpotlight } from "../../features/appShell/Board/BoardSpotlight.js";
import { boardRefOf } from "../../features/appShell/Board/board-surface-contracts.js";
import { useBoardSurfaceStore } from "../../features/appShell/Board/board-surface-store.js";
import "./harness.css";

const FETCHED_AT = 1_783_172_700_000;

/* ------------------------------------------------------------------ */
/* The fake process boundary                                           */
/* ------------------------------------------------------------------ */

/**
 * The safety read, held open until the test settles it.
 *
 * `unavailable`/`transport` with no cached evidence classifies as the
 * `unavailable` state, whose chip label - "Checks unavailable in this
 * response" - is the LONGEST string the frozen chip table can produce. That
 * is deliberate: the footer has to survive its own worst case, and a test
 * that settled on "Clean checks" would prove nothing about the case the
 * production screenshot broke on.
 */
let settleSafety: (() => void) | null = null;

function installFakeBridge(pools: readonly BoardPoolInput[]): void {
  const safetyPromise = new Promise<unknown>((resolve) => {
    settleSafety = () => {
      resolve({
        ok: true,
        data: {
          entries: pools.map((pool) => ({
            key: `${pool.chain}:${pool.pairAddress}`,
            subject: { chain: pool.chain, pairAddress: pool.pairAddress },
            outcome: { kind: "unavailable", reason: "transport" },
          })),
        },
      });
    };
  });

  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      boardIcons: {
        // A settled absence: every card wears its monogram, which is the
        // common case on a real board and the one that costs no network.
        read: (input: { readonly iconId: string }) =>
          Promise.resolve({
            ok: true,
            data: {
              iconId: input.iconId,
              icon: { kind: "absent", reason: "not_found" },
            },
          }),
      },
      boardSparkline: {
        hydrate: () => ({
          promise: Promise.resolve({
            ok: true,
            data: { entries: [], deadlineHit: false },
          }),
          cancel: () => undefined,
        }),
      },
      boardDetails: {
        prefetch: () => ({ promise: safetyPromise, cancel: () => undefined }),
        read: () => unavailable(),
      },
      // THE SPOTLIGHT'S SIX CHANNELS, ALL REFUSING. Every section renders its
      // own unavailable state, which is a DESIGNED state of the same elements
      // (the sections' contract) and therefore a layout the product really
      // has. It is also the widest of the settled states in the factual row,
      // so the region thresholds are measured against their own worst case
      // rather than against an empty frame.
      boardSpotlight: {
        topTraders: () => unavailable(),
        momentum: () => unavailable(),
        context: () => unavailable(),
        otherPools: () => unavailable(),
        tapePoll: () => unavailable(),
      },
    },
  });
}

/** A settled refusal in the bridge's own `Result` shape. */
function unavailable(): {
  readonly promise: Promise<unknown>;
  readonly cancel: () => void;
} {
  return {
    promise: Promise.resolve({
      ok: false,
      error: {
        code: "provider.unavailable",
        message: "The board layout harness serves no provider data.",
        correlationId: "board-layout-harness",
      },
    }),
    cancel: () => undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * REALISTIC COMPACT OUTPUT - the widest string each region renders in normal
 * service, not the widest the schema permits.
 *
 * Every figure here is a real DexScreener shape: a five-figure price, a
 * hundreds-of-thousands liquidity, a tens-of-millions volume, a five-digit
 * trade tally and a year-old pair. These are what the mode floors are sized
 * against; the schema extremes below are what the disclosure exists for.
 */
const REALISTIC_ROWS: readonly Partial<BoardHydratedRow>[] = [
  {
    baseTokenSymbol: "WBTC",
    baseTokenName: "Wrapped Bitcoin",
    priceUsd: "104238.9174",
    priceChange: { h1: "-1.73", h24: "-12.48" },
    liquidityUsd: "495612.34",
    volumeH24Usd: "12456789.01",
    txns: { buys: 12345, sells: 9876 },
    pairAgeSeconds: 31_536_000,
  },
  {
    baseTokenSymbol: "PEPE",
    baseTokenName: "Pepe the Frog",
    priceUsd: "0.00000123",
    priceChange: { h1: "4.10", h24: "661" },
    liquidityUsd: "75189.01",
    volumeH24Usd: "464284.04",
    txns: { buys: 1235, sells: 856 },
    pairAgeSeconds: 259_200,
  },
  {
    baseTokenSymbol: "DEGEN",
    baseTokenName: "Degen Chain Token",
    priceUsd: "0.0084213",
    priceChange: { h1: "0", h24: "-0.42" },
    liquidityUsd: "2341000.55",
    volumeH24Usd: "998877.10",
    txns: { buys: 998, sells: 1_240_000 },
    pairAgeSeconds: 7200,
  },
  {
    baseTokenSymbol: "USDC",
    baseTokenName: "USD Coin",
    priceUsd: "0.9998",
    priceChange: { h1: "0", h24: "0" },
    liquidityUsd: "1234567890.12",
    volumeH24Usd: "9876543210.99",
    txns: { buys: 450_000, sells: 449_999 },
    pairAgeSeconds: 94_608_000,
  },
  {
    baseTokenSymbol: "AERO",
    baseTokenName: "Aerodrome Finance",
    priceUsd: "1.2345",
    priceChange: { h1: "-0.5", h24: "8.31" },
    liquidityUsd: "18400000",
    volumeH24Usd: "3210987.65",
    txns: { buys: 8888, sells: 7777 },
    pairAgeSeconds: 1800,
  },
  {
    baseTokenSymbol: "TOSHI",
    baseTokenName: "Toshi",
    priceUsd: "0.00019234",
    priceChange: { h1: "2.2", h24: "-33.19" },
    liquidityUsd: "8912345.67",
    volumeH24Usd: "45678.90",
    txns: { buys: 60, sells: 41 },
    pairAgeSeconds: 300,
  },
];

/**
 * SCHEMA-REACHABLE EXTREMES - the widest a VALID board document can be.
 *
 * `BOARD_DECIMAL_MAX_CHARS` is 40 and `BOARD_TOKEN_LABEL_MAX_CHARS` is 512
 * (`src/lib/board/spec.ts`), so both of these parse. Neither can fit any
 * card at any width, which is precisely the case the full-value disclosure
 * owns: the cut becomes recoverable rather than silent.
 */
const EXTREME_PRICE = "1234567890123456789012345678901234.5678";
const EXTREME_SYMBOL = "X".repeat(512);
const EXTREME_NAME = "Wrapped ".repeat(60) + "Token";

const EXTREME_ROWS: readonly Partial<BoardHydratedRow>[] = [
  {
    baseTokenSymbol: EXTREME_SYMBOL,
    baseTokenName: EXTREME_NAME,
    priceUsd: EXTREME_PRICE,
    priceChange: { h1: "-1.73", h24: "-98765.4321" },
    liquidityUsd: "1234567890123456789012345678901234.5678",
    volumeH24Usd: "1234567890123456789012345678901234.5678",
    txns: { buys: 999_999_999, sells: 999_999_999 },
    pairAgeSeconds: 999_999_999,
  },
  ...REALISTIC_ROWS.slice(0, 2),
];

function row(overrides: Partial<BoardHydratedRow>): BoardHydratedRow {
  return {
    baseTokenSymbol: "PEPE",
    baseTokenName: "Pepe the Frog",
    quoteTokenSymbol: "WETH",
    chainId: "base",
    dexId: "uniswap",
    priceUsd: "0.00000123",
    priceChange: { h1: "-1.73", h24: "113" },
    liquidityUsd: "75189.01",
    volumeH24Usd: "464284.04",
    txns: { buys: 1235, sells: 856 },
    pairAgeSeconds: 259_200,
    iconId: null,
    description: null,
    ...overrides,
  };
}

function harnessSpec(kind: string, poolCount: number): BoardSpecV1 {
  const source = kind === "extreme" ? EXTREME_ROWS : REALISTIC_ROWS;
  const rows: BoardHydratedRow[] = [];
  for (let index = 0; index < poolCount; index += 1) {
    rows.push(row(source[index % source.length] ?? {}));
  }
  const pools: BoardPoolInput[] = rows.map((_, index) => ({
    chain: "base",
    pairAddress: `0x${String(index).padStart(6, "a")}`,
    analysis: null,
  }));
  return {
    version: 1,
    title: "Board layout harness",
    pools,
    hydration: {
      rows,
      candles: null,
      unmatchedMarkerAtMs: null,
      analysisCreatedAt: FETCHED_AT - 30_000,
      marketDataFetchedAt: FETCHED_AT,
      provenance: {
        transport: "http",
        sourceObservation: "board layout harness",
      },
      staleAfterMs: BOARD_STALE_AFTER_MS,
    },
  };
}

/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

/** A drawer body of the real width, with none of the panel's own channels. */
function AskStub(): JSX.Element {
  return (
    <div data-vex-area="board-ask-stub" className="pt-6 text-[13px] text-ink-secondary">
      Ask VEX
    </div>
  );
}

/**
 * The exact-container override for a seam case.
 *
 * `content-box` because `container-type: inline-size` measures the CONTENT
 * box: with it, `width: 727.98px` IS the number the `@container` query sees,
 * so a seam case can sit one hundredth of a pixel below a threshold. `flex:
 * none` and `max-width: none` stop the modal's own flex column from taking
 * the width back. Absent the parameter, not one byte of this is emitted.
 */
function containerOverride(
  selector: string,
  width: number | null,
): string {
  if (width === null) return "";
  return `${selector} { box-sizing: content-box; width: ${String(width)}px; max-width: none; flex: none; }`;
}

function widthParam(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (raw === null) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function Harness(): JSX.Element {
  const openBoardModal = useBoardSurfaceStore((s) => s.openBoardModal);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const kind = params.get("board") ?? "realistic";
    const poolCount = Number.parseInt(params.get("pools") ?? "6", 10);
    const spec = harnessSpec(kind, Number.isFinite(poolCount) ? poolCount : 6);
    installFakeBridge(spec.pools);
    // THE BOARD IS RE-ASSERTED, NOT TIMED OPEN.
    //
    // `BoardModalHost` registers an unmount teardown that clears every board
    // surface, and StrictMode's development double-invoke runs that cleanup
    // once - so a board opened synchronously here is closed again before the
    // first paint. Deferring the open by a timer papered over that and turned
    // it into a race that lost about one run in thirty under load, which is a
    // flaky spec rather than a fixed one.
    //
    // Subscribing instead makes it a fixed point: whenever the store reports
    // no bound board, this binds one, so no ordering of mount, cleanup and
    // remount can leave the page empty. The product never needs this, because
    // nothing opens a board during the shell's own mount.
    const board = boardRefOf("harness-session", 1, spec);
    const drawer = params.get("drawer") === "1";
    const spotlight = params.get("view") === "spotlight";
    const ensure = (): void => {
      const store = useBoardSurfaceStore.getState();
      if (store.modalBoard === null) {
        store.openBoardModal(board);
        if (spotlight) useBoardSurfaceStore.getState().openBoardSpotlight(0);
        if (drawer) useBoardSurfaceStore.getState().setBoardAskOpen(true);
      } else {
        if (spotlight && store.view !== "spotlight") {
          store.openBoardSpotlight(0);
        }
        if (drawer && !store.askPanelOpen) store.setBoardAskOpen(true);
      }
      setReady(true);
    };
    const unsubscribe = useBoardSurfaceStore.subscribe(ensure);
    ensure();
    return unsubscribe;
  }, [openBoardModal]);

  return (
    <>
      <BoardModalHost
        gridSlot={BoardGrid}
        spotlightSlot={BoardSpotlight}
        askSlot={AskStub}
      />
      {ready ? <div data-vex-area="board-harness-ready" /> : null}
    </>
  );
}

declare global {
  interface Window {
    readonly __vexBoardLayoutHarness: {
      readonly setDrawer: (open: boolean) => void;
      readonly settleSafety: () => void;
    };
  }
}

/* The seam override is written ONCE, before the first render and outside any
 * effect: StrictMode double-invokes effects, and a second copy of the rule
 * would be a second answer to how wide the container is. */
{
  const params = new URLSearchParams(window.location.search);
  const css =
    containerOverride(".vex-board-plate", widthParam(params, "plate")) +
    containerOverride(
      ".vex-board-spotlight-plate",
      widthParam(params, "spotlightPlate"),
    );
  if (css !== "") {
    const style = document.createElement("style");
    style.dataset["vexHarness"] = "container-override";
    style.textContent = css;
    document.head.append(style);
  }
}

Object.defineProperty(window, "__vexBoardLayoutHarness", {
  configurable: true,
  value: {
    setDrawer: (open: boolean) => {
      useBoardSurfaceStore.getState().setBoardAskOpen(open);
    },
    settleSafety: () => {
      settleSafety?.();
    },
  },
});

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

const host = document.getElementById("root");
if (host !== null) {
  createRoot(host).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>
    </StrictMode>,
  );
}
