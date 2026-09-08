import { STUDIES, type Study } from "./chart-indicators.js";
export interface ChartPreferences {
  studies: Study[];
  volume: boolean;
  chartType: "candles" | "line";
}
export const DEFAULT_CHART_PREFERENCES: ChartPreferences = {
  studies: [],
  volume: true,
  chartType: "candles"
};
export function parseChartPreferences(raw: string | null): ChartPreferences {
  const defaults = (): ChartPreferences => ({ ...DEFAULT_CHART_PREFERENCES, studies: [] });
  if (!raw || raw.length > 1024)
    return defaults();
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("studies" in value) || !Array.isArray(value.studies) || value.studies.length > STUDIES.length || !("volume" in value) || typeof value.volume !== "boolean" || !("chartType" in value) || (value.chartType !== "candles" && value.chartType !== "line"))
      return defaults();
    if (!value.studies.every(id => STUDIES.some(study => study.id === id)))
      return defaults();
    return {
      studies: [...new Set(value.studies)] as Study[],
      volume: value.volume,
      chartType: value.chartType
    };
  } catch {
    return defaults();
  }
}
