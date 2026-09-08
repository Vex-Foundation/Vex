/**
 * BrowserWindow factory z full security lockdown per skill §7.
 *
 * webPreferences locked: contextIsolation, sandbox, no nodeIntegration,
 * webSecurity, no insecure content, devTools only in dev builds, CJS preload.
 * Window state persisted via preferencesStore.
 */

import { BrowserWindow, app, screen, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger/index.js";
import { preferencesStore } from "../preferences/store.js";
import { APP_ORIGIN } from "../protocol/app-protocol.js";
import {
  isAllowedExternalUrl,
  type ExternalAllowEntry,
} from "../security/url.js";
import { EXPLORER_EXTERNAL_ALLOW } from "@shared/explorer-links.js";
import { observeWindowForFiles } from "../studio/files/files-composition.js";
import { observeWindowForTerminals } from "../studio/terminal-domain.js";
import { CHART_ATTRIBUTION_EXTERNAL_ALLOW } from "@shared/chart-attribution.js";
import {
  clampToVisibleArea,
  type DisplayInfo,
} from "./visibility.js";
import {
  computeFirstRunBounds,
  computeMinConstraints,
  isFirstRun,
} from "./bounds.js";

/**
 * Safety timeout (ms) before forcing `win.show()` if `ready-to-show`
 * never fires. WSLg + Electron in copy-mode presentation can stall on
 * the ready signal — without this the window stays `show: false`
 * forever and the user only sees a taskbar entry (codex turn 3).
 */
const READY_TO_SHOW_SAFETY_MS = 5_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * External-link allowlist for shell.openExternal.
 * Each entry is a host (exact match) or {host, pathPrefix} (path-boundary match).
 * Default scheme: `https:` — http: never allowed externally.
 *
 * Path prefixes are matched with boundary respect: `/electron/electron/releases`
 * matches `/electron/electron/releases` and `/electron/electron/releases/...`,
 * NOT `/electron/electron/releases-malicious`. See `pathStartsWithBoundary`.
 */
const ALLOWED_EXTERNAL: ReadonlyArray<ExternalAllowEntry> = [
  "vex.ai",
  "docs.vex.ai",
  "portal.jup.ag",
  "app.tavily.com",
  "openrouter.ai",
  "releases.electronjs.org",
  "desktop.docker.com",
  "docs.docker.com",
  // Go toolchain guidance (Studio bridge readiness panel, from-source runs
  // only). Path-scoped: the download page and the install doc, nothing else
  // on go.dev.
  { host: "go.dev", pathPrefix: "/dl" },
  { host: "go.dev", pathPrefix: "/doc/install" },
  // DexScreener: agent-surfaced token links (not a block explorer). Exact-host
  // entry is safe — `isAllowedExternalUrl` matches `url.hostname === entry`, so
  // `dexscreener.com.evil.com` / `notdexscreener.com` do not match.
  "dexscreener.com",
  // Lightweight Charts attribution link in the Light it up trading workspace.
  // Exact host only; the renderer links to the vendor homepage with no query.
  "www.tradingview.com",
  // Block-explorer hosts (user-clicked MOVES tx / account deep links). Single
  // source of truth in `@shared/explorer-links` so the chain→URL mapper and
  // this allowlist can never drift. Pre-existing hosts stay host-wide; the new
  // HyperEVM/Robinhood hosts are path-scoped there. https-only and
  // path-boundary matching are enforced upstream in `isAllowedExternalUrl`.
  ...EXPLORER_EXTERNAL_ALLOW,
  // The chart library's required attribution link (board chart). Single source
  // of truth in `@shared/chart-attribution` so the anchor the renderer draws
  // and the host admitted here cannot drift - the drift is silent, the click
  // just does nothing. Exact host `www.tradingview.com`; lookalikes denied by
  // `isAllowedExternalUrl`'s hostname equality.
  ...CHART_ATTRIBUTION_EXTERNAL_ALLOW,
  // Vex release notes (updater toast CTA) — path-scoped per owner decision
  // 2026-07-22. The former github.com/Vex-Foundation/ entry died with this
  // repoint (it existed solely for the release-notes CTA; zero remaining
  // consumers). Electron releases stay for the auto-updater doc links.
  { host: "projectvex.ai", pathPrefix: "/releases" },
  { host: "github.com", pathPrefix: "/electron/electron/releases" },
  // Rettiwt = the privacy-respecting Twitter/X API client the agent uses for
  // authenticated timeline/tweet reads (src/tools/twitter-account). Its
  // "X Auth Helper" browser extensions let a user mint a Rettiwt API key from
  // their own logged-in X session — no cookie/password is handed to Vex — so
  // these two store URLs are allow-listed to open externally. Exact extension
  // URLs only: path-boundary matching in `pathStartsWithBoundary` blocks
  // `-malicious`/`-clone` lookalike suffixes on the same store host.
  {
    host: "chromewebstore.google.com",
    pathPrefix:
      "/detail/x-auth-helper/igpkhkjmpdecacocghpgkghdcmcmpfhp",
  },
  {
    host: "addons.mozilla.org",
    pathPrefix: "/en-US/firefox/addon/rettiwt-auth-helper",
  },
];

function checkExternalUrl(raw: string): boolean {
  return isAllowedExternalUrl(raw, ALLOWED_EXTERNAL);
}

/** Max length of a sanitized URL emitted to the log. */
const SANITIZED_URL_MAX_LEN = 200;

/**
 * Reduce a URL to `scheme//host/pathname` for logging, dropping `search` and
 * `hash`. Denied URLs may carry secrets in the query string (e.g.
 * `?token=…`), so the raw URL must NEVER reach the log. A non-parseable input
 * returns the literal `"[unparseable-url]"` rather than echoing the raw value.
 */
function sanitizeUrlForLog(raw: string): string {
  try {
    const url = new URL(raw);
    const sanitized = `${url.protocol}//${url.host}${url.pathname}`;
    return sanitized.length > SANITIZED_URL_MAX_LEN
      ? `${sanitized.slice(0, SANITIZED_URL_MAX_LEN)}…`
      : sanitized;
  } catch {
    return "[unparseable-url]";
  }
}

function isAllowedAppUrl(raw: string): boolean {
  if (raw.startsWith(`${APP_ORIGIN}/`) || raw === APP_ORIGIN) return true;
  if (!app.isPackaged && raw.startsWith("http://127.0.0.1:5173/")) return true;
  return false;
}

export async function createMainWindow(): Promise<BrowserWindow> {
  const prefs = await preferencesStore.load();

  // Normalize saved bounds against the *current* display config. A
  // previously-docked secondary monitor may be gone, DPI may have
  // changed, etc. — restoring stale x/y verbatim opens the window
  // off-screen (codex turn 3).
  const allDisplays: ReadonlyArray<DisplayInfo> = screen.getAllDisplays();
  const primary: DisplayInfo | null = (() => {
    try {
      return screen.getPrimaryDisplay();
    } catch {
      return null;
    }
  })();
  // First-run: no persisted x/y yet — scale the initial window to
  // ~85% of the primary work area so the app launches at a sensible
  // size on whatever monitor the user is on, rather than the legacy
  // 1280×800 baked into defaultPreferences. After the first close,
  // persistState writes real bounds and isFirstRun returns false.
  const firstRun = isFirstRun(prefs.window);
  const effectiveSaved =
    firstRun && primary !== null
      ? { ...prefs.window, ...computeFirstRunBounds(primary.workArea) }
      : prefs.window;
  const normalized = clampToVisibleArea(effectiveSaved, allDisplays, primary);
  const { minWidth, minHeight } = computeMinConstraints(normalized);
  log.info(
    `[window] saved=${JSON.stringify(prefs.window)} firstRun=${firstRun} effective=${JSON.stringify(effectiveSaved)} normalized=${JSON.stringify(
      normalized
    )} min={w:${minWidth},h:${minHeight}} displays=${JSON.stringify(allDisplays.map((d) => d.workArea))}`
  );

  // BrowserWindow.icon: macOS reads only the .app bundle .icns, but on
  // Linux + Windows this controls the taskbar/title-bar icon. In dev the
  // renderer is served by Vite from src/renderer/public/, in packaged or
  // E2E builds it lives under dist/renderer/. Compute the gate once and
  // reuse for both `icon` and `loadURL` below.
  const loadBuiltBundle =
    app.isPackaged || process.env["VEX_E2E_LOAD_BUILT"] === "1";
  const iconPath = loadBuiltBundle
    ? path.join(__dirname, "../renderer/icon.png")
    : path.resolve(__dirname, "../../src/renderer/public/icon.png");

  const win = new BrowserWindow({
    width: normalized.width,
    height: normalized.height,
    x: normalized.x ?? undefined,
    y: normalized.y ?? undefined,
    minWidth,
    minHeight,
    show: false,
    // CONTRACT: must equal the chronos --vex-alias-bg-base (gray-1000) in
    // renderer tokens.css, so the pre-paint window plate matches first paint.
    backgroundColor: "#0a0d18",
    // Window title is the fixed product name — the agent's display name is
    // no longer user-configurable (retired persona.md mechanism).
    title: "Vex",
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      devTools: !app.isPackaged,
    },
  });

  if (prefs.window.maximized) win.maximize();

  // Window state persistence on close.
  const persistState = (): void => {
    if (win.isDestroyed()) return;
    const bounds = win.getNormalBounds();
    void preferencesStore.update({
      window: {
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        maximized: win.isMaximized(),
      },
    });
  };
  win.on("close", persistState);

  // The window's terminals are released when the window goes - on a deliberate
  // close AND on a renderer crash. Registered here because this is the owner of
  // the window's lifetime; `observeWindowForTerminals` explains why both events
  // are needed and what leaked while neither was wired.
  observeWindowForTerminals(win);
  // Same two triggers, same owner, for the window's FILE subscriptions: an
  // unreleased subscription holds a recursive OS watch for a window that is
  // gone.
  observeWindowForFiles(win);

  // Block window.open + redirect to allowlisted external opener.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (checkExternalUrl(url)) {
      void shell.openExternal(url);
    } else {
      log.warn(`[window] blocked window.open to ${sanitizeUrlForLog(url)}`);
    }
    return { action: "deny" };
  });

  // Block in-window navigation to anything outside app://vex/ + dev server.
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedAppUrl(url)) {
      event.preventDefault();
      if (checkExternalUrl(url)) {
        void shell.openExternal(url);
      } else {
        log.warn(`[window] blocked navigation to ${sanitizeUrlForLog(url)}`);
      }
    }
  });

  // Diagnostic: catch renderer load failures (CSP block, ENOTCONN to
  // dev server, asar protocol bug, etc.) so the smoke test surfaces
  // them immediately instead of showing a silent blank window.
  win.webContents.on(
    "did-fail-load",
    (_event, code, description, validatedURL) => {
      log.error(
        `[window] did-fail-load code=${code} url=${validatedURL} desc=${description}`
      );
    }
  );

  // Show on first paint — but with a hard safety timeout so a stalled
  // `ready-to-show` (known WSLg/Electron edge case) does not leave the
  // user staring at a taskbar entry forever (codex turn 3).
  let shown = false;
  const showOnce = (reason: string): void => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    log.info(`[window] showing main window (trigger: ${reason})`);
    win.show();
    win.focus();
  };
  win.once("ready-to-show", () => showOnce("ready-to-show"));
  const safetyTimer = setTimeout(() => {
    if (!shown) {
      log.warn(
        `[window] ready-to-show did not fire within ${READY_TO_SHOW_SAFETY_MS}ms; forcing show`
      );
      showOnce("safety-timeout");
    }
  }, READY_TO_SHOW_SAFETY_MS);
  safetyTimer.unref?.();
  win.on("closed", () => {
    clearTimeout(safetyTimer);
  });

  // Load renderer.
  //
  // `app.isPackaged` is FALSE when Electron is launched directly against
  // `dist/main/index.js` (the path Playwright uses via `_electron.launch`).
  // In that mode there is no Vite dev server to fall back to, so we honour
  // an explicit `VEX_E2E_LOAD_BUILT=1` override that forces the production
  // load path through the `app://vex/` protocol. The renderer bundle must
  // exist on disk (i.e. `pnpm run build` has run); CI orders the e2e job
  // after the build step to enforce that.
  if (loadBuiltBundle) {
    await win.loadURL(`${APP_ORIGIN}/index.html`);
  } else {
    await win.loadURL("http://127.0.0.1:5173/");
  }

  return win;
}
