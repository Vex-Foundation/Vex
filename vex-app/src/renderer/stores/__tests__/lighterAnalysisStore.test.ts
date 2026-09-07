import { requireValue } from "../../../../../src/__tests__/helpers/require-value.js";
import { describe, expect, it, vi } from "vitest";
import { coerceLighterAnalysis, createLighterAnalysisStore, LIGHTER_ANALYSIS_STORAGE_KEY, MAX_SAVED_CHARTS } from "../lighterAnalysisStore.js";
import type { Drawing } from "../../features/appShell/lighterTrading/chart-drawings.js";
const preferences = { studies: ["ema" as const], volume: false, chartType: "line" as const };
const drawing: Drawing = { id: "line-1", kind: "horizontal", a: { time: 100, price: 200 }, b: { time: 100, price: 200 } };
function memoryStorage(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [[LIGHTER_ANALYSIS_STORAGE_KEY, initial]]);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { values.set(key, value); }), removeItem: (key: string) => { values.delete(key); }, values };
}
describe("Lighter renderer preference persistence", () => {
  it("persists only the explicit cosmetic whitelist and restores deployment-specific charts", () => {
    const storage = memoryStorage();
    const store = createLighterAnalysisStore(() => storage);
    store.getState().savePreferences("rhc:7", preferences);
    store.getState().saveDrawings("rhc:7", [drawing]);
    store.getState().savePreferences("core:7", { studies: [], volume: true, chartType: "candles" });
    store.getState().saveFavorites(["rhc:perp:7:1:2:ETH", "core:spot:7:1:2:ETH"]);
    const raw = JSON.parse(requireValue(storage.values.get(LIGHTER_ANALYSIS_STORAGE_KEY)));
    expect(Object.keys(raw.state).sort()).toEqual(["charts", "favorites"]);
    expect(Object.keys(raw.state.charts["rhc:7"]).sort()).toEqual(["drawings", "preferences"]);
    const restored = createLighterAnalysisStore(() => storage);
    expect(restored.getState().charts["rhc:7"]).toEqual({ preferences, drawings: [drawing] });
    expect(requireValue(restored.getState().charts["core:7"]).preferences.chartType).toBe("candles");
    expect(typeof restored.getState().saveDrawings).toBe("function");
  });
  it("rejects injected methods, invalid scopes and malformed nested payloads on every rehydration", async () => {
    const storage = memoryStorage(JSON.stringify({ version: 1, state: {
      savePreferences: "attacker", charts: { "bad:7": { preferences }, "rhc:7": { preferences: { ...preferences, studies: ["unknown"] }, drawings: [{ ...drawing, a: { time: -1, price: 1 } }] } }, favorites: ["rhc:perp:7:1:2:ETH", "bad", "rhc:perp:7:1:2:ETH"], signingAuthority: "never",
    } }));
    const store = createLighterAnalysisStore(() => storage);
    expect(Object.keys(store.getState().charts)).toEqual(["rhc:7"]);
    expect(store.getState().charts["rhc:7"]).toEqual({ preferences: { studies: [], volume: true, chartType: "candles" }, drawings: [] });
    expect(store.getState().favorites).toEqual(["rhc:perp:7:1:2:ETH"]);
    expect(typeof store.getState().savePreferences).toBe("function");
    expect(store.getState()).not.toHaveProperty("signingAuthority");
    storage.values.set(LIGHTER_ANALYSIS_STORAGE_KEY, JSON.stringify({ version: 1, state: { charts: {}, favorites: ["core:spot:1:2:3:BTC"] } }));
    await store.persist.rehydrate();
    expect(store.getState().charts).toEqual({});
    expect(store.getState().favorites).toEqual(["core:spot:1:2:3:BTC"]);
  });
  it("bounds market history, favorites, drawings and indicators", () => {
    const store = createLighterAnalysisStore(() => memoryStorage());
    for (let i = 0; i <= MAX_SAVED_CHARTS; i++) store.getState().savePreferences(`rhc:${i}`, preferences);
    expect(Object.keys(store.getState().charts)).toHaveLength(MAX_SAVED_CHARTS);
    expect(store.getState().charts["rhc:0"]).toBeUndefined();
    expect(store.getState().savePreferences("other:1", preferences)).toBe(false);
    const oversized = { charts: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`rhc:${i}`, { preferences }])), favorites: Array(1001).fill("rhc:perp:7:1:2:ETH") };
    expect(coerceLighterAnalysis(oversized)).toEqual({ charts: {}, favorites: [] });
    expect(coerceLighterAnalysis({ charts: { "rhc:7": { preferences: { ...preferences, studies: Array(7).fill("ema") }, drawings: Array(61).fill(drawing) } } }).charts["rhc:7"]).toEqual({ preferences: { studies: [], volume: true, chartType: "candles" }, drawings: [] });
  });
  it("keeps edits in memory and reports write failure without leaking action methods", () => {
    const storage = memoryStorage("not-json");
    const store = createLighterAnalysisStore(() => storage);
    expect(store.getState().charts).toEqual({});
    storage.setItem.mockImplementation(() => { throw new Error("quota denied"); });
    expect(store.getState().savePreferences("rhc:7", preferences)).toBe(false);
    expect(store.getState().saveDrawings("rhc:7", [drawing])).toBe(false);
    expect(store.getState().saveFavorites(["rhc:perp:7:1:2:ETH"])).toBe(false);
    expect(store.getState().charts["rhc:7"]).toEqual({ preferences, drawings: [drawing] });
    expect(store.getState().favorites).toEqual(["rhc:perp:7:1:2:ETH"]);
  });
  it("validates version migrations with the same read whitelist", () => {
    const store = createLighterAnalysisStore(() => memoryStorage(JSON.stringify({ version: 0, state: { charts: { "rhc:7": { preferences, drawings: [drawing] } }, favorites: [], saveDrawings: "invalid" } })));
    expect(requireValue(store.getState().charts["rhc:7"]).preferences).toEqual(preferences);
    expect(typeof store.getState().saveDrawings).toBe("function");
  });
});
