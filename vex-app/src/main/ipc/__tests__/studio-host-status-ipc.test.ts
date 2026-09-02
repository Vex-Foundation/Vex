/**
 * vex.studio.hostStatus - the four boundary contracts (stage B0).
 *
 * Positive, invalid input, unauthorized sender, cancellation. `registerHandler`
 * is exercised FOR REAL, so the schema validation, the sender gate and the
 * `Result` envelope are the production ones; only the host-status cache and the
 * logger are mocked.
 *
 * The redaction assertion is the one with teeth: the handler must be incapable
 * of returning the host's endpoint, and the OUTPUT schema is what enforces it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StudioHostStatus } from "@shared/schemas/studio.js";

const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const getStudioHostStatus = vi.fn();
vi.mock("../../studio/host-status.js", () => ({
  getStudioHostStatus: () => getStudioHostStatus(),
}));

const { CH } = await import("@shared/ipc/channels.js");
const { registerStudioHandlers } = await import("../studio.js");
const { createTrustedSender, createMainFrame } = await import("./test-sender.js");

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

const RUNNING: StudioHostStatus = {
  state: "running",
  cause: null,
  connectionCount: 2,
  maxConnections: 16,
  atCapacity: false,
};

interface CallResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code?: string; readonly redacted?: boolean };
}

async function call(
  raw: unknown,
  event: unknown = createTrustedSender(),
): Promise<CallResult> {
  const handler = handlers.get(CH.studio.hostStatus);
  if (handler === undefined) throw new Error("handler was not registered");
  return (await handler(event, raw)) as CallResult;
}

let teardowns: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  getStudioHostStatus.mockReturnValue(RUNNING);
  teardowns = registerStudioHandlers();
});

afterEach(() => {
  for (const teardown of teardowns) teardown();
  teardowns = [];
});

describe("vex:studio:hostStatus", () => {
  it("POSITIVE: returns the cached status", async () => {
    const result = await call({ requestId: REQUEST_ID, payload: {} });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(RUNNING);
  });

  it("INVALID INPUT: rejects a payload with any field", async () => {
    // The input schema is `z.object({}).strict()`: there is nothing a caller
    // could usefully send, so anything sent is a caller bug or an attempt.
    const result = await call({
      requestId: REQUEST_ID,
      payload: { projectId: "anything" },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
  });

  it("UNAUTHORIZED SENDER: refuses a subframe and redacts the origin", async () => {
    const top = createMainFrame();
    const subframe = { url: "https://evil.example/x", parent: top, top };

    const result = await call(
      { requestId: REQUEST_ID, payload: {} },
      { senderFrame: subframe },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_sender");
    expect(result.error?.redacted).toBe(true);
    expect(JSON.stringify(result.error)).not.toContain("evil.example");
  });

  // NOTE ON CANCELLATION. This handler reads an in-memory cache synchronously:
  // no await, no I/O, no external work. There is nothing a cancel could stop
  // and no partial effect to unwind, so the only cancellation contract worth
  // asserting is that the plumbing is wired - which the case below does. A
  // future version that gains async work owes this file a drain test.
  it("CANCELLATION: a genuine AbortError normalises to internal.cancelled", async () => {
    // Proves the cancellation plumbing is actually wired for this channel,
    // which the case above cannot show precisely because it never aborts work.
    getStudioHostStatus.mockImplementation(() => {
      throw new DOMException("aborted", "AbortError");
    });

    const result = await call({ requestId: REQUEST_ID, payload: {} });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.cancelled");
  });

  it("REDACTION: an endpoint in the cache cannot cross the boundary", async () => {
    // Defense in depth. Even if a composition bug put the socket path on the
    // status object, the OUTPUT schema is `.strict()` and refuses it - the
    // renderer gets a redacted error instead of a privileged local address.
    getStudioHostStatus.mockReturnValue({
      ...RUNNING,
      endpoint: "/run/user/1000/vex-studio-abc.sock",
    });

    const result = await call({ requestId: REQUEST_ID, payload: {} });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(".sock");
  });
});
