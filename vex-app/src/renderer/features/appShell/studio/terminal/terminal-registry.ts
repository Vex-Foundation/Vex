/**
 * THE TERMINAL REGISTRY - xterm instances that live OUTSIDE React.
 *
 * A terminal is not a rendered value. It owns a scrollback buffer, a WebGL
 * context, a live attachment to a pty in another process, and a DOM subtree
 * xterm itself built. If React owned it, every move between panes - a split, a
 * tab reorder, a mode switch - would unmount and remount the component, and
 * remounting a terminal means throwing away the buffer the user is reading and
 * re-serializing it from the host. VS Code solved this the same way
 * (`terminalInstance.ts:1055-1086`): the instance owns a WRAPPER ELEMENT that is
 * created once and RE-PARENTED, and `attachToElement` is a no-op when the
 * container did not change.
 *
 * So this module keeps one entry per terminal id, keyed outside the React tree,
 * and the component is only a consumer of it.
 *
 * ## The acquire / release / dispose split, and why StrictMode forces it
 *
 * React 19's StrictMode double-invokes every effect: mount -> effect -> cleanup
 * -> effect. If `release` disposed, a StrictMode remount would destroy a live
 * terminal between the two effects and the user would watch their shell vanish
 * in development only. So the three verbs are distinct and the distinction is
 * the contract:
 *
 *  - `acquire` is IDEMPOTENT per id. The second call returns the same entry and
 *    creates nothing; it only raises the consumer count.
 *  - `release` NEVER disposes. It lowers the count and detaches the wrapper from
 *    the DOM; the terminal, its buffer and its host attachment survive.
 *  - `dispose` is EXPLICIT and is the only thing that destroys a terminal. Its
 *    three callers are a user closing the tab, a project vanishing under us, and
 *    the window going away.
 *
 * There is at most ONE consumer per terminal id at a time, because preload
 * allows at most one subscriber per (terminalId, event kind) per window: a
 * second `XtermHost` on the same id would silently steal the first one's
 * callbacks. The registry does not enforce this - it cannot see components -
 * but every consumer must uphold it, and the tab/pane model does by giving each
 * terminal exactly one pane.
 */

import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { TERMINAL_SCROLLBACK_ROWS } from "@shared/schemas/terminal.js";
import { openTerminalLink } from "../../../../lib/api/terminal-links.js";
import {
  observeTerminalTheme,
  prefersReducedMotion,
  readTerminalTheme,
} from "./terminal-palette.js";
import {
  enableWebglRenderer,
  importWebglAddon,
  sharedRendererPreference,
  type RendererPreference,
  type WebglAddonLoader,
  type WebglAttachment,
} from "./webgl-renderer.js";

/** The class the wrapper carries while its pane is the visible one. */
export const TERMINAL_WRAPPER_CLASS = "vex-terminal-surface";
export const TERMINAL_ACTIVE_CLASS = "vex-terminal-surface--active";

/** One live terminal, as its consumer sees it. */
export interface TerminalEntry {
  readonly terminalId: string;
  readonly terminal: Terminal;
  /** Created ONCE. Re-parented on every move; never rebuilt. */
  readonly wrapper: HTMLElement;
  readonly fit: FitAddon;
  readonly serialize: SerializeAddon;
  readonly search: SearchAddon;
}

/** The dimensions a fit settled on, or `null` when the element cannot be measured. */
export interface FittedSize {
  readonly cols: number;
  readonly rows: number;
}

interface RegistryRecord {
  readonly entry: TerminalEntry;
  /** How many consumers hold this terminal. Zero does NOT mean disposable. */
  consumers: number;
  container: HTMLElement | null;
  webgl: WebglAttachment | null;
  /**
   * Bumped whenever the terminal is disposed or its renderer is re-requested.
   * An in-flight WebGL load compares against it and drops itself when stale.
   */
  rendererGeneration: number;
  disposeTheme: () => void;
  disposed: boolean;
}

export interface TerminalRegistryOptions {
  /** Injected so the WebGL chain is reachable under jsdom. See webgl-renderer.ts. */
  readonly webglLoader?: WebglAddonLoader;
  readonly rendererPreference?: RendererPreference;
  /**
   * Where a clicked link goes.
   *
   * The default is the `vex.terminalLinks` channel: main applies the
   * terminal-link policy and asks the user, in a NATIVE dialog showing the
   * whole host and the whole URL, once per host per window per run. The
   * renderer never decides that a URL may be opened and never gets a window
   * handle. Injected so a test can observe the call without a bridge.
   *
   * IT WAS `window.open`, and that was the defect: xterm's own OSC 8 handler
   * runs `confirm()` and `window.open`, and `setWindowOpenHandler` serves a
   * CLOSED allowlist of Vex's own destinations, so every dexscreener link
   * Claude Code printed produced an ugly renderer confirm and then nothing
   * (owner's Windows session, 17.png/18.png).
   */
  readonly openLink?: (url: string) => void;
}

export class TerminalRegistry {
  readonly #records = new Map<string, RegistryRecord>();
  readonly #webglLoader: WebglAddonLoader;
  readonly #rendererPreference: RendererPreference;
  readonly #openLink: (url: string) => void;

  constructor(options: TerminalRegistryOptions = {}) {
    this.#webglLoader = options.webglLoader ?? importWebglAddon;
    this.#rendererPreference = options.rendererPreference ?? sharedRendererPreference;
    this.#openLink =
      options.openLink ??
      ((url) => {
        // Fire and forget by DESIGN: every outcome - opened, declined, refused
        // by name - is main's to surface through its own dialog, and a renderer
        // that awaited it would only be able to say something main already
        // said. The rejection path is a transport failure and is swallowed
        // rather than thrown into an xterm event handler.
        void openTerminalLink(url).catch(() => undefined);
      });
  }

  /** Whether a terminal already exists. Never creates one. */
  has(terminalId: string): boolean {
    return this.#records.has(terminalId);
  }

  /** Consumers currently holding a terminal. Exposed for lifecycle assertions. */
  consumerCount(terminalId: string): number {
    return this.#records.get(terminalId)?.consumers ?? 0;
  }

  /**
   * Take a consumer reference, creating the terminal on first use.
   *
   * IDEMPOTENT: acquiring an id that already exists returns the same entry and
   * builds nothing. That is what makes a StrictMode double-mount, a re-render
   * with a changed key, and a pane move all safe.
   */
  acquire(terminalId: string): TerminalEntry {
    const existing = this.#records.get(terminalId);
    if (existing !== undefined) {
      existing.consumers += 1;
      return existing.entry;
    }
    const record = this.#create(terminalId);
    this.#records.set(terminalId, record);
    record.consumers = 1;
    return record.entry;
  }

  /**
   * Give up a consumer reference.
   *
   * NEVER disposes, at any count. The terminal outlives its React consumer on
   * purpose: a StrictMode remount, a tab switch that unmounts a pane, and a
   * project switch all pass through here, and none of them is a decision to
   * destroy the user's shell. Only `dispose` is.
   */
  release(terminalId: string): void {
    const record = this.#records.get(terminalId);
    if (record === undefined) return;
    record.consumers = Math.max(0, record.consumers - 1);
    if (record.consumers === 0 && record.container !== null) {
      record.entry.wrapper.remove();
      record.container = null;
    }
  }

  /**
   * Destroy a terminal for good: the user closed its tab, its project vanished,
   * or the window is going away.
   *
   * Idempotent, and safe after a partial construction - the whole point of
   * collecting the disposers on the record rather than assuming a happy path.
   */
  dispose(terminalId: string): void {
    const record = this.#records.get(terminalId);
    if (record === undefined) return;
    this.#records.delete(terminalId);
    if (record.disposed) return;
    record.disposed = true;
    // Invalidate first, so an in-flight WebGL load cannot attach to a corpse.
    record.rendererGeneration += 1;
    record.disposeTheme();
    record.webgl?.dispose();
    record.webgl = null;
    record.entry.wrapper.remove();
    record.container = null;
    record.entry.terminal.dispose();
  }

  /** Destroy every terminal. The window teardown path. */
  disposeAll(): void {
    for (const terminalId of [...this.#records.keys()]) this.dispose(terminalId);
  }

  /**
   * Put a terminal's wrapper inside `container`.
   *
   * A no-op when the container did not change, exactly as VS Code's
   * `attachToElement` is: a re-render that hands back the same node must not
   * re-parent a live terminal, because re-parenting a canvas costs a full
   * repaint and can drop the selection.
   */
  attach(terminalId: string, container: HTMLElement): void {
    const record = this.#records.get(terminalId);
    if (record === undefined || record.disposed) return;
    if (record.container === container) return;

    record.container = container;
    container.appendChild(record.entry.wrapper);
    // The wrapper moved documents or stacking contexts. Re-opening xterm on its
    // OWN element is how VS Code makes it pick that up; `refresh` repaints the
    // viewport that the move invalidated.
    const element = record.entry.terminal.element;
    if (element !== undefined) record.entry.terminal.open(element);
    record.entry.terminal.refresh(0, record.entry.terminal.rows - 1);
  }

  /**
   * Show or hide a terminal, and refit when it becomes visible.
   *
   * THE REFIT IS MANDATORY, not an optimization. Keep-alive panes are hidden
   * with `display: none`, and a `display: none` element measures 0x0, so
   * `FitAddon` computed a nonsense size for every frame the pane was hidden.
   * VS Code's `setVisible` (`terminalInstance.ts:1435-1451`) does the same three
   * things in the same order: toggle the class, flush pending resizes, resize.
   *
   * Returns the size the fit settled on so the caller can send it to the host,
   * or `null` when the element still cannot be measured.
   */
  setVisible(terminalId: string, visible: boolean): FittedSize | null {
    const record = this.#records.get(terminalId);
    if (record === undefined || record.disposed) return null;
    record.entry.wrapper.classList.toggle(TERMINAL_ACTIVE_CLASS, visible);
    if (!visible) return null;
    return this.refit(terminalId);
  }

  /**
   * Fit the terminal to its container and report the resulting size.
   *
   * `null` means "not measurable right now" - a hidden pane, a container with no
   * layout yet - and is a normal answer, not a failure. Returning a fabricated
   * size instead would send the host a resize for a geometry no one is looking
   * at, and the host would reflow the user's shell to it.
   */
  refit(terminalId: string): FittedSize | null {
    const record = this.#records.get(terminalId);
    if (record === undefined || record.disposed) return null;
    const proposed = record.entry.fit.proposeDimensions();
    if (
      proposed === undefined ||
      !Number.isFinite(proposed.cols) ||
      !Number.isFinite(proposed.rows) ||
      proposed.cols < 1 ||
      proposed.rows < 1
    ) {
      return null;
    }
    const { cols, rows } = proposed;
    if (cols !== record.entry.terminal.cols || rows !== record.entry.terminal.rows) {
      record.entry.terminal.resize(cols, rows);
    }
    return { cols, rows };
  }

  #create(terminalId: string): RegistryRecord {
    const wrapper = document.createElement("div");
    wrapper.className = TERMINAL_WRAPPER_CLASS;
    wrapper.dataset["terminalId"] = terminalId;

    const terminal = new Terminal({
      // The 1000-row bound is the HOST's contract too: the pty host trims its
      // replay to it, so a renderer that kept more would show a history the
      // host cannot reproduce after a reattach.
      scrollback: TERMINAL_SCROLLBACK_ROWS,
      allowProposedApi: true,
      // WITHOUT THIS THE PANE PAINTS OPAQUE BLACK. The palette's background is
      // alpha 0 so the card surface and the brand watermark show through; with
      // `allowTransparency` at its default (false) xterm composites every cell
      // onto its own opaque background instead, and the watermark the pane
      // renders underneath is never visible. The WebGL renderer honours the
      // flag (`@xterm/addon-webgl` 0.19.0 passes it into the texture atlas and
      // returns NULL_COLOR for cell backgrounds), so this is not a
      // renderer-specific escape hatch. See `terminal-palette.ts` for why the
      // token is spelled `#00000000` rather than `transparent`.
      allowTransparency: true,
      convertEol: false,
      cursorBlink: !prefersReducedMotion(),
      // The library's only inertial behaviour. Reduced motion collapses it.
      smoothScrollDuration: prefersReducedMotion() ? 0 : 125,
      fontFamily: readMonoFontFamily(),
      theme: readTerminalTheme(document.documentElement),
      // THE OSC 8 PATH, which is a DIFFERENT path from the web-links addon
      // below and was the one that was broken. A shell that emits the
      // hyperlink escape sequence (Claude Code does, `gh` does, modern `ls`
      // does) is linkified by xterm's own `OscLinkProvider`, whose default
      // activation is `confirm()` + `window.open`
      // (`@xterm/xterm/src/browser/OscLinkProvider.ts:114-129`) and never
      // touches the addon. Both now end at the same owner.
      linkHandler: {
        activate: (_event, text) => {
          this.#openLink(text);
        },
      },
    });

    const fit = new FitAddon();
    const serialize = new SerializeAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(serialize);
    terminal.loadAddon(search);
    terminal.loadAddon(new ClipboardAddon());
    terminal.loadAddon(
      new WebLinksAddon((_event, uri) => {
        this.#openLink(uri);
      }),
    );
    const unicode11 = new Unicode11Addon();
    terminal.loadAddon(unicode11);
    // Width tables only take effect once the version is SELECTED; loading the
    // addon alone leaves xterm on the v6 tables and CJK/emoji columns drift
    // from what the pty computed.
    terminal.unicode.activeVersion = "11";

    terminal.open(wrapper);

    const record: RegistryRecord = {
      entry: { terminalId, terminal, wrapper, fit, serialize, search },
      consumers: 0,
      container: null,
      webgl: null,
      rendererGeneration: 0,
      disposeTheme: () => undefined,
      disposed: false,
    };

    record.disposeTheme = observeTerminalTheme(() => {
      if (record.disposed) return;
      // Repointing through the aliases, not a rebuild: `options.theme` is a
      // setter xterm re-reads, so the flip costs one repaint.
      terminal.options.theme = readTerminalTheme(document.documentElement);
    });

    const generation = record.rendererGeneration;
    void enableWebglRenderer({
      terminal,
      loader: this.#webglLoader,
      preference: this.#rendererPreference,
      isCurrent: () => !record.disposed && record.rendererGeneration === generation,
      onFallback: () => {
        record.webgl = null;
      },
    }).then((attachment) => {
      if (attachment === null) return;
      if (record.disposed || record.rendererGeneration !== generation) {
        attachment.dispose();
        return;
      }
      record.webgl = attachment;
    });

    return record;
  }
}

/**
 * The mono stack, read from the token rather than spelled here.
 *
 * xterm takes a font string, so the family cannot arrive as a `var()`. Reading
 * `--font-mono` off the root keeps ONE definition of the technical face; a
 * literal here would be a second one that silently stops matching the app.
 */
function readMonoFontFamily(): string {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return "monospace";
  }
  const raw = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim();
  return raw === "" ? "monospace" : raw;
}

/** The window's registry. One per renderer process, like the terminals it holds. */
export const terminalRegistry = new TerminalRegistry();
