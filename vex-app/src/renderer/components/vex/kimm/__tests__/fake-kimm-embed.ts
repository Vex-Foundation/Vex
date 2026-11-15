/**
 * A stand-in for her embed (`kimm-embed.ts`) for the live tests: jsdom has no WebGL and loads no script, so the
 * tests hand `createKimmLive` this through its loaders and read what it was asked to do. Never imported by the app.
 */

import type { KimmEmbed, KimmEmbedOptions } from "../kimm-embed.js";
import type { KimmFitOptions } from "../kimm-fit.js";
import type { KimmEvent, KimmLiveMood } from "../kimm-live-moods.js";
import type { KimmLiveLoaders, KimmPageMemory } from "../kimm-live.js";

export interface FakeEmbed {
  readonly el: HTMLElement;
  readonly options: KimmEmbedOptions;
  readonly calls: string[];
  readonly events: KimmEvent[];
  readonly moods: Array<{ readonly name: KimmLiveMood; readonly ms: number | undefined }>;
  readonly fits: Array<KimmFitOptions | undefined>;
  awake: boolean;
  destroyed: boolean;
  /** The last `lively()` value (the mount option until then). */
  lively: boolean;
  /** Settle `ready`: true (she is on screen) or false (a file or a library failed). */
  settle(ok: boolean): void;
}

export interface FakeEmbedKit {
  readonly loaders: KimmLiveLoaders;
  readonly mounts: FakeEmbed[];
  readonly page: KimmPageMemory;
  /** How many times the loader was called. */
  loads: number;
  /** The loader throws (a missing chunk). */
  failLoad: boolean;
  /** Each embed settles `ready` at once with this value; `null` leaves it pending until `settle`. */
  autoReady: boolean | null;
}

export function fakeEmbedKit(): FakeEmbedKit {
  const kit: FakeEmbedKit = {
    mounts: [],
    page: { failed: false },
    loads: 0,
    failLoad: false,
    autoReady: true,
    loaders: {
      embed: async () => {
        kit.loads += 1;
        if (kit.failLoad) throw new Error("chunk failed");
        return {
          mountKimm: (el: HTMLElement, options: KimmEmbedOptions): KimmEmbed => {
            let settle: (ok: boolean) => void = () => undefined;
            const ready = new Promise<boolean>((resolve) => {
              settle = resolve;
            });
            const fake: FakeEmbed = {
              el,
              options,
              calls: [],
              events: [],
              moods: [],
              fits: [],
              awake: false,
              destroyed: false,
              lively: options.lively === true,
              settle: (ok) => settle(ok),
            };
            kit.mounts.push(fake);
            if (kit.autoReady !== null) settle(kit.autoReady);
            return {
              ready,
              on: (event) => {
                fake.events.push(event);
              },
              mood: (name, ms) => {
                fake.moods.push({ name, ms });
              },
              look: () => undefined,
              talk: () => undefined,
              param: () => undefined,
              refit: (fit) => {
                fake.fits.push(fit);
              },
              sleep: () => {
                fake.calls.push("sleep");
                fake.awake = false;
              },
              wake: () => {
                fake.calls.push("wake");
                fake.awake = true;
              },
              step: () => undefined,
              get awake() {
                return fake.awake;
              },
              lively: (on) => {
                fake.calls.push(on ? "lively" : "calm");
                fake.lively = on;
              },
              destroy: () => {
                fake.calls.push("destroy");
                fake.destroyed = true;
              },
            };
          },
        };
      },
    },
  };
  return kit;
}

/** A GPU that passes the gate. */
export const GOOD_GPU = () => ({ webgl2: true, maxTextureSize: 16384 });

/** Let every pending promise settle. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}
