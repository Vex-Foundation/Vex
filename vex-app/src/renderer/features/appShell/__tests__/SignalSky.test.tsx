/**
 * SignalSky — jsdom contract tests.
 *
 * jsdom has no WebGL, so the default environment exercises the graceful
 * fallback branch (canvas unmounts, the static gradient div renders). The
 * WebGL happy path is exercised through a minimal mocked GL object plus a
 * reduced-motion matchMedia stub, which pins the deterministic single-
 * static-frame path (no rAF loop to control from the test).
 *
 * The shader module is pure strings — its contract (u_intensity replaces the
 * landing's u_scroll; ink palette; mirrored thresholds) is pinned directly.
 */

import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignalSky } from "../SignalSky.js";
import {
  SKY_ACCENTS,
  SKY_BRIGHT_HEX,
  SKY_FRAGMENT_SHADER,
  SKY_INK_HEX,
  SKY_ROBINHOOD_BRIGHT_HEX,
  SKY_SOFT_HEX,
  SKY_VERTEX_SHADER,
  hexToGlslVec3,
  hexToRgbTriplet,
} from "../signalSkyShaders.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface FakeGlOptions {
  /** getShaderParameter(COMPILE_STATUS) result — false = compile failure. */
  readonly compileOk?: boolean;
  /** getProgramParameter(LINK_STATUS) result — false = link failure. */
  readonly linkOk?: boolean;
}

/** Minimal WebGL double: every method SignalSky touches, as a vi.fn().
 * getUniformLocation echoes the uniform NAME so uniform1f/2f call args are
 * directly assertable. */
function makeFakeGl(options: FakeGlOptions) {
  const compileOk = options.compileOk ?? true;
  const linkOk = options.linkOk ?? true;
  return {
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    COMPILE_STATUS: 35713,
    LINK_STATUS: 35714,
    ARRAY_BUFFER: 34962,
    STATIC_DRAW: 35044,
    FLOAT: 5126,
    TRIANGLES: 4,
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => compileOk),
    getShaderInfoLog: vi.fn(() => "fake compile log"),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => linkOk),
    getProgramInfoLog: vi.fn(() => "fake link log"),
    deleteProgram: vi.fn(),
    useProgram: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    deleteBuffer: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    getUniformLocation: vi.fn((_program: unknown, name: string) => name),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    uniform3f: vi.fn(),
    viewport: vi.fn(),
    drawArrays: vi.fn(),
  };
}

/** Patch HTMLCanvasElement.getContext to hand SignalSky the fake GL. */
function installFakeWebGl(options: FakeGlOptions = {}): ReturnType<typeof makeFakeGl> {
  const gl = makeFakeGl(options);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (contextId: string) =>
      // The double implements exactly the surface SignalSky uses; anything
      // more would silently pass where a real context would throw.
      contextId === "webgl" ? (gl as unknown as WebGLRenderingContext) : null,
  );
  return gl;
}

/** Force the prefers-reduced-motion media query to `matches`. This jsdom
 * build ships NO window.matchMedia at all (SignalSky feature-detects it), so
 * the stub is installed as a global rather than spied onto an existing fn. */
function mockReducedMotion(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList => ({
      matches: query.includes("prefers-reduced-motion") ? matches : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  );
}

describe("SignalSky", () => {
  it("falls back to the static gradient when WebGL is unavailable (jsdom)", () => {
    const view = render(<SignalSky />);

    const root = view.container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.getAttribute("aria-hidden")).toBe("true");
    expect(root?.className).toContain("pointer-events-none");
    expect(root?.className).toContain("absolute");
    expect(root?.className).toContain("z-0");

    // getContext("webgl") returns null in jsdom → canvas unmounts, the
    // gradient sibling renders in its place.
    expect(
      view.container.querySelector("[data-vex-sky-fallback]"),
    ).not.toBeNull();
    expect(view.container.querySelector("canvas")).toBeNull();
  });

  it("mounts and unmounts cleanly, including StrictMode effect replay", () => {
    const view = render(
      <StrictMode>
        <SignalSky intensity={0.5} />
      </StrictMode>,
    );
    expect(() => {
      view.unmount();
    }).not.toThrow();
  });

  it("draws exactly one static frame under reduced motion and repaints on intensity change", () => {
    mockReducedMotion(true);
    const gl = installFakeWebGl();

    const view = render(<SignalSky />);

    // WebGL path: the canvas stays, no fallback.
    expect(view.container.querySelector("[data-vex-sky]")).not.toBeNull();
    expect(view.container.querySelector("[data-vex-sky-fallback]")).toBeNull();

    // FULL STOP: one frame, at the default (full) intensity, time 0, and the
    // default (vex/cobalt) 4-band palette fed to the u_ink/u_soft/u_deep/
    // u_bright uniforms.
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    expect(gl.uniform1f.mock.calls).toContainEqual(["u_intensity", 1]);
    expect(gl.uniform1f.mock.calls).toContainEqual(["u_time", 0]);
    expect(gl.uniform3f.mock.calls).toContainEqual([
      "u_ink",
      ...SKY_ACCENTS.vex.ink,
    ]);
    expect(gl.uniform3f.mock.calls).toContainEqual([
      "u_soft",
      ...SKY_ACCENTS.vex.soft,
    ]);
    expect(gl.uniform3f.mock.calls).toContainEqual([
      "u_deep",
      ...SKY_ACCENTS.vex.deep,
    ]);
    expect(gl.uniform3f.mock.calls).toContainEqual([
      "u_bright",
      ...SKY_ACCENTS.vex.bright,
    ]);

    // Intensity prop change → one more static frame at the new value
    // (no loop exists to ease it).
    view.rerender(<SignalSky intensity={0.35} />);
    expect(gl.drawArrays).toHaveBeenCalledTimes(2);
    expect(gl.uniform1f.mock.calls).toContainEqual(["u_intensity", 0.35]);

    // Unmount releases the GL objects it created.
    view.unmount();
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
  });

  it("clamps an out-of-range intensity prop at the boundary", () => {
    mockReducedMotion(true);
    const gl = installFakeWebGl();

    render(<SignalSky intensity={7} />);

    expect(gl.uniform1f.mock.calls).toContainEqual(["u_intensity", 1]);
  });

  it("feeds the Robinhood accent pair to the u_deep/u_bright uniforms in robinhood theme", () => {
    mockReducedMotion(true);
    const gl = installFakeWebGl();

    render(<SignalSky theme="robinhood" />);

    expect(gl.uniform3f.mock.calls).toContainEqual([
      "u_deep",
      ...SKY_ACCENTS.robinhood.deep,
    ]);
    expect(gl.uniform3f.mock.calls).toContainEqual([
      "u_bright",
      ...SKY_ACCENTS.robinhood.bright,
    ]);
  });

  it("repaints a static frame at the new accent when the theme flips (reduced motion)", () => {
    mockReducedMotion(true);
    const gl = installFakeWebGl();

    const view = render(<SignalSky theme="vex" />);
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);

    view.rerender(<SignalSky theme="robinhood" />);
    // No loop under reduced motion → one more static frame at the lime accent.
    expect(gl.drawArrays).toHaveBeenCalledTimes(2);
    expect(gl.uniform3f.mock.calls).toContainEqual([
      "u_bright",
      ...SKY_ACCENTS.robinhood.bright,
    ]);
  });

  it("falls back to the gradient when shader compilation fails", () => {
    mockReducedMotion(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gl = installFakeWebGl({ compileOk: false });

    const view = render(<SignalSky />);

    expect(
      view.container.querySelector("[data-vex-sky-fallback]"),
    ).not.toBeNull();
    expect(view.container.querySelector("canvas")).toBeNull();
    expect(gl.drawArrays).not.toHaveBeenCalled();
    // The failure is surfaced (not swallowed) and the partial shader freed.
    expect(warn).toHaveBeenCalled();
    expect(gl.deleteShader).toHaveBeenCalled();
  });
});

describe("signalSkyShaders", () => {
  it("drives the sky with u_intensity (u_scroll is gone) over the ink palette", () => {
    expect(SKY_FRAGMENT_SHADER).toContain("uniform float u_intensity");
    expect(SKY_FRAGMENT_SHADER).not.toContain("u_scroll");

    // ALL FOUR posterization bands are now theme-driven uniforms, not baked
    // consts — Hypervexing re-inks the surface bands (bottle-green), so ink/
    // soft were promoted alongside deep/bright. vex/robinhood feed the same
    // navy surface values they baked before, so the change is behavior-
    // preserving for those themes.
    expect(SKY_FRAGMENT_SHADER).toContain(
      "uniform vec3 u_ink; uniform vec3 u_soft; uniform vec3 u_deep; uniform vec3 u_bright;",
    );
    expect(SKY_FRAGMENT_SHADER).not.toContain("const vec3 INK");
    expect(SKY_FRAGMENT_SHADER).not.toContain("const vec3 SOFT");
    expect(SKY_FRAGMENT_SHADER).not.toContain("const vec3 DEEP");
    expect(SKY_FRAGMENT_SHADER).not.toContain("const vec3 BRIGHT");

    // Threshold mapping mirrored from the landing: base <0.46, soft <0.72,
    // deep-accent <0.92, else the bright signal fleck (all four bands now
    // resolve from the uniforms).
    expect(SKY_FRAGMENT_SHADER).toContain(
      "if(dv<0.46)col=u_ink; else if(dv<0.72)col=u_soft; else if(dv<0.92)col=u_deep; else col=u_bright;",
    );

    expect(SKY_VERTEX_SHADER).toContain("gl_Position");
  });

  it("converts #rrggbb to a normalized GLSL vec3 and rejects malformed input", () => {
    expect(hexToGlslVec3("#1f44ff")).toBe("vec3(0.1216,0.2667,1.0000)");
    expect(hexToGlslVec3("#0a0d18")).toBe("vec3(0.0392,0.0510,0.0941)");
    expect(() => hexToGlslVec3("1f44ff")).toThrow(/expected #rrggbb/);
    expect(() => hexToGlslVec3("#fff")).toThrow(/expected #rrggbb/);
  });

  it("exposes per-theme 4-band palettes for the u_ink/u_soft/u_deep/u_bright uniforms", () => {
    // 0..1 RGB triplet form (what uniform3f wants), not the GLSL string form.
    expect(hexToRgbTriplet("#ccff00")).toEqual([204 / 255, 1, 0]);
    expect(() => hexToRgbTriplet("ccff00")).toThrow(/expected #rrggbb/);
    // The neon-lime bright band is the Robinhood signal fleck; vex stays cobalt.
    expect(SKY_ACCENTS.robinhood.bright).toEqual(
      hexToRgbTriplet(SKY_ROBINHOOD_BRIGHT_HEX),
    );
    expect(SKY_ACCENTS.vex.bright).toEqual(hexToRgbTriplet(SKY_BRIGHT_HEX));
    // vex + robinhood share the navy surface pair (ink/soft) — byte-identical
    // to the values baked before the uniform promotion (behavior-preserving).
    expect(SKY_ACCENTS.vex.ink).toEqual(hexToRgbTriplet(SKY_INK_HEX));
    expect(SKY_ACCENTS.vex.soft).toEqual(hexToRgbTriplet(SKY_SOFT_HEX));
    expect(SKY_ACCENTS.robinhood.ink).toEqual(hexToRgbTriplet(SKY_INK_HEX));
    expect(SKY_ACCENTS.robinhood.soft).toEqual(hexToRgbTriplet(SKY_SOFT_HEX));
  });

  it("every SkyTheme has a complete 4-band palette (SignalSky indexes by theme and would crash on a gap)", () => {
    for (const palette of Object.values(SKY_ACCENTS)) {
      for (const band of [palette.ink, palette.soft, palette.deep, palette.bright]) {
        expect(band).toHaveLength(3);
        for (const channel of band) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
    }
    // The Hypervexing entry MUST exist before the theme value can occur — the
    // sky indexes accents by theme, so a missing entry is a runtime crash.
    // Ink-first re-ink (2026-07-13): the bright fleck band is the venue
    // turquoise #4FD1C5, not the retired pastel mint.
    expect(SKY_ACCENTS.hypervexing.bright).toEqual([79 / 255, 209 / 255, 197 / 255]);
    expect(Object.keys(SKY_ACCENTS).sort()).toEqual([
      "hypervexing",
      "robinhood",
      "vex",
    ]);
  });
});
