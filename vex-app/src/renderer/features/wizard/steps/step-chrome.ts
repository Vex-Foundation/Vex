/**
 * Shared status chrome for wizard step interiors (docs/design/V10-SPREAD.md
 * section 1: status by fill, never by colour).
 *
 * Warnings and errors are the RISK CALLOUT: a 1.5px ink frame with a
 * hatched left band and ink type (`.vex-callout`, global-css/onboarding.css),
 * never a blue or a status hue and never a filled box. Calm/success states
 * render as plain text (no frame at all). ONE source for the recipe so the
 * ~15 alert sites across the steps cannot drift apart. The callout sets its
 * own type size and ink; callers add only spacing.
 *
 * These strings are world-neutral: the callout reads on the stage's paper
 * leaf AND on the Settings sheet (the Settings screen hosts the same step
 * forms).
 */

export const RAIL_WARNING_CHROME = "vex-callout";

export const RAIL_DANGER_CHROME = "vex-callout";
