/**
 * THE EMERGENCY CEILING, END TO END: host half and preload half in one run.
 *
 * The two halves of this recovery were each proven separately and the seam
 * between them was broken. The host detached a consumer that stopped keeping
 * up, cleared its own accounting and sent `resyncRequired`; preload received
 * it, told the consumer to clear its screen, and posted `{kind:"resync"}` back.
 * And `PersistentTerminal.resync()` read a consumer that the ceiling had just
 * set to `null` and returned - so the replay never happened, and a terminal
 * that had been ordered to clear itself stayed blank for the rest of the
 * session.
 *
 * Neither half's own suite could see it. The host's suite asserted that
 * `resyncRequired` was sent; the preload suite asserted that a `resync` packet
 * was posted. Both were true. What was false was that the second causes a
 * replay, and only a test that owns both ends can assert that.
 *
 * So this suite wires the REAL preload bridge to a REAL `PtyHostService` over a
 * bidirectional port pair, blows the ceiling with real bytes, and asserts that
 * the consumer's screen comes back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcListeners = new Map<string, Array<(event: unknown, raw: unknown) => void>>();
let invokeReply: (channel: string) => unknown = () => ({
  ok: true,
  data: { ok: true, value: null },
});

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, handler: (event: unknown, raw: unknown) => void) => {
      const existing = ipcListeners.get(channel) ?? [];
      existing.push(handler);
      ipcListeners.set(channel, existing);
    },
    removeListener: (channel: string, handler: (event: unknown, raw: unknown) => void) => {
      ipcListeners.set(
        channel,
        (ipcListeners.get(channel) ?? []).filter((item) => item !== handler),
      );
    },
    invoke: (channel: string) => Promise.resolve(invokeReply(channel)),
  },
}));

const { EV } = await import("../../shared/ipc/channels.js");
const { TERMINAL_DATA_BUFFER_MS, TERMINAL_PENDING_CEILING_BYTES } = await import(
  "../../shared/schemas/terminal.js"
);
const { PtyHostService } = await import("../../pty-host/host-service.js");
const { TerminalSnapshotStore } = await import("../../pty-host/snapshot-store.js");
const { ScriptedPty, fakeProbe, scriptedSpawner } = await import(
  "../../pty-host/__tests__/scripted-pty.js"
);
const { terminal, __resetTerminalBridgeForTests } = await import("../shell/terminal.js");

const CWD = "/projects/demo";
const SHELL = "/bin/bash";
const WINDOW = "w1";
const TERMINAL = "t1";
const NONCE = "n".repeat(32);

/**
 * The two ends of one channel, each shaped for the process that would hold it.
 *
 * `hostEnd` satisfies the host's `HostPort`; `rendererEnd` satisfies the slice
 * of `MessagePort` the preload bridge uses. Everything either side posts is
 * delivered to the other, asynchronously, which is what a real port does.
 */
function channelPair(): {
  hostEnd: {
    postMessage(value: unknown): void;
    onMessage(listener: (value: unknown) => void): void;
    close(): void;
  };
  rendererEnd: {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage(value: unknown): void;
    start(): void;
    close(): void;
    addEventListener(type: string, listener: () => void): void;
  };
} {
  let hostListener: ((value: unknown) => void) | null = null;
  const rendererEnd = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(value: unknown): void {
      queueMicrotask(() => {
        hostListener?.(value);
      });
    },
    start(): void {
      /* nothing to start on a synchronous pair */
    },
    close(): void {
      /* the host owns teardown in this suite */
    },
    addEventListener(): void {
      /* the pair never entangled-closes here */
    },
  };
  const hostEnd = {
    postMessage(value: unknown): void {
      queueMicrotask(() => {
        rendererEnd.onmessage?.({ data: value });
      });
    },
    onMessage(listener: (value: unknown) => void): void {
      hostListener = listener;
    },
    close(): void {
      /* nothing */
    },
  };
  return { hostEnd, rendererEnd };
}

/**
 * Let the whole pipeline settle: microtasks AND the outbound coalescing window.
 *
 * `TERMINAL_DATA_BUFFER_MS` is a real timer on the host's data path, so a
 * microtask drain alone observes a terminal that has produced nothing yet.
 * Fake timers are not an option here: the mirror's parse completion, which
 * paces a detached terminal, is driven by the xterm write queue rather than by
 * the clock.
 */
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, TERMINAL_DATA_BUFFER_MS * 4);
    });
  }
}

/**
 * Wait until `ready` holds, or fail loudly.
 *
 * The ceiling is 8 MiB, and pushing that much through a headless xterm's
 * parser takes real time that no amount of microtask draining can substitute
 * for. Polling a CONDITION rather than sleeping a guessed interval is what
 * keeps this deterministic on a loaded machine: it ends as soon as the property
 * holds, and a failure names the property rather than a timeout.
 */
async function waitFor(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (ready()) return;
    await settle();
  }
  throw new Error(`timed out waiting for: ${what}`);
}

let requestCounter = 0;

describe("the emergency ceiling recovers the consumer's screen", () => {
  beforeEach(() => {
    // NOT cleared: the bridge registers its `EV.terminal.port` listener at
    // MODULE LOAD, and clearing the map would remove the one handler that can
    // deliver a transferred port - the acquisition would then sit until its own
    // timeout for a reason that has nothing to do with the code under test.
    requestCounter = 0;
    __resetTerminalBridgeForTests();
    invokeReply = (channel) =>
      channel.endsWith("acquirePort")
        ? { ok: true, data: { ok: true, value: { nonce: NONCE } } }
        : { ok: true, data: { ok: true, value: null } };
  });

  it(
    "replays the mirror when the PRODUCTION preload resync request answers a "
      + "ceiling detach",
    { timeout: 90_000 },
    async () => {
      const pty = new ScriptedPty();
      const service = new PtyHostService({
        spawn: scriptedSpawner(pty).spawn,
        probe: fakeProbe({
          directories: [CWD],
          files: [SHELL],
          executables: { bash: SHELL },
        }),
        baseEnv: { PATH: "/usr/bin" },
        snapshotStore: new TerminalSnapshotStore("/nonexistent-snapshot-dir"),
        scrollbackRows: 1000,
        graceMs: 60_000,
        shortGraceMs: 6_000,
        sendToMain: () => undefined,
        platform: "linux",
      });

      const { hostEnd, rendererEnd } = channelPair();
      requestCounter += 1;
      await service.handleMainMessage(
        {
          requestId: `r${String(requestCounter)}`,
          request: { kind: "attachWindow", windowId: WINDOW, nonce: NONCE },
        },
        [hostEnd],
      );
      requestCounter += 1;
      await service.handleMainMessage(
        {
          requestId: `r${String(requestCounter)}`,
          request: {
            kind: "create",
            terminalId: TERMINAL,
            windowId: WINDOW,
            projectId: "p1",
            launch: {
              executable: "bash",
              args: [],
              cwd: CWD,
              projectLabel: "proj",
              cols: 80,
              rows: 24,
              env: {},
            },
          },
        },
        [],
      );

      // ---- the renderer's consumer, through the real bridge ----
      /**
       * The consumer's timeline, in order.
       *
       * ORDER IS THE PROPERTY under test, so the two channels share one log
       * rather than two arrays whose interleaving would have to be guessed.
       */
      const timeline: Array<{ kind: "data" | "resync"; value: string }> = [];
      terminal.onData(TERMINAL, (data) => {
        // A consumer that NEVER completes its writes. That is what drives the
        // pending bytes to the ceiling; a consumer that acked would never get
        // there, which is the whole reason the ceiling is an emergency.
        timeline.push({ kind: "data", value: data });
      });
      terminal.onResync(TERMINAL, (info) => {
        timeline.push({ kind: "resync", value: info.reason });
      });
      const resyncs = (): string[] =>
        timeline.filter((item) => item.kind === "resync").map((item) => item.value);

      const attaching = terminal.attach({ terminalId: TERMINAL });
      for (const handler of ipcListeners.get(EV.terminal.port) ?? []) {
        handler({ ports: [rendererEnd] }, { nonce: NONCE });
      }
      await attaching;
      await settle();

      expect(resyncs()).toEqual(["replay"]);
      const marker = "THE-SCREEN-BEFORE-THE-CEILING";
      pty.emit(`${marker}\r\n`);
      await settle();
      expect(
        timeline
          .filter((item) => item.kind === "data")
          .map((item) => item.value)
          .join(""),
      ).toContain(marker);
      const beforeCeiling = timeline.length;

      // ---- blow the ceiling ----
      const chunk = "x".repeat(4096);
      for (
        let sent = 0;
        sent <= TERMINAL_PENDING_CEILING_BYTES + chunk.length;
        sent += chunk.length
      ) {
        pty.emit(chunk);
      }
      await waitFor(
        () =>
          timeline
            .slice(beforeCeiling)
            .some((item) => item.kind === "resync" && item.value === "pending_ceiling"),
        "the host to detach the consumer at the emergency ceiling",
      );
      // The replay is the property under test, so it gets its own wait rather
      // than being folded into the one above: a failure here must read "no
      // replay ever came back", not "the ceiling never fired".
      const sawReplayAfterCeiling = (): boolean => {
        const slice = timeline.slice(beforeCeiling);
        const at = slice.findIndex(
          (item) => item.kind === "resync" && item.value === "pending_ceiling",
        );
        if (at < 0) return false;
        return slice
          .slice(at + 1)
          .some((item) => item.kind === "resync" && item.value === "replay");
      };
      try {
        await waitFor(
          sawReplayAfterCeiling,
          "the replay the preload resync request asks for",
        );
      } catch {
        // Fall through: the assertions below name the defect precisely.
      }

      const after = timeline.slice(beforeCeiling);

      // The host detached and demanded a resync.
      const ceilingAt = after.findIndex(
        (item) => item.kind === "resync" && item.value === "pending_ceiling",
      );
      expect(ceilingAt).toBeGreaterThanOrEqual(0);

      // THE ASSERTIONS THAT WERE MISSING, and they are about what happened
      // AFTER that point. Preload turned the demand into a real `resync`
      // request, the host answered it with a REPLAY, and the replay carried
      // the screen. Before the fix the ceiling nulled the consumer, `resync()`
      // returned immediately, and this suffix of the timeline was EMPTY: the
      // consumer had been ordered to clear itself and was never sent another
      // byte for the rest of the session.
      const replayAt = after.findIndex(
        (item, index) =>
          index > ceilingAt && item.kind === "resync" && item.value === "replay",
      );
      expect(replayAt).toBeGreaterThan(ceilingAt);

      const replayed = after
        .slice(replayAt + 1)
        .filter((item) => item.kind === "data")
        .map((item) => item.value)
        .join("");
      expect(replayed.length).toBeGreaterThan(0);
      expect(replayed).toContain("x");

      await service.shutdownAll();
    },
  );
});
