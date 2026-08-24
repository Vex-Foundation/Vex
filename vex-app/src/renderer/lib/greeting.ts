/**
 * Welcome-hero greeting copy + pure pick logic (owner decision 2026-08-20,
 * rotating-pool revision): each time-of-day bucket carries a small
 * owner-approved pool mixing plain, playful-DeFi and brand ("Vexing") lines;
 * name variants join the draw only when a displayName exists. The caller
 * injects the [0,1) random so the pick is deterministic under test.
 */

export interface GreetingVariant {
  /** Headline copy; carries the "{name}" placeholder when `withName`. */
  readonly text: string;
  readonly withName: boolean;
}

/** Morning 5-11 (owner-approved copy - keep exactly). */
export const MORNING_GREETINGS: readonly GreetingVariant[] = [
  { text: "Morning, {name}", withName: true },
  { text: "gm, {name}", withName: true },
  { text: "Morning. DeFi time?", withName: false },
  { text: "Morning moves?", withName: false },
];

/** Afternoon 12-17 (owner-approved copy - keep exactly). */
export const AFTERNOON_GREETINGS: readonly GreetingVariant[] = [
  { text: "Afternoon, {name}", withName: true },
  { text: "Afternoon.", withName: false },
  { text: "Vexing, {name}?", withName: true },
  { text: "What are we executing?", withName: false },
];

/** Evening 18-4, wrapping through midnight (owner-approved copy - keep exactly). */
export const EVENING_GREETINGS: readonly GreetingVariant[] = [
  { text: "Evening, {name}", withName: true },
  { text: "Evening. Markets never sleep.", withName: false },
  { text: "Vexing tonight, {name}?", withName: true },
  { text: "Night shift?", withName: false },
];

export type Greeting = "Morning" | "Afternoon" | "Evening";

/**
 * Bucket resolver. Local-hour bands: Morning 5-11, Afternoon 12-17,
 * Evening 18-4 (wraps through midnight). `hour` is a 0-23
 * `Date#getHours()` value.
 */
export function greetingForHour(hour: number): Greeting {
  if (hour >= 5 && hour <= 11) return "Morning";
  if (hour >= 12 && hour <= 17) return "Afternoon";
  return "Evening";
}

const POOL_BY_BUCKET: Record<Greeting, readonly GreetingVariant[]> = {
  Morning: MORNING_GREETINGS,
  Afternoon: AFTERNOON_GREETINGS,
  Evening: EVENING_GREETINGS,
};

/** The pool for a 0-23 `Date#getHours()` value. */
export function greetingPoolForHour(hour: number): readonly GreetingVariant[] {
  return POOL_BY_BUCKET[greetingForHour(hour)];
}

/**
 * Draw one headline. With a set displayName the WHOLE bucket is eligible
 * (name variants and nameless ones alike); with none, only nameless
 * variants are. `rand01` is an injected [0,1) number - the component passes
 * Math.random(), tests pass exact index boundaries. A blank name counts as
 * unset; an out-of-range rand clamps to the pool's edges rather than
 * throwing on the welcome stage.
 */
export function pickGreeting(
  hour: number,
  displayName: string | null,
  rand01: number,
): string {
  const name = displayName?.trim() ?? "";
  const pool = greetingPoolForHour(hour);
  const eligible =
    name.length > 0 ? pool : pool.filter((variant) => !variant.withName);
  const index = Math.min(
    eligible.length - 1,
    Math.max(0, Math.floor(rand01 * eligible.length)),
  );
  const variant = eligible[index];
  if (variant === undefined) return "";
  return variant.withName ? variant.text.replace("{name}", name) : variant.text;
}
