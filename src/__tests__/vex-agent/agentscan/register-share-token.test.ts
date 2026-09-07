import { describe, expect, it, vi } from "vitest";

import { registerPersistedShareToken } from "../../../vex-agent/agentscan/register-share-token.js";
import type { RegisterShareTokenOutcome } from "../../../vex-agent/agentscan/share-token-client.js";

const SHARE_A = "vex_share_" + "A".repeat(43);
const SHARE_B = "vex_share_" + "B".repeat(43);
const INGEST = "I".repeat(43);

function registered(): RegisterShareTokenOutcome {
  return { kind: "registered" };
}

describe("registerPersistedShareToken", () => {
  it("mode ensure with an existing unregistered token does not call generate", async () => {
    const generate = vi.fn(() => SHARE_B);
    const persistShareToken = vi.fn(async () => undefined);
    const markShareTokenRegistered = vi.fn(async () => undefined);
    const post = vi.fn(async () => registered());

    const outcome = await registerPersistedShareToken({
      baseUrl: () => "http://localhost",
      getState: async () => ({ ingestToken: INGEST, shareToken: SHARE_A }),
      persistShareToken,
      markShareTokenRegistered,
      generate,
      post,
      mode: "ensure",
    });

    expect(outcome).toEqual({ kind: "registered" });
    expect(generate).not.toHaveBeenCalled();
    expect(persistShareToken).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ ingestToken: INGEST, shareToken: SHARE_A });
    expect(markShareTokenRegistered).toHaveBeenCalledTimes(1);
  });

  it("dropped 200: persist happened, mark not called, second ensure retries the same token", async () => {
    const persistShareToken = vi.fn(async () => undefined);
    const markShareTokenRegistered = vi.fn(async () => undefined);
    const generate = vi.fn(() => SHARE_A);
    const post = vi.fn(async (): Promise<RegisterShareTokenOutcome> => ({
      kind: "retryable",
      status: 500,
      retryAfterSeconds: null,
      detail: "HTTP 500",
    }));
    let stored: string | null = null;

    const first = await registerPersistedShareToken({
      baseUrl: () => "http://localhost",
      getState: async () => ({ ingestToken: INGEST, shareToken: stored }),
      persistShareToken: async (token) => {
        stored = token;
        await persistShareToken(token);
      },
      markShareTokenRegistered,
      generate,
      post,
      mode: "ensure",
    });

    expect(first.kind).toBe("retryable");
    expect(persistShareToken).toHaveBeenCalledWith(SHARE_A);
    expect(markShareTokenRegistered).not.toHaveBeenCalled();
    expect(stored).toBe(SHARE_A);

    post.mockResolvedValueOnce(registered());
    const second = await registerPersistedShareToken({
      baseUrl: () => "http://localhost",
      getState: async () => ({ ingestToken: INGEST, shareToken: stored }),
      persistShareToken,
      markShareTokenRegistered,
      generate,
      post,
      mode: "ensure",
    });

    expect(second).toEqual({ kind: "registered" });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenLastCalledWith({ ingestToken: INGEST, shareToken: SHARE_A });
    expect(markShareTokenRegistered).toHaveBeenCalledTimes(1);
  });

  it("mode rotate calls generate once and persist before post", async () => {
    const calls: string[] = [];
    const generate = vi.fn(() => SHARE_B);
    const persistShareToken = vi.fn(async (token: string) => {
      calls.push(`persist:${token}`);
    });
    const markShareTokenRegistered = vi.fn(async () => {
      calls.push("mark");
    });
    const post = vi.fn(async (input: { ingestToken: string; shareToken: string }) => {
      calls.push(`post:${input.shareToken}`);
      return registered();
    });

    const outcome = await registerPersistedShareToken({
      baseUrl: () => "http://localhost",
      getState: async () => ({ ingestToken: INGEST, shareToken: SHARE_A }),
      persistShareToken,
      markShareTokenRegistered,
      generate,
      post,
      mode: "rotate",
    });

    expect(outcome).toEqual({ kind: "registered" });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([`persist:${SHARE_B}`, `post:${SHARE_B}`, "mark"]);
  });

  it("returns not_ready when ingestToken or baseUrl is missing", async () => {
    const generate = vi.fn(() => SHARE_A);
    const persistShareToken = vi.fn(async () => undefined);
    const markShareTokenRegistered = vi.fn(async () => undefined);
    const post = vi.fn(async () => registered());

    expect(
      await registerPersistedShareToken({
        baseUrl: () => null,
        getState: async () => ({ ingestToken: INGEST, shareToken: null }),
        persistShareToken,
        markShareTokenRegistered,
        generate,
        post,
        mode: "ensure",
      }),
    ).toEqual({ kind: "not_ready" });

    expect(
      await registerPersistedShareToken({
        baseUrl: () => "http://localhost",
        getState: async () => ({ ingestToken: null, shareToken: null }),
        persistShareToken,
        markShareTokenRegistered,
        generate,
        post,
        mode: "ensure",
      }),
    ).toEqual({ kind: "not_ready" });

    expect(generate).not.toHaveBeenCalled();
    expect(persistShareToken).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("does not stamp on conflict, retryable, invalid, stopped, or auth_lost", async () => {
    const markShareTokenRegistered = vi.fn(async () => undefined);
    const persistShareToken = vi.fn(async () => undefined);
    const generate = vi.fn(() => SHARE_A);

    for (const outcome of [
      { kind: "conflict" },
      { kind: "invalid", detail: "HTTP 400" },
      { kind: "auth_lost" },
      { kind: "stopped", reason: "quarantined" },
      { kind: "retryable", status: 429, retryAfterSeconds: 10, detail: "HTTP 429" },
    ] as const) {
      markShareTokenRegistered.mockClear();
      const post = vi.fn(async () => outcome);
      const result = await registerPersistedShareToken({
        baseUrl: () => "http://localhost",
        getState: async () => ({ ingestToken: INGEST, shareToken: SHARE_A }),
        persistShareToken,
        markShareTokenRegistered,
        generate,
        post,
        mode: "ensure",
      });
      expect(result).toEqual(outcome);
      expect(markShareTokenRegistered).not.toHaveBeenCalled();
    }
  });
});
