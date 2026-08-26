/**
 * Contract tests for the five `vex:boardSpotlight:*` channels.
 *
 * Follows the `board-icons-ipc.test.ts` pattern: the REAL `registerHandler`
 * boundary drives schema validation, sender trust and the output-schema gate,
 * and only the services behind the door are mocked.
 *
 * THE PROPERTY THESE TESTS EXIST FOR is that the renderer holds no network
 * authority on these channels. Every attempt below to smuggle a host, a
 * deadline, a page budget, a lookback window, a sort key or a row limit through
 * the payload is refused BY THE SCHEMA, before any privileged work runs, and
 * the service is asserted never to have been called.
 *
 * UNAVAILABILITY IS A SUCCESS. Each section of the mockup is a card that must
 * render its own honest state rather than vanish, so `unavailable` rides the ok
 * path. A `Result` error here therefore means only invalid input, an untrusted
 * sender, or cancellation, which is what makes those three worth alerting on.
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

const topTraders = vi.fn();
const momentum = vi.fn();
const otherPools = vi.fn();
const context = vi.fn();
const tapePoll = vi.fn();
let spotlightService: unknown = null;

vi.mock("../../market/board-spotlight-service.js", () => ({
  getBoardSpotlightService: () => spotlightService,
}));

const detailsRead = vi.fn();
let detailsService: unknown = null;

vi.mock("../../market/board-details-service.js", () => ({
  getBoardDetailsService: () => detailsService,
}));

const { CH } = await import("@shared/ipc/channels.js");
const { registerBoardSpotlightHandlers } = await import("../board-spotlight.js");

const SUBJECT = {
  chain: "solana",
  pairAddress: "22CfmLna8Bsh7xrbyvGSs6NdD31iFj1UFVnwB7EberWU",
};
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

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
  channel: string,
  payload: unknown,
  options: { sender?: unknown } = {},
): Promise<OkResult | ErrResult> {
  const fn = handlers.get(channel);
  if (fn === undefined) throw new Error(`handler not registered: ${channel}`);
  return (await fn((options.sender ?? trustedSender) as TestIpcEvent, {
    requestId: REQUEST_ID,
    payload,
  })) as OkResult | ErrResult;
}

let teardown: ReadonlyArray<() => void> = [];

beforeEach(() => {
  spotlightService = {
    topTraders,
    momentum,
    otherPools,
    context,
    tape: { poll: tapePoll },
  };
  detailsService = { read: detailsRead };
  detailsRead.mockResolvedValue({ kind: "unavailable", reason: "transport" });
  teardown = registerBoardSpotlightHandlers();
});

afterEach(() => {
  for (const off of teardown) off();
  handlers.clear();
  vi.clearAllMocks();
});

const TRADERS_PANEL = {
  kind: "traders",
  rows: [],
  rowsAvailable: 0,
  lookbackDays: 30,
  windowLabel: "30-day pair-local cash flow",
  semanticsNote: "Net is cash flow through this pool, not profit.",
  fetchedAtMs: 1_787_741_000_000,
};

const MOMENTUM_PANEL = {
  kind: "momentum",
  rows: (["m5", "h1", "h6", "h24"] as const).map((window) => ({
    window,
    hours: 1,
    volumeUsd: null,
    volumeBuyUsd: null,
    volumeSellUsd: null,
    buys: null,
    sells: null,
    priceChangePct: null,
    volumeUsdPerHour: null,
    tradesPerHour: null,
    buySharePct: null,
  })),
  fetchedAtMs: 1_787_741_000_000,
};

// ── Positive ────────────────────────────────────────────────────────────

describe("a valid subject reaches the service and its panel comes back", () => {
  it("answers the traders channel", async () => {
    topTraders.mockResolvedValue(TRADERS_PANEL);
    const result = await call(CH.boardSpotlight.topTraders, { subject: SUBJECT });
    expect(result).toEqual({
      ok: true,
      data: { subject: SUBJECT, outcome: TRADERS_PANEL },
    });
    expect(topTraders).toHaveBeenCalledWith(SUBJECT, expect.any(AbortSignal));
  });

  it("answers the momentum channel", async () => {
    momentum.mockResolvedValue(MOMENTUM_PANEL);
    const result = await call(CH.boardSpotlight.momentum, { subject: SUBJECT });
    expect(result).toEqual({
      ok: true,
      data: { subject: SUBJECT, outcome: MOMENTUM_PANEL },
    });
  });

  it("answers the tape channel and forwards the reset flag", async () => {
    const tick = {
      kind: "tape",
      rows: [],
      watermark: null,
      appended: 0,
      droppedIncompleteIdentity: 0,
      pagesFetched: 1,
      gapBefore: false,
      fetchedAtMs: 1_787_741_000_000,
    };
    tapePoll.mockResolvedValue(tick);
    const result = await call(CH.boardSpotlight.tapePoll, {
      subject: SUBJECT,
      reset: true,
    });
    expect(result).toEqual({ ok: true, data: { subject: SUBJECT, outcome: tick } });
    expect(tapePoll).toHaveBeenCalledWith({
      subject: SUBJECT,
      reset: true,
      signal: expect.any(AbortSignal),
    });
  });

  it("takes the narrative join keys from MAIN's own details read, never from the payload", async () => {
    detailsRead.mockResolvedValue({
      kind: "details",
      bundle: { metaIds: ["KAxVtm2QhpF8vU6RkrBl"] },
    });
    context.mockResolvedValue({
      kind: "context",
      boostsActive: 10,
      promotionNote: "A boost buys visibility, not demand.",
      narratives: [],
      unjoinedMetaIds: [],
      fetchedAtMs: 1_787_741_000_000,
    });
    await call(CH.boardSpotlight.context, { subject: SUBJECT });
    expect(context).toHaveBeenCalledWith({
      subject: SUBJECT,
      metaIds: ["KAxVtm2QhpF8vU6RkrBl"],
      signal: expect.any(AbortSignal),
    });
  });
});

describe("unavailability rides the ok path so the card keeps its designed state", () => {
  it.each([
    [CH.boardSpotlight.topTraders, topTraders],
    [CH.boardSpotlight.momentum, momentum],
    [CH.boardSpotlight.otherPools, otherPools],
  ])("returns ok with an unavailable outcome on %s", async (channel, service) => {
    service.mockResolvedValue({ kind: "unavailable", reason: "transport" });
    const result = await call(channel, { subject: SUBJECT });
    expect(result).toEqual({
      ok: true,
      data: { subject: SUBJECT, outcome: { kind: "unavailable", reason: "transport" } },
    });
  });

  it("answers not_mounted when no service is running, rather than throwing", async () => {
    spotlightService = null;
    const result = await call(CH.boardSpotlight.momentum, { subject: SUBJECT });
    expect(result).toEqual({
      ok: true,
      data: {
        subject: SUBJECT,
        outcome: { kind: "unavailable", reason: "not_mounted" },
      },
    });
  });

  it("keeps the context section when the details read that carries the ids fails", async () => {
    // A missing join must never turn the promotion flag beside it into an
    // error: the section renders with an empty narrative list.
    detailsRead.mockResolvedValue({ kind: "unavailable", reason: "transport" });
    context.mockResolvedValue({
      kind: "context",
      boostsActive: null,
      promotionNote: "A boost buys visibility, not demand.",
      narratives: [],
      unjoinedMetaIds: [],
      fetchedAtMs: 1,
    });
    const result = await call(CH.boardSpotlight.context, { subject: SUBJECT });
    expect(isErr(result)).toBe(false);
    expect(context).toHaveBeenCalledWith({
      subject: SUBJECT,
      metaIds: [],
      signal: expect.any(AbortSignal),
    });
  });
});

// ── Invalid input: validation runs before any privileged work ─────────────

describe("invalid input never reaches the service", () => {
  it.each([
    ["no payload at all", undefined],
    ["no subject", {}],
    ["a chain that is not a slug", { subject: { chain: "SO LANA", pairAddress: "x" } }],
    ["an empty pair address", { subject: { chain: "solana", pairAddress: "" } }],
    ["a subject that is a string", { subject: "solana:abc" }],
  ])("refuses %s", async (_label, payload) => {
    const result = await call(CH.boardSpotlight.topTraders, payload);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("validation.invalid_input");
    expect(topTraders).not.toHaveBeenCalled();
  });

  it.each([
    ["a caption, which is the agent's prose", { caption: "deepest pool" }],
    ["an analysis, which is the model's assessment", { analysis: "Looks clean." }],
  ])("refuses a persisted pool field: %s", async (_label, extra) => {
    // The channel takes IDENTITY, not the pool document. A subtractive rule
    // would have let a later pool field through unnoticed.
    const result = await call(CH.boardSpotlight.topTraders, {
      subject: { ...SUBJECT, ...extra },
    });
    expect(isErr(result)).toBe(true);
    expect(topTraders).not.toHaveBeenCalled();
  });

  it.each([
    ["a host", { host: "https://evil.example" }],
    ["a deadline", { timeoutMs: 600_000 }],
    ["a page budget", { maxPages: 999 }],
    ["a lookback window", { lookbackDays: 1 }],
    ["a sort key", { sortBy: "netCashFlowUsd" }],
    ["a row limit", { limit: 500 }],
    ["a cadence", { cadenceMs: 10 }],
  ])("refuses %s smuggled beside the subject", async (_label, extra) => {
    const result = await call(CH.boardSpotlight.topTraders, {
      subject: SUBJECT,
      ...extra,
    });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("validation.invalid_input");
    expect(topTraders).not.toHaveBeenCalled();
  });

  it("refuses a tape poll with no reset decision", async () => {
    const result = await call(CH.boardSpotlight.tapePoll, { subject: SUBJECT });
    expect(isErr(result)).toBe(true);
    expect(tapePoll).not.toHaveBeenCalled();
  });

  it("refuses a tape poll carrying a watermark of the renderer's choosing", async () => {
    // The watermark is main's state. A renderer that could set it could make
    // the tape skip blocks or re-read history at will.
    const result = await call(CH.boardSpotlight.tapePoll, {
      subject: SUBJECT,
      reset: false,
      watermark: 1,
    });
    expect(isErr(result)).toBe(true);
    expect(tapePoll).not.toHaveBeenCalled();
  });
});

// ── Unauthorized sender ───────────────────────────────────────────────────

describe("an untrusted sender is refused on every channel", () => {
  it.each([
    [CH.boardSpotlight.topTraders, { subject: SUBJECT }, topTraders],
    [CH.boardSpotlight.momentum, { subject: SUBJECT }, momentum],
    [CH.boardSpotlight.otherPools, { subject: SUBJECT }, otherPools],
    [CH.boardSpotlight.context, { subject: SUBJECT }, context],
    [CH.boardSpotlight.tapePoll, { subject: SUBJECT, reset: false }, tapePoll],
  ])("refuses %s", async (channel, payload, service) => {
    const result = await call(channel, payload, { sender: untrustedSender });
    expect(isErr(result)).toBe(true);
    expect(service).not.toHaveBeenCalled();
  });
});

// ── Cancellation ──────────────────────────────────────────────────────────

describe("cancellation", () => {
  it("passes the request's signal to the service so a reader who left cuts the read", async () => {
    let seen: AbortSignal | null = null;
    momentum.mockImplementation(async (_subject: unknown, signal: AbortSignal) => {
      seen = signal;
      return { kind: "unavailable", reason: "cancelled" };
    });
    await call(CH.boardSpotlight.momentum, { subject: SUBJECT });
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it("returns a cancelled outcome on the ok path rather than an error", async () => {
    // The reader moved on. That is not a failure they should be shown.
    tapePoll.mockResolvedValue({ kind: "unavailable", reason: "cancelled" });
    const result = await call(CH.boardSpotlight.tapePoll, {
      subject: SUBJECT,
      reset: false,
    });
    expect(result).toEqual({
      ok: true,
      data: { subject: SUBJECT, outcome: { kind: "unavailable", reason: "cancelled" } },
    });
  });

  it("normalises a handler abort into the cancelled Result code", async () => {
    momentum.mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );
    const result = await call(CH.boardSpotlight.momentum, { subject: SUBJECT });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("internal.cancelled");
  });
});

// ── Output gate ───────────────────────────────────────────────────────────

describe("the output schema is a gate on main's own bugs", () => {
  it("refuses to ship an off-contract panel", async () => {
    // A service that returned a shape the contract does not describe is a main
    // fault, and it is caught HERE rather than surfacing in the renderer as a
    // section that renders nothing.
    topTraders.mockResolvedValue({ kind: "traders", rows: "not-an-array" });
    const result = await call(CH.boardSpotlight.topTraders, { subject: SUBJECT });
    expect(isErr(result)).toBe(true);
  });
});
