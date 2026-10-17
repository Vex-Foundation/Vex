import { describe, expect, it } from "vitest";
import {
  formatDiskBytes,
  formatMemoryBytes,
  localRuntimeView,
} from "../SystemCheck/localRuntime.js";

const GiB = 1024 ** 3;

describe("localRuntimeView", () => {
  it("disk sizes read as Finder prints them, memory as the OS labels it", () => {
    expect(formatDiskBytes(245_107_195_904)).toBe("245 GB");
    expect(formatDiskBytes(17_179_869_184)).toBe("17.2 GB");
    expect(formatDiskBytes(937_000_000)).toBe("937 MB");
    expect(formatDiskBytes(12_000)).toBe("12 KB");
    expect(formatMemoryBytes(16 * GiB)).toBe("16 GB");
    expect(formatMemoryBytes(3.5 * GiB)).toBe("3.5 GB");
  });

  it("a failed check fails every row it covers, without holding setup back", () => {
    const view = localRuntimeView({
      isPending: false,
      data: {
        ok: false,
        error: {
          code: "internal.unexpected",
          domain: "system",
          message: "x",
          retryable: true,
          userActionable: false,
          redacted: true,
          correlationId: "c",
        },
      },
    });
    expect([view.bundle.status, view.disk.status, view.memory.status]).toEqual(["fail", "fail", "fail"]);
    expect(view.blocksContinue).toBe(false);
  });

  it("a disk that could not be measured warns and does not block", () => {
    const view = localRuntimeView({
      isPending: false,
      data: {
        ok: true,
        data: {
          bundle: { kind: "present", platform: "linux", arch: "x64" },
          disk: { kind: "unreadable", message: "The free space on this disk could not be read." },
          memory: { totalBytes: 8 * GiB, freeBytes: 2 * GiB },
        },
      },
    });
    expect(view.disk).toEqual({ status: "warn", detail: "The free space on this disk could not be read." });
    expect(view.bundle.detail).toBe("Database and embeddings server · Linux x64");
    expect(view.blocksContinue).toBe(false);
  });
});
