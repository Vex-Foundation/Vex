/**
 * Signal Sky shader source — the landing page's procedural WebGL dither sky
 * (vex-landing-final-main/index-new.html, the #ditherbg IIFE), RECOLORED for
 * the shell's ink canvas. Pure module: strings + palette constants only, no
 * DOM/GL access, so it stays trivially unit-testable.
 *
 * Structure is a 1:1 port of the landing scene: value-noise fbm clouds +
 * rising flecks, posterized to a 4-color palette through 4x4 ordered (Bayer)
 * dithering. Two deliberate differences from the landing source:
 *
 *   1. Palette inverted for ink. The landing paints on paper
 *      (PAPER→SOFT→BLUE→DEEP as dv rises); the shell paints on ink, so the
 *      same thresholds map INK→SOFT→DEEP-BLUE→BRIGHT — the brightest band
 *      (#1f44ff, the accent root) is the sparks, not the shadows.
 *   2. `u_scroll` is dropped (the shell has no page scroll) and replaced by
 *      `u_intensity` (0..1), which scales the animated cloud + fleck terms:
 *      1 = full sky on the welcome stage, ~0.35 = dimmed behind an active
 *      session transcript. The static top-bias gradient stays unscaled so a
 *      dim sky still reads as a lit room, not a dead screen.
 *
 * 100% generated in-shader — no source imagery, no network fetch (CSP-safe).
 */

/* Sky palette — ALL FOUR posterization bands are now per-theme u_* uniforms
 * fed by SignalSky, so a theme flip crossfades the whole scene without a
 * recompile. The two SURFACE bands (ink / soft) were baked consts while both
 * themes shared the navy canvas; Hypervexing's canvas is bottle-green, and a
 * navy cloud band under a green UI reads as a broken screen — so ink/soft were
 * promoted to u_ink / u_soft alongside the existing u_deep / u_bright. The vex
 * and robinhood values stay byte-for-byte identical (the shared navy pair), so
 * this is behavior-preserving for the two existing themes.
 *
 * SKY_INK_HEX / SKY_SOFT_HEX = the shared navy surface pair (--vex-surface-0/-2
 * on the navy canvas); SKY_DEEP_HEX / SKY_BRIGHT_HEX = the VEX (cobalt) accent
 * pair; the Robinhood and Hypervexing pairs sit alongside. */
export const SKY_INK_HEX = "#0a0d18";
export const SKY_SOFT_HEX = "#11162a";
export const SKY_DEEP_HEX = "#0a23b8";
export const SKY_BRIGHT_HEX = "#1f44ff";
/** Robinhood accent pair — a dim olive-lime rising to the neon #ccff00. */
export const SKY_ROBINHOOD_DEEP_HEX = "#4d6300";
export const SKY_ROBINHOOD_BRIGHT_HEX = "#ccff00";
/** Hypervexing — "ink first, mint as signal" (2026-07-13 re-ink): charcoal
 * bands matched to --vex-surface-0/-2 (#0A0F11/#121C20), one deep-teal accent
 * band as the brand whisper, rising to sparse turquoise flecks. The sky is
 * the ONLY place the green identity breathes behind the glass — quiet by
 * design, never wallpaper. */
export const SKY_HYPERVEXING_INK_HEX = "#0a0f11";
export const SKY_HYPERVEXING_SOFT_HEX = "#121c20";
export const SKY_HYPERVEXING_DEEP_HEX = "#124b3d";
export const SKY_HYPERVEXING_BRIGHT_HEX = "#4fd1c5";

export type SkyTheme = "vex" | "robinhood" | "hypervexing";

/** RGB channels normalized to 0..1 — the form uniform3f wants. */
export type RgbTriplet = readonly [number, number, number];

export interface SkyAccentPalette {
  /** The base posterization band (dv < 0.46) — the canvas ink. */
  readonly ink: RgbTriplet;
  /** The second band (dv 0.46..0.72) — the soft cloud shoulder. */
  readonly soft: RgbTriplet;
  /** The lower accent band (dv 0.72..0.92). */
  readonly deep: RgbTriplet;
  /** The brightest signal fleck (dv > 0.92). */
  readonly bright: RgbTriplet;
}

/** Convert `#rrggbb` to a normalized `vec3(r,g,b)` GLSL literal. Throws on
 * malformed input — the inputs are module constants, so a typo fails loudly
 * at module load instead of compiling a silently-wrong shader. */
export function hexToGlslVec3(hex: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`hexToGlslVec3: expected #rrggbb, got "${hex}"`);
  }
  const channel = (offset: number): string =>
    (Number.parseInt(hex.slice(offset, offset + 2), 16) / 255).toFixed(4);
  return `vec3(${channel(1)},${channel(3)},${channel(5)})`;
}

/** Convert `#rrggbb` to a normalized `[r,g,b]` (0..1) triplet for uniform3f.
 * Throws on malformed input (module-constant inputs → loud failure). */
export function hexToRgbTriplet(hex: string): RgbTriplet {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`hexToRgbTriplet: expected #rrggbb, got "${hex}"`);
  }
  const channel = (offset: number): number =>
    Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return [channel(1), channel(3), channel(5)];
}

/** Per-theme 4-band palette fed to u_ink / u_soft / u_deep / u_bright. vex and
 * robinhood share the navy surface pair (ink/soft) — identical to the values
 * baked before ink/soft were promoted to uniforms. */
export const SKY_ACCENTS: Record<SkyTheme, SkyAccentPalette> = {
  vex: {
    ink: hexToRgbTriplet(SKY_INK_HEX),
    soft: hexToRgbTriplet(SKY_SOFT_HEX),
    deep: hexToRgbTriplet(SKY_DEEP_HEX),
    bright: hexToRgbTriplet(SKY_BRIGHT_HEX),
  },
  robinhood: {
    ink: hexToRgbTriplet(SKY_INK_HEX),
    soft: hexToRgbTriplet(SKY_SOFT_HEX),
    deep: hexToRgbTriplet(SKY_ROBINHOOD_DEEP_HEX),
    bright: hexToRgbTriplet(SKY_ROBINHOOD_BRIGHT_HEX),
  },
  hypervexing: {
    ink: hexToRgbTriplet(SKY_HYPERVEXING_INK_HEX),
    soft: hexToRgbTriplet(SKY_HYPERVEXING_SOFT_HEX),
    deep: hexToRgbTriplet(SKY_HYPERVEXING_DEEP_HEX),
    bright: hexToRgbTriplet(SKY_HYPERVEXING_BRIGHT_HEX),
  },
};

/** Fullscreen pass-through vertex shader (one oversized triangle). */
export const SKY_VERTEX_SHADER =
  "attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}";

/** Fragment shader — landing #ditherbg body with the ink palette and the
 * u_scroll → u_intensity substitution described in the header. */
export const SKY_FRAGMENT_SHADER = [
  "precision highp float;",
  "uniform vec2 u_res; uniform float u_time; uniform float u_intensity;",
  "uniform vec3 u_ink; uniform vec3 u_soft; uniform vec3 u_deep; uniform vec3 u_bright;",
  "float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}",
  "float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);",
  "  float a=hash(i),b=hash(i+vec2(1.0,0.0)),c=hash(i+vec2(0.0,1.0)),d=hash(i+vec2(1.0,1.0));",
  "  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}",
  "float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<5;i++){v+=a*vnoise(p);p*=2.0;a*=0.5;}return v;}",
  "float bayer4(vec2 c){",
  "  int x=int(mod(c.x,4.0)),y=int(mod(c.y,4.0));int i=x+y*4;",
  "  float t=0.0;",
  "  if(i==0)t=0.0;else if(i==1)t=8.0;else if(i==2)t=2.0;else if(i==3)t=10.0;",
  "  else if(i==4)t=12.0;else if(i==5)t=4.0;else if(i==6)t=14.0;else if(i==7)t=6.0;",
  "  else if(i==8)t=3.0;else if(i==9)t=11.0;else if(i==10)t=1.0;else if(i==11)t=9.0;",
  "  else if(i==12)t=15.0;else if(i==13)t=7.0;else if(i==14)t=13.0;else t=5.0;",
  "  return (t+0.5)/16.0;}",
  "void main(){",
  "  vec2 uv=gl_FragCoord.xy/u_res;",
  "  vec2 p=uv; p.x*=u_res.x/u_res.y;",
  "  float t=u_time*0.025;",
  "  float clouds=fbm(p*2.0+vec2(t,t*0.3));",
  "  float clouds2=fbm(p*4.2-vec2(t*0.6,0.0));",
  "  float topBias=smoothstep(0.15,1.05,uv.y);",
  "  float v=topBias*0.62+(clouds*0.5+clouds2*0.2)*u_intensity-0.18;",
  "  vec2 pp=p*6.5+vec2(sin(t)*0.4,-t*2.2);",
  "  float petal=smoothstep(0.74,0.9,fbm(pp));",
  "  v+=petal*0.30*u_intensity;",
  "  float thr=bayer4(gl_FragCoord.xy);",
  "  float dv=clamp(v,0.0,1.0)+(thr-0.5)*0.20;",
  "  vec3 col;",
  "  if(dv<0.46)col=u_ink; else if(dv<0.72)col=u_soft; else if(dv<0.92)col=u_deep; else col=u_bright;",
  "  gl_FragColor=vec4(col,1.0);",
  "}",
].join("\n");
