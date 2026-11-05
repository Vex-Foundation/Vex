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
 * same reason. What the operating system draws over the window is stood in
 * for (`chrome-standin.ts`): the traffic lights on a mac window, the caption
 * overlay on a Windows one, with `--overlay-w` set to its width as Window
 * Controls Overlay sets it in the app.
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
 *                            page class, the Lighter desk's included (each
 *                            state's own default otherwise)
 *   ?os=mac|win|linux        the window chrome (mac)
 *   ?kimm=standins|shipped   Kimm's art: the dev stand-ins cropped from the
 *                            mockup (`kimm-standin-art.ts`, the default), or
 *                            the art as the app ships it, every piece missing
 *                            until her files arrive
 *   ?plate=<id>              one of our own H3 plates (`plates/index.ts`)
 *                            instead of a state: a design proposal for a
 *                            surface H3 does not draw, never the product
 *   ?stage=<id>              one of the real screens before the shell
 *                            (`stages/index.ts`): the product's own stage
 *                            (`StagePlate`) and screen, as `App` mounts them,
 *                            on the stand-in bridge, to be set beside the
 *                            approved plate it was built from
 * There is no theme switch: the app is dark only (chronos), the room every
 * H3 plate is drawn in.
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
import { StagePlate } from "../../components/onboarding/PreShellStage.js";
import { ErrorBoundary } from "../../components/ui/error-boundary.js";
import { KIMM_SHIPPED_ART } from "../../components/vex/kimm/kimm-assets.js";
import { KimmArtProvider } from "../../components/vex/kimm/kimm-art-context.js";
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
import {
  STANDIN_CAPTION_OVERLAY,
  STANDIN_LIGHT_GAP,
  STANDIN_LIGHT_SIZE,
  STANDIN_TRAFFIC_LIGHTS,
} from "./chrome-standin.js";
import { KIMM_STANDIN_ART } from "./kimm-standin-art.js";
import { H3_HARNESS_MARK } from "./mark.js";
import { HARNESS_PLATES, plateById } from "./plates/index.js";
import type { HarnessPlate } from "./plates/types.js";
import { HARNESS_STAGES, stageById } from "./stages/index.js";
import type { HarnessStage } from "./stages/types.js";
import { HARNESS_STATES, stateById } from "./states/index.js";
import type { HarnessState, HarnessUi } from "./states/types.js";
import "./harness.css";

const params = new URLSearchParams(window.location.search);

function pick<T extends string>(name: string, options: readonly T[], fallback: T): T {
  const raw = params.get(name);
  return options.find((option) => option === raw) ?? fallback;
}

const THEME: VexTheme = "chronos";
const OS: WindowOs = pick<WindowOs>("os", ["mac", "win", "linux"], "mac");
const VEX = params.get("vex");
const STATE = stateById(params.get("state"));
const KIMM_ART =
  pick("kimm", ["standins", "shipped"], "standins") === "shipped" ? KIMM_SHIPPED_ART : KIMM_STANDIN_ART;
const PLATE = plateById(params.get("plate"));
const STAGE = stageById(params.get("stage"));

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
// Window Controls Overlay reports its width through env(); a page has none,
// so the reserve the shell keeps for the buttons is set here, as wide as the
// buttons the stand-in draws.
if (OS === "win") {
  document.documentElement.style.setProperty("--overlay-w", `${String(STANDIN_CAPTION_OVERLAY.width)}px`);
}

/**
 * The operating system's chrome over the window, stood in for: three 12px
 * lights from the inset on a mac window, the caption overlay's box at the top
 * right of a Windows one, both above the page and never hit-tested.
 */
function WindowChromeStandin(): JSX.Element | null {
  if (OS === "mac") {
    return (
      <div aria-hidden className="vex-h3-harness__lights" data-vex-h3-standin="traffic-lights">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              left: STANDIN_TRAFFIC_LIGHTS.x + i * (STANDIN_LIGHT_SIZE + STANDIN_LIGHT_GAP),
              top: STANDIN_TRAFFIC_LIGHTS.y,
              width: STANDIN_LIGHT_SIZE,
              height: STANDIN_LIGHT_SIZE,
            }}
          />
        ))}
      </div>
    );
  }
  if (OS === "win") {
    return (
      <div
        aria-hidden
        className="vex-h3-harness__caption"
        data-vex-h3-standin="caption-overlay"
        style={{ width: STANDIN_CAPTION_OVERLAY.width, height: STANDIN_CAPTION_OVERLAY.height }}
      >
        <span>-</span>
        <span>□</span>
        <span>×</span>
      </div>
    );
  }
  return null;
}

/**
 * Point the store where the state says, before the first render. The view is
 * the shell (the pre-shell machine is not mounted here at all), the mode is
 * the agent shell unless the state says otherwise, and `?vex=` writes the
 * stored choice for BOTH page classes so it holds whichever the state opens.
 */
function pointStore(state: { readonly ui?: HarnessUi; readonly prepare?: () => void }): void {
  const vex = VEX === "open" ? true : VEX === "closed" ? false : null;
  state.prepare?.();
  useUiStore.setState({
    theme: THEME,
    themePreference: THEME,
    currentView: "appShell",
    runtimeMode: "agent",
    ...state.ui,
    ...(vex === null ? {} : { vexOpenChat: vex, vexOpenPages: vex, vexOpenLighter: vex }),
  });
}

/**
 * The ready stamp: the state's own element is on screen, what the state
 * delivered after mount has landed, and no query is in flight - for two
 * frames running (one frame can be the commit before an effect's follow-up
 * fetch starts).
 */
function useReady(selector: string, client: QueryClient, delivered: boolean): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!delivered) return undefined;
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
  }, [selector, client, delivered]);
  return ready;
}

function Harness({
  state,
  client,
}: {
  readonly state: HarnessState;
  readonly client: QueryClient;
}): JSX.Element {
  const [delivered, setDelivered] = useState(state.afterMount === undefined);
  const ready = useReady(state.ready, client, delivered);
  // After the first commit, so the shell's own subscriptions exist; once per
  // load, because StrictMode replays effects and an event emitted twice is a
  // second event. The settle is a module-level promise for the same reason:
  // the replayed effect must wait on the one delivery, not start another.
  useEffect(() => {
    if (bridge === null || state.afterMount === undefined) return;
    afterMount ??= state.afterMount(bridge);
    let live = true;
    void afterMount.then(() => {
      if (live) setDelivered(true);
    });
    return () => {
      live = false;
    };
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
          {/* Her art: the stand-ins by default, handed to every Kimm surface
            * the real shell mounts (`kimm-art-context.tsx`). */}
          <KimmArtProvider art={KIMM_ART}>
            <AppShell />
          </KimmArtProvider>
        </ErrorBoundary>
        <ToastHost />
      </MotionConfig>
      <WindowChromeStandin />
    </div>
  );
}

/**
 * A plate in the window frame. Ready once the fonts it draws in have loaded
 * and a frame has painted: a plate fetches nothing, so the fonts are the only
 * thing a capture could catch half-done.
 */
function PlateFrame({ plate }: { readonly plate: HarnessPlate }): JSX.Element {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => {
      requestAnimationFrame(() => {
        if (live) setReady(true);
      });
    });
    return () => {
      live = false;
    };
  }, []);
  const { Plate } = plate;
  return (
    <div
      className="vex-h3-harness"
      data-vex-area="h3-harness"
      data-vex-harness={H3_HARNESS_MARK}
      data-vex-h3-plate={plate.id}
      data-vex-h3-ready={ready ? "true" : undefined}
    >
      <MotionConfig reducedMotion="user">
        <Plate />
      </MotionConfig>
      <WindowChromeStandin />
    </div>
  );
}

/**
 * A real screen before the shell: the product's own stage (her column,
 * `StagePlate`) and the screen beside it, mounted as `App` mounts them, with
 * the selected art set handed to her section. Ready once the stage's own
 * element is on screen, no query is in flight and the fonts have loaded.
 */
function StageRunner({
  stage,
  client,
}: {
  readonly stage: HarnessStage;
  readonly client: QueryClient;
}): JSX.Element {
  const ready = useReady(stage.ready, client, true);
  const [fonts, setFonts] = useState(false);
  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => {
      if (live) setFonts(true);
    });
    return () => {
      live = false;
    };
  }, []);
  const { Screen } = stage;
  return (
    <div
      className="vex-h3-harness"
      data-vex-area="h3-harness"
      data-vex-harness={H3_HARNESS_MARK}
      data-vex-h3-stage={stage.id}
      data-vex-h3-ready={ready && fonts ? "true" : undefined}
    >
      <MotionConfig reducedMotion="user">
        <ErrorBoundary surface="app" extent="screen" title="The harness could not render this stage">
          <KimmArtProvider art={KIMM_ART}>
            <StagePlate className="fixed inset-0" />
            <div className="fixed inset-0">
              <Screen />
            </div>
          </KimmArtProvider>
        </ErrorBoundary>
        <ToastHost />
      </MotionConfig>
      <WindowChromeStandin />
    </div>
  );
}

/** An unknown `?state=`: the list of states and plates, as links. */
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
      {HARNESS_PLATES.length > 0 ? (
        <>
          <h2>Our H3 plates (proposals, not the product)</h2>
          <ul>
            {HARNESS_PLATES.map((plate) => (
              <li key={plate.id}>
                <a href={`?plate=${plate.id}`}>{plate.id}</a> {plate.title}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {HARNESS_STAGES.length > 0 ? (
        <>
          <h2>The real screens before the shell</h2>
          <ul>
            {HARNESS_STAGES.map((stage) => (
              <li key={stage.id}>
                <a href={`?stage=${stage.id}`}>{stage.id}</a> {stage.title}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </main>
  );
}

/**
 * Point the store at a stage, before the first render: the view `App` would
 * stand on, no gate and no handoff over it, and `?vex=` for her one stored
 * choice on the stage (the chat's).
 */
function pointStage(stage: HarnessStage): void {
  const vex = VEX === "open" ? true : VEX === "closed" ? false : null;
  useUiStore.setState({
    theme: THEME,
    themePreference: THEME,
    currentView: stage.view,
    setupGateActive: false,
    unlockCurtainActive: false,
    ...stage.ui,
    ...(vex === null ? {} : { vexOpenChat: vex }),
  });
  stage.setup?.();
}

let bridge: HarnessBridge | null = null;
let afterMount: Promise<void> | null = null;
if (STAGE !== null) {
  bridge = installHarnessBridge(STAGE.answers());
  pointStage(STAGE);
} else if (PLATE !== null) {
  // A plate installs a bridge only when it mounts real parts that read one.
  if (PLATE.answers !== undefined) bridge = installHarnessBridge(PLATE.answers());
  pointStore(PLATE);
} else if (STATE !== null) {
  bridge = installHarnessBridge(STATE.answers());
  pointStore(STATE);
}

Object.defineProperty(window, "__vexH3Harness", {
  configurable: true,
  value: {
    state: STATE?.id ?? null,
    states: HARNESS_STATES.map((state) => state.id),
    plates: HARNESS_PLATES.map((plate) => plate.id),
    stages: HARNESS_STAGES.map((stage) => stage.id),
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
      {STAGE !== null ? (
        <QueryClientProvider client={client}>
          <StageRunner stage={STAGE} client={client} />
        </QueryClientProvider>
      ) : PLATE !== null ? (
        <QueryClientProvider client={client}>
          <PlateFrame plate={PLATE} />
        </QueryClientProvider>
      ) : STATE === null ? (
        <StateIndex />
      ) : (
        <QueryClientProvider client={client}>
          <Harness state={STATE} client={client} />
        </QueryClientProvider>
      )}
    </StrictMode>,
  );
}
