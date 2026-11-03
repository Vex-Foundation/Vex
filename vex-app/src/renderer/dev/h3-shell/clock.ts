/**
 * THE HARNESS CLOCK - one instant and one random sequence for every load.
 *
 * The shell reads the wall clock in places a capture can see: the welcome's
 * greeting picks its bucket from the local hour and its line from
 * `Math.random()` (`lib/greeting.ts`), the chat list groups by day and stamps
 * times, a live turn's timer and a waiting card's "since" are differences
 * from now. A harness state that read the real clock would be a different
 * picture every minute, so before any product module evaluates this module
 * pins both:
 *
 *   - `Date.now()` and `new Date()` with no argument return ONE instant,
 *     `H3_NOW`, and do not advance. A frozen clock is what makes "Thinking
 *     0:03" read 0:03 on every capture rather than whatever the load took;
 *     every other `Date` use (parsing, formatting, arithmetic) is the real
 *     one. `performance.now()` is untouched, so React's scheduler, Motion and
 *     CSS keep their own time.
 *   - `Math.random()` is a seeded mulberry32, so every draw the shell makes
 *     is the same draw on every load.
 *
 * `H3_NOW` is 3 November 2026, 14:30 UTC: the day of the H3 sheet, and an
 * afternoon in every timezone from UTC-2 to UTC+3. The parity spec pins its
 * browser to UTC, so the local hour it renders is exactly 14.
 */

export const H3_NOW = Date.UTC(2026, 10, 3, 14, 30, 0);

/** The fixed instant as the ISO string the bridge's DTOs carry. */
export function isoAt(offsetMs: number): string {
  return new Date(H3_NOW + offsetMs).toISOString();
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const RealDate = Date;

/**
 * The instant the clock reads: `H3_NOW` for the whole life of a state, except
 * inside `atInstant`. A state whose product code stamps "now" when an event
 * arrives (a live turn's clock starts at its first delta) delivers that event
 * at an earlier instant and then comes back here, so the elapsed figure on
 * screen is an exact, fixed number rather than the time the load took.
 */
let reading = H3_NOW;

type DateParts = [number, number, number?, number?, number?, number?, number?];

class HarnessDate extends RealDate {
  // Every constructor form forwards unchanged except the no-argument one,
  // which is "now": `new Date(y, m, d)` is how the chat list finds the start
  // of the local day, and it must stay the real calendar arithmetic.
  constructor(...args: [] | [string | number | Date] | DateParts) {
    if (args.length === 0) super(reading);
    else if (args.length === 1) super(args[0]);
    else super(...(args as DateParts));
  }

  static override now(): number {
    return reading;
  }
}

/**
 * Run `deliver` with the clock reading `instant`, hold it there for `holdMs`
 * of real time (long enough for the stream store's 16 ms coalescing flush to
 * stamp it), then return the clock to `H3_NOW`.
 */
export async function atInstant(instant: number, deliver: () => void, holdMs = 120): Promise<void> {
  reading = instant;
  try {
    deliver();
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, holdMs);
    });
  } finally {
    reading = H3_NOW;
  }
}

/** mulberry32: a tiny, well-mixed 32-bit PRNG, seeded once per load. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function installHarnessClock(): void {
  globalThis.Date = HarnessDate as DateConstructor;
  Math.random = seeded(0x4833);
}
