/**
 * The K2 host (`VexK2.tsx`) re-fitting her for the morning coffee, with the engine stood in for (it
 * records what it is handed). Regressions this catches: a host that keeps the bust's necklace cut
 * while the engine reports the mug, or keeps the lower cut once the mug is gone; a stage (the wide
 * drawing) that takes the coffee's cut; and a coffee cut that wins over the approval palm's.
 */

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { K2EngineOptions } from "../k2-engine.js";
import { BUST, type Fit } from "../k2-rig.js";

/** Each engine the host made: its options and every fit it was handed. */
const made: { readonly o: K2EngineOptions; readonly fits: Fit[] }[] = [];

vi.mock("../k2-engine.js", () => ({
  K2Engine: class {
    readonly o: K2EngineOptions;
    readonly fits: Fit[] = [];
    constructor(o: K2EngineOptions) {
      this.o = o;
      made.push(this);
    }
    setFit(fit: Fit): void {
      this.fits.push(fit);
    }
    setEmotion(): void {}
    setHover(): void {}
    setMorning(): void {}
    setDark(): void {}
    setGround(): void {}
    setClosed(): void {}
    setTokenOnly(): void {}
    start(): Promise<void> {
      return Promise.resolve();
    }
    destroy(): void {}
  },
}));

const { VexK2 } = await import("../VexK2.js");

let width: ReturnType<typeof vi.spyOn> | null = null;
let height: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  made.length = 0;
  width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
  height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(284);
});

afterEach(() => {
  width?.mockRestore();
  height?.mockRestore();
});

/** The engine reports the mug shown or gone; the host re-fits after that frame. */
async function report(on: boolean): Promise<void> {
  await act(async () => {
    made[0]?.o.onCoffee?.(on);
    await Promise.resolve();
  });
}

const lastFit = (): Fit | undefined => made[0]?.fits.at(-1);

describe("VexK2 and the coffee's cut", () => {
  it.each(["welcome", "sidebar"] as const)(
    "on the %s bust the mug's report re-fits her with the cut under the mug, and back once it is gone",
    async (placement) => {
      render(<VexK2 placement={placement} ground="paper" morning />);
      expect(lastFit()?.rig.coffee).toBe(false);
      expect(lastFit()?.rig.cut?.bottom).toBe(BUST.cut.y);
      await report(true);
      expect(lastFit()?.rig.coffee).toBe(true);
      expect(lastFit()?.rig.cut?.bottom).toBe(BUST.coffeeCut.y);
      await report(false);
      expect(lastFit()?.rig.coffee).toBe(false);
      expect(lastFit()?.rig.cut?.bottom).toBe(BUST.cut.y);
    },
  );

  it("the stage's wide drawing never takes the coffee's cut", async () => {
    render(<VexK2 placement="stage" ground="print" morning />);
    await report(true);
    expect(lastFit()?.rig.drawing).toBe("wide");
    expect(lastFit()?.rig.coffee).toBe(false);
    expect(lastFit()?.rig.cut).toBeNull();
  });

  it("the approval palm's cut wins over the coffee's", async () => {
    render(<VexK2 placement="sidebar" ground="print" emotion="approval" morning />);
    await report(true);
    expect(lastFit()?.rig.palm).toBe(true);
    expect(lastFit()?.rig.coffee).toBe(false);
    expect(lastFit()?.rig.cut?.bottom).toBe(BUST.palmCut.y);
  });
});
