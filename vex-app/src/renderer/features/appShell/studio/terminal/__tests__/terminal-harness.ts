/**
 * Shared doubles for the Studio terminal suites.
 *
 * A HELPER MODULE, not a spec: it is deliberately named without `.test.` so the
 * runner does not collect it, and it owns exactly the three environment gaps
 * that stand between jsdom and a real terminal.
 *
 *  1. `matchMedia`, which jsdom does not implement and xterm calls during
 *     construction. Without it `new Terminal()` throws and every suite below
 *     would fail for a reason that has nothing to do with the code under test.
 *  2. `ResizeObserver`, likewise absent. `XtermHost` already guards for it, so
 *     the stub exists to let a test DRIVE a resize rather than to make the code
 *     run at all.
 *  3. `window.vex.terminal`, the bridge. Renderer suites mock the bridge (the
 *     repository's standing convention) rather than injecting an adapter, so the
 *     components under test use the same import path they use in production.
 *
 * The bridge double records every call and exposes an emitter per event kind, so
 * a test can play the host's side of the protocol - a resync followed by a
 * multi-chunk replay, a refusal, an exit - against the real component.
 *
 * It also enforces the bridge's OWN invariant, one subscriber per (terminalId,
 * kind): subscribing again replaces the previous callback. A component that
 * leaked a second subscription would otherwise pass here and fail in the app.
 */

import type { TerminalErrorCode, TerminalProperty } from "@shared/schemas/terminal.js";
import type {
  TerminalHostAvailability,
  TerminalWorkspaceLayout,
  TerminalWorkspaceRestore,
} from "@shared/schemas/terminal.js";
import { vi } from "vitest";

type Unsubscribe = () => void;
type EventKind = "data" | "resync" | "property" | "exit" | "refused";

export interface CreateAnswer {
  readonly terminalId: string;
  readonly pid: number;
  readonly shellName: string;
  readonly cwd: string;
}

export interface TerminalBridgeStub {
  readonly writes: { terminalId: string; data: string }[];
  readonly resizes: { terminalId: string; cols: number; rows: number }[];
  readonly attaches: string[];
  readonly detaches: string[];
  readonly kills: string[];
  readonly creates: { projectId: string; cols: number; rows: number }[];
  readonly persisted: TerminalWorkspaceLayout[];
  /**
   * Whether each persist carried the close's `final` flag, in call order.
   *
   * The flag is what stops the pty host from recommitting - and, after the
   * kills, EMPTYING - a closed workspace's snapshot on its own shutdown, so a
   * close that stopped sending it would lose the revive it just promised with
   * every assertion in this suite still green.
   */
  readonly persistFinals: boolean[];
  /**
   * Every persist and kill IN THE ORDER THE BRIDGE SAW THEM.
   *
   * The separate `persisted` and `kills` arrays cannot express an ordering
   * between the two, and the close path's whole contract is an ordering: the
   * buffer-bearing commit happens BEFORE the first kill, and nothing persists
   * after it. Entries are `persist:<projectId>:<paneCount>` and
   * `kill:<terminalId>`, so a proof can also see whether a late persist carried
   * a full workspace or an emptied one.
   */
  readonly ops: string[];
  /** How the next `create` answers. Set a code to make it refuse. */
  nextCreate: { ok: true; value: CreateAnswer } | { ok: false; code: TerminalErrorCode };
  /** What `readWorkspace` returns. `null` means "nothing to revive". */
  savedWorkspace: TerminalWorkspaceRestore | null;
  /**
   * Completion callbacks handed to the data subscriber and not yet called.
   *
   * The bridge now acks on CONSUMER COMPLETION, so a test that wants to model a
   * renderer keeping up calls these, and one that wants a slow renderer simply
   * does not. Counting them is how a proof shows the acks follow the consumer
   * rather than the packet.
   */
  pendingDataCompletions: Array<() => void>;
  /**
   * Hold `create` in flight instead of answering it.
   *
   * The controller's publication fence can only be exercised while a create has
   * been ISSUED and has not landed: that window is where a tab close, a project
   * switch or a remount happens. A test that cannot hold the answer cannot
   * produce the window at all, so it would prove nothing about the fence.
   */
  deferCreate: boolean;
  /** Issued creates whose answer is still being withheld. */
  pendingCreates: Array<() => void>;
  /** Answer every withheld create, in issue order. */
  settleCreates: () => void;
  /**
   * How the next `persistWorkspace` answers.
   *
   * The close COMMITS THE BUFFERS and only then kills, so "the commit was
   * refused" is the case the whole ordering exists for and the one a suite
   * cannot reach without this: a bridge that always says yes can only ever
   * prove the happy path, and the defect it hid was that the kills ran anyway.
   */
  nextPersist: { ok: true } | { ok: false; code: TerminalErrorCode };
  /** Hold `persistWorkspace` in flight, for the same reason as `deferCreate`. */
  deferPersist: boolean;
  /** Issued commits whose answer is still being withheld. */
  pendingPersists: Array<() => void>;
  /** Answer every withheld commit, in issue order. */
  settlePersists: () => void;
  /**
   * Codes `kill` answers with, per terminal id. Absent means it succeeds.
   *
   * Per id rather than a single next-answer because the close kills a whole
   * workspace in one `Promise.all`, and the interesting cases are partial: one
   * shell that is already gone beside one the host could not reach.
   */
  readonly killRefusals: Map<string, TerminalErrorCode>;
  /** Hold `readWorkspace` in flight, for the same reason as `deferCreate`. */
  deferReadWorkspace: boolean;
  /** Issued restores whose answer is still being withheld. */
  pendingReads: Array<() => void>;
  /** Answer every withheld restore, in issue order. */
  settleReads: () => void;
  emitData: (terminalId: string, data: string) => void;
  /** Run every completion callback the consumer has been handed so far. */
  settleData: () => void;
  emitResync: (terminalId: string, droppedRows: number) => void;
  emitProperty: (terminalId: string, change: TerminalProperty) => void;
  emitExit: (terminalId: string, exitCode: number, signal: number | null) => void;
  emitRefused: (terminalId: string, code: TerminalErrorCode) => void;
  /** Live subscriptions, so a test can prove a cleanup actually ran. */
  subscriberCount: (kind: EventKind) => number;

  /* ---------------- the fake main and pty host ---------------- */

  /**
   * The ptys the fake host believes are RUNNING.
   *
   * The reason this exists at all: the controller's stale-restore fence was
   * proven by asserting that a discarded result was not applied, which says
   * nothing about the shells it created. Every open revives a set of ptys, and
   * a suite with no model of them cannot tell one live set from three. Counting
   * them here is what makes "exactly one live set" an assertion rather than a
   * hope.
   */
  readonly livePtys: Set<string>;
  /**
   * How many GENUINE revives ran - opens that actually spawned, as opposed to
   * opens that joined an in-flight one or reused a settled one.
   */
  reviveCount: number;
  /**
   * Model main's ownership of the open.
   *
   * `true` reproduces the production contract: single-flight per project, and a
   * settled open reused while its terminals are live. `false` reproduces the
   * behaviour that shipped - every open spawns a fresh set - so a test can show
   * the proof is measuring something real by watching it fail.
   */
  singleFlightOpens: boolean;
  /** Play a pty-host death for these ids, as main broadcasts it. */
  emitTerminalsLost: (terminalIds: readonly string[]) => void;
}

/** jsdom has no matchMedia; xterm calls it while constructing. */
export function installMatchMedia(matches = false): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

/** A ResizeObserver that records its observers so a test can fire one. */
export function installResizeObserver(): { trigger: () => void } {
  const callbacks: (() => void)[] = [];
  class StubResizeObserver {
    readonly #callback: () => void;
    constructor(callback: () => void) {
      this.#callback = callback;
      callbacks.push(callback);
    }
    observe(): void {
      // Real observers fire once on observe; this stub fires only on demand so
      // a test controls exactly when a resize happens.
      void this.#callback;
    }
    unobserve(): void {
      /* nothing retained per element */
    }
    disconnect(): void {
      const at = callbacks.indexOf(this.#callback);
      if (at >= 0) callbacks.splice(at, 1);
    }
  }
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: StubResizeObserver,
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: StubResizeObserver,
  });
  return {
    trigger: () => {
      for (const callback of [...callbacks]) callback();
    },
  };
}

const AVAILABILITY: TerminalHostAvailability = {
  state: "running",
  restartCount: 0,
  responsive: true,
};

/** Install a recording `window.vex.terminal`. Returns the control surface. */
export function installTerminalBridge(): TerminalBridgeStub {
  // ONE MAP PER EVENT KIND, each typed with its real payload. A single
  // heterogeneous map would need a cast at every emit, and a test double that
  // has to cast is a double whose own contract is unchecked.
  const channels = {
    data: new Map<string, (payload: string, done: () => void) => void>(),
    resync: new Map<
      string,
      (payload: { reason: "replay"; droppedRows: number }) => void
    >(),
    property: new Map<string, (payload: TerminalProperty) => void>(),
    exit: new Map<
      string,
      (payload: { exitCode: number; signal: number | null }) => void
    >(),
    refused: new Map<string, (payload: TerminalErrorCode) => void>(),
  };

  /**
   * The data channel, whose callback takes a completion function.
   *
   * Recorded rather than invoked, so a test decides when - or whether - this
   * consumer reports that it kept up.
   */
  function subscribeData(
    terminalId: string,
    callback: (payload: string, done: () => void) => void,
  ): Unsubscribe {
    return subscribe(
      channels.data,
      terminalId,
      (payload: string, done: () => void) => {
        stub.pendingDataCompletions.push(done);
        callback(payload, done);
      },
    );
  }

  function subscribe<T extends unknown[]>(
    channel: Map<string, (...payload: T) => void>,
    terminalId: string,
    callback: (...payload: T) => void,
  ): Unsubscribe {
    channel.set(terminalId, callback);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Only remove OUR callback: a later subscription replaced it, and a stale
      // cleanup must not silence the live consumer.
      if (channel.get(terminalId) === callback) channel.delete(terminalId);
    };
  }

  const stub: TerminalBridgeStub = {
    writes: [],
    resizes: [],
    attaches: [],
    detaches: [],
    kills: [],
    creates: [],
    persisted: [],
    persistFinals: [],
    ops: [],
    pendingDataCompletions: [],
    nextCreate: {
      ok: true,
      value: { terminalId: "t1", pid: 4242, shellName: "bash", cwd: "/w" },
    },
    savedWorkspace: null,
    nextPersist: { ok: true },
    deferPersist: false,
    pendingPersists: [],
    settlePersists: () => {
      const owed = stub.pendingPersists.splice(0);
      for (const settle of owed) settle();
    },
    killRefusals: new Map<string, TerminalErrorCode>(),
    deferCreate: false,
    pendingCreates: [],
    settleCreates: () => {
      const owed = stub.pendingCreates.splice(0);
      for (const settle of owed) settle();
    },
    deferReadWorkspace: false,
    pendingReads: [],
    settleReads: () => {
      const owed = stub.pendingReads.splice(0);
      for (const settle of owed) settle();
    },
    emitData: (terminalId, data) => {
      channels.data.get(terminalId)?.(data, () => undefined);
    },
    settleData: () => {
      const owed = stub.pendingDataCompletions.splice(0);
      for (const settle of owed) settle();
    },
    emitResync: (terminalId, droppedRows) => {
      channels.resync.get(terminalId)?.({ reason: "replay", droppedRows });
    },
    emitProperty: (terminalId, change) => {
      channels.property.get(terminalId)?.(change);
    },
    emitExit: (terminalId, exitCode, signal) => {
      channels.exit.get(terminalId)?.({ exitCode, signal });
    },
    emitRefused: (terminalId, code) => {
      channels.refused.get(terminalId)?.(code);
    },
    subscriberCount: (kind) => channels[kind].size,
    livePtys: new Set<string>(),
    reviveCount: 0,
    singleFlightOpens: true,
    emitTerminalsLost: (terminalIds) => {
      for (const terminalId of terminalIds) stub.livePtys.delete(terminalId);
      for (const listener of [...lostListeners]) listener(terminalIds);
    },
  };

  const lostListeners = new Set<(terminalIds: readonly string[]) => void>();

  /**
   * Settled or in-flight opens, per project. THE FAKE MAIN's memory.
   *
   * Keyed by project rather than by call, because that is the granularity the
   * production owner works at: a second open of the same project joins or
   * reuses the first, and only a project whose terminals are all gone revives
   * again.
   */
  const opens = new Map<string, Promise<TerminalWorkspaceRestore | null>>();

  /**
   * Spawn one workspace's worth of ptys and answer with their ids.
   *
   * The FIRST revive of a project keeps the snapshot's own ids, so the suites
   * that assert on those ids read the way they always did. Every later revive
   * mints fresh ones, exactly as the real revive does - which is what makes a
   * duplicate set visible as a larger `livePtys` rather than as an idempotent
   * no-op that hides the leak.
   */
  async function revive(
    template: TerminalWorkspaceRestore,
  ): Promise<TerminalWorkspaceRestore> {
    if (stub.deferReadWorkspace) {
      await new Promise<void>((resolve) => {
        stub.pendingReads.push(resolve);
      });
    }
    stub.reviveCount += 1;
    const rename = stub.reviveCount === 1
      ? (id: string) => id
      : (id: string) => `${id}-revive${String(stub.reviveCount)}`;
    const restored: TerminalWorkspaceRestore = {
      layout: {
        ...template.layout,
        groups: template.layout.groups.map((group) => ({
          ...group,
          panes: group.panes.map((pane) => ({
            ...pane,
            terminalId: rename(pane.terminalId),
          })),
        })),
      },
      terminals: template.terminals.map((entry) => ({
        ...entry,
        terminalId: rename(entry.terminalId),
      })),
      idMap: template.idMap.map((entry) => ({ ...entry, to: rename(entry.to) })),
    };
    for (const entry of restored.terminals) stub.livePtys.add(entry.terminalId);
    return restored;
  }

  const terminal = {
    create: vi.fn(async (input: { projectId: string; cols: number; rows: number }) => {
      stub.creates.push(input);
      // The answer is fixed WHEN THE CALL IS ISSUED, not when it is settled, so
      // a test that changes `nextCreate` while an earlier create is withheld
      // does not rewrite that earlier create's answer.
      const answer = stub.nextCreate;
      if (stub.deferCreate) {
        await new Promise<void>((resolve) => {
          stub.pendingCreates.push(resolve);
        });
      }
      // A CREATED PTY IS A RUNNING PTY, and the fake host has to know it. Only
      // `revive` used to record one, so a suite could assert that a terminal
      // the controller opened was killed while being unable to ask the simpler
      // question underneath it - is that shell still running - which is the
      // question a refused close turns on.
      if (answer.ok) stub.livePtys.add(answer.value.terminalId);
      return { ok: true as const, data: answer };
    }),
    write: vi.fn(async (input: { terminalId: string; data: string }) => {
      stub.writes.push(input);
      return { ok: true as const, data: { ok: true as const, value: null } };
    }),
    resize: vi.fn(async (input: { terminalId: string; cols: number; rows: number }) => {
      stub.resizes.push(input);
      return { ok: true as const, data: { ok: true as const, value: null } };
    }),
    kill: vi.fn(async (input: { terminalId: string }) => {
      stub.kills.push(input.terminalId);
      stub.ops.push(`kill:${input.terminalId}`);
      const refusal = stub.killRefusals.get(input.terminalId);
      if (refusal !== undefined) {
        // A REFUSED kill does not end the pty. Leaving it in `livePtys` is what
        // makes "the shell survived the close" an assertion rather than a
        // matter of trusting the recorded call.
        return { ok: true as const, data: { ok: false as const, code: refusal } };
      }
      // THE PTY ACTUALLY GOES. A kill recorded but not modelled would let a
      // leak test pass by counting a shell the controller had already ended.
      stub.livePtys.delete(input.terminalId);
      return { ok: true as const, data: { ok: true as const, value: null } };
    }),
    attach: vi.fn(async (input: { terminalId: string }) => {
      stub.attaches.push(input.terminalId);
      return { ok: true as const, data: { ok: true as const, value: null } };
    }),
    detach: vi.fn(async (input: { terminalId: string }) => {
      stub.detaches.push(input.terminalId);
      return { ok: true as const, data: { ok: true as const, value: null } };
    }),
    onData: (terminalId: string, cb: (data: string, done: () => void) => void) =>
      subscribeData(terminalId, cb),
    onResync: (
      terminalId: string,
      cb: (info: { reason: "replay"; droppedRows: number }) => void,
    ) => subscribe(channels.resync, terminalId, cb),
    onProperty: (terminalId: string, cb: (change: TerminalProperty) => void) =>
      subscribe(channels.property, terminalId, cb),
    onExit: (
      terminalId: string,
      cb: (info: { exitCode: number; signal: number | null }) => void,
    ) => subscribe(channels.exit, terminalId, cb),
    onRefused: (terminalId: string, cb: (code: TerminalErrorCode) => void) =>
      subscribe(channels.refused, terminalId, cb),
    persistWorkspace: vi.fn(async (input: {
      layout: TerminalWorkspaceLayout;
      final?: boolean;
    }) => {
      // Fixed WHEN THE CALL IS ISSUED, like `create` and `readWorkspace`: a
      // test that changes the answer while an earlier commit is withheld must
      // not rewrite that earlier commit's answer.
      const answer = stub.nextPersist;
      stub.persisted.push(input.layout);
      stub.persistFinals.push(input.final === true);
      const panes = input.layout.groups.reduce(
        (sum, group) => sum + group.panes.length,
        0,
      );
      stub.ops.push(`persist:${input.layout.projectId}:${String(panes)}`);
      if (stub.deferPersist) {
        await new Promise<void>((resolve) => {
          stub.pendingPersists.push(resolve);
        });
      }
      if (!answer.ok) {
        return { ok: true as const, data: { ok: false as const, code: answer.code } };
      }
      return { ok: true as const, data: { ok: true as const, value: null } };
    }),
    readWorkspace: vi.fn(async (input: { projectId: string }) => {
      // Same rule as `create`: the snapshot this read answers with is the one
      // that existed when the read was issued.
      const template = stub.savedWorkspace;
      if (template === null) {
        if (stub.deferReadWorkspace) {
          await new Promise<void>((resolve) => {
            stub.pendingReads.push(resolve);
          });
        }
        return { ok: true as const, data: { ok: true as const, value: null } };
      }

      if (!stub.singleFlightOpens) {
        return {
          ok: true as const,
          data: { ok: true as const, value: await revive(template) },
        };
      }

      const remembered = opens.get(input.projectId);
      if (remembered !== undefined) {
        const settled = await remembered;
        // Reused only while it still describes live ptys - the same condition
        // main applies, and the reason a memory cannot outlive what it names.
        if (
          settled !== null
          && settled.terminals.some((entry) => stub.livePtys.has(entry.terminalId))
        ) {
          return { ok: true as const, data: { ok: true as const, value: settled } };
        }
        opens.delete(input.projectId);
      }
      const promise = revive(template);
      opens.set(input.projectId, promise);
      return { ok: true as const, data: { ok: true as const, value: await promise } };
    }),
    getAvailability: vi.fn(async () => ({ ok: true as const, data: AVAILABILITY })),
    onAvailability: () => () => undefined,
    onTerminalsLost: (cb: (terminalIds: readonly string[]) => void) => {
      lostListeners.add(cb);
      return () => {
        lostListeners.delete(cb);
      };
    },
  };

  // `window.vex` is declared readonly for product code; defineProperty installs
  // the double without a cast, which keeps this file free of the unsafe escapes
  // the test gate bans.
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { terminal },
  });

  return stub;
}

/** Give an element a measurable box, which jsdom otherwise reports as 0x0. */
export function stubBox(
  element: Element,
  box: { width: number; height: number; left?: number; top?: number },
): void {
  const left = box.left ?? 0;
  const top = box.top ?? 0;
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value: () => ({
      width: box.width,
      height: box.height,
      left,
      top,
      right: left + box.width,
      bottom: top + box.height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }),
  });
}
