/**
 * H3 SHELL HARNESS - the page the H3 revamp is looked at and measured on.
 *
 * DEV SCAFFOLDING, NEVER A SHIPPED SURFACE. Nothing in `src/renderer/main.tsx`
 * imports this module, `vite.renderer.config.ts` builds only its own listed
 * HTML inputs, and `scripts/check-build-artifacts.mjs` fails a production
 * build that carries any file of this directory into `dist/`. It exists
 * because the states the revamp has to be checked in - a new chat, a live
 * turn, a waiting swap, a filled receipt, the Portfolio page - are unreachable
 * in the built app without a running local runtime and an unlocked vault (the
 * Electron smoke fixture stops at SystemCheck), and because the columns, rows
 * and card boxes the H3 contract fixes can only be MEASURED in a real engine
 * at real window sizes.
 *
 * THE FRAME. The page is the Electron window's content area and nothing more:
 * `.vex-h3-harness` takes the viewport exactly, on the shell's own ground, and
 * never scrolls (`harness.css`). The window's platform is stamped on `<html>`
 * with the renderer's own `applyWindowChrome`, so the mac traffic-light and
 * Windows caption reservations in `window-chrome.css` are the product's, and
 * a capture taken on a Linux runner still shows the mac window unless asked
 * otherwise. The theme goes through the uiStore's own document writer for the
 * same reason.
 *
 * THE CONTROL SURFACE, all by URL so every capture is a link:
 *   ?theme=chronos|celeris   the room (chronos, the dark one every H3 plate
 *                            is drawn in)
 *   ?os=mac|win|linux        the window chrome (mac)
 * The frame carries `data-vex-h3-ready` once its first render has committed;
 * a spec waits for it rather than for a timer.
 */

import { StrictMode, useEffect, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { PxSprite } from "../../components/icons/px/PxSprite.js";
import {
  applyWindowChrome,
  detectChrome,
  type WindowOs,
} from "../../lib/use-window-chrome.js";
import { applyThemeToDocument, type VexTheme } from "../../stores/uiStore/theme.js";
import { H3_HARNESS_MARK } from "./mark.js";
import "./harness.css";

const params = new URLSearchParams(window.location.search);

function pick<T extends string>(name: string, options: readonly T[], fallback: T): T {
  const raw = params.get(name);
  return options.find((option) => option === raw) ?? fallback;
}

const THEME: VexTheme = pick<VexTheme>("theme", ["chronos", "celeris"], "chronos");
const OS: WindowOs = pick<WindowOs>("os", ["mac", "win", "linux"], "mac");

/* Stamped before the first render, outside any effect: the shell's sheets
 * read both attributes from the root, and a first frame painted without them
 * is a frame of a window that does not exist. A Windows window is the
 * caption-overlay one the product opens (`chrome-options.ts`); Linux keeps
 * its native frame. */
applyThemeToDocument(THEME);
applyWindowChrome(
  document.documentElement,
  OS,
  OS === "win" ? "overlay" : detectChrome(OS, undefined),
);

function Harness(): JSX.Element {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);
  return (
    <div
      className="vex-h3-harness"
      data-vex-area="h3-harness"
      data-vex-harness={H3_HARNESS_MARK}
      data-vex-h3-ready={ready ? "true" : undefined}
    />
  );
}

const host = document.getElementById("root");
if (host !== null) {
  createRoot(host).render(
    <StrictMode>
      <PxSprite />
      <Harness />
    </StrictMode>,
  );
}
