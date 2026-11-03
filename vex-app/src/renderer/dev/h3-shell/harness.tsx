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
 * IT MOUNTS THE REAL THING. The real `AppShell` - the left column, the running
 * head, the transcript and composer, the Vex column, the pages - inside the
 * product's own `MotionConfig`, error boundary and toast host, on the
 * product's own query client defaults (`app/queryClient.ts`) and
 * `styles/globals.css` verbatim. What is replaced is exactly the process
 * boundary: `window.vex`, which `bridge.ts` stands in for from the selected
 * state's typed fixtures. Above the bridge nothing is faked.
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
 * DETERMINISM. `boot.ts` runs before every product module: it empties the
 * origin's persisted UI state, freezes the clock at one instant and seeds
 * `Math.random` (`clock.ts`). The bridge answers on the microtask queue, never
 * on a timer.
 *
 * THE CONTROL SURFACE, all by URL so every capture is a link:
 *   ?state=<id>              the state (`states/index.ts`); none is the bare
 *                            install, an unknown id lists the states
 *   ?vex=open|closed         the Vex column's stored choice for the state's
 *                            page class (each state's own default otherwise)
 *   ?theme=chronos|celeris   the room (chronos, the dark one every H3 plate
 *                            is drawn in)
 *   ?os=mac|win|linux        the window chrome (mac)
 * The frame carries `data-vex-h3-ready` once the state's own element is on
 * screen and no query is still fetching; a spec waits for it rather than for
 * a timer. `window.__vexH3Harness` exposes the bridge's record (`calls()`,
 * `unanswered()`), its `emit` and the state ids, for the spec and for a
 * person at the console.
 */

import "./boot.js";
import { StrictMode, useEffect, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { createQueryClient } from "../../app/queryClient.js";
import { PxSprite } from "../../components/icons/px/PxSprite.js";
import { ErrorBoundary } from "../../components/ui/error-boundary.js";
import { ToastHost } from "../../components/ui/toast-host.js";
import { AppShell } from "../../features/appShell/AppShell.js";
import {
  applyWindowChrome,
  detectChrome,
  type WindowOs,
} from "../../lib/use-window-chrome.js";
import { useUiStore } from "../../stores/uiStore.js";
import { applyThemeToDocument, type VexTheme } from "../../stores/uiStore/theme.js";
import { installHarnessBridge, type HarnessBridge } from "./bridge.js";
import { H3_HARNESS_MARK } from "./mark.js";
import { HARNESS_STATES, stateById } from "./states/index.js";
import type { HarnessState } from "./states/types.js";
import "./harness.css";

const params = new URLSearchParams(window.location.search);

function pick<T extends string>(name: string, options: readonly T[], fallback: T): T {
  const raw = params.get(name);
  return options.find((option) => option === raw) ?? fallback;
}

const THEME: VexTheme = pick<VexTheme>("theme", ["chronos", "celeris"], "chronos");
const OS: WindowOs = pick<WindowOs>("os", ["mac", "win", "linux"], "mac");
const VEX = params.get("vex");
const STATE = stateById(params.get("state"));

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

/**
 * Point the store where the state says, before the first render. The view is
 * the shell (the pre-shell machine is not mounted here at all), the mode is
 * the agent shell unless the state says otherwise, and `?vex=` writes the
 * stored choice for BOTH page classes so it holds whichever the state opens.
 */
function pointStore(state: HarnessState): void {
  const vex = VEX === "open" ? true : VEX === "closed" ? false : null;
  useUiStore.setState({
    theme: THEME,
    themePreference: THEME,
    currentView: "appShell",
    runtimeMode: "agent",
    ...state.ui,
    ...(vex === null ? {} : { vexOpenChat: vex, vexOpenPages: vex }),
  });
}

/**
 * The ready stamp: the state's own element is on screen and no query is in
 * flight, for two frames running (one frame can be the commit before an
 * effect's follow-up fetch starts).
 */
function useReady(selector: string, client: QueryClient): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let raf = 0;
    let settled = 0;
    const tick = (): void => {
      const done = client.isFetching() === 0 && document.querySelector(selector) !== null;
      settled = done ? settled + 1 : 0;
      if (settled >= 2) setReady(true);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [selector, client]);
  return ready;
}

function Harness({
  state,
  client,
}: {
  readonly state: HarnessState;
  readonly client: QueryClient;
}): JSX.Element {
  const ready = useReady(state.ready, client);
  // After the first commit, so the shell's own subscriptions exist; once per
  // load, because StrictMode replays effects and an event emitted twice is a
  // second event.
  useEffect(() => {
    if (bridge === null || afterMountRan) return;
    afterMountRan = true;
    state.afterMount?.(bridge);
  }, [state]);
  return (
    <div
      className="vex-h3-harness"
      data-vex-area="h3-harness"
      data-vex-harness={H3_HARNESS_MARK}
      data-vex-h3-state={state.id}
      data-vex-h3-ready={ready ? "true" : undefined}
    >
      <MotionConfig reducedMotion="user">
        <ErrorBoundary surface="app" extent="screen" title="The harness could not render this state">
          <AppShell />
        </ErrorBoundary>
        <ToastHost />
      </MotionConfig>
    </div>
  );
}

/** An unknown `?state=`: the list of states, as links. */
function StateIndex(): JSX.Element {
  return (
    <main
      className="vex-h3-harness vex-h3-harness__index"
      data-vex-harness={H3_HARNESS_MARK}
      data-vex-h3-ready="true"
    >
      <h1>H3 shell harness states</h1>
      <ul>
        {HARNESS_STATES.map((state) => (
          <li key={state.id}>
            <a href={`?state=${state.id}`}>{state.id}</a> {state.title}
          </li>
        ))}
      </ul>
    </main>
  );
}

let bridge: HarnessBridge | null = null;
let afterMountRan = false;
if (STATE !== null) {
  bridge = installHarnessBridge(STATE.answers());
  pointStore(STATE);
}

Object.defineProperty(window, "__vexH3Harness", {
  configurable: true,
  value: {
    state: STATE?.id ?? null,
    states: HARNESS_STATES.map((state) => state.id),
    calls: () => bridge?.calls() ?? [],
    unanswered: () => bridge?.unanswered() ?? [],
    emit: (path: `${string}.on${string}`, event: unknown) => bridge?.emit(path, event) ?? 0,
  },
});

const host = document.getElementById("root");
if (host !== null) {
  const client = createQueryClient();
  createRoot(host).render(
    <StrictMode>
      <PxSprite />
      {STATE === null ? (
        <StateIndex />
      ) : (
        <QueryClientProvider client={client}>
          <Harness state={STATE} client={client} />
        </QueryClientProvider>
      )}
    </StrictMode>,
  );
}
