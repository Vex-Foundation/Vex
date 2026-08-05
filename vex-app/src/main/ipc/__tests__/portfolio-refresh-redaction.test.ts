/**
 * `vex:portfolio:refresh` FAILURE LOGGING — the redaction contract (Wave P,
 * Blocker 8).
 *
 * The failure line interpolated a raw provider/DB `error.message` into the
 * log's first line. That message is third-party-and-attacker-shaped text: a
 * request URL with its query string, a SQL fragment, a response body. The
 * logger's own contract states that a call site must NOT rely on its pattern
 * scrubber to make raw content safe — the scrubber is defence in depth, not a
 * licence to hand it secrets.
 *
 * The canary below is a single error message carrying every shape that must not
 * survive: an API key in a URL, a bearer token, a SQL fragment and a wallet
 * address. NONE of it may reach the log; the error's CLASS NAME (code-authored)
 * and the correlation id are what remain.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, raw: unknown) => unknown;

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

const logWarn = vi.fn();
const logInfo = vi.fn();
vi.mock("../../logger/index.js", () => ({
  log: {
    info: (...a: unknown[]) => logInfo(...a),
    warn: (...a: unknown[]) => logWarn(...a),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    silly: vi.fn(),
  },
}));

const mockRefreshPortfolioNow = vi.fn();
vi.mock("@vex-agent/sync/index.js", () => ({
  refreshPortfolioNow: (...a: unknown[]) => mockRefreshPortfolioNow(...a),
}));

const { errorClassName, registerPortfolioRefreshHandler, resetPortfolioRefreshRateLimit } =
  await import("../portfolio-refresh.js");

/** Every shape that must never survive into a log line, in one string. */
const CANARY_MESSAGE =
  "request to https://api.provider.example/v1/balances?apiKey=sk_live_CANARYKEY123 failed: " +
  "Authorization: Bearer CANARYTOKEN456 — " +
  'SELECT secret FROM vault WHERE address = \'0xCANARYWALLET789\'';

/** A trusted app frame, the shape `registerHandler` validates the sender against. */
function trustedSender(): unknown {
  const frame: { url: string; parent: null; top: unknown } = {
    url: "app://vex/index.html",
    parent: null,
    top: null,
  };
  frame.top = frame;
  return { senderFrame: frame };
}

async function invokeRefresh(): Promise<unknown> {
  handlers.clear();
  registerPortfolioRefreshHandler();
  const handler = handlers.get("vex:portfolio:refresh");
  if (handler === undefined) throw new Error("portfolio refresh handler not registered");
  return handler(trustedSender(), {
    requestId: "11111111-2222-4333-8444-555555555555",
    payload: {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPortfolioRefreshRateLimit();
});

describe("errorClassName", () => {
  it("returns the code-authored class name and nothing from the message", () => {
    class ProviderTimeoutError extends Error {}
    expect(errorClassName(new ProviderTimeoutError(CANARY_MESSAGE))).toBe("ProviderTimeoutError");
    expect(errorClassName(new Error(CANARY_MESSAGE))).toBe("Error");
  });

  it("refuses to stringify a non-Error throw", () => {
    // Stringifying it would reintroduce exactly the arbitrary content this
    // function exists to exclude.
    expect(errorClassName({ message: CANARY_MESSAGE })).toBe("non_error:object");
    expect(errorClassName(CANARY_MESSAGE)).toBe("non_error:string");
  });
});

describe("the refresh failure log line", () => {
  it("carries no fragment of a raw provider error", async () => {
    mockRefreshPortfolioNow.mockRejectedValue(new Error(CANARY_MESSAGE));

    const result = await invokeRefresh();

    // A failed refresh stays a degraded SUCCESS for the renderer.
    expect(result).toMatchObject({ ok: true, data: { status: "unavailable" } });

    expect(logWarn).toHaveBeenCalledTimes(1);
    const line = String(logWarn.mock.calls[0]?.[0] ?? "");
    for (const canary of [
      "sk_live_CANARYKEY123",
      "CANARYTOKEN456",
      "0xCANARYWALLET789",
      "api.provider.example",
      "SELECT",
      "Bearer",
      "apiKey",
    ]) {
      expect(line).not.toContain(canary);
    }
    // What SHOULD survive: the class name and the correlation id.
    expect(line).toContain("errorName=Error");
    expect(line).toContain("correlationId=11111111-2222-4333-8444-555555555555");
  });

  it("logs a non-Error throw by type alone", async () => {
    mockRefreshPortfolioNow.mockRejectedValue(CANARY_MESSAGE);

    await invokeRefresh();

    const line = String(logWarn.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("errorName=non_error:string");
    expect(line).not.toContain("CANARYKEY123");
  });
});
