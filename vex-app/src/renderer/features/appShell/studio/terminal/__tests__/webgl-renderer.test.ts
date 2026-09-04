/**
 * The WebGL fallback chain, driven through its injected loader seam.
 *
 * Every branch here is a branch that only ever runs on a machine whose GPU
 * misbehaves, which is exactly why it needs a test: nobody exercises it by hand,
 * and its failure mode is a terminal that renders nothing. The seam exists so
 * these four scenarios are reachable under jsdom, where a real WebGL context
 * cannot be created at all.
 *
 * What each case would catch if the chain regressed:
 *  - load failure without the downgrade: every terminal pays a failing dynamic
 *    import, forever, on a machine that will never succeed;
 *  - a stale load that still attaches: a WebGL context leaked onto a disposed
 *    terminal, one per terminal the user closes while the import is in flight;
 *  - context loss without a dispose: xterm never falls back to its DOM renderer,
 *    so the pane goes permanently blank;
 *  - an activation failure that throws: the whole host crashes over a RENDERER
 *    preference, taking a working shell with it.
 */

import { describe, expect, it, vi } from "vitest";
import {
  enableWebglRenderer,
  RendererPreference,
  type WebglAddonConstructor,
  type WebglAddonLike,
} from "../webgl-renderer.js";

/**
 * A terminal stub. The chain's parameter is narrowed to `Pick<Terminal,
 * "loadAddon">`, so this is a complete implementation of what it asks for -
 * no cast, and the compiler still checks the shape against the real class.
 */
function fakeTerminal(loadAddon: (addon: WebglAddonLike) => void = () => undefined) {
  return { loadAddon: vi.fn(loadAddon) };
}

interface FakeAddonHandle {
  readonly ctor: WebglAddonConstructor;
  readonly instances: {
    disposed: boolean;
    fireContextLoss: () => void;
  }[];
}

function fakeAddon(): FakeAddonHandle {
  const instances: FakeAddonHandle["instances"] = [];
  class FakeWebglAddon implements WebglAddonLike {
    #listeners: (() => void)[] = [];
    #record: FakeAddonHandle["instances"][number];
    constructor() {
      this.#record = {
        disposed: false,
        fireContextLoss: () => {
          for (const listener of [...this.#listeners]) listener();
        },
      };
      instances.push(this.#record);
    }
    activate(): void {
      /* xterm calls this through loadAddon; the double needs no behaviour */
    }
    onContextLoss = (listener: () => void): { dispose: () => void } => {
      this.#listeners.push(listener);
      return {
        dispose: () => {
          this.#listeners = this.#listeners.filter((item) => item !== listener);
        },
      };
    };
    dispose = (): void => {
      this.#record.disposed = true;
    };
  }
  return { ctor: FakeWebglAddon, instances };
}

describe("enableWebglRenderer", () => {
  it("attaches the addon on the happy path", async () => {
    const addon = fakeAddon();
    const terminal = fakeTerminal();
    const preference = new RendererPreference();

    const attachment = await enableWebglRenderer({
      terminal,
      loader: () => Promise.resolve(addon.ctor),
      preference,
      isCurrent: () => true,
    });

    expect(attachment).not.toBeNull();
    expect(terminal.loadAddon).toHaveBeenCalledTimes(1);
    expect(preference.suggested).toBe("webgl");
    expect(addon.instances[0]?.disposed).toBe(false);
  });

  it("downgrades this window to the DOM renderer when the addon cannot load", async () => {
    const preference = new RendererPreference();
    const loader = vi.fn(() => Promise.reject(new Error("chunk failed")));
    const fallbacks: string[] = [];

    const first = await enableWebglRenderer({
      terminal: fakeTerminal(),
      loader,
      preference,
      isCurrent: () => true,
      onFallback: (reason) => fallbacks.push(reason),
    });

    expect(first).toBeNull();
    expect(preference.suggested).toBe("dom");
    expect(fallbacks).toEqual(["load_failed"]);

    // The downgrade is what makes the SECOND terminal cheap: it must not even
    // reach the loader again.
    const second = await enableWebglRenderer({
      terminal: fakeTerminal(),
      loader,
      preference,
      isCurrent: () => true,
    });
    expect(second).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("downgrades and disposes when the addon loads but fails to ACTIVATE", async () => {
    const addon = fakeAddon();
    const preference = new RendererPreference();
    const fallbacks: string[] = [];

    const attachment = await enableWebglRenderer({
      terminal: fakeTerminal(() => {
        throw new Error("no webgl2 context");
      }),
      loader: () => Promise.resolve(addon.ctor),
      preference,
      isCurrent: () => true,
      onFallback: (reason) => fallbacks.push(reason),
    });

    expect(attachment).toBeNull();
    expect(preference.suggested).toBe("dom");
    expect(fallbacks).toEqual(["activate_failed"]);
    // The constructed addon holds a context even though activation failed;
    // leaking it is the defect this asserts against.
    expect(addon.instances[0]?.disposed).toBe(true);
  });

  it("DROPS a load whose generation went stale, without constructing the addon", async () => {
    const addon = fakeAddon();
    const terminal = fakeTerminal();
    let current = true;

    const pending = enableWebglRenderer({
      terminal,
      loader: async () => {
        // The terminal is disposed while the import is in flight - the exact
        // race the generation token exists for.
        current = false;
        return addon.ctor;
      },
      preference: new RendererPreference(),
      isCurrent: () => current,
    });

    expect(await pending).toBeNull();
    expect(addon.instances).toHaveLength(0);
    expect(terminal.loadAddon).not.toHaveBeenCalled();
  });

  it("disposes the addon on context loss, which is what returns xterm to DOM", async () => {
    const addon = fakeAddon();
    const fallbacks: string[] = [];

    const attachment = await enableWebglRenderer({
      terminal: fakeTerminal(),
      loader: () => Promise.resolve(addon.ctor),
      preference: new RendererPreference(),
      isCurrent: () => true,
      onFallback: (reason) => fallbacks.push(reason),
    });

    expect(attachment).not.toBeNull();
    expect(addon.instances[0]?.disposed).toBe(false);

    addon.instances[0]?.fireContextLoss();

    expect(fallbacks).toEqual(["context_lost"]);
    expect(addon.instances[0]?.disposed).toBe(true);

    // Disposing the attachment afterwards must not dispose twice.
    attachment?.dispose();
    expect(addon.instances).toHaveLength(1);
  });

  it("never attempts a load once the window is on the DOM renderer", async () => {
    const preference = new RendererPreference();
    preference.downgradeToDom();
    const loader = vi.fn(() => Promise.reject(new Error("should not be called")));

    expect(
      await enableWebglRenderer({
        terminal: fakeTerminal(),
        loader,
        preference,
        isCurrent: () => true,
      }),
    ).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });
});
