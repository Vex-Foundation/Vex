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
  TerminalWorkspaceSnapshot,
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
  /** How the next `create` answers. Set a code to make it refuse. */
  nextCreate: { ok: true; value: CreateAnswer } | { ok: false; code: TerminalErrorCode };
  /** What `readWorkspace` returns. `null` means "no saved workspace". */
  savedWorkspace: TerminalWorkspaceSnapshot | null;
  emitData: (terminalId: string, data: string) => void;
  emitResync: (terminalId: string, droppedRows: number) => void;
  emitProperty: (terminalId: string, change: TerminalProperty) => void;
  emitExit: (terminalId: string, exitCode: number, signal: number | null) => void;
  emitRefused: (terminalId: string, code: TerminalErrorCode) => void;
  /** Live subscriptions, so a test can prove a cleanup actually ran. */
  subscriberCount: (kind: EventKind) => number;
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
    data: new Map<string, (payload: string) => void>(),
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

  function subscribe<T>(
    channel: Map<string, (payload: T) => void>,
    terminalId: string,
    callback: (payload: T) => void,
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
    nextCreate: {
      ok: true,
      value: { terminalId: "t1", pid: 4242, shellName: "bash", cwd: "/w" },
    },
    savedWorkspace: null,
    emitData: (terminalId, data) => {
      channels.data.get(terminalId)?.(data);
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
  };

  const terminal = {
    create: vi.fn(async (input: { projectId: string; cols: number; rows: number }) => {
      stub.creates.push(input);
      return { ok: true as const, data: stub.nextCreate };
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
    onData: (terminalId: string, cb: (data: string) => void) =>
      subscribe(channels.data, terminalId, cb),
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
    persistWorkspace: vi.fn(async (input: { layout: TerminalWorkspaceLayout }) => {
      stub.persisted.push(input.layout);
      return { ok: true as const, data: { ok: true as const, value: null } };
    }),
    readWorkspace: vi.fn(async () => ({
      ok: true as const,
      data: { ok: true as const, value: stub.savedWorkspace },
    })),
    getAvailability: vi.fn(async () => ({ ok: true as const, data: AVAILABILITY })),
    onAvailability: () => () => undefined,
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
