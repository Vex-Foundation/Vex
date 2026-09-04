/**
 * `vex:portfolio:listAgentScan` - the SCOPE contract at the IPC boundary.
 *
 * The read itself is pinned in `database/__tests__/agent-scan-db*.test.ts`.
 * What this suite owns is the boundary: which requests are allowed to reach
 * main's resolver at all, and what the caller is told when they are not.
 *
 * The matrix rule 90 asks for on a scoped read:
 *   - a positive PROJECT read reaches the resolver with the project id, and
 *     nothing else about the scope crosses the wire;
 *   - a request carrying BOTH scope ids is refused at the boundary and the
 *     resolver is never called - the schema refuses it by name, and the public
 *     error stays redacted (the name belongs in the log and the type, not in a
 *     payload sent back to an untrusted renderer);
 *   - an unknown project surfaces main's TYPED refusal, not a flattened
 *     "unexpected error" and never an empty page;
 *   - a project with nothing selected is a real EMPTY page with hasMore false;
 *   - an untrusted sender is refused before any read;
 *   - a user cancellation that races a query timeout surfaces as
 *     `internal.cancelled`, not as a spurious database timeout;
 *   - the log line names WHETHER a scope applied, never WHICH one.
 *
 * `getAgentScan` is mocked: this file is about the handler, and the resolver
 * has its own suites with a real query builder behind them.
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
  getAgentScan: vi.fn(),
  getPortfolio: vi.fn(),
  getTokenHistory: vi.fn(),
  registerPortfolioRefreshHandler: vi.fn(() => () => undefined),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
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
  app: { isPackaged: true },
}));

vi.mock("../../database/agent-scan-db.js", () => ({
  getAgentScan: (...a: unknown[]) => mocks.getAgentScan(...a),
}));
vi.mock("../../database/portfolio-db.js", () => ({
  getPortfolio: (...a: unknown[]) => mocks.getPortfolio(...a),
}));
vi.mock("../../database/token-history-db.js", () => ({
  getTokenHistory: (...a: unknown[]) => mocks.getTokenHistory(...a),
}));
vi.mock("../portfolio-refresh.js", () => ({
  registerPortfolioRefreshHandler: () =>
    mocks.registerPortfolioRefreshHandler(),
}));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { CH } = await import("../../../shared/ipc/channels.js");
const { getCancelController } = await import("../register-handler.js");
const { registerPortfolioHandlers } = await import("../portfolio.js");

const PROJECT = "33333333-4444-4555-8666-777777777777";
const SESSION = "11111111-2222-4333-8444-555555555555";

const trustedSender = createTrustedSender({ sender: createTestWebContents() });
const untrustedSender = {
  senderFrame: createMainFrame("https://evil.example/"),
  sender: createTestWebContents(),
};

const EMPTY_PAGE = {
  status: "available",
  entries: [],
  nextCursor: null,
  hasMore: false,
} as const;

let cleanups: ReadonlyArray<() => void> | null = null;

interface CallResult {
  readonly ok: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly message: string };
}

async function call(
  payload: Record<string, unknown>,
  options: { readonly sender?: unknown; readonly requestId?: string } = {},
): Promise<CallResult> {
  const handler = handlers.get(CH.portfolio.listAgentScan);
  if (handler === undefined) throw new Error("listAgentScan is not registered");
  const requestId = options.requestId ?? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  return (await handler(
    (options.sender ?? trustedSender) as TestIpcEvent,
    { requestId, payload },
  )) as CallResult;
}

/** Every `ok` log line this handler wrote. */
function okLogLines(): readonly string[] {
  return mocks.log.info.mock.calls
    .map((callArgs) => String(callArgs[0]))
    .filter((line) => line.includes("[ipc:vex:portfolio:listAgentScan]"));
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  mocks.getAgentScan.mockResolvedValue({ ok: true, data: EMPTY_PAGE });
  cleanups = registerPortfolioHandlers();
});

afterEach(() => {
  if (cleanups !== null) for (const cleanup of cleanups) cleanup();
  cleanups = null;
  handlers.clear();
});

describe("listAgentScan - the project scope reaches main", () => {
  it("passes the project id to the resolver and returns its page", async () => {
    const page = {
      status: "available",
      entries: [],
      nextCursor: null,
      hasMore: true,
    };
    mocks.getAgentScan.mockResolvedValue({ ok: true, data: page });

    const result = await call({ filters: { projectId: PROJECT } });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(page);
    // The renderer sends an ID; the wallet resolution is main's own.
    expect(mocks.getAgentScan).toHaveBeenCalledWith(
      { cursor: null, filters: { projectId: PROJECT } },
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
  });

  it("a project with nothing selected is an EMPTY page, not an error", async () => {
    const result = await call({ filters: { projectId: PROJECT } });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(EMPTY_PAGE);
    expect(result.data?.["hasMore"]).toBe(false);
  });

  it("surfaces a TYPED project refusal instead of flattening it", async () => {
    mocks.getAgentScan.mockResolvedValue({
      ok: false,
      error: {
        code: "projects.not_found",
        domain: "portfolio",
        message: "That project no longer exists. Refresh your project list.",
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      },
    });

    const result = await call({ filters: { projectId: PROJECT } });

    expect(result.ok).toBe(false);
    // An unknown project must never arrive as an empty page: on an audit feed
    // that reads as "this project has never done anything".
    expect(result.error?.code).toBe("projects.not_found");
    expect(result.data).toBeUndefined();
  });
});

describe("listAgentScan - refusals happen before the read", () => {
  it("refuses sessionId and projectId together, and never calls the resolver", async () => {
    const result = await call({
      filters: { sessionId: SESSION, projectId: PROJECT },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    // The schema names the offending field (pinned in the shared schema
    // suite); the PUBLIC error stays redacted, and the read never happens.
    expect(mocks.getAgentScan).not.toHaveBeenCalled();
  });

  it("refuses an untrusted sender before any read", async () => {
    const result = await call(
      { filters: { projectId: PROJECT } },
      { sender: untrustedSender },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_sender");
    expect(JSON.stringify(result.error)).not.toContain("evil.example");
    expect(mocks.getAgentScan).not.toHaveBeenCalled();
  });

  it("refuses a caller-supplied wallet address by rejecting the unknown key", async () => {
    const result = await call({
      filters: { projectId: PROJECT, walletAddress: "0xdeadbeef" },
    });
    expect(result.ok).toBe(false);
    expect(mocks.getAgentScan).not.toHaveBeenCalled();
  });
});

describe("listAgentScan - cancellation", () => {
  it("reports a cancelled project read as internal.cancelled, not a timeout", async () => {
    const requestId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    // The real race: the user cancels while the bounded read is running, and
    // the resolver returns its degraded `unavailable` DTO afterwards. That is
    // a cancellation, not "the database timed out".
    mocks.getAgentScan.mockImplementation(async () => {
      getCancelController(requestId)?.abort();
      return { ok: true, data: { status: "unavailable", reason: "query_timeout" } };
    });

    const result = await call({ filters: { projectId: PROJECT } }, { requestId });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.cancelled");
  });

  it("keeps an UNCANCELLED timeout a degraded page, not a cancellation", async () => {
    mocks.getAgentScan.mockResolvedValue({
      ok: true,
      data: { status: "unavailable", reason: "query_timeout" },
    });
    const result = await call({ filters: { projectId: PROJECT } });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ status: "unavailable", reason: "query_timeout" });
  });
});

describe("listAgentScan - logging says whether, never which", () => {
  it("records projectScoped beside sessionScoped and logs no ids", async () => {
    await call({ filters: { projectId: PROJECT } });
    const lines = okLogLines();
    expect(lines.some((line) => line.includes("projectScoped=true"))).toBe(true);
    expect(lines.some((line) => line.includes("sessionScoped=false"))).toBe(true);
    for (const line of lines) expect(line).not.toContain(PROJECT);
  });

  it("records a session-scoped read as sessionScoped only", async () => {
    await call({ filters: { sessionId: SESSION } });
    const lines = okLogLines();
    expect(lines.some((line) => line.includes("sessionScoped=true"))).toBe(true);
    expect(lines.some((line) => line.includes("projectScoped=false"))).toBe(true);
    for (const line of lines) expect(line).not.toContain(SESSION);
  });
});
