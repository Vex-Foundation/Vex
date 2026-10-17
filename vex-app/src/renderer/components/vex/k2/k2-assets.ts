/**
 * K2's art and her scratch canvases. The art ships with the renderer (`public/art/vex-k2/`) and is
 * read from its own origin: the `app://` protocol in the packaged app, the dev server in
 * development. Every file is fetched as bytes and decoded with `createImageBitmap`, never through an
 * object URL or a remote address (the renderer's CSP pins `img-src 'self' data:`), and every JSON
 * is checked at runtime before it is trusted: a file that does not match keeps her away rather than
 * half drawn.
 */
import { type AnyCanvas, type Ctx2D, createCanvas } from "../../../lib/pixel/core.js";
import { decodeMap, type K2Eye, type K2Map, type K2Meta } from "./k2-portrait.js";
import type { TokenFrame, TokenSheet } from "./k2-token.js";

/** Where her art is served from (`public/art/vex-k2/`). */
export const K2_ART = "/art/vex-k2/";

/** A scratch canvas (an offscreen one off the main thread) and its 2D context. */
export type Scratch = AnyCanvas;
export type Scratch2D = Ctx2D;

/** A scratch canvas of at least 1 x 1 px. */
export function scratchCanvas(width: number, height: number): Scratch {
  return createCanvas(width, height);
}

/** A scratch canvas's 2D context, or null where the canvas has none. */
export function context2dOf(canvas: Scratch, readback = false): Scratch2D | null {
  const settings = { willReadFrequently: readback };
  if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas) {
    const ctx = canvas.getContext("2d", settings);
    return typeof OffscreenCanvasRenderingContext2D !== "undefined" &&
      ctx instanceof OffscreenCanvasRenderingContext2D
      ? ctx
      : null;
  }
  if (typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", settings);
    return typeof CanvasRenderingContext2D !== "undefined" &&
      ctx instanceof CanvasRenderingContext2D
      ? ctx
      : null;
  }
  return null;
}

/* ------------------------------------------------------------------ runtime guards */

type Rec = Readonly<Record<string, unknown>>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNums = (v: unknown, n?: number): v is readonly number[] =>
  Array.isArray(v) && (n === undefined || v.length === n) && v.every(isNum);
const isPoints = (v: unknown): v is readonly (readonly [number, number])[] =>
  Array.isArray(v) && v.every((p) => isNums(p, 2));
const hasNums = (v: Rec, keys: readonly string[]): boolean => keys.every((k) => isNum(v[k]));

function isEye(v: unknown): v is K2Eye {
  return (
    isRec(v) &&
    isPoints(v["top"]) &&
    isPoints(v["bot"]) &&
    isNums(v["iris"], 4) &&
    isNums(v["pupil"], 4) &&
    isNums(v["hl"], 3) &&
    isNums(v["hl2"], 2) &&
    isNums(v["gmax"], 3) &&
    hasNums(v, ["lash", "outer"])
  );
}

/** Her metadata as the converter writes it (`meta.json`). */
export function isK2Meta(v: unknown): v is K2Meta {
  if (!isRec(v)) return false;
  const face = v["face"];
  const cls = v["cls"];
  const col = v["col"];
  const flags = v["flags"];
  return (
    hasNums(v, ["pitch", "bx", "by", "gw", "gh", "k", "rise", "streamMaxX"]) &&
    Array.isArray(v["eyes"]) &&
    v["eyes"].every(isEye) &&
    isRec(face) &&
    isPoints(face["mouth"]) &&
    isPoints(face["lip"]) &&
    isPoints(face["nose"]) &&
    isRec(cls) &&
    hasNums(cls, ["none", "hair", "skin", "tee", "acc", "eye", "cloud", "hand", "line"]) &&
    isRec(col) &&
    hasNums(col, ["white", "ink", "blue_w", "blue_i"]) &&
    isRec(flags) &&
    hasNums(flags, ["ring", "strand", "in"]) &&
    isNums(v["ycut"]) &&
    isNums(v["rest"], 2) &&
    isNums(v["glance"], 2) &&
    (v["shoulder"] === undefined || isNum(v["shoulder"]))
  );
}

const FRAME_KINDS: readonly string[] = ["tilt", "press", "flip", "flat"];

function isFrame(v: unknown): v is TokenFrame {
  return (
    isRec(v) &&
    typeof v["kind"] === "string" &&
    FRAME_KINDS.includes(v["kind"]) &&
    hasNums(v, ["tiltX", "tiltY", "press", "flip", "cx", "cy", "rx", "ry"])
  );
}

/** The token's sprite sheet layout (`token.json`). */
export function isTokenSheet(v: unknown): v is TokenSheet {
  if (!isRec(v)) return false;
  const ratios = v["ratios"];
  return (
    hasNums(v, ["td", "box", "cols"]) &&
    isRec(ratios) &&
    hasNums(ratios, ["1x", "2x"]) &&
    isFrame(v["flat"]) &&
    Array.isArray(v["frames"]) &&
    v["frames"].every(isFrame)
  );
}

/* ------------------------------------------------------------------ loaders */

async function fetchOk(file: string): Promise<Response> {
  const res = await fetch(`${K2_ART}${file}`);
  if (!res.ok) throw new Error(`K2: ${file}`);
  return res;
}

async function json<T>(file: string, guard: (v: unknown) => v is T): Promise<T> {
  const res = await fetchOk(file);
  const raw: unknown = await res.json();
  if (!guard(raw)) throw new Error(`K2: ${file} does not match`);
  return raw;
}

/** A drawing's metadata (`dir`: "" for the wide drawing, "app/" for the app drawing). */
export function loadMeta(dir = ""): Promise<K2Meta> {
  return json(`${dir}meta.json`, isK2Meta);
}

/** The token's sprite sheet layout. */
export function loadTokenSheet(): Promise<TokenSheet> {
  return json("token.json", isTokenSheet);
}

/** An image file as a bitmap (decoded from its bytes). */
export async function loadBitmap(
  file: string,
  options?: ImageBitmapOptions,
): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") throw new Error("K2: no createImageBitmap");
  const blob = await (await fetchOk(file)).blob();
  return createImageBitmap(blob, options);
}

/** A map PNG as cells (decoded without colour management: its bytes are data, not colour). */
export async function loadMap(file: string, n: number): Promise<K2Map> {
  const bmp = await loadBitmap(file, {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  const c = scratchCanvas(bmp.width, bmp.height);
  const x = context2dOf(c, true);
  if (x === null) {
    bmp.close();
    throw new Error("K2: no 2D context");
  }
  x.drawImage(bmp, 0, 0);
  bmp.close();
  return decodeMap(x.getImageData(0, 0, c.width, c.height).data, n);
}
