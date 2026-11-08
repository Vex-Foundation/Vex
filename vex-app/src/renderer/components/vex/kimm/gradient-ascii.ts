/* Gradient ASCII background, ported to vanilla JS from React Bits (github.com/DavidHDev/react-bits, src/content/Backgrounds/GradientASCII).
   Copyright (c) 2026 David Haz. MIT + Commons Clause License Condition v1.0: use, copy, modify as part of a website or product.
   Usage: const bg = GradientASCII(containerEl, { colors, shape, characters, cellSize, ... }); bg.dispose(); */
/* In this port the function is `mountGradientAscii` (a lower-case name: it is not a React component). */
/* The licence's full text: GRADIENT-ASCII-LICENSE.md beside this file; THIRD_PARTY_NOTICES.md "Gradient ASCII". */

/**
 * HER LIVE GLYPH FIELD, THE DRAWING (docs/design/H3-DESKTOP.md sections 1.5,
 * 3.2 and 3.5; MOTION-POLICY.md "Kimm's glyph field"). VEX Cloud's port
 * (`apps/web/src/components/kimm/gradient-ascii.ts`, from the H3 mockup's
 * `js/vendor/gradient-ascii.mjs`), with its values, shaders and behaviour
 * unchanged: WebGL2 only, plain canvas code (no eval, no wasm, no
 * worker), so the renderer's CSP is untouched. It stops drawing when hidden
 * or off screen; reduced motion and `still` freeze its time and draw one
 * frame. Desktop changes: the indent, and the options type lives in
 * `kimm-field.ts`. `KimmField.tsx` mounts it, reached only through a dynamic
 * import, and drives `setStill` from desktop's run gate and still frame.
 */
import type { GradientAsciiOptions } from "./kimm-field.js";

const MAX_COLORS = 8;
const MAX_CLICKS = 4;
const MAX_TRAIL = 24;
const CLICK_LIFE = 1.2;
const TRAIL_LIFE = 0.7;
const TRAIL_STEP = 0.015;
const INTRO_SECONDS = 2.4;
const ATLAS_CELL_W = 60;
const ATLAS_CELL_H = 100;
const ATLAS_COLUMNS = 16;
const FONT_SCALE = 0.78;
const DEFAULT_COLORS = ["#1e3fd8", "#f6f8ff", "#a5d8ff", "#38bdf8"];
const DEFAULT_CHARACTERS = " =+xX0S8#@";
const DEFAULT_FONT =
  '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SHAPES = { horizon: 0, pinch: 1, rise: 2, eclipse: 3 } as const;
const CLICK_EFFECTS = { none: 0, wave: 1, burst: 2 } as const;

const VERTEX = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMMON = `
float hash12(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
`;

const FIELD = `#version 300 es
precision highp float;
precision highp int;
uniform float uAspect;
uniform float uTime;
uniform int uShape;
uniform vec3 uRamp[8];
uniform int uCount;
uniform float uScale;
uniform float uSoftness;
uniform float uFlow;
uniform vec2 uSeed;
uniform vec4 uTrail[24];
uniform float uRadius;
uniform vec4 uClicks[4];
uniform int uClickEffect;
uniform float uIntro;
uniform float uFrame;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outAux;
${COMMON}
vec2 hash22(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.103, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy) * 2.0 - 1.0;
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash22(i), f);
  float b = dot(hash22(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(hash22(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(hash22(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return 0.5 + 0.5 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec3 labToRgb(vec3 lab) {
  float l = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  l = l * l * l;
  m = m * m * m;
  s = s * s * s;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
}

vec3 encode(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

vec3 horizon(vec2 p, float time, out float order) {
  float span = 0.5 * max(uAspect, 1.0);
  float x = p.x / span;
  float arch = -0.17 - 0.2 * x * x + 0.02 * sin(time * 0.6);
  float soft = mix(0.05, 0.22, uSoftness);
  float edge = p.y - arch;
  float rim = 0.38 * smoothstep(-soft, 0.42, edge);
  vec2 sun = vec2(0.08 * sin(time * 0.31) * span, 0.58);
  float spread = length((p - sun) / vec2(0.95 * span, 0.75));
  float sky = mix(0.55, 1.0, smoothstep(0.2, 0.95, spread));
  order = clamp(edge * 1.3, 0.0, 1.0);
  return vec3(rim, sky, smoothstep(0.18, 0.62, edge));
}

vec3 pinch(vec2 p, float time, out float order) {
  float span = 0.5 * max(uAspect, 0.75);
  float x = p.x / span;
  float sway = 0.02 * sin(x * 1.7 + time * 0.55);
  float breathe = 1.0 + 0.06 * sin(time * 0.8);
  float width = (0.13 + 0.22 * x * x) * breathe * mix(0.85, 1.2, uSoftness);
  float y = abs(p.y - sway) / width;
  float t = exp(-pow(y, 2.2)) * (0.42 + 0.58 * exp(-x * x * 1.8));
  order = clamp(abs(p.y - sway) * 2.4 + abs(x) * 0.3, 0.0, 1.0);
  return vec3(t, t, 0.0);
}

vec3 rise(vec2 p, float time, out float order) {
  float wide = max(uAspect, 0.9);
  vec2 center = vec2(0.05 * sin(time * 0.45) * wide, -0.7);
  vec2 radius = vec2(0.82 * wide, 0.64 * (1.0 + 0.04 * sin(time * 0.8)));
  float d = length((p - center) / radius);
  float soft = mix(0.6, 1.15, uSoftness);
  float t = clamp(pow(clamp(1.0 - d, 0.0, 1.0), soft) * 1.35, 0.0, 1.0);
  order = clamp((d - 0.2) * 1.3, 0.0, 1.0);
  return vec3(t, t, 0.0);
}

vec3 eclipse(vec2 p, float time, out float order) {
  float fit = min(1.0, uAspect * 1.25);
  float r = 0.23 * fit * (1.0 + 0.015 * sin(time * 0.9));
  float angle = atan(p.y, p.x);
  float rays = noise(vec2(cos(angle), sin(angle)) * 2.2 + time * 0.08) * 0.8 + 0.6;
  float d = length(p) - r;
  float reach = mix(0.07, 0.15, uSoftness) * rays * fit;
  float t = smoothstep(-0.006, 0.006 + 0.02 * uSoftness, d) * exp(-max(d, 0.0) / reach);
  order = clamp(d * 2.0, 0.0, 1.0);
  return vec3(t, t, 0.0);
}

vec4 tone(float t) {
  float x = smoothstep(0.3, 1.0, t) * float(uCount - 1);
  int index = int(floor(x));
  return vec4(mix(uRamp[index], uRamp[min(index + 1, uCount - 1)], fract(x)), smoothstep(0.0, 0.38, t));
}

void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float time = uTime;
  vec2 q = p / uScale;
  vec2 warp = vec2(
    noise(q * 1.6 + uSeed + vec2(0.0, time * 0.3)),
    noise(q * 1.6 + uSeed.yx + vec2(4.3, -time * 0.24))
  ) - 0.5;
  q += warp * uFlow * (uShape == 3 ? 0.04 : 0.18);
  float order = 0.0;
  vec3 shape;
  if (uShape == 0) shape = horizon(q, time, order);
  else if (uShape == 1) shape = pinch(q, time, order);
  else if (uShape == 2) shape = rise(q, time, order);
  else shape = eclipse(q, time, order);

  float reveal = clamp((uIntro * 1.45 - order) / 0.45, 0.0, 1.0);
  reveal = reveal * reveal * (3.0 - 2.0 * reveal);

  float scramble = 0.0;
  for (int i = 0; i < 24; i++) {
    vec4 point = uTrail[i];
    if (point.z <= 0.0) continue;
    vec2 d = p - point.xy;
    scramble = max(scramble, point.z * exp(-dot(d, d) / (uRadius * uRadius)));
  }
  for (int i = 0; i < 4; i++) {
    vec4 c = uClicks[i];
    if (c.w <= 0.0) continue;
    float d = length(p - c.xy);
    if (uClickEffect == 1) {
      scramble = max(scramble, exp(-pow((d - c.z * 0.75) / 0.06, 2.0)) * c.w);
    } else if (uClickEffect == 2) {
      float size = 0.08 + 0.22 * (1.0 - exp(-c.z * 5.0));
      scramble = max(scramble, (1.0 - smoothstep(size * 0.6, size, d)) * c.w);
    }
  }
  vec2 t = clamp(shape.xy * mix(0.7, 1.0, reveal), 0.0, 1.0);
  vec4 mixed = mix(tone(t.x), tone(t.y), shape.z);
  vec3 color = encode(labToRgb(mixed.rgb));
  float alpha = mixed.a * reveal;
  float dither = (hash12(gl_FragCoord.xy + uFrame * 13.7) - 0.5) / 255.0;
  outColor = clamp(vec4(color * alpha + dither, alpha + dither), 0.0, 1.0);
  outAux = vec4(reveal, scramble, 0.0, 1.0);
}`;

const GLYPHS = `
uniform sampler2D uField;
uniform sampler2D uAux;
uniform sampler2D uAtlas;
uniform vec2 uResolution;
uniform vec2 uCell;
uniform vec2 uOffset;
uniform vec2 uAtlasGrid;
uniform float uCount;
uniform float uDensity;
uniform float uOpacity;
uniform float uFlicker;
uniform float uDepth;
uniform float uGlyphTime;
uniform float uSeedValue;
uniform float uLight;
${COMMON}
float sampleGlyph(float index, vec2 local, vec2 coord, float soft) {
  float column = mod(index, uAtlasGrid.x);
  float row = floor(index / uAtlasGrid.x);
  vec2 atlasUv = vec2((column + local.x) / uAtlasGrid.x, (row + 1.0 - local.y) / uAtlasGrid.y);
  vec2 continuous = coord / uAtlasGrid;
  float scale = exp2(soft);
  return textureGrad(uAtlas, atlasUv, dFdx(continuous) * scale, dFdy(continuous) * scale).a;
}

vec4 glyphAt(vec2 px) {
  vec2 coord = (px - uOffset) / uCell;
  vec2 cell = floor(coord);
  vec2 local = coord - cell;
  vec2 uv = clamp(((cell + 0.5) * uCell + uOffset) / uResolution, vec2(0.0), vec2(1.0));
  vec4 field = texture(uField, uv);
  vec4 aux = texture(uAux, uv);
  vec3 visible = uLight > 0.5 ? field.rgb + (1.0 - field.a) : field.rgb;
  float luma = dot(visible, vec3(0.2126, 0.7152, 0.0722));
  float value = uLight > 0.5 ? clamp((1.0 - luma) * 1.5, 0.0, 1.0) : luma;
  float pick = hash12(cell + uSeedValue * 7.31);
  float level = hash12(cell * 1.73 + 4.1 + uSeedValue);
  float tick = floor(uGlyphTime * 9.0 + level * 9.0);
  float wobble = (hash12(cell * 2.31 + tick * 17.7) - 0.5) * uFlicker * 0.4 + (level - 0.5) * 0.1;
  float tone = clamp(pow(value, 0.75) + wobble, 0.0, 1.0);
  /* VEX: each cell holds one of V, E, X, picked per cell, so the three letters mix evenly; tone still sets brightness */
  float index = 1.0 + min(uCount - 2.0, floor(level * (uCount - 1.0)));
  float decode = max(aux.g, 1.0 - aux.r);
  if (decode > 0.02) {
    float frame = floor(uGlyphTime * 20.0);
    if (hash12(cell * 3.7 + frame * 5.3) < decode * 1.25) index = 1.0 + floor(hash12(cell + frame * 1.37) * (uCount - 1.0));
  }
  /* VEX: glyphs gather toward the corners and clear out around the middle, where Kimm stands */
  vec2 q = abs(uv * 2.0 - 1.0);
  float corner = smoothstep(0.75, 1.38, length(q));
  float present = step(pick, uDensity * mix(1.0, 0.3 + tone * 1.1, 0.55) * (0.05 + 2.4 * corner * corner));
  float cutoff = smoothstep(0.03, 0.1, value);
  float focus = step(hash12(cell * 0.71 + 9.2 + uSeedValue), uDepth);
  float coverage = sampleGlyph(index, local, coord, focus * 1.2);
  float alpha = uOpacity * present * cutoff * coverage * mix(1.0, 0.35 + 0.65 * level, 0.55) * (1.0 - focus * 0.5);
  if (uLight < 0.5) {
    vec3 light = field.rgb * 0.55 + vec3(0.03) * field.a;
    return vec4(light * alpha, 0.6 * field.a * alpha);
  }
  vec3 ink = visible * 0.8;
  return vec4(ink * alpha, alpha);
}
`;

const HALO = `#version 300 es
precision highp float;
uniform float uDownscale;
in vec2 vUv;
out vec4 outColor;
${GLYPHS}
void main() {
  outColor = glyphAt(gl_FragCoord.xy * uDownscale);
}`;

const BLUR = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uStep;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 sum = texture(uSource, vUv) * 0.2270270270;
  sum += texture(uSource, vUv + uStep * 1.3846153846) * 0.3162162162;
  sum += texture(uSource, vUv - uStep * 1.3846153846) * 0.3162162162;
  sum += texture(uSource, vUv + uStep * 3.2307692308) * 0.0702702703;
  sum += texture(uSource, vUv - uStep * 3.2307692308) * 0.0702702703;
  outColor = sum;
}`;

const COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D uHalo;
uniform float uGlow;
uniform float uGradient;
uniform float uGrain;
uniform float uFrame;
in vec2 vUv;
out vec4 outColor;
${GLYPHS}
void main() {
  vec4 base = texture(uField, vUv) * uGradient;
  vec4 glyph = glyphAt(gl_FragCoord.xy);
  vec4 halo = texture(uHalo, vUv) * uGlow;
  vec4 color;
  if (uLight < 0.5) {
    color = base + glyph + halo;
  } else {
    color = glyph + base * (1.0 - glyph.a);
    color += halo * 0.6 * (1.0 - color.a);
  }
  float grain = (hash12(gl_FragCoord.xy + uFrame * vec2(17.0, 59.0)) + hash12(gl_FragCoord.xy * 1.31 + uFrame * 7.0) - 1.0) * uGrain;
  float body = clamp(color.a, 0.0, 1.0);
  color.rgb += grain * (0.25 + body) * 0.5;
  color.a = clamp(color.a, 0.0, 1.0);
  color.rgb = clamp(color.rgb, 0.0, color.a);
  outColor = color;
}`;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const toLinear = (value: number) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

const toLab = ([r, g, b]: readonly [number, number, number]): number[] => {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};

type Gl = WebGL2RenderingContext;

interface Program {
  readonly program: WebGLProgram;
  readonly uniforms: Record<string, WebGLUniformLocation | null>;
}

interface Target {
  readonly textures: WebGLTexture[];
  readonly framebuffer: WebGLFramebuffer | null;
  width: number;
  height: number;
}

interface Atlas {
  readonly texture: WebGLTexture | null;
  readonly count: number;
  readonly grid: readonly [number, number];
}

const compile = (gl: Gl, type: number, source: string) => {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
};

const link = (gl: Gl, fragmentSource: string): Program | null => {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, "");
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return { program, uniforms };
};

const createTarget = (gl: Gl, count: number): Target => {
  const textures = Array.from({ length: count }, () => {
    const texture = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  });
  return { textures, framebuffer: gl.createFramebuffer(), width: 0, height: 0 };
};

const sizeTarget = (gl: Gl, target: Target, width: number, height: number) => {
  if (target.width === width && target.height === height) return;
  target.width = width;
  target.height = height;
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  target.textures.forEach((texture, i) => {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0 + i,
      gl.TEXTURE_2D,
      texture,
      0,
    );
  });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
};

const buildAtlas = (gl: Gl, characters: string, fontFamily: string): Atlas => {
  const list = [
    ...new Set(
      [...characters].filter((char) => char !== "\n" && char !== "\r"),
    ),
  ];
  if (!list.length) list.push(" ");
  const font = `300 ${Math.round(ATLAS_CELL_H * FONT_SCALE)}px ${fontFamily}`;
  const columns = Math.min(ATLAS_COLUMNS, list.length);
  const rows = Math.ceil(list.length / columns);
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_CELL_W * columns;
  canvas.height = ATLAS_CELL_H * rows;
  const context = canvas.getContext("2d");
  if (context) {
    context.font = font;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#fff";
    list.forEach((char, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      context.fillText(
        char,
        column * ATLAS_CELL_W + ATLAS_CELL_W / 2,
        row * ATLAS_CELL_H + ATLAS_CELL_H / 2 + 3,
      );
    });
  }
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { texture, count: list.length, grid: [columns, rows] };
};

/** The handle of a mounted field. `drawn` is false when WebGL2 or a shader was not available (nothing was drawn). */
export interface GradientAsciiHandle {
  readonly drawn: boolean;
  dispose(): void;
  wake(): void;
  setStill(on: boolean): void;
}

export function mountGradientAscii(
  container: HTMLElement,
  {
    colors = DEFAULT_COLORS,
    shape = "horizon",
    characters = DEFAULT_CHARACTERS,
    cellSize = 18,
    density = 0.8,
    glyphOpacity = 0.85,
    glow = 0.2,
    depthOfField = 0,
    flicker = 0.2,
    softness = 0.5,
    scale = 1,
    flow = 0.5,
    speed = 1,
    gradientOpacity = 0.9,
    grain = 0.08,
    variation = 0,
    mouseInteraction = true,
    scrambleRadius = 0.1,
    clickEffect = "wave",
    intro = true,
    still = false,
    lightMode = false,
    fontFamily = DEFAULT_FONT,
    dpr,
  }: GradientAsciiOptions = {},
): GradientAsciiHandle {
  const canvas = document.createElement("canvas");
  canvas.className = "gradient-ascii-canvas";
  canvas.setAttribute("aria-hidden", "true");
  container.appendChild(canvas);
  let wakeFn: (() => void) | null = null;
  let stillFn: ((on: boolean) => void) | null = null;
  const palette = (
    Array.isArray(colors) && colors.length ? colors : DEFAULT_COLORS
  ).slice(0, MAX_COLORS);
  const settings = {
    colors: palette.length > 1 ? palette : [palette[0], palette[0]],
    shape: SHAPES[shape] ?? 0,
    characters: characters || DEFAULT_CHARACTERS,
    cellSize: clamp(cellSize, 6, 64),
    density: clamp(density, 0, 1),
    glyphOpacity: clamp(glyphOpacity, 0, 1),
    glow: clamp(glow, 0, 2),
    depthOfField: clamp(depthOfField, 0, 1),
    flicker: clamp(flicker, 0, 1),
    softness: clamp(softness, 0, 1),
    scale: clamp(scale, 0.4, 2.5),
    flow: clamp(flow, 0, 2),
    speed: Math.max(0, speed),
    gradientOpacity: clamp(gradientOpacity, 0, 1),
    grain: clamp(grain, 0, 0.4),
    variation: Math.max(0, variation),
    mouseInteraction,
    scrambleRadius: clamp(scrambleRadius, 0.02, 0.4),
    clickEffect: CLICK_EFFECTS[clickEffect] ?? 1,
    intro,
    lightMode,
    fontFamily: fontFamily || DEFAULT_FONT,
    dpr,
  };

  const dispose = ((): (() => void) | undefined => {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) return undefined;

    const field = link(gl, FIELD);
    const halo = link(gl, HALO);
    const blur = link(gl, BLUR);
    const composite = link(gl, COMPOSITE);
    if (!field || !halo || !blur || !composite) {
      /* a shader that failed to link leaves no context behind: the programs that linked and the context go now */
      for (const item of [field, halo, blur, composite])
        if (item) gl.deleteProgram(item.program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return undefined;
    }
    const vao = gl.createVertexArray();
    /* WebGL's `useProgram` is no React hook; one call site keeps a hook rule quiet */
    const bindProgram = (item: Program) =>
      gl.useProgram(item.program);
    const fieldTarget = createTarget(gl, 2);
    const haloA = createTarget(gl, 1);
    const haloB = createTarget(gl, 1);

    const probe = document
      .createElement("canvas")
      .getContext("2d", { willReadFrequently: true });
    const colorCache = new Map<string, [number, number, number]>();
    const parse = (value: string): [number, number, number] => {
      const key = String(value);
      const cached = colorCache.get(key);
      if (cached) return cached;
      let rgb: [number, number, number] = [0, 0, 0];
      if (probe) {
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = "#000000";
        probe.fillStyle = key;
        probe.fillRect(0, 0, 1, 1);
        const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
        rgb = [r / 255, g / 255, b / 255];
      }
      colorCache.set(key, rgb);
      return rgb;
    };

    const reduceMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    /* H3: `still` draws one frame and stops, like reduced motion; setStill() turns it on and off */
    let reduce = reduceMotion || still;
    const view = { width: 1, height: 1, ratio: 1 };
    const ramp = new Float32Array(MAX_COLORS * 3);
    const clickData = new Float32Array(MAX_CLICKS * 4);
    const clicks: { x: number; y: number; age: number }[] = [];
    const trailData = new Float32Array(MAX_TRAIL * 4);
    const trail: { x: number; y: number; age: number }[] = [];
    const pointer = { x: 0, y: 0, inside: false };
    let atlas: Atlas | null = null;
    let atlasKey = "";
    let paletteKey = "";
    let time = 0;
    let glyphTime = 0;
    let introClock = settings.intro && !reduce ? 0 : 1;
    let frameSeed = 0;
    let grainClock = 0;
    let raf = 0;
    let last = 0;
    let visible = true;
    let disposed = false;

    const syncAtlas = () => {
      const key = `${settings.fontFamily}|${settings.characters}`;
      if (key === atlasKey && atlas) return;
      atlasKey = key;
      if (atlas) gl.deleteTexture(atlas.texture);
      atlas = buildAtlas(gl, settings.characters, settings.fontFamily);
      document.fonts
        ?.load?.(`300 64px ${settings.fontFamily}`, settings.characters)
        .then(
          () => {
            if (disposed || atlasKey !== key) return;
            if (atlas) gl.deleteTexture(atlas.texture);
            atlas = buildAtlas(gl, settings.characters, settings.fontFamily);
            draw();
          },
          () => {},
        );
    };

    const syncPalette = () => {
      const key = settings.colors.join(",");
      if (key === paletteKey) return;
      paletteKey = key;
      settings.colors.forEach((color, i) => {
        ramp.set(toLab(parse(color ?? "")), i * 3);
      });
    };

    const bindGlyphs = (program: Program, width: number, height: number) => {
      if (!atlas) return;
      const u = program.uniforms;
      const cellH = settings.cellSize * view.ratio;
      const cellW = cellH * (ATLAS_CELL_W / ATLAS_CELL_H);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fieldTarget.textures[0] ?? null);
      gl.uniform1i(u.uField ?? null, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, fieldTarget.textures[1] ?? null);
      gl.uniform1i(u.uAux ?? null, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, atlas.texture);
      gl.uniform1i(u.uAtlas ?? null, 2);
      gl.uniform2f(u.uResolution ?? null, width, height);
      gl.uniform2f(u.uCell ?? null, cellW, cellH);
      gl.uniform2f(
        u.uOffset ?? null,
        (width - Math.ceil(width / cellW) * cellW) / 2,
        (height - Math.ceil(height / cellH) * cellH) / 2,
      );
      gl.uniform2f(u.uAtlasGrid ?? null, atlas.grid[0], atlas.grid[1]);
      gl.uniform1f(u.uCount ?? null, atlas.count);
      gl.uniform1f(u.uDensity ?? null, settings.density);
      gl.uniform1f(u.uOpacity ?? null, settings.glyphOpacity);
      gl.uniform1f(u.uFlicker ?? null, reduce ? 0 : settings.flicker);
      gl.uniform1f(u.uDepth ?? null, settings.depthOfField);
      gl.uniform1f(u.uGlyphTime ?? null, glyphTime);
      gl.uniform1f(u.uSeedValue ?? null, settings.variation);
      gl.uniform1f(u.uLight ?? null, settings.lightMode ? 1 : 0);
    };

    const draw = () => {
      const aspect = view.width / view.height;
      syncAtlas();
      syncPalette();
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND);

      gl.bindFramebuffer(gl.FRAMEBUFFER, fieldTarget.framebuffer);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.viewport(0, 0, fieldTarget.width, fieldTarget.height);
      bindProgram(field);
      const fu = field.uniforms;
      gl.uniform1f(fu.uAspect ?? null, aspect);
      gl.uniform1f(fu.uTime ?? null, time);
      gl.uniform1i(fu.uShape ?? null, settings.shape);
      gl.uniform3fv(fu.uRamp ?? null, ramp);
      gl.uniform1i(fu.uCount ?? null, settings.colors.length);
      gl.uniform1f(fu.uScale ?? null, settings.scale);
      gl.uniform1f(fu.uSoftness ?? null, settings.softness);
      gl.uniform1f(fu.uFlow ?? null, settings.flow);
      gl.uniform2f(
        fu.uSeed ?? null,
        settings.variation * 3.17,
        settings.variation * 1.91,
      );
      gl.uniform4fv(fu.uTrail ?? null, trailData);
      gl.uniform1f(fu.uRadius ?? null, settings.scrambleRadius);
      gl.uniform4fv(fu.uClicks ?? null, clickData);
      gl.uniform1i(fu.uClickEffect ?? null, settings.clickEffect);
      gl.uniform1f(fu.uIntro ?? null, introClock);
      gl.uniform1f(fu.uFrame ?? null, frameSeed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      const glowing = settings.glow > 0.001;
      if (glowing) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, haloA.framebuffer);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        gl.viewport(0, 0, haloA.width, haloA.height);
        bindProgram(halo);
        bindGlyphs(halo, canvas.width, canvas.height);
        gl.uniform1f(
          halo.uniforms.uDownscale ?? null,
          canvas.width / haloA.width,
        );
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        bindProgram(blur);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(blur.uniforms.uSource ?? null, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, haloB.framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, haloA.textures[0] ?? null);
        gl.uniform2f(blur.uniforms.uStep ?? null, 1 / haloA.width, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, haloA.framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, haloB.textures[0] ?? null);
        gl.uniform2f(blur.uniforms.uStep ?? null, 0, 1 / haloA.height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      bindProgram(composite);
      bindGlyphs(composite, canvas.width, canvas.height);
      const cu = composite.uniforms;
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, haloA.textures[0] ?? null);
      gl.uniform1i(cu.uHalo ?? null, 3);
      gl.uniform1f(cu.uGlow ?? null, glowing ? settings.glow : 0);
      gl.uniform1f(cu.uGradient ?? null, settings.gradientOpacity);
      gl.uniform1f(cu.uGrain ?? null, settings.grain);
      gl.uniform1f(cu.uFrame ?? null, frameSeed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const resize = () => {
      view.width = Math.max(1, container.clientWidth);
      view.height = Math.max(1, container.clientHeight);
      view.ratio = Math.min(settings.dpr || window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(view.width * view.ratio));
      canvas.height = Math.max(1, Math.round(view.height * view.ratio));
      sizeTarget(
        gl,
        fieldTarget,
        Math.max(1, Math.round(canvas.width / 2)),
        Math.max(1, Math.round(canvas.height / 2)),
      );
      const haloWidth = Math.max(1, Math.round(canvas.width / 4));
      const haloHeight = Math.max(1, Math.round(canvas.height / 4));
      sizeTarget(gl, haloA, haloWidth, haloHeight);
      sizeTarget(gl, haloB, haloWidth, haloHeight);
      draw();
      wake();
    };

    const updateInput = (dt: number) => {
      for (const point of trail) point.age += dt;
      while (trail.length && (trail[trail.length - 1]?.age ?? 0) > TRAIL_LIFE)
        trail.pop();
      for (let i = 0; i < MAX_TRAIL; i++) {
        const point = trail[i];
        if (!point) {
          trailData[i * 4 + 2] = 0;
          continue;
        }
        const k = 1 - point.age / TRAIL_LIFE;
        trailData.set([point.x, point.y, k * k, 0], i * 4);
      }
      for (const click of clicks) click.age += dt;
      while (
        clicks.length &&
        (clicks[clicks.length - 1]?.age ?? 0) > CLICK_LIFE
      )
        clicks.pop();
      for (let i = 0; i < MAX_CLICKS; i++) {
        const click = clicks[i];
        if (!click) {
          clickData[i * 4 + 3] = 0;
          continue;
        }
        const k = click.age / CLICK_LIFE;
        const envelope = Math.min(1, click.age / 0.08) * (1 - k) * (1 - k);
        clickData.set([click.x, click.y, click.age, envelope], i * 4);
      }
    };

    const frame = (now: number) => {
      raf = 0;
      if (disposed || !visible || document.hidden) return;
      const dt = last ? clamp((now - last) / 1000, 0.001, 0.05) : 1 / 60;
      last = now;
      if (!reduce) {
        time += dt * settings.speed * 0.5;
        glyphTime += dt * Math.max(settings.speed, 0.15);
      }
      if (introClock < 1)
        introClock = Math.min(1, introClock + dt / INTRO_SECONDS);
      grainClock += dt;
      if (!reduce && grainClock > 1 / 24) {
        grainClock = 0;
        frameSeed = (frameSeed + 1) % 97;
      }
      updateInput(dt);
      draw();
      const busy =
        !reduce || introClock < 1 || clicks.length > 0 || trail.length > 0;
      if (busy) raf = requestAnimationFrame(frame);
      else last = 0;
    };

    function wake() {
      if (!raf && !disposed && visible && !document.hidden)
        raf = requestAnimationFrame(frame);
    }

    const locate = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const x = (event.clientX - rect.left) / Math.max(1, rect.width);
      const y = 1 - (event.clientY - rect.top) / Math.max(1, rect.height);
      const aspect = rect.width / Math.max(1, rect.height);
      pointer.inside = x >= 0 && x <= 1 && y >= 0 && y <= 1;
      pointer.x = (x - 0.5) * aspect;
      pointer.y = y - 0.5;
    };

    const onPointerMove = (event: PointerEvent) => {
      locate(event);
      if (!pointer.inside || !settings.mouseInteraction || reduce) return;
      const head = trail[0];
      const gap = head
        ? Math.hypot(pointer.x - head.x, pointer.y - head.y)
        : Number.POSITIVE_INFINITY;
      if (gap < TRAIL_STEP) return;
      if (head && head.age < 0.1) {
        const steps = Math.min(6, Math.floor(gap / (TRAIL_STEP * 2)));
        for (let i = 1; i <= steps; i++) {
          const k = i / (steps + 1);
          trail.unshift({
            x: head.x + (pointer.x - head.x) * k,
            y: head.y + (pointer.y - head.y) * k,
            age: 0,
          });
        }
      }
      trail.unshift({ x: pointer.x, y: pointer.y, age: 0 });
      trail.length = Math.min(trail.length, MAX_TRAIL);
      wake();
    };

    const onPointerDown = (event: PointerEvent) => {
      locate(event);
      if (!pointer.inside || !settings.clickEffect || reduce) return;
      clicks.unshift({ x: pointer.x, y: pointer.y, age: 0 });
      if (clicks.length > MAX_CLICKS) clicks.pop();
      wake();
    };

    const onVisibility = () => {
      last = 0;
      wake();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const intersection = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (visible) {
        last = 0;
        wake();
      }
    });
    intersection.observe(container);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    resize();
    wakeFn = wake;
    stillFn = (on) => {
      reduce = reduceMotion || on;
      last = 0;
      wake();
    };

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      wakeFn = null;
      stillFn = null;
      resizeObserver.disconnect();
      intersection.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const target of [fieldTarget, haloA, haloB]) {
        for (const texture of target.textures) gl.deleteTexture(texture);
        gl.deleteFramebuffer(target.framebuffer);
      }
      if (atlas) gl.deleteTexture(atlas.texture);
      gl.deleteVertexArray(vao);
      for (const item of [field, halo, blur, composite])
        gl.deleteProgram(item.program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  })();
  return {
    drawn: dispose !== undefined,
    dispose: () => {
      dispose?.();
      canvas.remove();
    },
    wake: () => wakeFn?.(),
    setStill: (on) => stillFn?.(on),
  };
}
