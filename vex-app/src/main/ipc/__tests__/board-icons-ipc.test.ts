/**
 * Contract tests for `vex:boardIcons:read` (C-board icons).
 *
 * Follows the `images-ipc.test.ts` / `projects-ipc.test.ts` pattern: the real
 * `registerHandler` boundary drives schema validation, sender trust, and the
 * output-schema gate; only `resolveBoardIcon` (the service's single door,
 * `../images/index.js`) is mocked.
 *
 * ABSENCE IS SUCCESS ON THIS CHANNEL. `absent` and `unavailable` both ride the
 * `ok` path as named union members - a `Result` error here means only invalid
 * input or an untrusted sender.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMainFrame,
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const handlers = new Map<string, Handler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  app: { isPackaged: true },
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const resolveBoardIcon = vi.fn();
vi.mock("../../images/index.js", () => ({
  resolveBoardIcon: (iconId: string) => resolveBoardIcon(iconId),
}));

const { CH } = await import("@shared/ipc/channels.js");
const { registerBoardIconHandlers } = await import("../board-icons.js");

const VALID_ID = "profile_0123456789abcdef";
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

const trustedSender = createTrustedSender({ sender: createTestWebContents() });
const untrustedSender = { senderFrame: createMainFrame("https://evil.example/") };

interface OkResult {
  ok: true;
  data: unknown;
}
interface ErrResult {
  ok: false;
  error: { code: string; message: string; domain: string; redacted: true };
}

function isErr(value: unknown): value is ErrResult {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

async function call(
  payload: unknown,
  options: { sender?: unknown } = {},
): Promise<OkResult | ErrResult> {
  const fn = handlers.get(CH.boardIcons.read);
  if (fn === undefined) throw new Error(`handler not registered: ${CH.boardIcons.read}`);
  return (await fn((options.sender ?? trustedSender) as TestIpcEvent, {
    requestId: REQUEST_ID,
    payload,
  })) as OkResult | ErrResult;
}

function expectErr(value: OkResult | ErrResult, code: string): ErrResult {
  expect(isErr(value)).toBe(true);
  if (!isErr(value)) throw new Error("unreachable");
  expect(value.error.code).toBe(code);
  return value;
}

let teardown: ReadonlyArray<() => void> = [];

beforeEach(() => {
  teardown = registerBoardIconHandlers();
});

afterEach(() => {
  for (const off of teardown) off();
  handlers.clear();
  vi.clearAllMocks();
});

// ── Positive ────────────────────────────────────────────────────────────

describe("a valid iconId with an image behind it", () => {
  it("returns ok with the iconId echoed and the image dataUrl", async () => {
    resolveBoardIcon.mockResolvedValue({
      kind: "image",
      dataUrl: "data:image/png;base64,QUJD",
    });
    const result = await call({ iconId: VALID_ID });
    expect(result).toEqual({
      ok: true,
      data: { iconId: VALID_ID, icon: { kind: "image", dataUrl: "data:image/png;base64,QUJD" } },
    });
    expect(resolveBoardIcon).toHaveBeenCalledWith(VALID_ID);
  });
});

// ── Invalid input: validation runs before any privileged work ─────────────

describe("invalid input never reaches the service", () => {
  it.each([
    ["profile/with-a-slash", "a slash"],
    ["ab", "too short (below the 4-char floor)"],
    ["", "empty"],
  ])("rejects %s (%s)", async (iconId) => {
    const result = await call({ iconId });
    expectErr(result, "validation.invalid_input");
    expect(resolveBoardIcon).not.toHaveBeenCalled();
  });

  it("rejects a numeric iconId - the schema requires a string", async () => {
    const result = await call({ iconId: 12345 });
    expectErr(result, "validation.invalid_input");
    expect(resolveBoardIcon).not.toHaveBeenCalled();
  });

  it("rejects an unknown extra field - the payload is strict", async () => {
    const result = await call({ iconId: VALID_ID, url: "https://evil.example" });
    expectErr(result, "validation.invalid_input");
    expect(resolveBoardIcon).not.toHaveBeenCalled();
  });
});

// ── Unauthorized sender ────────────────────────────────────────────────────

describe("an untrusted sender", () => {
  it("is rejected before the service is ever called", async () => {
    const result = await call({ iconId: VALID_ID }, { sender: untrustedSender });
    const err = expectErr(result, "validation.invalid_sender");
    expect(err.error.redacted).toBe(true);
    expect(JSON.stringify(err.error)).not.toContain("evil.example");
    expect(resolveBoardIcon).not.toHaveBeenCalled();
  });
});

// ── Absence and unavailability ride the ok path ────────────────────────────

describe("absent is a success, not an error", () => {
  it("answers ok with kind: absent, reason: not_found", async () => {
    resolveBoardIcon.mockResolvedValue({ kind: "absent", reason: "not_found" });
    const result = await call({ iconId: VALID_ID });
    expect(result).toEqual({
      ok: true,
      data: { iconId: VALID_ID, icon: { kind: "absent", reason: "not_found" } },
    });
  });

  it("answers ok with kind: absent, reason: unsupported_image", async () => {
    resolveBoardIcon.mockResolvedValue({ kind: "absent", reason: "unsupported_image" });
    const result = await call({ iconId: VALID_ID });
    expect(result).toEqual({
      ok: true,
      data: { iconId: VALID_ID, icon: { kind: "absent", reason: "unsupported_image" } },
    });
  });

  it("answers ok with kind: absent, reason: over_cap", async () => {
    resolveBoardIcon.mockResolvedValue({ kind: "absent", reason: "over_cap" });
    const result = await call({ iconId: VALID_ID });
    expect(result).toEqual({
      ok: true,
      data: { iconId: VALID_ID, icon: { kind: "absent", reason: "over_cap" } },
    });
  });
});

describe("unavailable is a success, not an error", () => {
  it("answers ok with kind: unavailable, reason: busy", async () => {
    resolveBoardIcon.mockResolvedValue({ kind: "unavailable", reason: "busy" });
    const result = await call({ iconId: VALID_ID });
    expect(result).toEqual({
      ok: true,
      data: { iconId: VALID_ID, icon: { kind: "unavailable", reason: "busy" } },
    });
  });

  it("answers ok with kind: unavailable, reason: not_mounted", async () => {
    resolveBoardIcon.mockResolvedValue({ kind: "unavailable", reason: "not_mounted" });
    const result = await call({ iconId: VALID_ID });
    expect(result).toEqual({
      ok: true,
      data: { iconId: VALID_ID, icon: { kind: "unavailable", reason: "not_mounted" } },
    });
  });
});

// ── The output schema really gates ────────────────────────────────────────

describe("the output schema gates a malformed answer", () => {
  it("a malformed dataUrl produces a contract violation instead of being forwarded", async () => {
    resolveBoardIcon.mockResolvedValue({
      kind: "image",
      // Not a data: URL at all - the service's own contract would never
      // produce this, but the output schema exists precisely so a future
      // defect there fails loudly instead of reaching the renderer.
      dataUrl: "not-a-data-url",
    });
    const result = await call({ iconId: VALID_ID });
    expectErr(result, "internal.contract_violation");
  });
});
