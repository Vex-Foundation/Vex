/**
 * Bounded concurrent dispatch for ONE segment of audited parallel-safe reads
 * (Kairos Phase 5, T-1). Pure scheduling: it knows nothing about tools,
 * transcripts or leases, which the caller injects.
 *
 * Guarantees:
 *  - calls START strictly in their original order (the next call to start is
 *    always the lowest unstarted index), so the calls that never started are
 *    always a suffix of the segment;
 *  - at most `limit` calls are in flight, and at most `providerCap(p)` calls
 *    to one provider;
 *  - `beforeStart(k)` runs immediately before call `k` starts, AFTER a slot
 *    is free. A non-null answer (Stop, lease lost, deadline) starts nothing
 *    more;
 *  - every started call SETTLES before this returns: an in-flight read is
 *    never abandoned and never interrupted by this scheduler;
 *  - a rejected dispatch starts nothing more and is reported, after the
 *    in-flight siblings settle, as `error`.
 */

export interface SegmentSchedule<R, S> {
  /** Results by segment position; defined exactly for positions `< started`. */
  readonly results: ReadonlyArray<R | undefined>;
  /** How many calls started (a prefix of the segment). */
  readonly started: number;
  /** Why the scheduler stopped starting calls early, if it did. */
  readonly refusal: S | null;
  /** The first rejected dispatch, if any. */
  readonly error: { readonly value: unknown } | null;
}

export async function scheduleReadSegment<R, S, P>(args: {
  readonly count: number;
  readonly limit: number;
  readonly providerOf: (position: number) => P;
  readonly providerCap: (provider: P) => number;
  readonly beforeStart: (position: number) => Promise<S | null>;
  readonly dispatch: (position: number) => Promise<R>;
}): Promise<SegmentSchedule<R, S>> {
  const limit = Math.max(1, Math.floor(args.limit));
  const results: Array<R | undefined> = new Array<R | undefined>(args.count).fill(undefined);
  const inFlight = new Set<Promise<void>>();
  const perProvider = new Map<P, number>();
  let started = 0;
  let refusal: S | null = null;
  let error: { value: unknown } | null = null;

  const providerLoad = (provider: P): number => perProvider.get(provider) ?? 0;
  const mustWait = (position: number): boolean => {
    if (inFlight.size >= limit) return true;
    const provider = args.providerOf(position);
    return providerLoad(provider) >= Math.max(1, args.providerCap(provider));
  };

  while (started < args.count && refusal === null && error === null) {
    while (inFlight.size > 0 && mustWait(started)) {
      await Promise.race(inFlight);
    }
    if (error !== null) break;

    refusal = await args.beforeStart(started);
    if (refusal !== null) break;

    const position = started;
    const provider = args.providerOf(position);
    perProvider.set(provider, providerLoad(provider) + 1);
    const settled: Promise<void> = args
      .dispatch(position)
      .then(
        (value) => {
          results[position] = value;
        },
        (reason: unknown) => {
          error ??= { value: reason };
        },
      )
      .finally(() => {
        perProvider.set(provider, providerLoad(provider) - 1);
        inFlight.delete(settled);
      });
    inFlight.add(settled);
    started += 1;
  }

  await Promise.all(inFlight);
  return { results, started, refusal, error };
}
