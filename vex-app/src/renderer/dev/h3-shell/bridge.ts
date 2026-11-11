/**
 * THE HARNESS BRIDGE - a stand-in `window.vex` that answers what the shell
 * reads, from typed fixtures, and nothing else.
 *
 * WHERE THE LINE IS. In the product `window.vex` is the preload bridge: the
 * one process boundary between the renderer and main (`vex.d.ts`,
 * `shared/types/bridge/`). Everything above it - every TanStack Query hook in
 * `lib/api/*`, every store, every component and every sheet - is the
 * product's own code in this harness. Faking anything above the bridge would
 * show a shell the product does not have, so the bridge is the ONLY thing the
 * harness replaces.
 *
 * WHAT IT ANSWERS. A state hands `installHarnessBridge` a `BridgeAnswers`
 * object typed against `VexBridge` itself, so an answer whose shape drifts
 * from the real contract is a type error, not a silently wrong capture. Every
 * other member is answered by the bridge's own defaults, which are designed
 * to put the reading component in a QUIET, real state rather than an error:
 *
 *   - an event subscription (`onX`) registers and returns its unsubscribe, so
 *     the component's own effect lifecycle runs exactly as in the product, and
 *     `emit` can push an event through it on demand;
 *   - a request resolves to a typed refusal (`ok: false`) carrying the
 *     harness mark as its correlation id. That is a state each query hook
 *     already renders, and it is recorded, so a state that leaves an
 *     unanswered read on screen can be found from the console
 *     (`window.__vexH3Harness.unanswered()`) rather than guessed at.
 *
 * WHAT IT NEVER DOES. It holds no key, signs nothing and decides no
 * approval: the approve and reject members are answered with a refusal like
 * any other unanswered call, so a press on a harness card cannot be mistaken
 * for a decision. Nothing here reaches the network (the harness CSP pins
 * `connect-src` to its own dev server).
 *
 * DETERMINISM. Answers resolve on the microtask queue, never on a timer, so
 * the order in which the shell's queries settle does not depend on load.
 */

import type { VexBridge } from "@shared/types/bridge.js";
import type { Result } from "@shared/ipc/result.js";
import { H3_HARNESS_MARK } from "./mark.js";

/** What a state answers: any member of any namespace, typed by the real contract. */
export type BridgeAnswers = {
  readonly [K in keyof VexBridge]?: Partial<VexBridge[K]>;
};

type Listener = (event: unknown) => void;

export interface HarnessBridge {
  /** Every `namespace.member` the shell called that no state answered. */
  readonly unanswered: () => readonly string[];
  /** Every `namespace.member` the shell called, answered or not, in first-call order. */
  readonly calls: () => readonly string[];
  /** Push one event through every live subscriber of `namespace.onX`. */
  readonly emit: (path: `${string}.on${string}`, event: unknown) => number;
  /**
   * Resolve once `namespace.onX` has a live subscriber. A product hook often
   * subscribes only after its own data has loaded, so a state that pushes an
   * event waits for the listener instead of guessing a delay.
   */
  readonly whenSubscribed: (path: `${string}.on${string}`) => Promise<void>;
}

/** The refusal an unanswered request resolves to, in the bridge's own `Result` shape. */
export function harnessRefusal<T>(path: string): Result<T> {
  return {
    ok: false,
    error: {
      code: "provider.unavailable",
      message: `The H3 shell harness does not answer ${path}.`,
      correlationId: H3_HARNESS_MARK,
    },
  } as Result<T>;
}

/** A settled success in the bridge's own `Result` shape, for answers. */
export function ok<T>(data: T): Promise<Result<T>> {
  return Promise.resolve({ ok: true, data } as Result<T>);
}

/**
 * Layer answers, later over earlier, member by member: a state starts from the
 * base install and replaces only the reads it is about.
 */
export function mergeAnswers(...layers: readonly BridgeAnswers[]): BridgeAnswers {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const layer of layers) {
    for (const [namespace, members] of Object.entries(layer)) {
      merged[namespace] = { ...merged[namespace], ...(members as Record<string, unknown>) };
    }
  }
  return merged as BridgeAnswers;
}

export function installHarnessBridge(answers: BridgeAnswers): HarnessBridge {
  const listeners = new Map<string, Set<Listener>>();
  const waiters = new Map<string, Array<() => void>>();
  const calls: string[] = [];
  const unanswered: string[] = [];
  const note = (list: string[], path: string): void => {
    if (!list.includes(path)) list.push(path);
  };

  const member = (namespace: string, name: string): unknown => {
    const path = `${namespace}.${name}`;
    const answer = (answers as Record<string, Record<string, unknown> | undefined>)[namespace]?.[name];
    if (answer !== undefined) {
      if (typeof answer !== "function") return answer;
      return (...args: unknown[]): unknown => {
        note(calls, path);
        return (answer as (...a: unknown[]) => unknown)(...args);
      };
    }
    if (/^on[A-Z]/.test(name)) {
      return (listener: Listener): (() => void) => {
        note(calls, path);
        const set = listeners.get(path) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(path, set);
        for (const wake of waiters.get(path) ?? []) wake();
        waiters.delete(path);
        return () => {
          set.delete(listener);
        };
      };
    }
    // A request member of the real bridge returns either a promise or an
    // `AbortableInvocation` (`{ promise, cancel }`, `shared/types/bridge/
    // common.ts`), and which one is the member's own contract. The default
    // refusal is BOTH - a promise that also carries `promise` and `cancel` -
    // so a caller of either shape reads the same settled refusal and none
    // throws where the product never does.
    return (): unknown => {
      note(calls, path);
      note(unanswered, path);
      const refusal = Promise.resolve(harnessRefusal(path));
      return Object.assign(refusal, { promise: refusal, cancel: () => undefined });
    };
  };

  const namespaces = new Map<string, unknown>();
  const bridge = new Proxy(
    {},
    {
      get(_target, namespace) {
        if (typeof namespace !== "string") return undefined;
        let ns = namespaces.get(namespace);
        if (ns === undefined) {
          const cache = new Map<string, unknown>();
          ns = new Proxy(
            {},
            {
              get(_t, name) {
                if (typeof name !== "string") return undefined;
                // A promise-like probe (`await window.vex.x`) must not see a
                // `then` member, or every namespace would read as a thenable.
                if (name === "then") return undefined;
                let value = cache.get(name);
                if (value === undefined) {
                  value = member(namespace, name);
                  cache.set(name, value);
                }
                return value;
              },
            },
          );
          namespaces.set(namespace, ns);
        }
        return ns;
      },
    },
  ) as VexBridge;

  Object.defineProperty(window, "vex", { configurable: true, value: bridge });

  return {
    unanswered: () => [...unanswered],
    calls: () => [...calls],
    emit: (path, event) => {
      const set = listeners.get(path);
      if (set === undefined) return 0;
      for (const listener of set) listener(event);
      return set.size;
    },
    whenSubscribed: (path) =>
      (listeners.get(path)?.size ?? 0) > 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.set(path, [...(waiters.get(path) ?? []), resolve]);
          }),
  };
}
