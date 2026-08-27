/**
 * The board's chart and spotlight bridges are ABORTABLE.
 *
 * THE DEFECT THESE PIN. Both used `invokeWithSchema`, which has no cancel. The
 * renderer's per-tick AbortController therefore could not reach main: a cut
 * stopped the renderer LISTENING while main ran the provider read to its
 * deadline for a surface nobody was watching. `board-details.ts` was already
 * correct and is the precedent these follow.
 *
 * WHAT IS ASSERTED is the wire effect, not the helper's identity: calling
 * `cancel` must send `vex:cancel` carrying THIS request's correlation id, so
 * main's `ctx.signal` - the signal the provider read is actually plumbed into -
 * fires. A test that asserted "abortableInvoke was imported" would prove
 * nothing about the renderer's ability to stop a read.
 *
 * The renderer gains only "I have stopped waiting": every invocation below is
 * also checked to carry no host, deadline, budget, cadence or limit.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Invocation {
  readonly channel: string;
  readonly payload: { readonly requestId: string; readonly payload: unknown };
}

const invocations: Invocation[] = [];

vi.mock("electron", () => ({
  ipcRenderer: {
    invoke: (channel: string, payload: Invocation["payload"]) => {
      invocations.push({ channel, payload });
      return Promise.resolve({ ok: true, data: {} });
    },
    on: () => undefined,
    removeListener: () => undefined,
  },
}));

const { CH } = await import("../../shared/ipc/channels.js");
const { boardChart } = await import("../agent/board-chart.js");
const { boardSpotlight } = await import("../agent/board-spotlight.js");

const SUBJECT = {
  chain: "solana",
  pairAddress: "22CfmLna8Bsh7xrbyvGSs6NdD31iFj1UFVnwB7EberWU",
};

beforeEach(() => {
  invocations.length = 0;
});

const methods: ReadonlyArray<[string, string, () => { cancel: () => void }]> = [
  [
    "boardChart.poll",
    CH.boardChart.poll,
    () => boardChart.poll({ subject: SUBJECT, resolution: "1m" }),
  ],
  [
    "boardSpotlight.topTraders",
    CH.boardSpotlight.topTraders,
    () => boardSpotlight.topTraders({ subject: SUBJECT }),
  ],
  [
    "boardSpotlight.momentum",
    CH.boardSpotlight.momentum,
    () => boardSpotlight.momentum({ subject: SUBJECT }),
  ],
  [
    "boardSpotlight.otherPools",
    CH.boardSpotlight.otherPools,
    () => boardSpotlight.otherPools({ subject: SUBJECT }),
  ],
  [
    "boardSpotlight.context",
    CH.boardSpotlight.context,
    () => boardSpotlight.context({ subject: SUBJECT }),
  ],
  [
    "boardSpotlight.tapePoll",
    CH.boardSpotlight.tapePoll,
    () => boardSpotlight.tapePoll({ subject: SUBJECT, reset: true }),
  ],
];

describe("every board chart and spotlight method can be cancelled", () => {
  it.each(methods)("%s exposes a cancel that reaches vex:cancel", (_name, channel, invoke) => {
    const invocation = invoke();
    expect(invocation.cancel).toBeTypeOf("function");

    const sent = invocations.find((entry) => entry.channel === channel);
    expect(sent).toBeDefined();

    invocation.cancel();
    const cancelled = invocations.find((entry) => entry.channel === CH.cancel);
    expect(cancelled?.payload.payload).toEqual({
      correlationId: sent?.payload.requestId,
    });
  });

  it.each(methods)("%s cancel is idempotent", (_name, _channel, invoke) => {
    const invocation = invoke();
    invocation.cancel();
    invocation.cancel();
    expect(invocations.filter((entry) => entry.channel === CH.cancel)).toHaveLength(
      1,
    );
  });

  it.each(methods)("%s sends only the identity it was given", (_name, channel, invoke) => {
    invoke();
    const sent = invocations.find((entry) => entry.channel === channel);
    const payload = sent?.payload.payload as Record<string, unknown>;
    // No host, no deadline, no budget, no cadence, no page count, no limit.
    for (const forbidden of [
      "origin",
      "host",
      "url",
      "timeoutMs",
      "deadlineMs",
      "budgetMs",
      "cadenceMs",
      "pages",
      "limit",
      "sort",
    ]) {
      expect(payload).not.toHaveProperty(forbidden);
    }
  });
});
