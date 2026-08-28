/**
 * THE SAFETY SEAM - what a card's chip and a chat card's sentence are made of.
 *
 * THE EXPERIMENT IS THE WHOLE PIPELINE, not the hook's internals: a real
 * `boardDetails.prefetch` shape crosses a mocked bridge, the SHARED evidence
 * combiner turns it into evidence, and the SHARED A11 classifier decides. A
 * test that stubbed the classifier would prove the plumbing and nothing about
 * what a reader is told, which is the only thing at stake here.
 *
 * GREEN IS UNREACHABLE WITHOUT EVIDENCE. The first case asserts the transition
 * a board actually makes - every chip `pending` before an answer, a verdict
 * after - and the second asserts that one pool's silence never colours
 * another's. Both are what a naive "default to clear" implementation would
 * fail, and both are what the chat card's tally is counted from.
 *
 * CANCELLATION IS PROVEN THROUGH THE BRIDGE, not asserted about React. The
 * hook consumes the query's `AbortSignal`, so the card unmounting has to reach
 * `cancel()` on the invocation - which is what fires main's own `ctx.signal`
 * and stops a board's worth of provider reads for a surface nobody is looking
 * at.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import type {
  BoardDetailsBundle,
  BoardDetailsOutcome,
  BoardGoPlusFlags,
  BoardPercent,
  BoardQuickIntelFlags,
} from "@shared/schemas/board-details.js";
import { boardDetailsBundleSchema } from "@shared/schemas/board-details.js";
import { CADENCE_DETAILS_MS } from "@shared/board/live-channels.js";
import {
  BOARD_DETAILS_MIN_REFRESH_MS,
  BOARD_DETAILS_RETRY_MS,
  boardDetailsFreshnessMs,
  useBoardSafetyVerdicts,
} from "../board-safety-surface.js";
import { BOARD_PREVIEW_PENDING_CONCLUSION } from "../BoardPreviewCard.js";
import { BoardPreviewCard } from "../BoardPreviewCard.js";
import { BOARD_LIVE_READOUT_SNAPSHOT } from "../board-live-overlay.js";
import { boardRefOf, type BoardRef } from "../board-surface-contracts.js";
import { boardSpec, hydratedRow } from "./boardFixture.js";

const NOW = 1_756_000_000_000;

const prefetch = vi.fn();
const readBoardIcon = vi.fn();
/** Every `cancel` handed out, so a test can ask whether ANY was called. */
let cancels: ReturnType<typeof vi.fn>[] = [];

function pct(value: number): BoardPercent {
  return { raw: String(value), normalizedPct: value, unit: "percent" };
}

function goPlusClean(): BoardGoPlusFlags {
  return {
    isHoneypot: false,
    isOpenSource: true,
    isProxy: false,
    isMintable: false,
    isBlacklisted: false,
    transferPausable: false,
    hiddenOwner: false,
    canTakeBackOwnership: false,
    cannotSellAll: false,
    slippageModifiable: false,
    buyTaxPct: pct(0),
    sellTaxPct: pct(0),
    ownerShare: pct(1.2),
    creatorShare: pct(0.4),
  };
}

function quickIntelClean(): BoardQuickIntelFlags {
  return {
    contractVerified: true,
    isScam: false,
    isHoneypot: false,
    isProxy: false,
    hiddenOwner: false,
    canMint: false,
    canBlacklist: false,
    canPauseTrading: false,
    hasFeeWarning: false,
    hasExternalContractRisk: false,
    hasGeneralVulnerabilities: false,
    hasObfuscatedAddressRisk: false,
    buyTaxPct: pct(0),
    sellTaxPct: pct(0),
    transferTaxPct: pct(0),
    lpBurnedPct: pct(99.99),
  };
}

/** A complete, verified, entirely clean document: the only shape that is green. */
function cleanBundle(chain: string, pairAddress: string): BoardDetailsBundle {
  return {
    subject: { chain, pairAddress },
    baseTokenAddress: "0xabc0000000000000000000000000000000000001",
    baseTokenSymbol: "ETHCATE",
    holders: { count: 1358, source: "goplus", shareUnit: "fraction" },
    liquidityLocks: {
      lockedPct: pct(99.99),
      rows: [{ tag: "Burned", share: pct(99.99) }],
    },
    safety: {
      coverage: {
        state: "complete",
        presentBlocks: ["security.goplus", "security.quickintel"],
        absentBlocks: [],
      },
      goplus: goPlusClean(),
      quickintel: quickIntelClean(),
      tokenAuthority: null,
      conflicts: [],
    },
    auditedTokenCheck: {
      auditedTokenAddress: "0xabc0000000000000000000000000000000000001",
      auditedTokenSymbol: "ETHCATE",
      addressesAgree: true,
      symbolsAgree: true,
      mismatch: false,
    },
    providerWindow: { cacheMaxAgeSeconds: 60, cacheAgeSeconds: 5 },
    fetchedAtMs: NOW - 10_000,
    expiresAtMs: NOW + 50_000,
    metaIds: [],
  };
}

/** A deferred invocation, shaped exactly as the abortable bridge returns one. */
function deferred(): {
  invocation: { promise: Promise<unknown>; cancel: () => void };
  settle: (value: unknown) => void;
} {
  let settle: (value: unknown) => void = () => {};
  const promise = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  const cancel = vi.fn();
  cancels.push(cancel);
  return { invocation: { promise, cancel }, settle };
}

function answerWith(
  outcomeFor: (subject: { chain: string; pairAddress: string }) => BoardDetailsOutcome,
): void {
  prefetch.mockImplementation(
    (input: { pools: { chain: string; pairAddress: string }[] }) => {
      const cancel = vi.fn();
      cancels.push(cancel);
      return {
        promise: Promise.resolve({
          ok: true,
          data: {
            entries: input.pools.map((subject) => ({
              key: `${subject.chain}:${subject.pairAddress}`.toLowerCase(),
              subject,
              outcome: outcomeFor(subject),
            })),
          },
        }),
        cancel,
      };
    },
  );
}

function threePoolBoard(): BoardRef {
  const pools = [
    { chain: "base", pairAddress: "0xaaa111", analysis: null },
    { chain: "base", pairAddress: "0xbbb222", analysis: null },
    { chain: "base", pairAddress: "0xccc333", analysis: null },
  ];
  return boardRefOf(
    "s1",
    9,
    boardSpec({ pools, rows: pools.map(() => hydratedRow()) }),
  );
}

/** Reports the seam's output as text, one verdict state per pool, in order. */
function Probe({ board }: { readonly board: BoardRef }): JSX.Element {
  const verdicts = useBoardSafetyVerdicts(board.spec);
  return (
    <p data-testid="verdicts">
      {verdicts.map((verdict) => verdict.state).join(",")}
    </p>
  );
}

function wrap(node: ReactNode): JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  cancels = [];
  prefetch.mockReset();
  readBoardIcon.mockReset();
  readBoardIcon.mockResolvedValue({
    ok: true,
    data: { iconId: "abcd1234", icon: { kind: "not_found" } },
  });
  answerWith((subject) => ({
    kind: "details",
    bundle: cleanBundle(subject.chain, subject.pairAddress),
  }));
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      boardDetails: { prefetch },
      boardIcons: { read: readBoardIcon },
    },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

describe("the fixture is valid against the wire contract", () => {
  it("parses the clean bundle through its own schema", () => {
    // A fixture that could not cross the IPC boundary would prove nothing
    // about production behaviour.
    expect(
      boardDetailsBundleSchema.safeParse(cleanBundle("base", "0xaaa111")).success,
    ).toBe(true);
  });
});

describe("useBoardSafetyVerdicts", () => {
  it("is pending for every pool until evidence arrives, then classifies", async () => {
    const board = threePoolBoard();
    const pending = deferred();
    prefetch.mockReturnValue(pending.invocation);

    render(wrap(<Probe board={board} />));
    // A11 row 1: a read is in flight and no pool has any last-good. Nothing
    // here can produce a colour, because no code names a state at all.
    expect(screen.getByTestId("verdicts").textContent).toBe(
      "pending,pending,pending",
    );

    pending.settle({
      ok: true,
      data: {
        entries: board.spec.pools.map((pool) => ({
          key: `${pool.chain}:${pool.pairAddress}`.toLowerCase(),
          subject: { chain: pool.chain, pairAddress: pool.pairAddress },
          outcome: {
            kind: "details",
            bundle: cleanBundle(pool.chain, pool.pairAddress),
          },
        })),
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("verdicts").textContent).toBe(
        "clear,clear,clear",
      );
    });
  });

  it("keeps one pool's failure off the other pools' chips", async () => {
    const board = threePoolBoard();
    answerWith((subject) =>
      subject.pairAddress === "0xbbb222"
        ? { kind: "unavailable", reason: "transport" }
        : {
            kind: "details",
            bundle: cleanBundle(subject.chain, subject.pairAddress),
          },
    );

    render(wrap(<Probe board={board} />));
    // Positional against `spec.pools`: the middle pool is the one that failed,
    // and it is `unavailable` (A11 row 2, no usable last-good) while its
    // neighbours are green on their own evidence.
    await waitFor(() => {
      expect(screen.getByTestId("verdicts").textContent).toBe(
        "clear,unavailable,clear",
      );
    });
  });

  it("returns one verdict per pool, in the spec's own pool order", async () => {
    const board = threePoolBoard();
    answerWith((subject) =>
      subject.pairAddress === "0xccc333"
        ? { kind: "absent", reason: "unknown_pair" }
        : {
            kind: "details",
            bundle: cleanBundle(subject.chain, subject.pairAddress),
          },
    );
    render(wrap(<Probe board={board} />));
    await waitFor(() => {
      expect(screen.getByTestId("verdicts").textContent).toBe(
        "clear,clear,not-indexed",
      );
    });
  });

  it("aborts the read when the surface goes away", async () => {
    const board = threePoolBoard();
    const pending = deferred();
    prefetch.mockReturnValue(pending.invocation);

    const view = render(wrap(<Probe board={board} />));
    await waitFor(() => {
      expect(prefetch).toHaveBeenCalledTimes(1);
    });
    expect(pending.invocation.cancel).not.toHaveBeenCalled();

    // The modal host unmounts its slot children on EVERY close path, so this
    // is the close as the hook experiences it.
    view.unmount();

    await waitFor(() => {
      expect(pending.invocation.cancel).toHaveBeenCalled();
    });
  });
});

describe("the chat card's conclusion is counted from the same verdicts", () => {
  function preview(board: BoardRef): JSX.Element {
    return wrap(
      <BoardPreviewCard
        board={board}
        onOpen={() => {}}
        live={BOARD_LIVE_READOUT_SNAPSHOT}
      />,
    );
  }

  it("says it is still checking while no pool has a settled verdict", () => {
    const pending = deferred();
    prefetch.mockReturnValue(pending.invocation);
    render(preview(threePoolBoard()));
    expect(
      document.querySelector('[data-vex-area="board-preview-conclusion"]')
        ?.textContent,
    ).toBe(BOARD_PREVIEW_PENDING_CONCLUSION);
  });

  it("counts every pool, including the ones nobody could read", async () => {
    answerWith((subject) =>
      subject.pairAddress === "0xbbb222"
        ? { kind: "unavailable", reason: "transport" }
        : {
            kind: "details",
            bundle: cleanBundle(subject.chain, subject.pairAddress),
          },
    );
    render(preview(threePoolBoard()));

    // Two clean, and the pool nobody could read is COUNTED as unchecked
    // rather than dropped to make the board read cleaner than it is.
    await waitFor(() => {
      const text =
        document.querySelector('[data-vex-area="board-preview-conclusion"]')
          ?.textContent ?? "";
      expect(text).toContain("2 clean");
      expect(text).toContain("1 unchecked");
    });
  });
});

describe("boardDetailsFreshnessMs", () => {
  function result(outcomes: BoardDetailsOutcome[]): {
    ok: true;
    data: { entries: { key: string; subject: { chain: string; pairAddress: string }; outcome: BoardDetailsOutcome }[] };
  } {
    return {
      ok: true,
      data: {
        entries: outcomes.map((outcome, index) => ({
          key: `base:0x${String(index)}`,
          subject: { chain: "base", pairAddress: `0x${String(index)}` },
          outcome,
        })),
      },
    };
  }

  it("follows the provider's own freshness edge, not a chosen interval", () => {
    const bundle = cleanBundle("base", "0xaaa111");
    // 50 s of provider freshness left, which is inside the window and above
    // the floor, so it is used verbatim.
    expect(
      boardDetailsFreshnessMs(result([{ kind: "details", bundle }]), NOW),
    ).toBe(bundle.expiresAtMs - NOW);
  });

  it("takes the EARLIEST pool's edge: the board is as fresh as its stalest row", () => {
    const soon = cleanBundle("base", "0xaaa111");
    const later = {
      ...cleanBundle("base", "0xbbb222"),
      expiresAtMs: NOW + 55_000,
    };
    expect(
      boardDetailsFreshnessMs(
        result([
          { kind: "details", bundle: later },
          { kind: "details", bundle: soon },
        ]),
        NOW,
      ),
    ).toBe(soon.expiresAtMs - NOW);
  });

  it("floors an already-consumed freshness instead of spinning", () => {
    // Measured on ethereum: no `age` header means the freshness is treated as
    // fully consumed, so the edge is in the past and the raw minimum is
    // negative. Without the floor this would re-ask on every commit.
    const consumed = {
      ...cleanBundle("base", "0xaaa111"),
      expiresAtMs: NOW - 1_000,
    };
    expect(
      boardDetailsFreshnessMs(result([{ kind: "details", bundle: consumed }]), NOW),
    ).toBe(BOARD_DETAILS_MIN_REFRESH_MS);
  });

  it("re-asks a non-answer soon and a settled absence on the provider's window", () => {
    expect(
      boardDetailsFreshnessMs(
        result([{ kind: "unavailable", reason: "not_mounted" }]),
        NOW,
      ),
    ).toBe(BOARD_DETAILS_RETRY_MS);
    expect(
      boardDetailsFreshnessMs(
        result([{ kind: "absent", reason: "unknown_pair" }]),
        NOW,
      ),
    ).toBe(CADENCE_DETAILS_MS);
  });

  it("never re-asks a boundary refusal: it cannot answer differently", () => {
    expect(boardDetailsFreshnessMs(undefined, NOW)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(
      boardDetailsFreshnessMs(
        {
          ok: false,
          error: {
            code: "validation.invalid_input",
            domain: "preload",
            message: "no",
            retryable: false,
            userActionable: false,
            redacted: true,
            correlationId: "c1",
          },
        },
        NOW,
      ),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});
