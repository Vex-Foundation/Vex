/**
 * Contract tests for `vex:boardChart:poll`.
 *
 * Follows the `board-spotlight-ipc.test.ts` pattern: the REAL `registerHandler`
 * boundary drives schema validation, sender trust and the output-schema gate,
 * and only the service behind the door is mocked.
 *
 * THE PROPERTY THESE TESTS EXIST FOR is that the renderer holds no network
 * authority on this channel. The resolution is a CLOSED four-member enum, and
 * every attempt below to name a fifth resolution, a bar count, a deadline or a
 * transport is refused BY THE SCHEMA before any privileged work runs, with the
 * service asserted never to have been called.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMainFrame,
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const handlers = new Map<string, Handler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  app: { isPackaged: true },
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const poll = vi.fn();
let chartService: unknown = null;

vi.mock("../../market/board-chart-service.js", () => ({
  getBoardChartService: () => chartService,
}));

const { CH } = await import("@shared/ipc/channels.js");
const { registerBoardChartHandlers } = await import("../board-chart.js");

const SUBJECT = {
  chain: "solana",
  pairAddress: "22CfmLna8Bsh7xrbyvGSs6NdD31iFj1UFVnwB7EberWU",
};
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

const SERIES = {
  kind: "series",
  series: {
    bars: [{ tMs: 1_787_741_000_000, o: "1.5", h: "1.9", l: "1.4", c: "1.8" }],
    lastBarPartial: true,
    coveredRange: { fromMs: 1_787_741_000_000, toMs: 1_787_741_000_000 },
    resolution: "1m",
    truncated: false,
  },
  requestedBars: 60,
  providerBars: 1,
  undrawableBars: 0,
  windowedOutBars: 0,
  fetchedAtMs: 1_787_741_000_000,
};

const trustedSender = createTrustedSender({ sender: createTestWebContents() });
const untrustedSender = { senderFrame: createMainFrame("https://evil.example/") };

interface OkResult {
  ok: true;
  data: unknown;
}
interface ErrResult {
  ok: false;
  error: { code: string; message: string; domain: string; redacted: true };
}

function isErr(value: unknown): value is ErrResult {
  return (
    typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false
  );
}

async function call(
  payload: unknown,
  options: { sender?: unknown } = {},
): Promise<OkResult | ErrResult> {
  const fn = handlers.get(CH.boardChart.poll);
  if (fn === undefined) throw new Error("handler not registered");
  return (await fn((options.sender ?? trustedSender) as TestIpcEvent, {
    requestId: REQUEST_ID,
    payload,
  })) as OkResult | ErrResult;
}

let teardown: ReadonlyArray<() => void> = [];


/**
 * A REAL scheduler is mounted for these tests, not a stub.
 *
 * Admission is the property under test on this channel now: a handler that
 * reached the service without passing the board's two-exchange ceiling is the
 * defect these suites exist to catch, and a mocked scheduler would prove only
 * that glue called glue.
 */
const { mountBoardLiveScheduler } = await import(
  "../../market/board-live-scheduler.js"
);
const { getCancelController } = await import("../register-handler.js");
let stopScheduler: () => Promise<void> = async (): Promise<void> => undefined;

beforeEach(() => {
  chartService = { poll };
  stopScheduler = mountBoardLiveScheduler();
  teardown = registerBoardChartHandlers();
});

afterEach(async () => {
  await stopScheduler();
  for (const off of teardown) off();
  handlers.clear();
  vi.clearAllMocks();
});

// ── Positive ────────────────────────────────────────────────────────────

describe("a valid subject and pill reach the service", () => {
  it.each(["1m", "15m", "2h", "8h"] as const)("answers the %s pill", async (resolution) => {
    poll.mockResolvedValue({ ...SERIES, series: { ...SERIES.series, resolution } });
    const result = await call({ subject: SUBJECT, resolution });
    expect(isErr(result)).toBe(false);
    expect(poll).toHaveBeenCalledWith({
      subject: SUBJECT,
      resolution,
      signal: expect.any(AbortSignal),
    });
  });

  it("ECHOES the resolution so a pill switched mid-flight can refuse the answer", async () => {
    poll.mockResolvedValue(SERIES);
    const result = await call({ subject: SUBJECT, resolution: "1m" });
    expect(result).toEqual({
      ok: true,
      data: { subject: SUBJECT, resolution: "1m", outcome: SERIES },
    });
  });
});

describe("absence and unavailability ride the ok path", () => {
  it("returns an absent outcome without an error", async () => {
    poll.mockResolvedValue({ kind: "absent", reason: "no_drawable_bars" });
    const result = await call({ subject: SUBJECT, resolution: "15m" });
    expect(result).toEqual({
      ok: true,
      data: {
        subject: SUBJECT,
        resolution: "15m",
        outcome: { kind: "absent", reason: "no_drawable_bars" },
      },
    });
  });

  it("answers not_mounted when no service is running, rather than throwing", async () => {
    chartService = null;
    const result = await call({ subject: SUBJECT, resolution: "2h" });
    expect(result).toEqual({
      ok: true,
      data: {
        subject: SUBJECT,
        resolution: "2h",
        outcome: { kind: "unavailable", reason: "not_mounted" },
      },
    });
  });
});

// ── Invalid input ────────────────────────────────────────────────────────

describe("invalid input never reaches the service", () => {
  it.each([
    ["no payload at all", undefined],
    ["no resolution", { subject: SUBJECT }],
    ["no subject", { resolution: "1m" }],
    ["a chain that is not a slug", { subject: { chain: "SO LANA", pairAddress: "x" }, resolution: "1m" }],
    ["an empty pair address", { subject: { chain: "solana", pairAddress: "" }, resolution: "1m" }],
    ["a subject that is a string", { subject: "solana:abc", resolution: "1m" }],
  ])("refuses %s", async (_label, payload) => {
    const result = await call(payload);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("validation.invalid_input");
    expect(poll).not.toHaveBeenCalled();
  });

  it.each([
    ["a second-scale resolution nobody sized a window for", "1s"],
    ["a board resolution that is not a pill", "1h"],
    ["a daily bar", "1d"],
    ["a provider wire spelling", "M1"],
    ["an empty string", ""],
  ])("refuses %s", async (_label, resolution) => {
    // The pill list is a POSITIVE PICK of four, not the board's eighteen: the
    // windows, cadences and politeness budget were measured for four buckets.
    const result = await call({ subject: SUBJECT, resolution });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("validation.invalid_input");
    expect(poll).not.toHaveBeenCalled();
  });

  it.each([
    ["a caption, which is the agent's prose", { caption: "deepest pool" }],
    ["an analysis, which is the model's assessment", { analysis: "Looks clean." }],
  ])("refuses a persisted pool field: %s", async (_label, extra) => {
    const result = await call({ subject: { ...SUBJECT, ...extra }, resolution: "1m" });
    expect(isErr(result)).toBe(true);
    expect(poll).not.toHaveBeenCalled();
  });

  it.each([
    ["a host", { host: "https://evil.example" }],
    ["a bar count", { countBack: 999 }],
    ["a deadline", { timeoutMs: 600_000 }],
    ["a transport", { transport: "feed_ws" }],
    ["a series selector", { series: "marketCap" }],
    ["an inversion flag", { inverted: true }],
    ["a cadence", { cadenceMs: 10 }],
  ])("refuses %s smuggled beside the subject", async (_label, extra) => {
    const result = await call({ subject: SUBJECT, resolution: "1m", ...extra });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("validation.invalid_input");
    expect(poll).not.toHaveBeenCalled();
  });
});

// ── Unauthorized sender ───────────────────────────────────────────────────

describe("an untrusted sender is refused", () => {
  it("never reaches the service", async () => {
    const result = await call(
      { subject: SUBJECT, resolution: "1m" },
      { sender: untrustedSender },
    );
    expect(isErr(result)).toBe(true);
    expect(poll).not.toHaveBeenCalled();
  });
});

// ── Cancellation ──────────────────────────────────────────────────────────

describe("cancellation", () => {
  it("passes the request's signal so a reader who left the spotlight cuts the read", async () => {
    let seen: AbortSignal | null = null;
    poll.mockImplementation(async (args: { signal: AbortSignal }) => {
      seen = args.signal;
      return { kind: "unavailable", reason: "cancelled" };
    });
    await call({ subject: SUBJECT, resolution: "1m" });
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it("returns a cancelled outcome on the ok path rather than an error", async () => {
    poll.mockResolvedValue({ kind: "unavailable", reason: "cancelled" });
    const result = await call({ subject: SUBJECT, resolution: "8h" });
    expect(result).toEqual({
      ok: true,
      data: {
        subject: SUBJECT,
        resolution: "8h",
        outcome: { kind: "unavailable", reason: "cancelled" },
      },
    });
  });

  it("normalises a handler abort into the cancelled Result code", async () => {
    poll.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const result = await call({ subject: SUBJECT, resolution: "1m" });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("internal.cancelled");
  });
});

// ── Output gate ───────────────────────────────────────────────────────────

describe("the output schema is a gate on main's own bugs", () => {
  it("refuses to ship a series the contract does not describe", async () => {
    poll.mockResolvedValue({ ...SERIES, series: { ...SERIES.series, bars: "nope" } });
    const result = await call({ subject: SUBJECT, resolution: "1m" });
    expect(isErr(result)).toBe(true);
  });
});


/* ------------------------------------------------------------------ */
/* Admission - the cut reaches the provider                            */
/* ------------------------------------------------------------------ */

describe("the cut reaches the provider", () => {
  it("aborts the SERVICE's own signal when the request is cancelled", async () => {
    // END TO END through the real handler: `vex:cancel` fires `ctx.signal`,
    // admission links it to the run's controller, and the run's signal is what
    // the chart service was handed. The assertion is on that SIGNAL, not on a
    // call count - a mock that was called proves nothing about whether the
    // provider read actually stopped. Before the preload half of this fix the
    // renderer could not even fire the cancel; before the admission half the
    // read did not travel through anything that could link it.
    let seen: AbortSignal | undefined;
    let release = (): void => undefined;
    poll.mockImplementation(async (args: { signal: AbortSignal }) => {
      seen = args.signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { kind: "unavailable", reason: "cancelled" };
    });

    const pending = call({ subject: SUBJECT, resolution: "1m" });
    for (let index = 0; index < 24; index += 1) await Promise.resolve();
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);

    getCancelController(REQUEST_ID)?.abort();
    expect(seen?.aborted).toBe(true);

    release();
    await pending;
  });
});
