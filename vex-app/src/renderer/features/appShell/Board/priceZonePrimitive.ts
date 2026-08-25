/**
 * PRICE ZONE PRIMITIVE - a horizontal band drawn behind the candles for a
 * `zone` annotation.
 *
 * Every member of `ISeriesPrimitiveBase` is optional, so a band needs exactly
 * `paneViews()` plus `attached`/`detached` to own its lifetime. Two contracts
 * from the library's own JSDoc drive the shape of this file:
 *
 * 1. "the lightweight library uses internal caches based on references to
 *    arrays. So, this method must return new array if set of views has
 *    changed and should try to return the same array if nothing changed."
 *    -> the view array lives in a readonly field and the SAME reference is
 *    returned every call. A fresh `[...]` per call would invalidate the cache
 *    on every frame, which is a real flicker source.
 * 2. `requestUpdate` from `attached()` is the only sanctioned way for a
 *    primitive to ask for a repaint. It is captured on attach and nulled on
 *    detach, so a band that outlives its chart cannot poke a destroyed one.
 *
 * The zone's own prices arrive as already-converted display numbers: the
 * decimal-string boundary is `boardChartFeed.toChartBar` and its sibling
 * conversion in `BoardChart`, and this file does no parsing of its own.
 *
 * The band deliberately does NOT implement `autoscaleInfo()`. A zone is the
 * agent's analytical annotation, and expanding the price axis to contain a
 * far-off level would compress the actual price action the user came to
 * read. A zone outside the visible range is simply not drawn, and its label
 * and prices are still listed in the React annotation legend below the chart,
 * so nothing is hidden by the choice.
 */

import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";

/** One band: a price interval and the fill it paints. */
export interface PriceZoneBand {
  /** Lower price bound, as a display number. */
  readonly from: number;
  /** Upper price bound, as a display number. */
  readonly to: number;
  readonly fill: string;
}

type CandleSeries = ISeriesApi<"Candlestick", Time>;

export class PriceZonePrimitive implements ISeriesPrimitive<Time> {
  private series: CandleSeries | null = null;
  private requestUpdate: (() => void) | null = null;
  private bands: readonly PriceZoneBand[] = [];

  /** Stable identity: the library caches pane views on this reference. */
  private readonly views: readonly IPrimitivePaneView[] = [
    {
      // Behind the candles, above the background.
      zOrder: (): "bottom" => "bottom",
      renderer: (): IPrimitivePaneRenderer | null => this.buildRenderer(),
    },
  ];

  attached(param: SeriesAttachedParameter<Time, "Candlestick">): void {
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /** Replace the bands and ask for exactly one repaint. */
  setBands(bands: readonly PriceZoneBand[]): void {
    this.bands = bands;
    this.requestUpdate?.();
  }

  private buildRenderer(): IPrimitivePaneRenderer | null {
    const series = this.series;
    if (series === null || this.bands.length === 0) return null;

    // Coordinates are resolved at RENDER time, not at setBands time: the
    // price scale moves under scroll and zoom, so a cached y would smear.
    const rects: { readonly top: number; readonly height: number; readonly fill: string }[] =
      [];
    for (const band of this.bands) {
      const yTo = series.priceToCoordinate(band.to);
      const yFrom = series.priceToCoordinate(band.from);
      if (yTo === null || yFrom === null) continue;
      const top = Math.min(yTo, yFrom);
      const height = Math.abs(yFrom - yTo);
      rects.push({ top, height, fill: band.fill });
    }
    if (rects.length === 0) return null;

    return {
      draw: (target): void => {
        target.useBitmapCoordinateSpace((scope) => {
          const { context, bitmapSize, verticalPixelRatio } = scope;
          for (const rect of rects) {
            context.fillStyle = rect.fill;
            context.fillRect(
              0,
              Math.round(rect.top * verticalPixelRatio),
              bitmapSize.width,
              // A zero-height band still deserves a visible hairline rather
              // than vanishing, so the height floors at one device pixel.
              Math.max(1, Math.round(rect.height * verticalPixelRatio)),
            );
          }
        });
      },
    };
  }
}
