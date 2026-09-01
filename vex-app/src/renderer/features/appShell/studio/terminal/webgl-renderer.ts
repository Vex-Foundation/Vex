/**
 * THE WEBGL RENDERER CHAIN, behind an INJECTED LOADER SEAM.
 *
 * xterm's WebGL addon is the renderer we want (VS Code ships it as the default
 * for the same reason: the DOM renderer costs a full layout per frame on a busy
 * shell). It is also the one piece of the terminal that CANNOT run under jsdom -
 * there is no WebGL2 context there, and construction throws. Hiding a bare
 * `await import("@xterm/addon-webgl")` inside the host would therefore make the
 * whole fallback chain untestable: the only observable would be "it did not
 * crash", which is exactly what a broken chain also looks like.
 *
 * So the loader is a PARAMETER. Production passes `importWebglAddon`; a test
 * passes a loader that rejects, or one that yields a fake addon whose
 * `onContextLoss` it can fire. The chain itself is then a pure function of
 * (loader, terminal, generation) and every branch is reachable.
 *
 * The chain mirrors `agents-colab/vscode/src/vs/workbench/contrib/terminal/
 * browser/xterm/xtermTerminal.ts:888-963`, whose three defences we adopt:
 *
 *  1. a PROCESS-WIDE downgrade. One machine has one GPU: if the addon failed to
 *     load or failed to activate once, every later terminal in this window
 *     opens on the DOM renderer directly instead of paying the failure again.
 *     VS Code keeps this in a static; we keep it in an injectable object so the
 *     downgrade is observable in a test without a module-reset backdoor.
 *  2. a LOAD GENERATION token. The import is asynchronous, and the terminal it
 *     was started for can be disposed or re-themed before it resolves. A
 *     resolved addon whose generation is stale is DROPPED rather than attached
 *     to a terminal that has moved on - attaching it would leak a WebGL context
 *     onto a dead terminal.
 *  3. `onContextLoss` -> dispose the addon. Disposing xterm's WebGL addon makes
 *     xterm fall back to its DOM renderer on the next frame, which is the whole
 *     recovery: a lost context is not recoverable in place, and a terminal that
 *     renders nothing is worse than one that renders slowly.
 */

import type { ITerminalAddon, Terminal } from "@xterm/xterm";

/** The subset of `WebglAddon` this module needs. */
export interface WebglAddonLike extends ITerminalAddon {
  readonly onContextLoss: (listener: () => void) => { dispose: () => void };
  dispose: () => void;
}

/** Constructor shape of `@xterm/addon-webgl`'s `WebglAddon`. */
export type WebglAddonConstructor = new (
  preserveDrawingBuffer?: boolean,
) => WebglAddonLike;

/** How the chain obtains the addon class. Injected so the chain is testable. */
export type WebglAddonLoader = () => Promise<WebglAddonConstructor>;

/** Production loader: a dynamic import, so the addon is not in the first chunk. */
export const importWebglAddon: WebglAddonLoader = async () => {
  const module = await import("@xterm/addon-webgl");
  return module.WebglAddon;
};

/**
 * Which renderer this window should try next.
 *
 * VS Code's `_suggestedRendererType` is a class static; ours is an object so a
 * test can hand a fresh one to the code under test instead of reaching into
 * module state to reset it. `sharedRendererPreference` is the production
 * instance, and it is deliberately process-wide: the GPU is.
 */
export class RendererPreference {
  #suggested: "webgl" | "dom" = "webgl";

  get suggested(): "webgl" | "dom" {
    return this.#suggested;
  }

  /** One-way. A window that failed WebGL once does not keep re-trying it. */
  downgradeToDom(): void {
    this.#suggested = "dom";
  }
}

export const sharedRendererPreference = new RendererPreference();

/** A live WebGL attachment. Disposing it returns the terminal to DOM rendering. */
export interface WebglAttachment {
  readonly dispose: () => void;
}

export interface EnableWebglRendererOptions {
  /**
   * NARROWED to the one method the chain calls. Taking the whole `Terminal`
   * would force every test to fabricate one, and fabricating a class this large
   * is done with a cast - which is how a test ends up asserting against a shape
   * the real terminal no longer has.
   */
  readonly terminal: Pick<Terminal, "loadAddon">;
  readonly loader: WebglAddonLoader;
  readonly preference: RendererPreference;
  /**
   * Whether the caller still wants this attachment when the load resolves.
   *
   * The generation check, expressed as a predicate the caller owns: the host
   * bumps a counter on dispose and on re-open, and passes a closure comparing
   * it. Returning false drops a resolved addon WITHOUT constructing it.
   */
  readonly isCurrent: () => boolean;
  /** Called when the chain falls back, so the host can log or re-fit. */
  readonly onFallback?: (reason: "load_failed" | "activate_failed" | "context_lost") => void;
}

/**
 * Attach the WebGL renderer, or resolve `null` when the terminal should keep
 * using xterm's DOM renderer.
 *
 * `null` is a NORMAL outcome, not an error: the DOM renderer is a correct,
 * shipping renderer and every fallback path in here is a deliberate choice to
 * use it. Nothing throws out of this function - a caller that had to try/catch
 * a renderer choice would end up disabling the terminal over a rendering
 * preference.
 */
export async function enableWebglRenderer(
  options: EnableWebglRendererOptions,
): Promise<WebglAttachment | null> {
  const { terminal, loader, preference, isCurrent, onFallback } = options;

  // The process-wide downgrade short-circuits before the import: a window that
  // already lost this bet does not pay for the module again per terminal.
  if (preference.suggested === "dom") return null;
  if (!isCurrent()) return null;

  let Addon: WebglAddonConstructor;
  try {
    Addon = await loader();
  } catch {
    preference.downgradeToDom();
    onFallback?.("load_failed");
    return null;
  }

  // The load is async and the terminal may be gone. Dropping a STALE addon
  // before constructing it is the point: constructing one acquires a WebGL
  // context, and attaching it to a disposed terminal leaks that context.
  if (!isCurrent()) return null;

  const addon = new Addon();
  let contextLossListener: { dispose: () => void } | null = null;
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    contextLossListener?.dispose();
    safeDispose(addon);
  };

  try {
    terminal.loadAddon(addon);
    contextLossListener = addon.onContextLoss(() => {
      onFallback?.("context_lost");
      dispose();
    });
  } catch {
    // Activation failed on a machine whose import succeeded - a blocked or
    // exhausted GPU. Same one-way downgrade: every later terminal goes DOM.
    preference.downgradeToDom();
    onFallback?.("activate_failed");
    safeDispose(addon);
    return null;
  }

  return { dispose };
}

/**
 * Disposing an addon that never fully activated can throw from inside xterm.
 * The caller is already on a fallback path, so a second failure there must not
 * replace the reason it was taken.
 */
function safeDispose(addon: WebglAddonLike): void {
  try {
    addon.dispose();
  } catch {
    // Intentionally ignored: see the doc comment above.
  }
}
