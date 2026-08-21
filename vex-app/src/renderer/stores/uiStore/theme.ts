/**
 * Theme runtime for the uiStore: the VexTheme/preference unions, the
 * preference -> resolved-theme function, untrusted-localStorage coercion,
 * and the documentElement writer the store and the system-change listener
 * share. `public/theme-boot.js` duplicates the resolve+write pair pre-paint
 * (it runs before the bundle, so it cannot import this module) - keep the
 * two in sync.
 */

/** Resolved shell theme: chronos = dark ink, celeris = light. */
export type VexTheme = "chronos" | "celeris";

/** Persisted user choice; "system" tracks the OS color scheme live. */
export type VexThemePreference = VexTheme | "system";

/**
 * No explicit choice = follow the OS (ratified 2026-08-21). Persistence
 * migration v13 re-defaults an install still carrying the seeded `chronos`
 * once; a user who deliberately wants chronos re-picks it in Settings.
 */
export const DEFAULT_THEME_PREFERENCE: VexThemePreference = "system";

/**
 * Coerce an untrusted (user-writable localStorage) value to the preference
 * union. Off-union values - including the retired "vex"/"robinhood" pair -
 * degrade to the default, never crash and never reach `data-vex-theme`.
 */
export function coerceThemePreference(value: unknown): VexThemePreference {
  return value === "chronos" || value === "celeris" || value === "system"
    ? value
    : DEFAULT_THEME_PREFERENCE;
}

/** True when the OS reports a dark color scheme (false when unknowable). */
export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Resolved theme = f(preference, system). Pure - tests exercise this. */
export function resolveTheme(
  preference: VexThemePreference,
  prefersDark: boolean,
): VexTheme {
  if (preference === "system") return prefersDark ? "chronos" : "celeris";
  return preference;
}

/**
 * Write the resolved theme to the document root - the single source the CSS
 * alias tier reads (`[data-vex-theme="celeris"]` in tokens.css). Also sets
 * `color-scheme` so native chrome (scrollbars, form controls) follows.
 */
export function applyThemeToDocument(theme: VexTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset["vexTheme"] = theme;
  document.documentElement.style.colorScheme =
    theme === "celeris" ? "light" : "dark";
}

/**
 * Track OS scheme changes so a "system" preference re-resolves live.
 * Returns an unsubscribe (used by tests; the app binds once for its
 * lifetime). No-op where matchMedia is unavailable (jsdom).
 */
export function bindSystemThemeListener(
  onSystemChange: (prefersDark: boolean) => void,
): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = (event: MediaQueryListEvent): void => {
    onSystemChange(event.matches);
  };
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
