/**
 * VEX TOKEN CARD — COMPACT rail widget (Chronos slim cut, 2026-07-20).
 *
 * The live $VEX signal rides the sessions rail between BROWSE ALL and the
 * profile footer (`SessionsList`). Slimmed by owner decree: a header row
 * [mark · $VEX · price · 24h delta] and a tight full-width sparkline — the
 * old 2×2 stat micro-grid (MCAP / LIQ / 24H VOL / HOLDERS) is gone.
 *
 * Speaks the Signal Tape grammar: solid-luminance surface + hairline,
 * `--vex-*` tokens ONLY (the shell design-guard enforces no raw hexes),
 * display numerals with `tabular-nums`, mono micro-labels. The 24h delta is
 * a BORDERLESS figure in the SEMANTIC status tone (success up / danger
 * down) always wearing the `.vex-delta-shimmer` sweep (owner-decreed
 * decorative exception; reduced motion stills it). Stale data keeps its own
 * honest marker next to the $VEX label.
 *
 * The data card (only the data card — loading/error states stay inert) is a
 * whole-card link out to the $VEX DexScreener pair, opened in the system
 * browser via main's external-URL allowlist.
 *
 * Every state resolves to a visible surface so the rail is never blank —
 * loading skeleton, error line, stale marker, or the data card.
 */

import type { JSX } from "react";
import type { VexMarketSnapshot } from "@shared/schemas/market.js";
import { useVexMarket } from "../../../lib/api/market.js";
import { cn } from "../../../lib/utils.js";
import {
  formatPercentDelta,
  formatTokenPriceUsd,
} from "../../../lib/format.js";

const CARD_CLASS =
  "rounded-xl border border-line-2 bg-surface-1 px-3 py-2.5";

// The $VEX DexScreener pair — a renderer-local literal by design: the
// market IPC schema (`@shared/schemas/market.js`) deliberately carries no
// addresses or URLs. `dexscreener.com` is already in main's external-URL
// allowlist (`main-window.ts`), so target=_blank routes through
// `shell.openExternal`, never a child window.
const DEXSCREENER_VEX_PAIR_URL =
  "https://dexscreener.com/robinhood/0x817f16f5d8da83d1b089b082c0172af3923618da";

export function VexTokenCardCompact(): JSX.Element {
  const query = useVexMarket();
  const result = query.data;
  const snapshot = result?.ok ? result.data : null;

  // Bridge/handler error → a boxed line, never a blank rail.
  if ((result !== undefined && !result.ok) || query.isError) {
    return (
      <section
        data-vex-area="vex-token-compact"
        data-state="error"
        aria-label="VEX market data unavailable"
        className={CARD_CLASS}
      >
        <div className="flex items-center gap-2">
          <VexMark />
          <div className="flex min-w-0 flex-col">
            <span className="vex-micro-label self-start uppercase text-ink-secondary">
              $VEX
            </span>
            <span className="text-[11px] text-warning-label">
              Market data unavailable.
            </span>
          </div>
        </div>
      </section>
    );
  }

  // First read (isLoading) OR polled-but-not-yet (`ok(null)`) → skeleton.
  if (snapshot === null) {
    return (
      <section
        data-vex-area="vex-token-compact"
        data-state="loading"
        aria-label="Loading VEX price"
        className={CARD_CLASS}
      >
        <div className="flex items-center gap-2">
          <VexMark />
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="vex-micro-label self-start uppercase text-ink-secondary">
              $VEX
            </span>
            <span
              aria-hidden
              className="h-4 w-20 animate-pulse rounded bg-line-3"
            />
          </div>
        </div>
      </section>
    );
  }

  return <CompactBody snapshot={snapshot} />;
}

function CompactBody({
  snapshot,
}: {
  readonly snapshot: VexMarketSnapshot;
}): JSX.Element {
  const priceLabel = formatTokenPriceUsd(snapshot.priceUsd);
  const deltaLabel = formatPercentDelta(snapshot.priceChange.h24);
  const closes = snapshot.sparkline.map((point) => point[1]);

  return (
    <section
      data-vex-area="vex-token-compact"
      data-state="data"
      data-stale={snapshot.stale ? "true" : "false"}
      aria-label={`VEX token price ${priceLabel}, 24 hour change ${deltaLabel}${
        snapshot.stale ? ", data delayed" : ""
      }`}
    >
      {/* target=_blank never opens a child window: main's
       * setWindowOpenHandler denies + routes allowlisted hosts (dexscreener.com
       * is already listed) through shell.openExternal. Only the data card
       * links out — loading/error states stay inert. */}
      <a
        href={DEXSCREENER_VEX_PAIR_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open $VEX on DexScreener"
        className={cn(
          CARD_CLASS,
          "block transition-colors hover:border-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <VexMark />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="vex-micro-label inline-flex items-center self-start gap-1.5 uppercase text-ink-secondary">
                $VEX
                {snapshot.stale ? <StaleMarker /> : null}
              </span>
              <span className="truncate font-display text-[15px] font-extrabold leading-none tracking-[-0.02em] tabular-nums text-ink-primary">
                {priceLabel}
              </span>
            </div>
          </div>
          <DeltaFigure change={snapshot.priceChange.h24} label={deltaLabel} />
        </div>

        <Sparkline closes={closes} />
      </a>
    </section>
  );
}

/** The Vex mark — the SAME `/icon.png` the profile row below wears (owner
 * decree: one identity image up and down the rail). */
function VexMark(): JSX.Element {
  return (
    <img
      src="/icon.png"
      alt="VEX token"
      className="h-6 w-6 shrink-0 rounded-full"
    />
  );
}

function StaleMarker(): JSX.Element {
  return (
    <span
      data-vex-area="vex-token-stale"
      className="flex items-center gap-1 text-ink-tertiary"
      title="Live feed delayed - showing the last known price."
    >
      <span
        aria-hidden
        className="h-[5px] w-[5px] rounded-full bg-[var(--vex-pin)]"
      />
      delayed
    </span>
  );
}

/**
 * 24h delta figure — BORDERLESS (owner decree: no pill chrome), set in the
 * SEMANTIC status tone (up = success, down = danger, flat/null = muted).
 * Status colours are a product contract the theme never re-tints. The figure
 * stays a SOLID direction color at all times (owner feedback: background-clip
 * on the number washed the text out); `.vex-delta-shimmer` now only drives an
 * `::after` overlay — a near-white band sweeping over a duplicate of the text
 * (via `data-shimmer-text`) — so the shine never dims the live figure. Always
 * on (owner-decreed decorative exception to the live-state motion law); OS
 * reduced motion drops the overlay and the solid figure stays.
 */
function DeltaFigure({
  change,
  label,
}: {
  readonly change: number | null;
  readonly label: string;
}): JSX.Element {
  const up = change !== null && Number.isFinite(change) && change > 0;
  const down = change !== null && Number.isFinite(change) && change < 0;
  return (
    <span
      data-vex-area="vex-token-delta"
      data-shimmer-text={label}
      className={cn(
        "vex-delta-shimmer inline-flex shrink-0 items-center text-[11px] font-semibold tabular-nums",
        up && "text-success",
        down && "text-warning-label",
        !up && !down && "text-ink-tertiary",
      )}
    >
      {label}
    </span>
  );
}

/**
 * Full-width rail sparkline — a single 2px accent path over the trailing hourly
 * closes, stretched edge-to-edge (preserveAspectRatio="none" + non-scaling
 * stroke keep the line crisp while the x-axis fills the rail). Fewer than two
 * finite points → a blank reserved track (graceful empty state, never blank).
 */
function Sparkline({
  closes,
}: {
  readonly closes: readonly number[];
}): JSX.Element {
  const W = 240;
  const H = 32;
  const PAD = 2;
  const points = closes.filter((v) => Number.isFinite(v));

  if (points.length < 2) {
    return (
      <div
        data-vex-area="vex-token-sparkline"
        data-empty="true"
        aria-hidden
        className="mt-2 h-8 w-full"
      />
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const stepX = (W - PAD * 2) / (points.length - 1);
  const y = (v: number): number => PAD + (H - PAD * 2) * (1 - (v - min) / span);

  const d = points
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"}${(PAD + i * stepX).toFixed(2)} ${y(v).toFixed(2)}`,
    )
    .join(" ");

  return (
    <svg
      data-vex-area="vex-token-sparkline"
      data-empty="false"
      aria-hidden
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="mt-2 h-8 w-full"
    >
      <path
        d={d}
        fill="none"
        stroke="var(--vex-accent)"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
