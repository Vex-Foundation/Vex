/* Pre-paint theme boot: stamps data-vex-theme on <html> BEFORE the bundle
 * loads so first paint carries the right alias values (no theme flash).
 * MUST stay a separate classic-script file - the CSP is script-src 'self'
 * with no inline scripts. Mirrors stores/uiStore/theme.ts (same storage key,
 * same resolve rules, same coercion posture); keep the two in sync. The
 * read-only localStorage access here is sanctioned by name in
 * scripts/check-build-artifacts.mjs. */
(function () {
  var theme = "chronos";
  try {
    var raw = window.localStorage.getItem("vex-ui");
    if (raw !== null) {
      var preference = JSON.parse(raw).state.themePreference;
      if (preference === "celeris") {
        theme = "celeris";
      } else if (preference === "system") {
        theme = window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "chronos"
          : "celeris";
      }
    }
  } catch (error) {
    /* Tampered/absent payload degrades to chronos - same as the store. */
  }
  document.documentElement.dataset.vexTheme = theme;
  document.documentElement.style.colorScheme =
    theme === "celeris" ? "light" : "dark";
})();
