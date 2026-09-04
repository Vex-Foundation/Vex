/**
 * THE SCHEDULE BEHIND "Results will fill in."
 *
 * Main answers the first query of a session with `building` and does not await
 * the walk, so the sentence the rail shows is only true if the renderer asks
 * again. This suite drives the hook alone, on fake timers, over a fake search
 * adapter, and pins the four things the schedule promises: WHEN it asks again,
 * that the fill-in reaches state, that it is single-flight and fenced by the
 * needle, and every condition that stops it.
 *
 * The timing discipline is VS Code's quick-input tests: controlled time and an
 * explicit cancellation, never a wall-clock sleep. Every request here is
 * resolved by the suite, so a case can hold one open and prove that a
 * superseded answer lands nowhere.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { err, type Result } from "@shared/ipc/result.js";
import type {
  SearchFileNamesValue,
  SearchIndexState,
  SearchOutcome,
} from "@shared/schemas/studio-search.js";

interface QueryInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly query: string;
  readonly limit?: number;
}
interface SessionInput {
  readonly projectId: string;
  readonly sessionId: string;
}

type QueryAnswer = Promise<Result<SearchOutcome<SearchFileNamesValue>>>;

const searchFileNamesMock = vi.fn<(input: QueryInput) => QueryAnswer>();
const releaseSessionMock =
  vi.fn<(input: SessionInput) => Promise<Result<SearchOutcome<null>>>>();

vi.mock("../../../../../lib/api/search.js", () => ({
  searchProjectFileNames: (input: QueryInput) => searchFileNamesMock(input),
  releaseProjectSearchSession: (input: SessionInput) => releaseSessionMock(input),
}));

const { useRailFileIndex } = await import("../use-rail-file-index.js");

/** The debounce before the FIRST request of a needle. */
const DEBOUNCE_MS = 150;
/** The first re-query, and then the second, as the hook's constants set them. */
const FIRST_REQUERY_MS = 250;
const SECOND_REQUERY_MS = 500;

/** One main-side answer, with the fields a `building` walk leaves empty. */
function answer(
  indexState: SearchIndexState,
  matches: Array<{ relativePath: string; nodeId: string; score: number }> = [],
): QueryAnswer {
  return Promise.resolve({
    ok: true,
    data: {
      ok: true,
      value: {
        matches,
        totalMatches: matches.length,
        truncated: false,
        indexState,
        indexedFileCount: indexState === "building" ? 0 : 120,
        indexedAtMs: indexState === "building" ? null : 1_700_000_000_000,
      },
    },
  });
}

/**
 * The adapter every case installs: `building` for the first `buildingAnswers`
 * requests, then `settled`.
 */
function fakeIndex(
  buildingAnswers: number,
  settled: SearchIndexState = "ready",
  matches: Array<{ relativePath: string; nodeId: string; score: number }> = [
    { relativePath: "deep/nested/folder/buried.ts", nodeId: "tok-buried", score: 900 },
  ],
): void {
  let seen = 0;
  searchFileNamesMock.mockImplementation(() => {
    seen += 1;
    if (seen <= buildingAnswers) return answer("building");
    return answer(settled, matches);
  });
}

/** Let a timer fire AND its answer settle, inside one act. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  searchFileNamesMock.mockReset();
  releaseSessionMock.mockReset();
  releaseSessionMock.mockResolvedValue({ ok: true, data: { ok: true, value: null } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the re-query schedule while the index is building", () => {
  it("asks again 250 ms after a building answer, and again 500 ms after the next", async () => {
    fakeIndex(10);
    renderHook(() => useRailFileIndex("proj-1", true, "buried"));

    await advance(DEBOUNCE_MS);
    expect(searchFileNamesMock).toHaveBeenCalledTimes(1);

    // Not a millisecond early: the interval is the contract, not "eventually".
    await advance(FIRST_REQUERY_MS - 1);
    expect(searchFileNamesMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(searchFileNamesMock).toHaveBeenCalledTimes(2);

    // And the interval DOUBLES: nothing at 250 more, the third at 500.
    await advance(FIRST_REQUERY_MS);
    expect(searchFileNamesMock).toHaveBeenCalledTimes(2);
    await advance(SECOND_REQUERY_MS - FIRST_REQUERY_MS);
    expect(searchFileNamesMock).toHaveBeenCalledTimes(3);
  });

  it("asks with the SAME needle and session, one request at a time", async () => {
    fakeIndex(10);
    renderHook(() => useRailFileIndex("proj-1", true, "buried"));

    await advance(DEBOUNCE_MS + FIRST_REQUERY_MS + SECOND_REQUERY_MS);
    expect(searchFileNamesMock).toHaveBeenCalledTimes(3);
    const calls = searchFileNamesMock.mock.calls.map(([input]) => input);
    expect(calls.map((input) => input.query)).toEqual(["buried", "buried", "buried"]);
    expect(new Set(calls.map((input) => input.sessionId)).size).toBe(1);
  });

  it("publishes the results the moment the walk answers ready", async () => {
    fakeIndex(2);
    const { result } = renderHook(() => useRailFileIndex("proj-1", true, "buried"));

    await advance(DEBOUNCE_MS);
    expect(result.current.state).toBe("building");
    expect(result.current.matches).toHaveLength(0);

    await advance(FIRST_REQUERY_MS);
    expect(result.current.state).toBe("building");

    // The third request is the one that finds the settled index, and nobody
    // touched the keyboard to get it.
    await advance(SECOND_REQUERY_MS);
    expect(result.current.state).toBe("ready");
    expect(result.current.matches.map((match) => match.relativePath)).toEqual([
      "deep/nested/folder/buried.ts",
    ]);
    expect(result.current.indexedFileCount).toBe(120);
  });

  it("stops asking once the answer is ready", async () => {
    fakeIndex(1);
    renderHook(() => useRailFileIndex("proj-1", true, "buried"));

    await advance(DEBOUNCE_MS + FIRST_REQUERY_MS);
    expect(searchFileNamesMock).toHaveBeenCalledTimes(2);

    await advance(10_000);
    expect(searchFileNamesMock).toHaveBeenCalledTimes(2);
  });
});

describe("what stops the schedule", () => {
  it("a CAPPED index stops it: the walk answered, it just could not hold everything", async () => {
    fakeIndex(1, "capped");
    const { result } = renderHook(() => useRailFileIndex("proj-1", true, "buried"));

    await advance(DEBOUNCE_MS + FIRST_REQUERY_MS);
    expect(result.current.state).toBe("capped");
    expect(searchFileNamesMock).toHaveBeenCalledTimes(2);

    await advance(10_000);
    expect(searchFileNamesMock).toHaveBeenCalledTimes(2);
  });

  it("a REFUSED query stops it: the project closed under the search", async () => {
    let seen = 0;
    searchFileNamesMock.mockImplementation(() => {
      seen += 1;
      if (seen === 1) return answer("building");
      return Promise.resolve({ ok: true, data: { ok: false, code: "project_closed" } });
    });
    const { result } = renderHook(() => useRailFileIndex("proj-1", true, "buried"));

    await advance(DEBOUNCE_MS + FIRST_REQUERY_MS);
    expect(result.current.state).toBe("unavailable");
    expect(searchFileNamesMock).toHaveBeenCalledTimes(2);

    await advance(10_000);
    expect(searchFileNamesMock).toHaveBeenCalledTimes(2);
  });

  it("a FAILED request stops it: an error is not a reason to hammer main", async () => {
    let seen = 0;
    searchFileNamesMock.mockImplementation(() => {
      seen += 1;
      if (seen === 1) return answer("building");
      return Promise.resolve(
        err({
          code: "internal.unexpected",
          domain: "studio",
          message: "The search could not run.",
          retryable: true,
          userActionable: false,
          redacted: true,
          correlationId: "corr-idx2",
        }),
      );
    });
    const { result } = renderHook(() => useRailFileIndex("proj-1", true, "buried"));

    await advance(DEBOUNCE_MS + FIRST_REQUERY_MS);
    expect(result.current.state).toBe("unavailable");
    expect(searchFileNamesMock).toHaveBeenCalledTimes(2);

    await advance(10_000);
    expect(searchFileNamesMock).toHaveBeenCalledTimes(2);
  });

  it("closing the search stops the polling and releases the session exactly once", async () => {
    fakeIndex(10);
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useRailFileIndex("proj-1", active, "buried"),
      { initialProps: { active: true } },
    );

    await advance(DEBOUNCE_MS + FIRST_REQUERY_MS);
    expect(searchFileNamesMock).toHaveBeenCalledTimes(2);

    rerender({ active: false });
    await advance(10_000);

    expect(searchFileNamesMock).toHaveBeenCalledTimes(2);
    expect(releaseSessionMock).toHaveBeenCalledTimes(1);
  });

  it("unmounting stops it, so a sidebar that went away leaves no timer behind", async () => {
    fakeIndex(10);
    const { unmount } = renderHook(() => useRailFileIndex("proj-1", true, "buried"));

    await advance(DEBOUNCE_MS);
    expect(searchFileNamesMock).toHaveBeenCalledTimes(1);

    unmount();
    await advance(10_000);
    expect(searchFileNamesMock).toHaveBeenCalledTimes(1);
    expect(releaseSessionMock).toHaveBeenCalledTimes(1);
  });
});

describe("the needle fence", () => {
  it("a new needle cancels the pending poll, and the old building answer lands nowhere", async () => {
    // The first needle's SECOND request is held open across the needle change,
    // so its `building` answer arrives after the newer needle is already ready.
    let releaseStale!: (value: Result<SearchOutcome<SearchFileNamesValue>>) => void;
    const stale = new Promise<Result<SearchOutcome<SearchFileNamesValue>>>((resolve) => {
      releaseStale = resolve;
    });
    let alphaCalls = 0;
    searchFileNamesMock.mockImplementation((input) => {
      if (input.query === "alpha") {
        alphaCalls += 1;
        return alphaCalls === 1 ? answer("building") : stale;
      }
      return answer("ready", [
        { relativePath: "src/beta.ts", nodeId: "tok-beta", score: 900 },
      ]);
    });

    const { result, rerender } = renderHook(
      ({ query }: { query: string }) => useRailFileIndex("proj-1", true, query),
      { initialProps: { query: "alpha" } },
    );

    await advance(DEBOUNCE_MS + FIRST_REQUERY_MS);
    expect(alphaCalls).toBe(2);
    expect(result.current.state).toBe("building");

    rerender({ query: "beta" });
    await advance(DEBOUNCE_MS);
    expect(result.current.state).toBe("ready");
    expect(result.current.matches.map((match) => match.relativePath)).toEqual([
      "src/beta.ts",
    ]);

    // NOW the superseded request answers `building`. It must neither overwrite
    // beta's results nor arm another alpha poll.
    await act(async () => {
      releaseStale(await answer("building"));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.state).toBe("ready");
    expect(result.current.matches.map((match) => match.relativePath)).toEqual([
      "src/beta.ts",
    ]);
    expect(alphaCalls).toBe(2);
  });
});
