/**
 * SPIKE ONLY (Stage B3 measurement). Not production code.
 *
 * Shared instrumentation so both candidates are counted the same way:
 * - commits: one increment per committed React render of the list component;
 * - row renders: one increment per render of a row, keyed by its stable id.
 */
export interface RenderCounters {
  commits: number;
  listRenders: number;
  readonly rowRenders: Map<string, number>;
  reset: () => void;
  /** total row render calls since the last reset */
  totalRowRenders: () => number;
  /** how many DISTINCT rows rendered since the last reset */
  distinctRows: () => number;
}

export const createRenderCounters = (): RenderCounters => {
  const rowRenders = new Map<string, number>();
  const counters: RenderCounters = {
    commits: 0,
    listRenders: 0,
    rowRenders,
    reset: () => {
      counters.commits = 0;
      counters.listRenders = 0;
      rowRenders.clear();
    },
    totalRowRenders: () =>
      [...rowRenders.values()].reduce((sum, n) => sum + n, 0),
    distinctRows: () => rowRenders.size,
  };
  return counters;
};

export const countRow = (counters: RenderCounters, id: string): void => {
  counters.rowRenders.set(id, (counters.rowRenders.get(id) ?? 0) + 1);
};
