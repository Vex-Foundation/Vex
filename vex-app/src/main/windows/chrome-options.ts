/**
 * Window chrome per OS (docs/design/R3-MINIMAL.md section 2.2). Pure: no Electron import, so the
 * title bar contract is unit-testable and the overlay IPC handler can share
 * the colour table without loading the window factory.
 *
 * `titleBarStyle: "hidden"` everywhere; the renderer's 44px head rows are the
 * drag region. macOS keeps the traffic lights, placed on the print. Windows
 * and Linux draw the native window controls as an overlay over the top 43px,
 * the head row less its bottom rule.
 */

import type { TitleBarTheme } from "@shared/schemas/system.js";

/** Height of every renderer head row (`--head-h` in window-chrome.css). */
export const TITLE_BAR_HEIGHT = 44;

/** The 1px rule at the foot of every head row. */
export const HEAD_RULE_WIDTH = 1;

/**
 * Height of the native overlay: the head row less its rule. The overlay is an
 * opaque plate in the paper colour, so at the full 44px it painted over the
 * rule and every head's rule stopped where the window controls begin, with
 * blank paper under the buttons. One pixel short, the rule runs on under the
 * controls to the window edge.
 */
export const TITLE_BAR_OVERLAY_HEIGHT = TITLE_BAR_HEIGHT - HEAD_RULE_WIDTH;

/** macOS traffic light inset (docs/design/R3-MINIMAL.md section 2.2). */
export const TRAFFIC_LIGHT_POSITION = { x: 20, y: 16 } as const;

/**
 * Overlay colours. Constants here because tokens.css is renderer-only.
 * color = the ground (`--color-h3-ground`), symbolColor = the ink on it
 * (`--color-h3-ink`), docs/design/H3-DESKTOP.md section 2.1. The app is dark
 * only: the schema still names a second theme for the IPC boundary, and it
 * takes the same dark pair, so nothing can paint a light caption over the
 * dark header. `theme-matrix.test.ts` ties these to the renderer's tokens.
 */
const DARK_OVERLAY = { color: "#010203", symbolColor: "#F3F5F9" } as const;

export const TITLE_BAR_OVERLAY_COLORS: Readonly<
  Record<TitleBarTheme, { readonly color: string; readonly symbolColor: string }>
> = {
  celeris: DARK_OVERLAY,
  chronos: DARK_OVERLAY,
};

export interface TitleBarOverlay {
  readonly color: string;
  readonly symbolColor: string;
  readonly height: number;
}

export function titleBarOverlayFor(theme: TitleBarTheme): TitleBarOverlay {
  return { ...TITLE_BAR_OVERLAY_COLORS[theme], height: TITLE_BAR_OVERLAY_HEIGHT };
}

export type ChromeOptions =
  | {
      readonly titleBarStyle: "hidden";
      readonly trafficLightPosition: { readonly x: number; readonly y: number };
    }
  | {
      readonly titleBarStyle: "hidden";
      readonly titleBarOverlay: TitleBarOverlay;
    }
  | Record<string, never>;

export interface ChromeOptionsFlags {
  /**
   * Keep the native frame. The Linux fallback for desktops where Window
   * Controls Overlay is unavailable (no overlay means no way to close the
   * window under a hidden title bar). Ignored on macOS and Windows.
   */
  readonly nativeFrame?: boolean;
}

export function chromeOptionsFor(
  platform: NodeJS.Platform,
  theme: TitleBarTheme,
  flags: ChromeOptionsFlags = {},
): ChromeOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hidden",
      trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    };
  }
  if (platform === "linux" && flags.nativeFrame === true) return {};
  return { titleBarStyle: "hidden", titleBarOverlay: titleBarOverlayFor(theme) };
}
