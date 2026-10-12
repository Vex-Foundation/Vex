/**
 * The session ordinal holds still while the list moves: pinning, the tabs and
 * the search, a removal, a list that ages its oldest rows out, a reload, a
 * new session. Each case below is one of those moves.
 */

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import {
  EMPTY_ORDINAL_LEDGER,
  ORDINAL_LEDGER_MAX,
  assignSessionOrdinals,
  formatOrdinal,
  useSessionOrdinals,
  type SessionOrdinalLedger,
} from "../sessionOrdinals.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { mergeUiState, partializeUiState } from "../../../../stores/uiStore/persistence.js";
import { coerceSessionOrdinals } from "../../../../stores/uiStore/session-ordinals.js";
import { filterSessionsByMode, groupSessions } from "../../sessionListModel.js";

function row(id: string, startedAt: string, over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    mode: "agent",
    permission: "restricted",
    title: id,
    initialGoal: null,
    startedAt,
    endedAt: null,
    missionStatus: null,
    pinnedAt: null,
    ...over,
  };
}

const A = row("aaaaaaaa-0000-4000-8000-000000000001", "2026-10-01T09:00:00.000Z");
const B = row("bbbbbbbb-0000-4000-8000-000000000002", "2026-10-02T09:00:00.000Z", { mode: "mission" });
const C = row("cccccccc-0000-4000-8000-000000000003", "2026-10-03T09:00:00.000Z");
const D = row("dddddddd-0000-4000-8000-000000000004", "2026-10-04T09:00:00.000Z");

/** The list as main returns it: most recent first. */
const LIST = [D, C, B, A];

function numbers(ledger: SessionOrdinalLedger, rows: readonly SessionListItem[]): number[] {
  return rows.map((r) => ledger.byId[r.id] ?? 0);
}

describe("assignSessionOrdinals", () => {
  it("seeds a fresh ledger in start order, oldest first", () => {
    const ledger = assignSessionOrdinals(EMPTY_ORDINAL_LEDGER, LIST);
    expect(numbers(ledger, [A, B, C, D])).toEqual([1, 2, 3, 4]);
    expect(ledger.next).toBe(5);
  });

  it("breaks a start-time tie by id, so two reads agree", () => {
    const twin = row("00000000-0000-4000-8000-000000000009", A.startedAt);
    const one = assignSessionOrdinals(EMPTY_ORDINAL_LEDGER, [A, twin]);
    const two = assignSessionOrdinals(EMPTY_ORDINAL_LEDGER, [twin, A]);
    expect(one.byId).toEqual(two.byId);
    expect(one.byId[twin.id]).toBe(1);
  });

  it("keeps every number when a session is pinned (the list reorders, nobody moves)", () => {
    const ledger = assignSessionOrdinals(EMPTY_ORDINAL_LEDGER, LIST);
    const pinnedB = { ...B, pinnedAt: "2026-10-05T09:00:00.000Z" };
    const reordered = groupSessions([D, C, pinnedB, A]).flatMap((g) => g.rows);
    expect(reordered[0]?.id).toBe(B.id);
    const after = assignSessionOrdinals(ledger, reordered);
    expect(after).toBe(ledger);
    expect(numbers(after, [A, B, C, D])).toEqual([1, 2, 3, 4]);
  });

  it("keeps every number under a tab or a search (a filter never numbers)", () => {
    const ledger = assignSessionOrdinals(EMPTY_ORDINAL_LEDGER, LIST);
    const missions = filterSessionsByMode(LIST, "mission");
    expect(assignSessionOrdinals(ledger, missions)).toBe(ledger);
    expect(ledger.byId[B.id]).toBe(2);
  });

  it("keeps the survivors' numbers when a session is removed, and never reuses the gap", () => {
    const ledger = assignSessionOrdinals(EMPTY_ORDINAL_LEDGER, LIST);
    const withoutB = assignSessionOrdinals(ledger, [D, C, A]);
    expect(numbers(withoutB, [A, C, D])).toEqual([1, 3, 4]);
    const E = row("eeeeeeee-0000-4000-8000-000000000005", "2026-10-06T09:00:00.000Z");
    const withE = assignSessionOrdinals(withoutB, [E, D, C, A]);
    expect(withE.byId[E.id]).toBe(5);
    expect(Object.values(withE.byId).filter((n) => n === 2)).toEqual([2]);
  });

  it("keeps a number for a session that aged out of the bounded list and comes back", () => {
    const ledger = assignSessionOrdinals(EMPTY_ORDINAL_LEDGER, LIST);
    const bounded = assignSessionOrdinals(ledger, [D, C]);
    const back = assignSessionOrdinals(bounded, LIST);
    expect(numbers(back, [A, B, C, D])).toEqual([1, 2, 3, 4]);
  });

  it("numbers a new session next, whatever its start time says", () => {
    const ledger = assignSessionOrdinals(EMPTY_ORDINAL_LEDGER, [D, C]);
    // An older row appearing later (a branch, a restored row) still goes last.
    const after = assignSessionOrdinals(ledger, LIST);
    expect(numbers(after, [C, D, A, B])).toEqual([1, 2, 3, 4]);
  });

  it("forgets the lowest numbers of unlisted sessions past its cap, and never hands one out again", () => {
    const byId: Record<string, number> = {};
    for (let i = 1; i <= ORDINAL_LEDGER_MAX; i += 1) byId[`old-${i}`] = i;
    const full: SessionOrdinalLedger = { next: ORDINAL_LEDGER_MAX + 1, byId };
    const after = assignSessionOrdinals(full, [A]);
    expect(Object.keys(after.byId)).toHaveLength(ORDINAL_LEDGER_MAX);
    expect(after.byId["old-1"]).toBeUndefined();
    expect(after.byId[A.id]).toBe(ORDINAL_LEDGER_MAX + 1);
    expect(after.next).toBe(ORDINAL_LEDGER_MAX + 2);
  });
});

describe("formatOrdinal", () => {
  it("prints two digits at least, inside parentheses", () => {
    expect(formatOrdinal(2)).toBe("(02)");
    expect(formatOrdinal(17)).toBe("(17)");
    expect(formatOrdinal(104)).toBe("(104)");
  });
});

describe("useSessionOrdinals", () => {
  beforeEach(() => {
    useUiStore.setState({ sessionOrdinals: EMPTY_ORDINAL_LEDGER });
  });

  it("writes the numbers into the persisted store, so a reload reads the same ones", () => {
    const { result } = renderHook(() => useSessionOrdinals(LIST));
    expect(result.current.get(B.id)).toBe(2);
    const payload = partializeUiState(useUiStore.getState());
    const rehydrated = mergeUiState(payload, useUiStore.getState());
    expect(rehydrated.sessionOrdinals.byId[B.id]).toBe(2);
    useUiStore.setState({ sessionOrdinals: rehydrated.sessionOrdinals });
    // After a reload the removed B is gone from the list; C keeps 3.
    const reloaded = renderHook(() => useSessionOrdinals([D, C, A]));
    expect(reloaded.result.current.get(C.id)).toBe(3);
  });

  it("re-seeds from the list when the stored ledger is not one", () => {
    useUiStore.setState({
      sessionOrdinals: coerceSessionOrdinals({ next: "x" }),
    });
    const { result } = renderHook(() => useSessionOrdinals(LIST));
    expect(result.current.get(A.id)).toBe(1);
  });

  it("answers from the ledger alone while the list has not been read", () => {
    const { result } = renderHook(() => useSessionOrdinals(null));
    expect(result.current.size).toBe(0);
  });
});

describe("coerceSessionOrdinals", () => {
  it("keeps a well-formed ledger", () => {
    const ledger: SessionOrdinalLedger = { next: 3, byId: { a: 1, b: 2 } };
    expect(coerceSessionOrdinals(ledger)).toEqual(ledger);
  });

  it("degrades every off-shape payload to the empty ledger", () => {
    for (const bad of [
      null,
      "x",
      { next: 0, byId: {} },
      { next: 2, byId: [] },
      { next: 2, byId: { a: 2 } },
      { next: 2, byId: { a: 1.5 } },
      { next: 2, byId: { ["x".repeat(65)]: 1 } },
    ]) {
      expect(coerceSessionOrdinals(bad)).toEqual(EMPTY_ORDINAL_LEDGER);
    }
  });
});
