/**
 * THE PINNED NATIVE BACKEND.
 *
 * @parcel/watcher's `"default"` backend selector probes Watchman before the
 * platform backend on Windows and Linux (2.6.0, `src/Backend.cc:40`), and on a
 * machine without Watchman that probe prints a shell error to the user's
 * console on EVERY subscribe. The remedy is naming the backend, and this suite
 * is what proves it is still named.
 *
 * The platform is INJECTED. A test that read `process.platform` would assert
 * exactly one of these three rows on any given machine and silently skip the
 * other two, which is how a Windows-only defect hides behind a green Linux
 * suite.
 */

import { describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above every other statement in the module, so the spy it
// closes over has to be hoisted with it.
const { subscribeSpy } = vi.hoisted(() => ({
  subscribeSpy: vi.fn(
    (
      _directory: string,
      _callback: unknown,
      _options: { ignore: unknown[]; backend?: string },
    ) => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
  ),
}));

vi.mock("@parcel/watcher", () => ({
  default: { subscribe: subscribeSpy },
}));

const {
  nativeWatcherBackend,
  nativeWatcherSubscribeOptions,
  subscribeNativeWatcher,
} = await import("../native-adapters.js");

describe("the native watcher backend, per platform", () => {
  it.each([
    ["win32", "windows"],
    ["linux", "inotify"],
    ["darwin", "fs-events"],
  ] as ReadonlyArray<[NodeJS.Platform, string]>)(
    "pins %s to the %s backend",
    (platform, backend) => {
      expect(nativeWatcherBackend(platform)).toBe(backend);
    },
  );

  it("names NO backend on a platform Vex does not ship", () => {
    // The reference's ternary would hand `fs-events` to these, where it is not
    // compiled in. Omitting the option leaves today's working default instead
    // of naming a backend that cannot exist.
    expect(nativeWatcherBackend("freebsd")).toBeUndefined();
    expect(nativeWatcherBackend("aix")).toBeUndefined();
  });

  it.each([
    ["win32", "windows"],
    ["linux", "inotify"],
    ["darwin", "fs-events"],
  ] as ReadonlyArray<[NodeJS.Platform, string]>)(
    "carries the %s backend into the subscribe options alongside the ignores",
    (platform, backend) => {
      expect(nativeWatcherSubscribeOptions(["node_modules"], platform)).toEqual({
        ignore: ["node_modules"],
        backend,
      });
    },
  );

  it("omits the key entirely rather than passing an undefined backend", () => {
    const options = nativeWatcherSubscribeOptions([], "freebsd");
    expect(options).toEqual({ ignore: [] });
    expect("backend" in options).toBe(false);
  });

  it("hands those exact options to @parcel/watcher's subscribe", async () => {
    // The pure builder above proves the table; this proves the ADAPTER
    // production wires actually uses it, rather than the two agreeing on paper.
    subscribeSpy.mockClear();
    const callback = (): void => undefined;
    await subscribeNativeWatcher("/tmp/vex-project", callback, {
      ignore: [".git"],
    });

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(subscribeSpy).toHaveBeenCalledWith(
      "/tmp/vex-project",
      callback,
      nativeWatcherSubscribeOptions([".git"], process.platform),
    );
    const passed = subscribeSpy.mock.calls[0]?.[2] as { backend?: string };
    expect(passed.backend).toBe(nativeWatcherBackend(process.platform));
  });
});
