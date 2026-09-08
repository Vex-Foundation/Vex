import { describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({
  setPermissionCheckHandler: vi.fn(),
  setPermissionRequestHandler: vi.fn(),
  setDevicePermissionHandler: vi.fn(),
  setDisplayMediaRequestHandler: vi.fn(),
}));
vi.mock("electron", () => ({ session: { defaultSession: handlers } }));
const { installPermissionHandlers } = await import("../permissions.js");

describe("browser permission policy", () => {
  it("grants no browser permissions, including both clipboard permissions", () => {
    installPermissionHandlers();
    const check = handlers.setPermissionCheckHandler.mock.calls[0]?.[0];
    const request = handlers.setPermissionRequestHandler.mock.calls[0]?.[0];
    expect(check).toBeTypeOf("function");
    expect(request).toBeTypeOf("function");
    for (const permission of ["clipboard-read", "clipboard-sanitized-write", "media", "geolocation", "notifications", "unknown"]) {
      expect(check(null, permission, "app://vex")).toBe(false);
      const answer = vi.fn();
      request(null, permission, answer);
      expect(answer).toHaveBeenCalledExactlyOnceWith(false);
    }
    expect(handlers.setDevicePermissionHandler.mock.calls[0]?.[0]({})).toBe(false);
    const answer = vi.fn();
    handlers.setDisplayMediaRequestHandler.mock.calls[0]?.[0]({}, answer);
    expect(answer).toHaveBeenCalledExactlyOnceWith({ video: undefined, audio: undefined });
    expect(handlers.setDisplayMediaRequestHandler.mock.calls[0]?.[1]).toEqual({ useSystemPicker: false });
  });
});
