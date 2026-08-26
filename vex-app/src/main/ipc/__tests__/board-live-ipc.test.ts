/**
 * The board-live IPC contract: positive, invalid, unauthorized, unsupported,
 * and the ownership refusal.
 *
 * The service itself is faked here because its behaviour has its own suite
 * (`main/market/__tests__/board-live-service.test.ts`). What is under test is
 * the BOUNDARY: schema strictness in both directions, the sender gate, the fact
 * that ownership is decided by the SENDER and never by the payload, and that a
 * failed first attempt reaches the renderer as a named domain outcome rather
 * than an "unexpected error".
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

const capability = vi.fn();
const subscribe = vi.fn();
const unsubscribe = vi.fn();
let service: unknown = null;
vi.mock("../../market/board-live-owner.js", () => ({
  getBoardLiveService: () => service,
}));

const { CH } = await import("@shared/ipc/channels.js");
const { registerBoardLiveHandlers } = await import("../board-live.js");

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
const LEASE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const POOLS = [{ chain: "solana", pairAddress: "PairAAA" }];

const SNAPSHOT = {
  fetchedAtMs: 1_000,
  rows: [
    {
      key: "solana:pairaaa",
      row: {
        baseTokenSymbol: "AAA",
        baseTokenName: null,
        quoteTokenSymbol: "USDC",
        chainId: "solana",
        dexId: "raydium",
        priceUsd: "1.25",
        priceChange: { h1: null, h24: "-1.5" },
        liquidityUsd: null,
        volumeH24Usd: null,
        txns: { buys: 1, sells: 2 },
        pairAgeSeconds: 10,
        iconId: null,
      },
    },
  ],
};

interface ErrShape {
  readonly ok: false;
  readonly error: { readonly code: string; readonly redacted: boolean; readonly message: string };
}
interface OkShape {
  readonly ok: true;
  readonly data: Record<string, unknown>;
}

const trustedSender = createTrustedSender({ sender: createTestWebContents() });
const untrustedSender = { senderFrame: createMainFrame("https://evil.example/") };

async function call(
  channel: string,
  payload: unknown,
  options: { sender?: unknown } = {},
): Promise<OkShape | ErrShape> {
  const fn = handlers.get(channel);
  if (fn === undefined) throw new Error(`handler not registered: ${channel}`);
  return (await fn((options.sender ?? trustedSender) as TestIpcEvent, {
    requestId: REQUEST_ID,
    payload,
  })) as OkShape | ErrShape;
}

let teardown: ReadonlyArray<() => void> = [];

beforeEach(() => {
  service = { capability, subscribe, unsubscribe };
  capability.mockReturnValue({ supported: true, detail: null });
  subscribe.mockResolvedValue({
    kind: "subscribed",
    leaseId: LEASE_ID,
    generation: 0,
    snapshot: SNAPSHOT,
  });
  unsubscribe.mockReturnValue("closed");
  teardown = registerBoardLiveHandlers();
});

afterEach(() => {
  for (const off of teardown) off();
  handlers.clear();
  vi.clearAllMocks();
});

describe("board live IPC", () => {
  it("claims a lease and returns the FIRST snapshot with it", async () => {
    const result = await call(CH.boardLive.subscribe, { pools: POOLS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No event race: the rows are in the response the toggle already awaited.
    expect(result.data["kind"]).toBe("subscribed");
    expect(result.data["leaseId"]).toBe(LEASE_ID);
    expect(result.data["snapshot"]).toStrictEqual(SNAPSHOT);
  });

  it.each([
    ["no pools at all", { pools: [] }],
    ["more pools than a board can hold", { pools: Array(9).fill(POOLS[0]) }],
    ["a pool with no address", { pools: [{ chain: "solana" }] }],
    ["a chain slug outside the contract", { pools: [{ chain: "so lana", pairAddress: "A" }] }],
    ["an extra field the contract does not name", { pools: POOLS, cadenceMs: 1 }],
    [
      "a caption smuggled in beside the identity",
      { pools: [{ ...POOLS[0], caption: "buy this" }] },
    ],
    ["not an object at all", "pools"],
  ])("refuses %s without reaching the service", async (_label, payload) => {
    const result = await call(CH.boardLive.subscribe, payload);
    expect(result.ok).toBe(false);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("refuses an untrusted sender and leaks nothing about it", async () => {
    const result = await call(
      CH.boardLive.subscribe,
      { pools: POOLS },
      { sender: untrustedSender },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.redacted).toBe(true);
    expect(JSON.stringify(result)).not.toContain("evil.example");
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("reports a failed first attempt as a named, remediable outcome", async () => {
    subscribe.mockResolvedValue({
      kind: "failed",
      retryable: true,
      detail: "The market channel could not be reached, so live figures were not started.",
    });
    const result = await call(CH.boardLive.subscribe, { pools: POOLS });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Not "unexpected error": the cause and the remedy both survive.
    expect(result.error.code).toBe("provider.unavailable");
    expect(result.error.message).toContain("market channel");
  });

  it("answers unsupported rather than failing when the build has no site bridge", async () => {
    capability.mockReturnValue({ supported: false, detail: "no site bridge here" });
    subscribe.mockResolvedValue({ kind: "unsupported", detail: "no site bridge here" });

    const asked = await call(CH.boardLive.capability, {});
    expect(asked.ok).toBe(true);
    if (asked.ok) expect(asked.data["supported"]).toBe(false);

    const result = await call(CH.boardLive.subscribe, { pools: POOLS });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data["kind"]).toBe("unsupported");
  });

  it("decides unsubscribe ownership from the SENDER, never from the payload", async () => {
    unsubscribe.mockReturnValue("not-owner");
    const result = await call(CH.boardLive.unsubscribe, { leaseId: LEASE_ID });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data["outcome"]).toBe("not-owner");

    const args = unsubscribe.mock.calls[0]?.[0] as {
      leaseId: string;
      ownerId: number;
    };
    expect(args.leaseId).toBe(LEASE_ID);
    // The owner id came from the trusted sender object, not from anything the
    // renderer wrote: a leaseId is a handle, not a credential.
    expect(args.ownerId).toBe(
      (trustedSender as unknown as { sender: { id: number } }).sender.id,
    );
  });

  it("refuses an unsubscribe payload that is not a lease id", async () => {
    for (const payload of [{}, { leaseId: "" }, { leaseId: "not-a-uuid" }, { leaseId: LEASE_ID, ownerId: 7 }]) {
      const result = await call(CH.boardLive.unsubscribe, payload);
      expect(result.ok).toBe(false);
    }
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("answers honestly when no live service is running in this process", async () => {
    service = null;
    const asked = await call(CH.boardLive.capability, {});
    expect(asked.ok).toBe(true);
    if (asked.ok) expect(asked.data["supported"]).toBe(false);

    const started = await call(CH.boardLive.subscribe, { pools: POOLS });
    expect(started.ok).toBe(true);
    if (started.ok) expect(started.data["kind"]).toBe("unsupported");

    // An unsubscribe with nothing to release is an ordinary outcome, so an
    // idempotent renderer cleanup never sees a failure.
    const released = await call(CH.boardLive.unsubscribe, { leaseId: LEASE_ID });
    expect(released.ok).toBe(true);
    if (released.ok) expect(released.data["outcome"]).toBe("unknown");
  });

  it("refuses to return an off-contract snapshot the service invented", async () => {
    subscribe.mockResolvedValue({
      kind: "subscribed",
      leaseId: LEASE_ID,
      generation: 0,
      // A money field arriving as a NUMBER is exactly the precision loss the
      // board's decimal-string contract exists to prevent, and the output gate
      // catches it here rather than letting it reach a card.
      snapshot: {
        fetchedAtMs: 1_000,
        rows: [
          { key: "solana:pairaaa", row: { ...SNAPSHOT.rows[0]?.row, priceUsd: 1.25 } },
        ],
      },
    });
    const result = await call(CH.boardLive.subscribe, { pools: POOLS });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("internal.contract_violation");
  });
});
