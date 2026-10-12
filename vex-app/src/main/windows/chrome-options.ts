/**
 * Window chrome per OS (SPEC section 8). Pure: no Electron import, so the
 * title bar contract is unit-testable and the overlay IPC handler can share
 * the colour table without loading the window factory.
 *
 * `titleBarStyle: "hidden"` everywhere; the renderer's 44px head rows are the
 * drag region. macOS keeps the traffic lights, placed on the print. Windows
 * and Linux draw the native window controls as an overlay over the top 44px.
 */

import type { TitleBarTheme } from "@shared/schemas/system.js";

/** Height of every renderer head row and of the native overlay. */
export const TITLE_BAR_HEIGHT = 44;

/** macOS traffic light inset (SPEC section 8). */
export const TRAFFIC_LIGHT_POSITION = { x: 20, y: 16 } as const;

/**
 * Overlay colours. Constants here because tokens.css is renderer-only.
 * color = the page paper (`--paper` light, `--night` dark), symbolColor = the
 * ink on it (`--ink` light, `--type` dark). Keep in step with SPEC section 1.
 */
export const TITLE_BAR_OVERLAY_COLORS: Readonly<
  Record<TitleBarTheme, { readonly color: string; readonly symbolColor: string }>
> = {
  celeris: { color: "#F3F4F7", symbolColor: "#0A0D18" },
  chronos: { color: "#1B1412", symbolColor: "#F3F4F7" },
};

export interface TitleBarOverlay {
  readonly color: string;
  readonly symbolColor: string;
  readonly height: number;
}

export function titleBarOverlayFor(theme: TitleBarTheme): TitleBarOverlay {
  return { ...TITLE_BAR_OVERLAY_COLORS[theme], height: TITLE_BAR_HEIGHT };
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
