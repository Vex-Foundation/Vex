/**
 * Contract tests for `vex:boardDetails:read` and `vex:boardDetails:prefetch`.
 *
 * The real `registerHandler` boundary drives schema validation, sender trust,
 * cancellation and the output-schema gate; only the service's single door
 * (`getBoardDetailsService`) is mocked.
 *
 * TWO PROPERTIES THESE EXIST FOR:
 *  - NOTHING BUT IDENTITY CROSSES. The payload is strict, so a caller naming a
 *    host, a route, a timeout or the agent's caption is refused BY NAME rather
 *    than having the field dropped silently.
 *  - ABSENCE AND UNAVAILABILITY ARE SUCCESSES. Two of four probed chains had
 *    no lock block and one had no security block at all, so those are ordinary
 *    answers on the ok path; a `Result` error here means only invalid input, an
 *    untrusted sender, or cancellation.
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

const read = vi.fn();
const prefetch = vi.fn();
let service: unknown = { read, prefetch, dispose: vi.fn() };
vi.mock("../../market/board-details-service.js", () => ({
  getBoardDetailsService: (): unknown => service,
}));

const { CH } = await import("@shared/ipc/channels.js");
const { registerBoardDetailsHandlers } = await import("../board-details.js");

const SUBJECT = {
  chain: "ethereum",
  pairAddress: "0x80BF6573d7b16c049E449D67017a7bE2DA8B429E",
};
const KEY = "ethereum:0x80bf6573d7b16c049e449d67017a7be2da8b429e";
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

function expectErr(value: OkResult | ErrResult, code: string): ErrResult {
  expect(isErr(value)).toBe(true);
  if (!isErr(value)) throw new Error("unreachable");
  expect(value.error.code).toBe(code);
  return value;
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
  service = { read, prefetch, dispose: vi.fn() };
  stopScheduler = mountBoardLiveScheduler();
  teardown = registerBoardDetailsHandlers();
});

afterEach(async () => {
  await stopScheduler();
  for (const off of teardown) off();
  handlers.clear();
  vi.clearAllMocks();
});

/** Let already-resolved promise jobs run. No wall clock is involved. */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe("read - the positive path", () => {
  it("echoes the subject and forwards the outcome", async () => {
    read.mockResolvedValue({ kind: "absent", reason: "unknown_pair" });
    const result = await call(CH.boardDetails.read, { subject: SUBJECT });
    expect(result).toEqual({
      ok: true,
      data: { subject: SUBJECT, outcome: { kind: "absent", reason: "unknown_pair" } },
    });
  });

  it.each([
    ["transport", "the provider could not be reached"],
    ["provider", "the provider refused"],
    ["not_mounted", "this build has no site bridge"],
    ["busy", "the read queue is full"],
    ["cancelled", "the reader left"],
  ])("carries unavailable/%s on the ok path (%s)", async (reason) => {
    read.mockResolvedValue({ kind: "unavailable", reason });
    const result = await call(CH.boardDetails.read, { subject: SUBJECT });
    expect(result).toEqual({
      ok: true,
      data: { subject: SUBJECT, outcome: { kind: "unavailable", reason } },
    });
  });
});

describe("read - invalid input never reaches the service", () => {
  it.each([
    ["an agent caption, which has no business on a live read channel", { ...SUBJECT, caption: "deepest pool" }],
    ["the model's written assessment", { ...SUBJECT, analysis: "Safety checks are clean." }],
    ["a host the caller tried to name", { ...SUBJECT, origin: "https://evil.example" }],
    ["a timeout knob", { ...SUBJECT, timeoutMs: 1 }],
    ["a provider field group", { ...SUBJECT, fields: "security" }],
  ])("rejects %s", async (_label, subject) => {
    const result = await call(CH.boardDetails.read, { subject });
    expectErr(result, "validation.invalid_input");
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["a chain slug with a path separator", { chain: "ether/eum", pairAddress: SUBJECT.pairAddress }],
    ["an empty pair address", { chain: "ethereum", pairAddress: "" }],
    ["a numeric pair address", { chain: "ethereum", pairAddress: 12345 }],
    ["a missing chain", { pairAddress: SUBJECT.pairAddress }],
  ])("rejects %s", async (_label, subject) => {
    const result = await call(CH.boardDetails.read, { subject });
    expectErr(result, "validation.invalid_input");
    expect(read).not.toHaveBeenCalled();
  });
});

describe("read - an untrusted sender", () => {
  it("is rejected before the service is ever called, and the origin is not echoed", async () => {
    const result = await call(
      CH.boardDetails.read,
      { subject: SUBJECT },
      { sender: untrustedSender },
    );
    const err = expectErr(result, "validation.invalid_sender");
    expect(err.error.redacted).toBe(true);
    expect(JSON.stringify(err.error)).not.toContain("evil.example");
    expect(read).not.toHaveBeenCalled();
  });
});

describe("read - cancellation", () => {
  it("plumbs a real AbortSignal into the service", async () => {
    // The reader closing the modal must stop the wait, not merely ignore the
    // answer when it eventually arrives.
    let seen: AbortSignal | undefined;
    read.mockImplementation(async (_subject: unknown, signal: AbortSignal) => {
      seen = signal;
      return { kind: "unavailable", reason: "cancelled" };
    });
    await call(CH.boardDetails.read, { subject: SUBJECT });
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it("normalises a thrown AbortError into the cancelled Result", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    read.mockRejectedValue(abort);
    const result = await call(CH.boardDetails.read, { subject: SUBJECT });
    expectErr(result, "internal.cancelled");
  });
});

describe("read - the cut reaches the provider", () => {
  it("aborts the SERVICE's own signal when the request is cancelled", async () => {
    // END TO END through the real handler: the renderer's `vex:cancel` fires
    // `ctx.signal`, admission links it to the run's controller, and the run's
    // signal is what the service was handed. The assertion is on that SIGNAL,
    // not on a call count: a mock that was called proves nothing about whether
    // the provider read actually stopped.
    let seen: AbortSignal | undefined;
    let release: (() => void) | undefined;
    read.mockImplementation(async (_subject: unknown, signal: AbortSignal) => {
      seen = signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { kind: "unavailable", reason: "cancelled" };
    });

    const pending = call(CH.boardDetails.read, { subject: SUBJECT });
    await flushMicrotasks();
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);

    getCancelController(REQUEST_ID)?.abort();
    expect(seen?.aborted).toBe(true);

    release?.();
    await pending;
  });

  it("aborts the prefetch fan-out's signal when the board closes", async () => {
    let seen: AbortSignal | undefined;
    let release: (() => void) | undefined;
    prefetch.mockImplementation(async (_pools: unknown, signal: AbortSignal) => {
      seen = signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [];
    });

    const pending = call(CH.boardDetails.prefetch, { pools: [SUBJECT] });
    await flushMicrotasks();
    expect(seen?.aborted).toBe(false);
    getCancelController(REQUEST_ID)?.abort();
    expect(seen?.aborted).toBe(true);
    release?.();
    await pending;
  });
});

describe("read - an unmounted service", () => {
  it("answers a typed unavailable rather than throwing", async () => {
    service = null;
    const result = await call(CH.boardDetails.read, { subject: SUBJECT });
    expect(result).toEqual({
      ok: true,
      data: {
        subject: SUBJECT,
        outcome: { kind: "unavailable", reason: "not_mounted" },
      },
    });
  });
});

describe("read - the output schema gates a malformed answer", () => {
  it("refuses an outcome kind the contract does not name", async () => {
    read.mockResolvedValue({ kind: "probably_fine" });
    const result = await call(CH.boardDetails.read, { subject: SUBJECT });
    expectErr(result, "internal.contract_violation");
  });
});

describe("prefetch", () => {
  it("returns one entry per pool", async () => {
    prefetch.mockResolvedValue([
      { key: KEY, subject: SUBJECT, outcome: { kind: "absent", reason: "unknown_pair" } },
    ]);
    const result = await call(CH.boardDetails.prefetch, { pools: [SUBJECT] });
    expect(result).toEqual({
      ok: true,
      data: {
        entries: [
          { key: KEY, subject: SUBJECT, outcome: { kind: "absent", reason: "unknown_pair" } },
        ],
      },
    });
  });

  it("still accounts for EVERY pool when the service is not mounted", async () => {
    // The chat card's sentence covers the whole board, so an unmounted service
    // produces a board's worth of unchecked rather than an empty answer the
    // counter would have to guess about.
    service = null;
    const result = await call(CH.boardDetails.prefetch, { pools: [SUBJECT] });
    expect(result).toEqual({
      ok: true,
      data: {
        entries: [
          {
            key: KEY,
            subject: SUBJECT,
            outcome: { kind: "unavailable", reason: "not_mounted" },
          },
        ],
      },
    });
  });

  it("refuses an empty pool list rather than answering about nothing", async () => {
    const result = await call(CH.boardDetails.prefetch, { pools: [] });
    expectErr(result, "validation.invalid_input");
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("refuses more pools than a board can hold", async () => {
    const result = await call(CH.boardDetails.prefetch, {
      pools: Array.from({ length: 9 }, () => SUBJECT),
    });
    expectErr(result, "validation.invalid_input");
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("refuses a pool carrying the agent's authored text", async () => {
    const result = await call(CH.boardDetails.prefetch, {
      pools: [{ ...SUBJECT, analysis: "clean" }],
    });
    expectErr(result, "validation.invalid_input");
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("rejects an untrusted sender before the service is called", async () => {
    const result = await call(
      CH.boardDetails.prefetch,
      { pools: [SUBJECT] },
      { sender: untrustedSender },
    );
    expectErr(result, "validation.invalid_sender");
    expect(prefetch).not.toHaveBeenCalled();
  });
});
