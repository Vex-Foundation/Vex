/**
 * THE $VEX LINE: the live $VEX signal as one line at the foot of the
 * Portfolio page (docs/design/R3-MINIMAL.md section 9.1: "A '$VEX' line
 * replaces the old price card"). The `$VEX` word (13 / 500), the price in
 * JetBrains Mono, the 24 hour change with its direction as an arrow and its
 * sign, then "24h", and "DexScreener" as the line's one link, out to the $VEX
 * pair in the system browser through main's external-URL allowlist.
 *
 * The 24 hour change is a trading value (a market's change, the same value the
 * Board colours, section 1.2), so it takes trade up or trade down; the arrow
 * and the sign say the same thing for anyone who cannot tell the colours
 * apart. Stale data keeps its own honest marker beside the label. Every state
 * resolves to something visible: the label with "Loading…" while the first
 * read is out, the label with a line while the read fails, or the data.
 *
 * The component keeps its name and its `vex-token-compact` seam: the Studio
 * sidebar still mounts it until that sidebar is rebuilt.
 */

import type { JSX } from "react";
import type { VexMarketSnapshot } from "@shared/schemas/market.js";
import { LineExternal } from "../../../components/icons/line/index.js";
import { useVexMarket } from "../../../lib/api/market.js";
import {
  formatPercentDelta,
  formatTokenPriceUsd,
} from "../../../lib/format.js";
import { NOT_AVAILABLE } from "../book/portfolio/portfolio-format.js";

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

  // Bridge or handler error: a line, never a blank.
  if ((result !== undefined && !result.ok) || query.isError) {
    return (
      <section
        data-vex-area="vex-token-compact"
        data-state="error"
        aria-label="VEX market data unavailable"
        className="vex-pf-vex"
      >
        <span className="vex-pf-vex__k">$VEX</span>
        <span className="vex-pf-vex__note">Market data unavailable.</span>
      </section>
    );
  }

  // First read (isLoading) OR polled-but-not-yet (`ok(null)`): the label and
  // the loading word where the price will be.
  if (snapshot === null) {
    return (
      <section
        data-vex-area="vex-token-compact"
        data-state="loading"
        aria-label="Loading VEX price"
        className="vex-pf-vex"
      >
        <span className="vex-pf-vex__k">$VEX</span>
        <span className="vex-pf-vex__note">Loading…</span>
      </section>
    );
  }

  return <LineBody snapshot={snapshot} />;
}

function LineBody({
  snapshot,
}: {
  readonly snapshot: VexMarketSnapshot;
}): JSX.Element {
  // A figure the feed does not carry says so (the money pages' one word).
  const priceLabel = Number.isFinite(snapshot.priceUsd ?? Number.NaN)
    ? formatTokenPriceUsd(snapshot.priceUsd)
    : NOT_AVAILABLE;
  const h24 = snapshot.priceChange.h24;
  const deltaLabel =
    h24 !== null && Number.isFinite(h24) ? formatPercentDelta(h24) : NOT_AVAILABLE;

  return (
    <section
      data-vex-area="vex-token-compact"
      data-state="data"
      data-stale={snapshot.stale ? "true" : "false"}
      aria-label={`VEX token price ${priceLabel}, 24 hour change ${deltaLabel}${
        snapshot.stale ? ", data delayed" : ""
      }`}
      className="vex-pf-vex"
    >
      <span className="vex-pf-vex__k">$VEX</span>
      <span className="vex-pf-vex__p vex-num">{priceLabel}</span>
      <DeltaFigure change={snapshot.priceChange.h24} label={deltaLabel} />
      <span className="vex-pf-vex__note">24h</span>
      {snapshot.stale ? <StaleMarker /> : null}
      {/* target=_blank never opens a child window: main's
       * setWindowOpenHandler denies and routes allowlisted hosts
       * (dexscreener.com is listed) through shell.openExternal. Only the data
       * line links out; the loading and error states stay inert. */}
      <a
        href={DEXSCREENER_VEX_PAIR_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open $VEX on DexScreener"
        className="vex-pf-vex__link"
      >
        DexScreener
        <LineExternal size={14} />
      </a>
    </section>
  );
}

function StaleMarker(): JSX.Element {
  return (
    <span
      data-vex-area="vex-token-stale"
      className="vex-pf-vex__note"
      title="Live feed delayed - showing the last known price."
    >
      delayed
    </span>
  );
}

/**
 * The 24h change: the figure with its direction as an arrow (up, down, or
 * none when flat or unknown), in the trading colour of its direction.
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
      data-trade={up ? "up" : down ? "down" : undefined}
      className="vex-pf-vex__c vex-num"
    >
      {up || down ? <span aria-hidden>{up ? "↑ " : "↓ "}</span> : null}
      {label}
    </span>
  );
}
