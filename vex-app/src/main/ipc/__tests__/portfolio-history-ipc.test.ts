/**
 * `vex:portfolio:readHistory` - the wallet total over time, at the IPC
 * boundary, and its preload method.
 *
 * The read itself is pinned in `database/__tests__/portfolio-history-db.test.ts`
 * (what main binds and maps) and `portfolio-history.int.test.ts` (the SQL on a
 * real Postgres). This suite owns the round trip a renderer request makes:
 *
 *   - a valid request reaches `getPortfolioHistory` parsed, with the request's
 *     correlation id, and its answer comes back through the output schema
 *     unchanged;
 *   - a malformed request (unknown range, malformed scope, stray key) is
 *     refused at the boundary and the read never runs;
 *   - an untrusted sender is refused before any read;
 *   - main's TYPED refusal (a wallet outside the inventory) reaches the
 *     renderer as itself, not flattened;
 *   - an answer that breaks the contract (an address riding on a point, more
 *     points than the bound) is refused by the output schema rather than sent;
 *   - the log line carries counts, never an address or a figure;
 *   - the preload method validates before invoking and invokes exactly this
 *     channel with the payload as given.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMainFrame,
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  getPortfolioHistory: vi.fn(),
  invoke: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  ipcRenderer: { invoke: mocks.invoke },
  app: { isPackaged: true },
}));

vi.mock("../../database/portfolio-db.js", () => ({
  getPortfolio: vi.fn(),
  getPortfolioHistory: (...args: unknown[]) => mocks.getPortfolioHistory(...args),
}));
vi.mock("../../database/token-history-db.js", () => ({ getTokenHistory: vi.fn() }));
vi.mock("../../database/agent-scan-db.js", () => ({ getAgentScan: vi.fn() }));
vi.mock("../portfolio-refresh.js", () => ({
  registerPortfolioRefreshHandler: () => () => undefined,
}));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { CH } = await import("@shared/ipc/channels.js");
const { PORTFOLIO_HISTORY_MAX_POINTS } = await import("@shared/schemas/portfolio-history.js");
const { registerPortfolioHandlers } = await import("../portfolio.js");
const { portfolio } = await import("../../../preload/agent/portfolio.js");

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
const SESSION = "00000000-0000-4000-8000-000000000003";
const WALLET = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";

const trustedSender = createTrustedSender({ sender: createTestWebContents() });
const untrustedSender = {
  senderFrame: createMainFrame("https://evil.example/"),
  sender: createTestWebContents(),
};

const POINT = {
  at: "2026-11-01T10:00:00.000Z",
  totalUsd: 1_234.56,
  settledUsd: 1_200,
  inTransitUsd: 34.56,
  partial: false,
};

const ANSWER = {
  scope: "global",
  range: "7d",
  walletCount: 2,
  groupCount: 2,
  sampled: false,
  points: [
    { ...POINT, at: "2026-11-01T09:55:00.000Z", totalUsd: 1_200, inTransitUsd: 0 },
    POINT,
  ],
} as const;

interface CallResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

async function call(payload: unknown, sender: unknown = trustedSender): Promise<CallResult> {
  const handler = handlers.get(CH.portfolio.readHistory);
  if (handler === undefined) throw new Error("readHistory is not registered");
  return (await handler(sender as TestIpcEvent, { requestId: REQUEST_ID, payload })) as CallResult;
}

let teardown: ReadonlyArray<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  mocks.getPortfolioHistory.mockResolvedValue({ ok: true, data: ANSWER });
  teardown = registerPortfolioHandlers();
});

afterEach(() => {
  for (const off of teardown) off();
  handlers.clear();
});

describe("readHistory - the round trip", () => {
  it("passes the parsed request and correlation id to the read and returns its answer unchanged", async () => {
    const result = await call({ range: "7d", wallets: { scope: "global" } });

    expect(result).toEqual({ ok: true, data: ANSWER });
    expect(mocks.getPortfolioHistory).toHaveBeenCalledWith(
      { range: "7d", wallets: { scope: "global" } },
      REQUEST_ID,
    );
  });

  it.each([
    { range: "24h", wallets: { scope: "global", walletAddress: WALLET } },
    { range: "30d", wallets: { scope: "session", sessionId: SESSION } },
    { range: "all", wallets: { scope: "global" } },
  ])("forwards every chip's scope as given: %j", async (payload) => {
    const result = await call(payload);

    expect(result.ok).toBe(true);
    expect(mocks.getPortfolioHistory).toHaveBeenCalledWith(payload, REQUEST_ID);
  });

  it("returns an empty answer as a success, not an error", async () => {
    const empty = { ...ANSWER, walletCount: 0, groupCount: 0, points: [] };
    mocks.getPortfolioHistory.mockResolvedValue({ ok: true, data: empty });

    expect(await call({ range: "24h", wallets: { scope: "global" } })).toEqual({ ok: true, data: empty });
  });
});

describe("readHistory - refusals before the read", () => {
  it.each([
    { range: "90d", wallets: { scope: "global" } },
    { range: "7d" },
    { range: "7d", wallets: { scope: "session" } },
    { range: "7d", wallets: { scope: "global", sessionId: SESSION } },
    { range: "7d", wallets: { scope: "global" }, addresses: [WALLET] },
  ])("refuses %j and never reads", async (payload) => {
    const result = await call(payload);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mocks.getPortfolioHistory).not.toHaveBeenCalled();
  });

  it("refuses an untrusted sender and never reads", async () => {
    const result = await call({ range: "7d", wallets: { scope: "global" } }, untrustedSender);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_sender");
    expect(mocks.getPortfolioHistory).not.toHaveBeenCalled();
  });

  it("surfaces main's typed refusal for a wallet outside the inventory", async () => {
    mocks.getPortfolioHistory.mockResolvedValue({
      ok: false,
      error: {
        code: "wallets.invalid_selection",
        domain: "portfolio",
        message: "Selected wallet is not in the configured inventory.",
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId: REQUEST_ID,
      },
    });

    const result = await call({ range: "7d", wallets: { scope: "global", walletAddress: "0xNOTMINE" } });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("wallets.invalid_selection");
  });
});

describe("readHistory - the output contract", () => {
  it("refuses an answer that carries an address on a point", async () => {
    mocks.getPortfolioHistory.mockResolvedValue({
      ok: true,
      data: { ...ANSWER, points: [{ ...POINT, walletAddress: WALLET }] },
    });

    const result = await call({ range: "7d", wallets: { scope: "global" } });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.contract_violation");
    expect(JSON.stringify(result)).not.toContain(WALLET);
  });

  it("refuses an answer with more points than the bound", async () => {
    const points = Array.from({ length: PORTFOLIO_HISTORY_MAX_POINTS + 1 }, (_, index) => ({
      ...POINT,
      at: new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString(),
    }));
    mocks.getPortfolioHistory.mockResolvedValue({
      ok: true,
      data: { ...ANSWER, groupCount: points.length, points },
    });

    const result = await call({ range: "all", wallets: { scope: "global" } });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.contract_violation");
  });

  it("logs the scope, range and counts, never an address or a figure", async () => {
    await call({ range: "7d", wallets: { scope: "global", walletAddress: WALLET } });

    const line = mocks.log.info.mock.calls
      .map((args) => String(args[0]))
      .find((text) => text.includes("[ipc:vex:portfolio:readHistory] ok"));
    expect(line).toBe(
      `[ipc:vex:portfolio:readHistory] ok scope=global range=7d wallets=2 groups=2 points=2 correlationId=${REQUEST_ID}`,
    );
    expect(line).not.toContain(WALLET);
    expect(line).not.toContain("1234");
  });
});

describe("readHistory - the preload method", () => {
  it("invokes exactly this channel with the payload as given", async () => {
    mocks.invoke.mockResolvedValue({ ok: true, data: ANSWER });
    const input = { range: "30d", wallets: { scope: "session", sessionId: SESSION } } as const;

    const result = await portfolio.readHistory(input);

    expect(mocks.invoke).toHaveBeenCalledWith(CH.portfolio.readHistory, {
      requestId: expect.any(String),
      payload: input,
    });
    expect(result).toEqual({ ok: true, data: ANSWER });
  });

  it("refuses a malformed request in preload without invoking main", async () => {
    // A stray key the strict input schema refuses; held in a variable, so the
    // compiler's excess-property check lets it reach the method, as a caller
    // outside the type system could.
    const input = { range: "7d" as const, wallets: { scope: "global" as const }, unrecognized: true };
    const result = await portfolio.readHistory(input);

    expect(result).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
