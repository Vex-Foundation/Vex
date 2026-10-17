/**
 * K2's seeded randomness: integer hashes, 1D value noise, event schedules and the Bayer threshold,
 * all pure functions of their inputs, so every blink, gust and gesture follows from the clock and a
 * recording is frame exact. Never `Math.random()`.
 */
import { BAYER } from "../../../lib/pixel/core.js";

/** The Bayer threshold of a grid cell in 0..1 (cell centres, so 1/32 to 31/32). */
export function bayerAt(i: number, j: number): number {
  return ((BAYER[j & 3]?.[i & 3] ?? 0) + 0.5) / 16;
}

/** 32-bit integer hash of up to three ints. */
export function ihash(a: number, b = 0, c = 0): number {
  let h =
    Math.imul(a | 0, 0x27d4eb2d) ^
    Math.imul(b | 0, 0x165667b1) ^
    Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A hash in 0..1. */
export const hash01 = (a: number, b = 0, c = 0): number =>
  ihash(a, b, c) / 4294967296;

const smooth = (x: number): number => x * x * (3 - 2 * x);

/** 1D value noise, smooth, about -1..1. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash01(i, seed) * 2 - 1;
  const b = hash01(i + 1, seed) * 2 - 1;
  return a + (b - a) * smooth(f);
}

export interface ScheduleHit {
  /** An event is running at t. */
  readonly on: boolean;
  /** ms since it began (-1 when off). */
  readonly age: number;
  /** Its index in the chain (the next one's when off). */
  readonly index: number;
}

const chains = new Map<string, number[]>();

/**
 * A deterministic event chain on one channel (`seed`): start(k + 1) = start(k) + dur + gap(k), each
 * gap hashed in [gapMin, gapMax]. The starts are cached per channel; the answer is a pure function
 * of t.
 */
export function schedule(
  t: number,
  seed: number,
  gapMin: number,
  gapMax: number,
  dur: number,
): ScheduleHit {
  const key = `${seed}|${gapMin}|${gapMax}|${dur}`;
  let st = chains.get(key);
  if (st === undefined) {
    st = [];
    chains.set(key, st);
  }
  while (st.length === 0 || (st[st.length - 1] ?? 0) <= t) {
    const k = st.length;
    const gap = gapMin + hash01(k, seed) * (gapMax - gapMin);
    st.push(k === 0 ? gap : (st[k - 1] ?? 0) + dur + gap);
  }
  let lo = 0;
  let hi = st.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((st[mid] ?? 0) <= t) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (idx >= 0 && t < (st[idx] ?? 0) + dur)
    return { on: true, age: t - (st[idx] ?? 0), index: idx };
  return { on: false, age: -1, index: idx + 1 };
}
