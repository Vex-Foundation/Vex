import type { EventEmitter } from "node:events";
import { Socket } from "node:net";

export interface TestSocketIo {
  destroyed: boolean;
  writableEnded: boolean;
  write(line: string, callback?: () => void): boolean;
  pause?(): unknown;
  resume?(): unknown;
  setNoDelay?(): unknown;
  end?(): unknown;
  destroy?(): unknown;
}

/** Adapt a deterministic EventEmitter fake through a real Socket instance. */
export function testSocket(backing: EventEmitter & TestSocketIo): Socket {
  const socket = new Socket();
  Object.defineProperties(socket, {
    destroyed: { configurable: true, get: () => backing.destroyed },
    writableEnded: { configurable: true, get: () => backing.writableEnded },
    write: {
      configurable: true,
      value: (line: string, callback?: () => void) => backing.write(line, callback),
    },
    on: { configurable: true, value: backing.on.bind(backing) },
    once: { configurable: true, value: backing.once.bind(backing) },
    off: { configurable: true, value: backing.off.bind(backing) },
    pause: {
      configurable: true,
      value: () => {
        backing.pause?.();
        return socket;
      },
    },
    resume: {
      configurable: true,
      value: () => {
        backing.resume?.();
        return socket;
      },
    },
    setNoDelay: {
      configurable: true,
      value: () => {
        backing.setNoDelay?.();
        return socket;
      },
    },
    end: {
      configurable: true,
      value: () => {
        backing.end?.();
        return socket;
      },
    },
    destroy: {
      configurable: true,
      value: () => {
        backing.destroy?.();
        return socket;
      },
    },
  });
  return socket;
}
