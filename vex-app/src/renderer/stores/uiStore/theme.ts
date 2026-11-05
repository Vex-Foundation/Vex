/**
 * Theme runtime for the uiStore. H3 is DARK ONLY (the H3 revamp plan,
 * decision 6, 2026-11-03): every H3 mockup is dark, so Celeris (the light
 * room) and the "system" choice retired together, and the app has one room.
 *
 * What is left is small on purpose:
 *   - the one room's name, `chronos`, which stays the `data-vex-theme` value
 *     so every reader keyed on it (the alias tier on :root, the Lighter
 *     desk's `data-lighter-theme` scopes) keeps working
 *     unchanged;
 *   - the coercion for the persisted `themePreference` slot, kept so an old
 *     payload still has somewhere to land: ANY stored value, the retired
 *     `celeris` and `system` included, coerces to the one room (persistence
 *     migration v23 rewrites the stored value too, so an older app reading
 *     the payload after a downgrade also finds dark);
 *   - the documentElement writer the store runs on boot and on rehydrate.
 *
 * `public/theme-boot.js` stamps the same room pre-paint (it runs before the
 * bundle, so it cannot import this module) - keep the two in sync.
 */

/** The one shell room: H3's dark. */
export type VexTheme = "chronos";

/**
 * The persisted slot's type. It can hold only the one room; the slot outlives
 * the choice so a payload written by an older release still coerces cleanly.
 */
export type VexThemePreference = VexTheme;

/** The room every install paints, and the only value the slot can hold. */
export const VEX_THEME: VexTheme = "chronos";

/** Kept under its old name for the store's initial state. */
export const DEFAULT_THEME_PREFERENCE: VexThemePreference = VEX_THEME;

/**
 * Coerce an untrusted (user-writable localStorage) value to the preference
 * slot. Everything - the retired `celeris` and `system`, the older
 * `vex`/`robinhood` pair, garbage, non-strings - lands on the one room. Never
 * throws, and nothing off the union reaches `data-vex-theme`.
 */
export function coerceThemePreference(_value: unknown): VexThemePreference {
  return VEX_THEME;
}

/**
 * Write the room to the document root - the attribute the CSS alias tier and
 * the Lighter scopes read - and `color-scheme: dark` so native chrome
 * (scrollbars, form controls, the caret) is dark too.
 */
export function applyThemeToDocument(theme: VexTheme = VEX_THEME): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset["vexTheme"] = theme;
  document.documentElement.style.colorScheme = "dark";
}
