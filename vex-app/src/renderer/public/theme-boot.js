/* Pre-paint theme boot: stamps data-vex-theme on <html> BEFORE the bundle
 * loads so first paint carries the right alias values (no theme flash).
 * MUST stay a separate classic-script file - the CSP is script-src 'self'
 * with no inline scripts. Mirrors stores/uiStore/theme.ts (same storage key,
 * same resolve rules, same coercion posture); keep the two in sync. The
 * read-only localStorage access here is sanctioned by name in
 * scripts/check-build-artifacts.mjs. */
(function () {
  /* DEFAULT_THEME_PREFERENCE in stores/uiStore/theme.ts - keep in sync. */
  var preference = "system";
  try {
    var raw = window.localStorage.getItem("vex-ui");
    if (raw !== null) {
      var stored = JSON.parse(raw).state.themePreference;
      /* Same closed-union coercion as coerceThemePreference(): anything off
       * the union degrades to the default, never reaches data-vex-theme. */
      if (stored === "chronos" || stored === "celeris" || stored === "system") {
        preference = stored;
      }
    }
  } catch (error) {
    /* Tampered/absent payload degrades to the default - same as the store. */
  }
  /* Mirrors systemPrefersDark(): an unavailable matchMedia reports DARK, the
   * safe fail for an ink-rooted app. */
  var prefersDark =
    typeof window.matchMedia !== "function"
    || window.matchMedia("(prefers-color-scheme: dark)").matches;
  var theme =
    preference === "system" ? (prefersDark ? "chronos" : "celeris") : preference;
  document.documentElement.dataset.vexTheme = theme;
  document.documentElement.style.colorScheme =
    theme === "celeris" ? "light" : "dark";
})();
