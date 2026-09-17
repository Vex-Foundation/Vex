import { DEFAULT_STUDY_PERIODS, STUDIES, STUDY_PERIOD_MAX, STUDY_PERIOD_MIN, type Study, type StudyPeriods } from "./chart-indicators.js";
export interface ChartPreferences {
  studies: Study[];
  volume: boolean;
  /** Fill arrows on the bars the account traded. */
  fills: boolean;
  chartType: "candles" | "line";
  scale: "linear" | "log";
  periods: StudyPeriods;
}
export const DEFAULT_CHART_PREFERENCES: ChartPreferences = {
  studies: [],
  volume: true,
  fills: true,
  chartType: "candles",
  scale: "linear",
  periods: DEFAULT_STUDY_PERIODS
};
function parsePeriods(value: unknown): StudyPeriods | null {
  if (value === undefined)
    return { ...DEFAULT_STUDY_PERIODS };
  if (typeof value !== "object" || value === null)
    return null;
  const periods = { ...DEFAULT_STUDY_PERIODS };
  for (const key of Object.keys(periods) as (keyof StudyPeriods)[]) {
    const period: unknown = key in value ? (value as Record<string, unknown>)[key] : undefined;
    if (!Number.isInteger(period) || (period as number) < STUDY_PERIOD_MIN || (period as number) > STUDY_PERIOD_MAX)
      return null;
    periods[key] = period as number;
  }
  return periods;
}
export function parseChartPreferences(raw: string | null): ChartPreferences {
  const defaults = (): ChartPreferences => ({ ...DEFAULT_CHART_PREFERENCES, studies: [], periods: { ...DEFAULT_STUDY_PERIODS } });
  if (!raw || raw.length > 1024)
    return defaults();
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("studies" in value) || !Array.isArray(value.studies) || value.studies.length > STUDIES.length || !("volume" in value) || typeof value.volume !== "boolean" || !("chartType" in value) || (value.chartType !== "candles" && value.chartType !== "line"))
      return defaults();
    if (!value.studies.every(id => STUDIES.some(study => study.id === id)))
      return defaults();
    // Settings added after the first release are optional so saved charts keep loading.
    const scale = "scale" in value ? value.scale : "linear";
    if (scale !== "linear" && scale !== "log")
      return defaults();
    const fills = "fills" in value ? value.fills : true;
    if (typeof fills !== "boolean")
      return defaults();
    const periods = parsePeriods("periods" in value ? value.periods : undefined);
    if (periods === null)
      return defaults();
    return {
      studies: [...new Set(value.studies)] as Study[],
      volume: value.volume,
      fills,
      chartType: value.chartType,
      scale,
      periods
    };
  } catch {
    return defaults();
  }
}
