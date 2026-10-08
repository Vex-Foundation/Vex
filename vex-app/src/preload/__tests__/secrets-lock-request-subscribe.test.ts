import { beforeEach, describe, expect, it, vi } from "vitest";
const listeners = new Map<string, (event: unknown, raw: unknown) => void>();
vi.mock("electron", () => ({ ipcRenderer: {
  on: (channel: string, listener: (event: unknown, raw: unknown) => void) => listeners.set(channel, listener),
  removeListener: (channel: string) => listeners.delete(channel),
  invoke: vi.fn(),
} }));
import { EV } from "../../shared/ipc/channels.js";
import { secrets } from "../shell/secrets.js";

beforeEach(() => listeners.clear());
describe("native lock request boundary", () => {
  it("delivers only an empty request and removes its exact subscription", () => {
    const callback = vi.fn();
    const cleanup = secrets.onLockRequested(callback);
    const listener = listeners.get(EV.secrets.lockRequested);
    if (listener === undefined) throw new Error("missing subscription");
    listener({}, { password: "forbidden" });
    listener({}, null);
    listener({}, "lock");
    expect(callback).not.toHaveBeenCalled();
    listener({}, {});
    expect(callback).toHaveBeenCalledExactlyOnceWith();
    cleanup();
    expect(listeners.has(EV.secrets.lockRequested)).toBe(false);
  });
});
