/* Pre-paint theme boot: stamps data-vex-theme on <html> BEFORE the bundle
 * loads so first paint carries the right alias values (no theme flash).
 * MUST stay a separate classic-script file - the CSP is script-src 'self'
 * with no inline scripts. Mirrors stores/uiStore/theme.ts; keep the two in
 * sync.
 *
 * H3 is DARK ONLY (2026-11-03): there is one room, so the stamp no longer
 * reads the persisted payload at all. Every stored choice - the retired
 * "celeris" and "system" included - coerces to the same room in the store
 * (coerceThemePreference) and is rewritten there by persistence migration
 * v23, so reading it here could only ever arrive at the answer below. A
 * light OS changes nothing. (scripts/check-build-artifacts.mjs still names
 * this file as the one sanctioned localStorage reader; it reads nothing
 * now.) */
(function () {
  /* VEX_THEME in stores/uiStore/theme.ts - keep in sync. */
  document.documentElement.dataset.vexTheme = "chronos";
  document.documentElement.style.colorScheme = "dark";
})();
