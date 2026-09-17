import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

import {
  useGenerateSuperboardKey,
  useRotateSuperboardKey,
  useSuperboardKey,
} from "../superboard-key.js";
import { superboardKeyKeys } from "../queryKeys.js";
import type { Result } from "@shared/ipc/result.js";
import type { SuperboardKeyStatus } from "@shared/schemas/superboard-key.js";

const SHARE = "S".repeat(43);

const getSuperboardKey = vi.fn();
const generateSuperboardKey = vi.fn();
const rotateSuperboardKey = vi.fn();

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

const MISSING: Result<SuperboardKeyStatus> = { ok: true, data: { kind: "missing" } };
const REGISTERED: Result<SuperboardKeyStatus> = {
  ok: true,
  data: { kind: "registered", shareToken: SHARE, rotation: { kind: "available" }, rotatedAt: null },
};

beforeEach(() => {
  getSuperboardKey.mockReset().mockResolvedValue(MISSING);
  generateSuperboardKey.mockReset().mockResolvedValue(REGISTERED);
  rotateSuperboardKey.mockReset().mockResolvedValue(REGISTERED);
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { settings: { getSuperboardKey, generateSuperboardKey, rotateSuperboardKey } },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "vex");
});

describe("useSuperboardKey", () => {
  it("reads the status through the settings bridge", async () => {
    const client = makeClient();
    const { result } = renderHook(() => useSuperboardKey(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getSuperboardKey).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(MISSING);
  });
});

describe("useGenerateSuperboardKey", () => {
  it("cancels the in-flight status query and publishes the ok result without refetching", async () => {
    const client = makeClient();
    client.setQueryData(superboardKeyKeys.status(), MISSING);
    const cancelSpy = vi.spyOn(client, "cancelQueries");
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useGenerateSuperboardKey(), { wrapper: makeWrapper(client) });
    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(generateSuperboardKey).toHaveBeenCalledTimes(1);
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: superboardKeyKeys.status() });
    expect(client.getQueryData(superboardKeyKeys.status())).toEqual(REGISTERED);
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(getSuperboardKey).not.toHaveBeenCalled();
  });

  it("leaves query data untouched when the mutation result is not ok", async () => {
    generateSuperboardKey.mockResolvedValue({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "settings",
        message: "no",
        retryable: false,
        userActionable: false,
        redacted: true,
        correlationId: "c",
      },
    });
    const client = makeClient();
    client.setQueryData(superboardKeyKeys.status(), MISSING);

    const { result } = renderHook(() => useGenerateSuperboardKey(), { wrapper: makeWrapper(client) });
    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(client.getQueryData(superboardKeyKeys.status())).toEqual(MISSING);
  });
});

describe("useRotateSuperboardKey", () => {
  it("rotates through the settings bridge and publishes the ok result without refetching", async () => {
    const client = makeClient();
    client.setQueryData(superboardKeyKeys.status(), REGISTERED);
    const cancelSpy = vi.spyOn(client, "cancelQueries");
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const rotated: Result<SuperboardKeyStatus> = {
      ok: true,
      data: {
        kind: "registered",
        shareToken: "N".repeat(43),
        rotation: { kind: "available" },
        rotatedAt: "2026-09-08T00:00:00.000Z",
      },
    };
    rotateSuperboardKey.mockResolvedValue(rotated);

    const { result } = renderHook(() => useRotateSuperboardKey(), { wrapper: makeWrapper(client) });
    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(rotateSuperboardKey).toHaveBeenCalledTimes(1);
    expect(generateSuperboardKey).not.toHaveBeenCalled();
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: superboardKeyKeys.status() });
    expect(client.getQueryData(superboardKeyKeys.status())).toEqual(rotated);
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(getSuperboardKey).not.toHaveBeenCalled();
  });
});
