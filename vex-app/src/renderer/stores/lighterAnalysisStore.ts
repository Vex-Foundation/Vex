import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { parseDrawings, type Drawing } from "../features/appShell/lighterTrading/chart-drawings.js";
import { parseChartPreferences, type ChartPreferences } from "../features/appShell/lighterTrading/chart-preferences.js";

export const LIGHTER_ANALYSIS_STORAGE_KEY = "vex-lighter-analysis";
export const MAX_SAVED_CHARTS = 64;
export const MAX_MARKET_FAVORITES = 1_000;

interface SavedChart {
  preferences: ChartPreferences;
  drawings: Drawing[];
}
export interface PersistedLighterAnalysis {
  charts: Record<string, SavedChart>;
  favorites: string[];
}
interface LighterAnalysisState extends PersistedLighterAnalysis {
  savePreferences: (scope: string, preferences: ChartPreferences) => boolean;
  saveDrawings: (scope: string, drawings: Drawing[]) => boolean;
  saveFavorites: (favorites: string[]) => boolean;
}

const validScope = (value: string): boolean => /^(?:core|rhc|unknown):[A-Za-z0-9._:/-]{1,48}$/.test(value);
const validFavorite = (value: unknown): value is string => typeof value === "string"
  && /^(?:core|rhc):(?:perp|spot):\d{1,5}:\d{1,5}:\d{1,5}:[A-Za-z0-9._:/-]{1,48}$/.test(value);
const emptyChart = (): SavedChart => ({ preferences: parseChartPreferences(null), drawings: [] });

/** Only cosmetic chart annotations, display settings and market favorites persist. */
export function partializeLighterAnalysis(state: LighterAnalysisState): PersistedLighterAnalysis {
  return { charts: state.charts, favorites: state.favorites };
}

/** Validate every persisted field before merging; stored methods never become authority. */
export function coerceLighterAnalysis(value: unknown): PersistedLighterAnalysis {
  const result: PersistedLighterAnalysis = { charts: {}, favorites: [] };
  if (typeof value !== "object" || value === null) return result;
  if ("favorites" in value && Array.isArray(value.favorites) && value.favorites.length <= MAX_MARKET_FAVORITES) {
    result.favorites = [...new Set(value.favorites.filter(validFavorite))];
  }
  if (!("charts" in value) || typeof value.charts !== "object" || value.charts === null || Array.isArray(value.charts)) return result;
  const entries = Object.entries(value.charts);
  if (entries.length > MAX_SAVED_CHARTS) return result;
  for (const [scope, chart] of entries) {
    if (!validScope(scope) || typeof chart !== "object" || chart === null) continue;
    result.charts[scope] = {
      preferences: parseChartPreferences("preferences" in chart ? (JSON.stringify(chart.preferences) ?? null) : null),
      drawings: parseDrawings("drawings" in chart ? (JSON.stringify(chart.drawings) ?? null) : null),
    };
  }
  return result;
}

function updateChart(charts: Record<string, SavedChart>, scope: string, patch: Partial<SavedChart>): Record<string, SavedChart> {
  const next = { ...charts };
  delete next[scope];
  next[scope] = { ...(charts[scope] ?? emptyChart()), ...patch };
  // Most recently edited markets survive the bounded preference history.
  return Object.fromEntries(Object.entries(next).slice(-MAX_SAVED_CHARTS));
}

export function createLighterAnalysisStore(storageProvider: () => StateStorage = () => localStorage) {
  const storage = createJSONStorage<PersistedLighterAnalysis>(storageProvider);
  return create<LighterAnalysisState>()(
    persist<LighterAnalysisState, [], [], PersistedLighterAnalysis>(
      (set) => ({
        charts: {},
        favorites: [],
        savePreferences: (scope, preferences) => {
          if (!validScope(scope)) return false;
          try {
            const validated = parseChartPreferences(JSON.stringify(preferences));
            set(state => ({ charts: updateChart(state.charts, scope, { preferences: validated }) }));
            return storage !== undefined;
          } catch { return false; }
        },
        saveDrawings: (scope, drawings) => {
          if (!validScope(scope)) return false;
          try {
            const validated = parseDrawings(JSON.stringify(drawings));
            set(state => ({ charts: updateChart(state.charts, scope, { drawings: validated }) }));
            return storage !== undefined;
          } catch { return false; }
        },
        saveFavorites: (favorites) => {
          try {
            set({ favorites: [...new Set(favorites.filter(validFavorite))].slice(0, MAX_MARKET_FAVORITES) });
            return storage !== undefined;
          } catch { return false; }
        },
      }),
      {
        name: LIGHTER_ANALYSIS_STORAGE_KEY,
        version: 1,
        storage,
        partialize: partializeLighterAnalysis,
        migrate: (persisted) => coerceLighterAnalysis(persisted),
        merge: (persisted, current) => ({ ...current, ...coerceLighterAnalysis(persisted) }),
      },
    ),
  );
}

export const useLighterAnalysisStore = createLighterAnalysisStore();
