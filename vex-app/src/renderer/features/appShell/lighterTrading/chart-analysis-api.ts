import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";

/** Operations used by the drawing overlay; the native chart satisfies this interface. */
export interface DrawingTimeScale {
  timeToCoordinate(time: Time): number | null;
  coordinateToLogical(coordinate: number): number | null;
  logicalToCoordinate(logical: number): number | null;
  subscribeVisibleLogicalRangeChange(handler: () => void): void;
  unsubscribeVisibleLogicalRangeChange(handler: () => void): void;
}
export interface DrawingChartApi {
  timeScale(): DrawingTimeScale;
  subscribeCrosshairMove(handler: () => void): void;
  unsubscribeCrosshairMove(handler: () => void): void;
  paneSize(index?: number): { width: number; height: number };
}
export interface DrawingSeriesApi {
  coordinateToPrice(coordinate: number): number | null;
  priceToCoordinate(price: number): number | null;
}
export interface StudySeriesApi {
  setData(data: Parameters<ISeriesApi<"Line">["setData"]>[0]): void;
  createPriceLine(options: Parameters<ISeriesApi<"Line">["createPriceLine"]>[0]): void;
}
export interface StudyChartApi extends DrawingChartApi {
  timeScale(): DrawingTimeScale & {
    getVisibleLogicalRange(): { from: number; to: number } | null;
    setVisibleLogicalRange(range: { from: number; to: number }): void;
  };
  takeScreenshot(): Pick<HTMLCanvasElement, "toBlob">;
  addSeries(...args: Parameters<IChartApi["addSeries"]>): StudySeriesApi;
  removeSeries(series: StudySeriesApi): void;
  panes(): { setStretchFactor(value: number): void }[];
}
