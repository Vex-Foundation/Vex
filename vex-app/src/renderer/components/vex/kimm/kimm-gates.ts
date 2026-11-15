/**
 * KIMM'S DEVICE GATE (VEX Cloud's `apps/web/src/components/kimm/kimm-gates.ts`: PLAN EC-17, PD-08; DG-3 "Kimm's
 * gates, one list" and decision 13; SK KIMM.md 0.1 and 8). Her model is about 15 MB to parse and about 160 MB of GPU
 * memory (three 4096 textures), so she goes live only where nothing below holds, and stays her still where anything
 * does:
 *
 *   - Save-Data, or reduced motion (a figure that cannot move does not earn 160 MB of GPU memory; her still swaps per
 *     mood as before);
 *   - `deviceMemory` reported and under 4, `hardwareConcurrency` reported and under 4 (4 passes: H3's `<=` was wrong);
 *   - no WebGL2; `MAX_TEXTURE_SIZE` under 4096 (her textures are 4096).
 *
 * DESKTOP PORT (owner decision 2026-11-15). Cloud's terms that measure a web page's link and a phone are dropped:
 * desktop reads her files from its own `app://` origin on disk, so no network term applies (Cloud's `slow-network`),
 * and its window floor is 1000 with a fine pointer, so neither does Cloud's app scope's window or pointer term. For
 * the same reason she starts as soon as the renderer is idle (`use-kimm-live.ts`), never waiting on a first
 * interaction as Cloud's narrow app window does (`kimmStartOf`, not ported).
 *
 * The cheap facts are read in an effect, never during render; the GPU facts need a WebGL2 context, so `probeGpu`
 * runs only right before a load would start (`kimm-live.ts`), and loses its context at once.
 */

/** The facts the gate reads. Optional ones are those a browser may not report. */
export interface KimmDevice {
  readonly saveData: boolean;
  readonly deviceMemory?: number | undefined;
  readonly hardwareConcurrency?: number | undefined;
  readonly reducedMotion: boolean;
  /** Read by `probeGpu` before a load; unknown until then. */
  readonly webgl2?: boolean | undefined;
  readonly maxTextureSize?: number | undefined;
}

export type KimmGateReason =
  | "save-data"
  | "low-memory"
  | "few-cores"
  | "no-webgl2"
  | "small-textures"
  | "reduced-motion";

/** Her textures are 4096 square (SK KIMM.md 0.1). */
export const KIMM_MIN_TEXTURE = 4096;

/** Every reason that keeps her still (pure; an empty list lets her go live). GPU facts count only once probed. */
export function kimmGateReasons(device: KimmDevice): KimmGateReason[] {
  const reasons: KimmGateReason[] = [];
  if (device.saveData) reasons.push("save-data");
  if (device.deviceMemory !== undefined && device.deviceMemory < 4) reasons.push("low-memory");
  if (device.hardwareConcurrency !== undefined && device.hardwareConcurrency < 4) reasons.push("few-cores");
  if (device.webgl2 === false) reasons.push("no-webgl2");
  if (device.maxTextureSize !== undefined && device.maxTextureSize < KIMM_MIN_TEXTURE) reasons.push("small-textures");
  if (device.reducedMotion) reasons.push("reduced-motion");
  return reasons;
}

interface NetworkInformationLike {
  readonly saveData?: boolean;
}

/** The cheap facts of this renderer (no WebGL context); call it in an effect, never during render. */
export function readKimmDevice(win: Window = window): KimmDevice {
  const nav = win.navigator as Navigator & {
    readonly connection?: NetworkInformationLike;
    readonly deviceMemory?: number;
  };
  const cores = nav.hardwareConcurrency;
  const reduced =
    typeof win.matchMedia === "function" && win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return {
    saveData: nav.connection?.saveData === true,
    deviceMemory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : undefined,
    hardwareConcurrency: typeof cores === "number" && cores > 0 ? cores : undefined,
    reducedMotion: reduced,
  };
}

/** The GPU facts: one WebGL2 context, read and lost at once. */
export function probeGpu(doc: Document = document): {
  readonly webgl2: boolean;
  readonly maxTextureSize: number | undefined;
} {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = doc.createElement("canvas").getContext("webgl2");
  } catch {
    gl = null;
  }
  if (!gl) return { webgl2: false, maxTextureSize: undefined };
  const size = gl.getParameter(gl.MAX_TEXTURE_SIZE) as unknown;
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return {
    webgl2: true,
    maxTextureSize: typeof size === "number" ? size : undefined,
  };
}
