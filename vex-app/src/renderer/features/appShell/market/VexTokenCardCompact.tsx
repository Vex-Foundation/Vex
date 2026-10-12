/**
 * $VEX ON THE GROUND (docs/design/V10-SPREAD.md section 3): the live $VEX
 * signal sits on the dark ground of the left page's print, under the flock and
 * over the profile row. One line in Departure Mono, white on the photograph:
 * the `$VEX` label, the price at 15px, and the 24h change at the right with
 * its direction as an arrow (status is never a colour), then a 26px spark of
 * the trailing hourly closes ending in a 4px square.
 *
 * No plate and no box: the print is the ground. The one link is the whole
 * data line, out to the $VEX DexScreener pair, opened in the system browser
 * through main's external-URL allowlist. Stale data keeps its own honest
 * marker beside the label. Every state resolves to something visible, so the
 * ground is never blank: the label with a placeholder bar while loading, the
 * label with a line while the read fails, or the data.
 */

import type { JSX } from "react";
import type { VexMarketSnapshot } from "@shared/schemas/market.js";
import { useVexMarket } from "../../../lib/api/market.js";
import {
  formatPercentDelta,
  formatTokenPriceUsd,
} from "../../../lib/format.js";

// The $VEX DexScreener pair: a renderer-local literal by design. The
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

  // Bridge/handler error: a line, never a blank ground.
  if ((result !== undefined && !result.ok) || query.isError) {
    return (
      <section
        data-vex-area="vex-token-compact"
        data-state="error"
        aria-label="VEX market data unavailable"
        className="vex-tok"
      >
        <span className="vex-tok__k">$VEX</span>
        <span className="vex-tok__note">Market data unavailable.</span>
      </section>
    );
  }

  // First read (isLoading) OR polled-but-not-yet (`ok(null)`): the label and
  // a placeholder bar where the price will be.
  if (snapshot === null) {
    return (
      <section
        data-vex-area="vex-token-compact"
        data-state="loading"
        aria-label="Loading VEX price"
        className="vex-tok"
      >
        <span className="vex-tok__k">$VEX</span>
        <span aria-hidden className="vex-tok__wait" />
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
       * is already listed) through shell.openExternal. Only the data line
       * links out; the loading and error states stay inert. */}
      <a
        href={DEXSCREENER_VEX_PAIR_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open $VEX on DexScreener"
        className="vex-tok vex-tok--link"
      >
        <span className="vex-tok__k">
          $VEX
          {snapshot.stale ? <StaleMarker /> : null}
        </span>
        <span className="vex-tok__p">{priceLabel}</span>
        <DeltaFigure change={snapshot.priceChange.h24} label={deltaLabel} />
        <Sparkline closes={closes} />
      </a>
    </section>
  );
}

function StaleMarker(): JSX.Element {
  return (
    <span
      data-vex-area="vex-token-stale"
      className="vex-tok__stale"
      title="Live feed delayed - showing the last known price."
    >
      delayed
    </span>
  );
}

/**
 * The 24h change: the figure with its direction as an arrow (up, down, or
 * none when flat or unknown). One ink, the ground's white: a rise and a fall
 * are told apart by the arrow and the sign, never by a colour.
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
      data-direction={up ? "up" : down ? "down" : "flat"}
      className="vex-tok__c"
    >
      {up || down ? <span aria-hidden>{up ? "↑ " : "↓ "}</span> : null}
      {label}
    </span>
  );
}

/** The spark's drawing box; the line stretches to the ground's width. */
const SPARK_W = 264;
const SPARK_H = 26;
const SPARK_PAD = 2;

/**
 * The trailing hourly closes as one 1.25px polyline across the ground's full
 * width, ending in a 4px square on the last close (non-scaling strokes keep
 * both crisp while the x axis stretches). Fewer than two finite points: a
 * blank reserved track, so the ground keeps its rhythm.
 */
function Sparkline({
  closes,
}: {
  readonly closes: readonly number[];
}): JSX.Element {
  const points = closes.filter((v) => Number.isFinite(v));

  if (points.length < 2) {
    return (
      <span
        data-vex-area="vex-token-sparkline"
        data-empty="true"
        aria-hidden
        className="vex-tok__spark"
      />
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const stepX = (SPARK_W - SPARK_PAD * 2) / (points.length - 1);
  const xy = points.map(
    (v, i) =>
      [
        SPARK_PAD + i * stepX,
        SPARK_PAD + (SPARK_H - SPARK_PAD * 2) * (1 - (v - min) / span),
      ] as const,
  );
  const line = xy.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const last = xy[xy.length - 1] ?? [SPARK_W - SPARK_PAD, SPARK_H / 2];

  return (
    <svg
      data-vex-area="vex-token-sparkline"
      data-empty="false"
      aria-hidden
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      className="vex-tok__spark"
    >
      <polyline
        points={line}
        fill="none"
        stroke="var(--vex-alias-on-photo)"
        strokeWidth={1.25}
        strokeLinejoin="miter"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={`M${last[0].toFixed(2)} ${last[1].toFixed(2)}h0`}
        stroke="var(--vex-alias-on-photo)"
        strokeWidth={4}
        strokeLinecap="square"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
