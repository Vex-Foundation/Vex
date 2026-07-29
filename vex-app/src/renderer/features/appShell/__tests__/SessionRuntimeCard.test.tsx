/**
 * RUNTIME & COST card — the session rail's engine instrument (replaces the
 * retired `SessionRuntimeBar`).
 *
 * Pins:
 *   - model identity + the "via {provider}" routing line, rendered ONLY when
 *     main actually reports a provider (never an assumed one), and the
 *     unconfigured state as its own quiet line,
 *   - IN / OUT / CACHE / REASONING last-turn tokens + the session cost, with
 *     the whole usage line absent until the session has had a turn,
 *   - the context meter's band markers come from the DTO (the ENGINE's
 *     `context-pressure-policy` fractions carried by main) and are NEVER
 *     hardcoded here — an older payload without them draws no markers rather
 *     than inventing positions,
 *   - the auto-compact caption reports the BARRIER fraction from that same
 *     DTO, and the meter always carries the "approx, lags one turn" caveat,
 *   - `contextLimit === null` degrades to a bare token count — no bar and no
 *     fabricated denominator,
 *   - the compaction note appears only while something is in flight (or after
 *     a terminal failure) and always names the remote path accessibly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ContextWindowDto } from "@shared/schemas/usage.js";

const mocks = vi.hoisted(() => ({
  useSessionModel: vi.fn(),
  useLastTurnUsage: vi.fn(),
  useSessionUsageTotals: vi.fn(),
  useContextWindow: vi.fn(),
  useCompactionStatus: vi.fn(),
  useCompactionLiveSync: vi.fn(),
}));

vi.mock("../../../lib/api/sessions.js", () => ({
  useSessionModel: mocks.useSessionModel,
}));
vi.mock("../../../lib/api/usage.js", () => ({
  useLastTurnUsage: mocks.useLastTurnUsage,
  useSessionUsageTotals: mocks.useSessionUsageTotals,
  useContextWindow: mocks.useContextWindow,
}));
vi.mock("../../../lib/api/compaction.js", () => ({
  useCompactionStatus: mocks.useCompactionStatus,
  useCompactionLiveSync: mocks.useCompactionLiveSync,
}));
vi.mock("../../wizard/steps/provider/ModelBrandIcon.js", () => ({
  ModelBrandIcon: () => null,
}));

const { SessionRuntimeCard } = await import("../book/SessionRuntimeCard.js");

const SESSION = "00000000-0000-4000-8000-00000000ddcc";

/** The engine's real band edges (context-pressure-policy.ts), via the DTO. */
const BANDS = {
  pressureWarningFraction: 0.85,
  pressureBarrierFraction: 0.88,
  pressureCriticalFraction: 0.92,
} as const;

function ok<T>(data: T) {
  return { isLoading: false, isError: false, data: { ok: true, data } };
}

function setup(overrides?: {
  readonly model?: unknown;
  readonly lastTurn?: unknown;
  readonly totals?: unknown;
  readonly context?: ContextWindowDto | null;
  readonly compaction?: unknown;
}): void {
  mocks.useSessionModel.mockReturnValue(
    ok(
      overrides?.model ?? {
        source: "env",
        provider: "OpenRouter",
        modelId: "anthropic/claude-opus-4",
      },
    ),
  );
  mocks.useLastTurnUsage.mockReturnValue(ok(overrides?.lastTurn ?? null));
  mocks.useSessionUsageTotals.mockReturnValue(
    ok(
      overrides?.totals ?? {
        requestCount: 0,
        totalTokens: 0,
        totalCost: null,
        currency: "USD",
        totalCachedSavings: null,
      },
    ),
  );
  mocks.useContextWindow.mockReturnValue(
    ok(overrides?.context === undefined ? null : overrides.context),
  );
  mocks.useCompactionStatus.mockReturnValue(ok(overrides?.compaction ?? null));
}

const TURN = {
  promptTokens: 60_100,
  completionTokens: 1_200,
  totalTokens: 61_300,
  cachedTokens: 45_000,
  reasoningTokens: 800,
  cachedSavings: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SessionRuntimeCard — model", () => {
  it("shows the model id and the 'via {provider}' routing line", () => {
    setup();
    render(<SessionRuntimeCard sessionId={SESSION} />);
    expect(screen.getByText("anthropic/claude-opus-4")).not.toBeNull();
    expect(screen.getByText("via OpenRouter")).not.toBeNull();
  });

  it("claims NO routing path when main reports no provider", () => {
    setup({
      model: { source: "env", provider: null, modelId: "some/model" },
    });
    render(<SessionRuntimeCard sessionId={SESSION} />);
    expect(screen.getByText("some/model")).not.toBeNull();
    expect(screen.queryByText(/^via /)).toBeNull();
  });

  it("states the unconfigured case plainly", () => {
    setup({ model: { source: "unconfigured", provider: null, modelId: null } });
    render(<SessionRuntimeCard sessionId={SESSION} />);
    expect(screen.getByText("Model not configured")).not.toBeNull();
  });
});

describe("SessionRuntimeCard — usage", () => {
  it("renders IN / OUT / CACHE / REASONING and the session cost", () => {
    setup({
      lastTurn: TURN,
      totals: {
        requestCount: 3,
        totalTokens: 90_000,
        totalCost: 0.1234,
        currency: "USD",
        totalCachedSavings: null,
      },
    });
    const { container } = render(<SessionRuntimeCard sessionId={SESSION} />);
    const text = container.textContent ?? "";
    expect(text).toContain("60.1k");
    expect(text).toContain("1.2k");
    expect(text).toContain("45.0k");
    expect(text).toContain("800");
    expect(screen.getByLabelText("session cost").textContent).toBe("$0.1234");
  });

  it("renders nothing at all before the session's first turn", () => {
    setup();
    render(<SessionRuntimeCard sessionId={SESSION} />);
    expect(screen.queryByLabelText("last turn tokens")).toBeNull();
    expect(screen.queryByLabelText("session cost")).toBeNull();
  });
});

describe("SessionRuntimeCard — context meter", () => {
  function meter(container: HTMLElement): HTMLElement {
    return container.querySelector(
      '[data-vex-area="session-context-meter"]',
    ) as HTMLElement;
  }

  it("places the band markers at the ENGINE's fractions carried by the DTO", () => {
    setup({
      context: {
        sessionId: SESSION,
        tokensUsed: 50_000,
        contextLimit: 200_000,
        ...BANDS,
      },
    });
    const { container } = render(<SessionRuntimeCard sessionId={SESSION} />);
    const marks = [...meter(container).querySelectorAll("span[title]")].map(
      (node) => (node as HTMLElement).style.left,
    );
    expect(marks).toEqual(["85%", "88%", "92%"]);
  });

  it("draws NO markers when the payload predates the fields — never invented positions", () => {
    setup({
      context: { sessionId: SESSION, tokensUsed: 50_000, contextLimit: 200_000 },
    });
    const { container } = render(<SessionRuntimeCard sessionId={SESSION} />);
    expect(meter(container).querySelectorAll("span[title]")).toHaveLength(0);
    expect(container.textContent).not.toContain("Auto-compact");
  });

  it("reports the auto-compact caption from the BARRIER fraction, with the lag caveat", () => {
    setup({
      context: {
        sessionId: SESSION,
        tokensUsed: 50_000,
        contextLimit: 200_000,
        ...BANDS,
      },
    });
    const { container } = render(<SessionRuntimeCard sessionId={SESSION} />);
    expect(container.textContent).toContain("Auto-compact ~88%");
    expect(container.textContent).toContain("approx, lags one turn");
  });

  it("degrades to a bare token count when the limit is null — no fabricated denominator", () => {
    setup({
      context: { sessionId: SESSION, tokensUsed: 50_000, contextLimit: null },
    });
    const { container } = render(<SessionRuntimeCard sessionId={SESSION} />);
    expect(meter(container).getAttribute("data-state")).toBe("no-limit");
    expect(container.textContent).toContain("50.0k");
    expect(container.textContent).not.toContain("%");
  });

  it("renders no meter at all for a missing session", () => {
    setup({ context: null });
    const { container } = render(<SessionRuntimeCard sessionId={SESSION} />);
    expect(
      container.querySelector('[data-vex-area="session-context-meter"]'),
    ).toBeNull();
  });
});

describe("SessionRuntimeCard — compaction", () => {
  it("names the remote path accessibly while a compaction runs", () => {
    setup({
      compaction: { activeCount: 1, latest: { status: "running" } },
    });
    render(<SessionRuntimeCard sessionId={SESSION} />);
    const chip = screen.getByLabelText(/Compaction status: Compacting/i);
    expect(chip.getAttribute("data-state")).toBe("running");
    expect(chip.getAttribute("aria-label")).toContain("redacted before it is sent");
  });

  it("stays hidden when nothing is in flight", () => {
    setup({ compaction: { activeCount: 0, latest: { status: "completed" } } });
    const { container } = render(<SessionRuntimeCard sessionId={SESSION} />);
    expect(
      container.querySelector('[data-vex-area="session-compaction-chip"]'),
    ).toBeNull();
  });
});
