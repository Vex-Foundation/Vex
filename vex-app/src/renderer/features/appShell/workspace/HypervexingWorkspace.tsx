/**
 * Hypervexing workspace (design spec §3 grid + §5 transition). The 5-zone
 * trading room that replaces the normal shell columns while the mode is active,
 * mounted above the SignalSky (which morphs its palette navy→bottle-green for
 * transition phase 1 "for free" via its uniform crossfade).
 *
 * Zones: top bar · left (markets + earn) · center chart · right copilot dock ·
 * bottom tabs. The sessions rail is intentionally NOT rendered in the mode.
 *
 * Transition — "the liquid pour": a mint droplet clip-path reveal expands from
 * the dock edge (the spec's fallback origin when no invoking-card anchor is
 * available), with a staggered panel entrance; exit contracts back toward the
 * EXIT origin. `prefers-reduced-motion` collapses both to a 120ms crossfade
 * (framer `useReducedMotion` here + the global keyframe-collapse rule for the
 * CSS `vex-rise` stagger). Only clip-path / opacity / transform animate — no
 * layout props, no blur (guard-compliant).
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import { motion, useReducedMotion } from "motion/react";

import { useUiStore } from "../../../stores/uiStore.js";
import { useHyperliquidPositions } from "../../../lib/api/hyperliquid.js";
import { HvZone } from "./HvZone.js";
import { HypervexingBookPane } from "./HypervexingBookPane.js";
import { HypervexingChartPane } from "./HypervexingChartPane.js";
import { HypervexingCopilotDock } from "./HypervexingCopilotDock.js";
import { HypervexingLeftColumn } from "./HypervexingLeftColumn.js";
import { HypervexingTabs } from "./HypervexingTabs.js";
import { HypervexingTopBar } from "./HypervexingTopBar.js";
import { findPositionByCoin, sumUnrealizedPnl } from "./workspacePositions.js";
import { buildWorkspaceTransition } from "./workspaceTransition.js";

/** The glass grid (design spec §13.1). Zones are HvZone glass islands; the
 * Signal Sky shows through the gaps, which is what unifies the room. Widths
 * carried as CSS vars so a later responsive fold-order pass can override them
 * per breakpoint. Below the wide-room edge the order-book column folds away
 * (the chart keeps the space); the pane unmounts so its poll stops. */
const GRID_ROWS = "52px minmax(0, 1fr) var(--hv-tabs-h, clamp(216px, 24vh, 264px))";
const WIDE_GRID_STYLE: CSSProperties = {
  gridTemplateAreas: `"top top top top" "left chart book dock" "left tabs tabs dock"`,
  gridTemplateColumns:
    "var(--hv-left-w, 264px) minmax(0, 1fr) var(--hv-book-w, 288px) var(--hv-dock-w, clamp(400px, 29vw, 480px))",
  gridTemplateRows: GRID_ROWS,
};
const NARROW_GRID_STYLE: CSSProperties = {
  gridTemplateAreas: `"top top top" "left chart dock" "left tabs dock"`,
  gridTemplateColumns:
    "var(--hv-left-w, 264px) minmax(0, 1fr) var(--hv-dock-w, clamp(400px, 29vw, 480px))",
  gridTemplateRows: GRID_ROWS,
};

/** Four columns need ~1560px to breathe; below that the book folds first. */
const WIDE_ROOM_QUERY = "(min-width: 1560px)";

function useWideRoom(): boolean {
  const [wide, setWide] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(WIDE_ROOM_QUERY).matches
      : true,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(WIDE_ROOM_QUERY);
    const onChange = (event: MediaQueryListEvent): void => setWide(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return wide;
}

/** The room's default market before any selection or open position. */
const DEFAULT_COIN = "BTC";

/** Pure selection rule so initial hydration can never masquerade as a new fill. */
export function nextPositionAutoFollow(
  known: ReadonlySet<string> | null,
  coins: readonly string[],
  hasManualSelection: boolean,
): { readonly known: ReadonlySet<string>; readonly follow: string | undefined } {
  const current = new Set(coins);
  if (known === null) return { known: current, follow: undefined };
  const fresh = [...current].find((coin) => !known.has(coin));
  return { known: current, follow: hasManualSelection ? undefined : fresh };
}

export function HypervexingWorkspace({
  onExit,
}: {
  readonly onExit: () => Promise<boolean>;
}): JSX.Element {
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const query = useHyperliquidPositions(activeSessionId);
  const positions = useMemo(
    () => (query.data?.ok ? query.data.data.positions : []),
    [query.data],
  );
  const account = query.data?.ok ? query.data.data.account ?? null : null;
  const watchlist = useMemo(
    () => (query.data?.ok ? query.data.data.watchlist ?? [] : []),
    [query.data],
  );

  // Selection priority: explicit user pick → first open position → BTC.
  // The room never shows an empty "pick a market" void.
  const [selectedCoin, setSelectedCoin] = useState<string | null>(null);
  const hasManualSelection = useRef(false);
  const effectiveCoin = selectedCoin ?? positions[0]?.coin ?? DEFAULT_COIN;
  const selectedPosition = findPositionByCoin(positions, effectiveCoin);

  // A NEWLY opened position pulls the chart to its market (owner order: a
  // HYPE position must not stream under a BTC chart) — once, on the coin's
  // first appearance; the user's later manual pick is never fought.
  const knownPositionCoins = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    // The first durable projection establishes the baseline. `effectiveCoin`
    // already falls back to its first position, and this must never overwrite a
    // picker choice made while the positions query was loading.
    const next = nextPositionAutoFollow(
      knownPositionCoins.current,
      positions.map((position) => position.coin),
      hasManualSelection.current,
    );
    knownPositionCoins.current = next.known;
    if (next.follow !== undefined) setSelectedCoin(next.follow);
  }, [positions]);

  const selectCoinManually = (coin: string): void => {
    hasManualSelection.current = true;
    setSelectedCoin(coin);
  };

  // One uPnL derivation for the room: venue-confirmed account total first,
  // position-sum fallback (same rule the top bar applies).
  const accountUpnl =
    account?.totalUnrealizedPnlUsd != null ? Number(account.totalUnrealizedPnlUsd) : null;
  const upnl =
    accountUpnl !== null && Number.isFinite(accountUpnl)
      ? accountUpnl
      : sumUnrealizedPnl(positions);

  const motionProps = buildWorkspaceTransition(useReducedMotion() ?? false);
  const wideRoom = useWideRoom();

  return (
    <motion.div
      data-vex-hypervexing-workspace
      className="absolute inset-0 z-10 grid gap-2.5 overflow-hidden p-2.5"
      style={wideRoom ? WIDE_GRID_STYLE : NARROW_GRID_STYLE}
      initial={motionProps.initial}
      animate={motionProps.animate}
      exit={motionProps.exit}
      transition={motionProps.transition}
    >
      <HvZone area="top" label="Hypervexing bar">
        <HypervexingTopBar
          positions={positions}
          account={account}
          onExit={onExit}
        />
      </HvZone>
      <HvZone area="left" label="Account and earn">
        <HypervexingLeftColumn
          account={account}
          upnl={upnl}
          sessionId={activeSessionId}
          selectedCoin={effectiveCoin}
        />
      </HvZone>
      <HvZone area="chart" label="Market chart">
        <HypervexingChartPane
          sessionId={activeSessionId}
          coin={effectiveCoin}
          position={selectedPosition}
          watchlist={watchlist}
          onSelectCoin={selectCoinManually}
        />
      </HvZone>
      {wideRoom ? (
        <HvZone area="book" label="Order book">
          <HypervexingBookPane sessionId={activeSessionId} coin={effectiveCoin} />
        </HvZone>
      ) : null}
      <HvZone area="dock" label="Vex copilot">
        <HypervexingCopilotDock />
      </HvZone>
      <HvZone area="tabs" label="Trading registers">
        <HypervexingTabs
          sessionId={activeSessionId}
          positionCount={positions.length}
          account={account}
        />
      </HvZone>
    </motion.div>
  );
}
