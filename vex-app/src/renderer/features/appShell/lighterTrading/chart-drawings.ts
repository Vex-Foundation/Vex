export type DrawingKind = "horizontal" | "trend" | "rectangle" | "fib" | "measure";
export interface Anchor {
  time: number;
  price: number;
}
export interface Drawing {
  id: string;
  kind: DrawingKind;
  a: Anchor;
  b: Anchor;
}
export interface DrawingHistory {
  past: Drawing[][];
  present: Drawing[];
  future: Drawing[][];
}
export const MAX_DRAWINGS = 60;
const kinds: DrawingKind[] = ["horizontal", "trend", "rectangle", "fib", "measure"];
const validAnchor = (a: unknown): a is Anchor => typeof a === "object" && a !== null && "time" in a && "price" in a && typeof a.time === "number" && Number.isFinite(a.time) && a.time >= 0 && a.time <= 32503680000 && typeof a.price === "number" && Number.isFinite(a.price) && Math.abs(a.price) <= 1e15;
export function parseDrawings(raw: string | null): Drawing[] {
  if (raw === null || raw.length > 32000)
    return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_DRAWINGS)
      return [];
    const ids = new Set<string>();
    return parsed.filter((row): row is Drawing => {
      if (!row || typeof row !== "object" || typeof row.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(row.id) || ids.has(row.id) || !kinds.includes(row.kind) || !validAnchor(row.a) || !validAnchor(row.b))
        return false;
      ids.add(row.id);
      return true;
    }).map(({ id, kind, a, b }) => ({
      id,
      kind,
      a: { time: a.time, price: a.price },
      b: { time: b.time, price: b.price }
    }));
  } catch {
    return [];
  }
}
export function drawingHistory(state: DrawingHistory, action: {
  type: "set";
  drawings: Drawing[];
} | {
  type: "undo" | "redo";
}): DrawingHistory {
  if (action.type === "set")
    return {
      past: [...state.past, state.present].slice(-30),
      present: action.drawings.slice(0, MAX_DRAWINGS),
      future: []
    };
  if (action.type === "undo") {
    const previous = state.past.at(-1);
    return previous ? {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future].slice(0, 30)
    } : state;
  }
  const next = state.future[0];
  return next ? {
    past: [...state.past, state.present].slice(-30),
    present: next,
    future: state.future.slice(1)
  } : state;
}
/** Interpolate around candle times so drawings retain their timestamp across resolutions. */
export function logicalToTime(logical: number, times: readonly number[]): number | null {
  if (times.length < 2 || !Number.isFinite(logical))
    return null;
  const index = Math.max(0, Math.min(times.length - 2, Math.floor(logical)));
  return times[index]! + (logical - index) * (times[index + 1]! - times[index]!);
}
export function timeToLogical(time: number, times: readonly number[]): number | null {
  if (times.length < 2)
    return null;
  let index = times.findIndex(t => t >= time) - 1;
  if (index === -2)
    index = times.length - 2;
  index = Math.max(0, index);
  return index + (time - times[index]!) / (times[index + 1]! - times[index]!);
}
