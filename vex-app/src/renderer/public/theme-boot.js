/* Pre-paint document boot: stamps data-vex-theme (and, under Save-Data,
 * data-still) on <html> BEFORE the bundle loads so first paint carries the
 * right alias values and motion rules (no theme flash, no first-frame
 * motion). MUST stay a separate classic-script file - the CSP is script-src
 * 'self' with no inline scripts. Mirrors stores/uiStore/theme.ts and
 * lib/motion/use-still-frame.ts; keep them in sync.
 *
 * H3 is DARK ONLY (2026-11-03): there is one room, so the stamp no longer
 * reads the persisted payload at all. Every stored choice - the retired
 * "celeris" and "system" included - coerces to the same room in the store
 * (coerceThemePreference) and is rewritten there by persistence migration
 * v23, so reading it here could only ever arrive at the answer below. A
 * light OS changes nothing. (scripts/check-build-artifacts.mjs still names
 * this file as the one sanctioned localStorage reader; it reads nothing
 * now.)
 *
 * SAVE-DATA (docs/design/H3-DESKTOP.md section 3.7): `data-still` is present
 * exactly while the connection asks to save data (stampSaveData in
 * use-still-frame.ts), so base.css lands every animation and transition at
 * once, as it does under reduced motion. The preference can change while
 * the window is open, so the stamp follows the connection's change event. */
(function () {
  var root = document.documentElement;
  /* VEX_THEME in stores/uiStore/theme.ts - keep in sync. */
  root.dataset.vexTheme = "chronos";
  root.style.colorScheme = "dark";

  /* stampSaveData in lib/motion/use-still-frame.ts - keep in sync. */
  var connection =
    typeof navigator !== "undefined" && navigator !== null
      ? navigator.connection
      : undefined;
  var stamp = function () {
    if (connection !== undefined && connection !== null && connection.saveData === true) {
      root.setAttribute("data-still", "");
    } else {
      root.removeAttribute("data-still");
    }
  };
  stamp();
  if (
    connection !== undefined
    && connection !== null
    && typeof connection.addEventListener === "function"
  ) {
    connection.addEventListener("change", stamp);
  }
})();
