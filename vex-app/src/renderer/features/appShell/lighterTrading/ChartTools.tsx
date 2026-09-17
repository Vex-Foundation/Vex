import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode, type RefObject } from "react";
import { LineSeries, HistogramSeries } from "lightweight-charts";
import type { DrawingSeriesApi, StudyChartApi, StudySeriesApi } from "./chart-analysis-api.js";
import { toChartCandles, toChartVolume, type ChartCandleRow } from "./chart-adapter.js";
import {
  computeStudies,
  isPeriodStudy,
  STUDIES,
  STUDY_BY_ID,
  STUDY_PERIOD_MAX,
  STUDY_PERIOD_MIN,
  type PeriodStudy,
  type Study,
} from "./chart-indicators.js";
import { parseChartPreferences } from "./chart-preferences.js";
import { useLighterAnalysisStore } from "../../../stores/lighterAnalysisStore.js";
import { ChartDrawings } from "./ChartDrawings.js";
export interface ChartToolsProps {
  chart: StudyChartApi | null;
  series: DrawingSeriesApi | null;
  host: RefObject<HTMLDivElement | null>;
  rows: readonly ChartCandleRow[];
  scope: string;
  theme: string;
  precision: number;
  minMove?: number;
  onChartType: (type: "candles" | "line") => void;
  onVolume: (visible: boolean) => void;
  onFills: (visible: boolean) => void;
  onScale: (scale: "linear" | "log") => void;
  /** Desk controls that share this one toolbar row: intervals first, expand last. */
  leading?: ReactNode;
  trailing?: ReactNode;
}
export function ChartTools({
  chart,
  series,
  host,
  rows,
  scope,
  theme,
  precision,
  minMove,
  onChartType,
  onVolume,
  onFills,
  onScale,
  leading,
  trailing,
}: ChartToolsProps): JSX.Element {
  const [preferences, setPreferences] = useState(() => useLighterAnalysisStore.getState().charts[scope]?.preferences ?? parseChartPreferences(null));
  const { studies, volume: showVolume, fills: showFills, chartType, scale, periods } = preferences;
  const studyLabel = (id: Study): string => STUDY_BY_ID[id].label(periods);

  const setPeriod = (id: PeriodStudy, raw: string): void => {
    const period = Number(raw);
    if (!Number.isInteger(period) || period < STUDY_PERIOD_MIN || period > STUDY_PERIOD_MAX)
      return;
    setPreferences((current) => ({ ...current, periods: { ...current.periods, [id]: period } }));
  };

  const [notice, setNotice] = useState<string | null>(null);
  const toggleStudy = (id: Study): void => {
    setPreferences((current) => ({
      ...current,
      studies: current.studies.includes(id)
        ? current.studies.filter((study) => study !== id)
        : [...current.studies, id],
    }));
  };

  useEffect(() => {
    onChartType(chartType);
  }, [chartType, onChartType]);

  useEffect(() => {
    if (!useLighterAnalysisStore.getState().savePreferences(scope, preferences)) {
      setNotice("Chart settings cannot be saved on this device.");
    }
  }, [preferences, scope]);

  const saveImage = (): void => {
    if (!chart)
      return;
    try {
      chart.takeScreenshot().toBlob((blob) => {
        if (!blob) {
          setNotice("Chart image could not be created. Try again.");
          return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${scope.replace(/[^a-z0-9-]/gi, "-")}-chart.png`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice("Chart image download started. Drawings are not included.");
      }, "image/png");
    } catch {
      setNotice("Chart image could not be saved. Try again.");
    }
  };

  const studySeries = useRef<{
    id: Study;
    lines: StudySeriesApi[];
  }[]>([]);
  const candles = useMemo(() => toChartCandles(rows), [rows]);
  const computed = useMemo(
    () => computeStudies(candles, new Map(toChartVolume(rows, "", "").map((p) => [Number(p.time), p.value])), periods),
    [candles, rows, periods],
  );
  const computedRef = useRef(computed);
  computedRef.current = computed;

  useLayoutEffect(() => {
    if (!chart)
      return;
    const range = chart.timeScale().getVisibleLogicalRange();
    const colors = host.current ? getComputedStyle(host.current) : null;
    const positive = colors?.getPropertyValue("--lit-positive").trim() || "#4dc9b0";
    const secondary = colors?.getPropertyValue("--lit-ink-secondary").trim() || "#aeb4b8";
    const negative = colors?.getPropertyValue("--lit-negative").trim() || "#ee7a83";
    let pane = 1;
    studySeries.current = studies.map((id) => {
      const paneIndex = id === "rsi" || id === "macd" ? pane++ : 0;
      const lines = computedRef.current[id].map((data, i) => {
        const colorRole = id === "macd" && i === 1 ? "signal" : id;
        const studyColor = colors?.getPropertyValue(`--lit-study-${colorRole}`).trim();
        const line = id === "macd" && i === 2
          ? chart.addSeries(HistogramSeries, {
            title: "MACD Δ",
            priceLineVisible: false,
            lastValueVisible: false
          }, paneIndex)
          : chart.addSeries(LineSeries, {
            // Overlays on the price pane carry no title: the chart draws it
            // beside the price label, where it crowds the last price. The
            // toolbar readout names them instead; pane studies keep theirs.
            title: paneIndex === 0 ? "" : id === "macd" ? i === 0 ? "MACD" : "Signal" : studyLabel(id),
            color: studyColor || (i === 1 ? secondary : i === 2 ? negative : positive),
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false
          }, paneIndex);
        line.setData(data.map((p) => ({ ...p, ...(id === "macd" && i === 2 ? { color: p.value >= 0 ? positive : negative } : {}) })));
        if (id === "rsi") {
          line.createPriceLine({
            price: 70,
            color: secondary,
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: ""
          });
          line.createPriceLine({
            price: 30,
            color: secondary,
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: ""
          });
        }
        return line;
      });
      if (paneIndex > 0) {
        chart.panes()[paneIndex]?.setStretchFactor(1);
      }
      return { id, lines };
    });
    if (studies.length > 0) {
      chart.panes()[0]?.setStretchFactor(3);
      if (range !== null)
        chart.timeScale().setVisibleLogicalRange(range);
    }
    return () => {
      for (const study of studySeries.current) {
        for (const line of study.lines) {
          chart.removeSeries(line);
        }
      }
      studySeries.current = [];
    };
  }, [chart, studies, periods, theme, host]);

  useEffect(() => {
    if (!chart || studySeries.current.length === 0)
      return;
    const range = chart.timeScale().getVisibleLogicalRange();
    const colors = host.current ? getComputedStyle(host.current) : null;
    for (const study of studySeries.current)
      study.lines.forEach((line, i) => line.setData(
        (computed[study.id][i] ?? []).map((p) => ({
          ...p,
          ...(study.id === "macd" && i === 2
            ? { color: colors?.getPropertyValue(p.value >= 0 ? "--lit-positive" : "--lit-negative").trim() || "#aeb4b8" }
            : {}),
        })),
      ));
    if (range)
      chart.timeScale().setVisibleLogicalRange(range);
  }, [chart, computed, host]);

  useEffect(() => {
    onVolume(showVolume);
  }, [showVolume, onVolume, chart]);

  useEffect(() => {
    onFills(showFills);
  }, [showFills, onFills, chart]);

  useEffect(() => {
    onScale(scale);
  }, [scale, onScale, chart]);

  return <>
    <div
      className="lit-analysis-toolbar"
      role="toolbar"
      aria-label="Chart analysis"
    >
      {leading}
      <select
        aria-label="Chart type"
        value={chartType}
        onChange={(event) => setPreferences((current) => ({ ...current, chartType: event.target.value as "candles" | "line" }))}
      >
        <option value="candles">Candles</option>
        <option value="line">Line</option>
      </select>
      <details className="lit-study-menu" onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
          event.stopPropagation();
        }
      }}>
        <summary>Indicators{studies.length ? ` · ${studies.length}` : ""}</summary>
        <div className="lit-study-popover">
          {STUDIES.map((study) => <div className="lit-study-row" key={study.id}>
            <label>
              <input
                type="checkbox"
                checked={studies.includes(study.id)}
                onChange={() => toggleStudy(study.id)}
              />
              <span>
                {study.label(periods)}
                <small>
                  {study.description(periods)}
                </small>
              </span>
            </label>
            {isPeriodStudy(study.id) ? <input
              className="lit-study-period"
              type="number"
              aria-label={`${study.label(periods)} period`}
              min={STUDY_PERIOD_MIN}
              max={STUDY_PERIOD_MAX}
              step={1}
              defaultValue={periods[study.id]}
              onChange={(event) => setPeriod(study.id as PeriodStudy, event.target.value)}
              onBlur={(event) => { event.target.value = String(preferences.periods[study.id as PeriodStudy]); }}
            /> : null}
          </div>)}
          <p>Calculated from the loaded bars; scroll left to load older history. Early values require a full warm-up period. VWAP begins at the first loaded bar if the session starts outside this window.</p>
        </div>
      </details>
      <button
        type="button"
        aria-pressed={showVolume}
        onClick={() => setPreferences((current) => ({ ...current, volume: !current.volume }))}
      >Volume</button>
      <button
        type="button"
        aria-pressed={showFills}
        title="Mark the account's fills on the chart"
        onClick={() => setPreferences((current) => ({ ...current, fills: !current.fills }))}
      >Fills</button>
      <button
        type="button"
        aria-pressed={scale === "log"}
        title="Logarithmic price scale"
        onClick={() => setPreferences((current) => ({ ...current, scale: current.scale === "log" ? "linear" : "log" }))}
      >Log</button>
      <span className="lit-study-active" aria-label="Active indicators">
        {studies.map(studyLabel).join(" · ")}
      </span>
      <button
        className="lit-chart-export"
        type="button"
        aria-label="Save chart image without drawings"
        title="Save chart image · drawings excluded"
        disabled={!chart || candles.length === 0}
        onClick={saveImage}
      >
        <svg
          viewBox="0 0 20 20"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M3 6h3l1-2h6l1 2h3v10H3Z" />
          <circle
            cx="10"
            cy="11"
            r="3"
          />
        </svg>
      </button>
      {trailing}
    </div>
    {notice ? <div className="lit-chart-tool-notice" role="status">
      {notice}
      <button
        type="button"
        aria-label="Dismiss chart notice"
        onClick={() => setNotice(null)}
      >Dismiss</button>
    </div> : null}
    {chart && series ? <ChartDrawings
      key={scope}
      chart={chart}
      series={series}
      host={host}
      times={candles.map((c) => Number(c.time))}
      scope={scope}
      precision={precision}
      minMove={minMove}
    /> : null}
  </>;
}
