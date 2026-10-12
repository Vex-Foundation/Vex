/**
 * Window chrome hook: stamps `data-os` / `data-chrome` on <html> for the CSS
 * in styles/global-css/window-chrome.css and, on Windows and Linux, recolours
 * the native overlay whenever the resolved theme changes
 * (vex.system.setTitleBarOverlay). Mounted once at the app root.
 */

import { useEffect } from "react";
import { useUiStore } from "../stores/uiStore.js";
import "../styles/global-css/window-chrome.css";

export type WindowOs = "mac" | "win" | "linux";
export type WindowChrome = "mac" | "overlay" | "native";

/** Sync platform read; UA is enough, the overlay call is a no-op on mac. */
export function detectOs(nav: Pick<Navigator, "userAgent"> = navigator): WindowOs {
  const ua = nav.userAgent;
  if (/Mac/i.test(ua)) return "mac";
  if (/Win/i.test(ua)) return "win";
  return "linux";
}

/** Overlay when Window Controls Overlay is live, native frame otherwise. */
export function detectChrome(
  os: WindowOs,
  wco: { readonly visible: boolean } | undefined,
): WindowChrome {
  if (os === "mac") return "mac";
  return wco?.visible === true ? "overlay" : "native";
}

export function applyWindowChrome(root: HTMLElement, os: WindowOs, chrome: WindowChrome): void {
  root.dataset["os"] = os;
  root.dataset["chrome"] = chrome;
}

type WcoNavigator = Navigator & {
  windowControlsOverlay?: EventTarget & { visible: boolean };
};

export function useWindowChrome(): void {
  const theme = useUiStore((s) => s.theme);

  useEffect(() => {
    const os = detectOs();
    const wco = (navigator as WcoNavigator).windowControlsOverlay;
    const sync = (): void =>
      applyWindowChrome(document.documentElement, os, detectChrome(os, wco));
    sync();
    wco?.addEventListener("geometrychange", sync);
    return () => wco?.removeEventListener("geometrychange", sync);
  }, []);

  useEffect(() => {
    if (detectOs() === "mac") return;
    void window.vex?.system?.setTitleBarOverlay?.({ theme })?.catch(() => undefined);
  }, [theme]);
}
