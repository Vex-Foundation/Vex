import { describe, expect, it, vi } from "vitest";

import { registerPersistedShareToken } from "../../../vex-agent/agentscan/register-share-token.js";
import type { RegisterShareTokenOutcome } from "../../../vex-agent/agentscan/share-token-client.js";

const SHARE_A = "A".repeat(43);
const SHARE_B = "B".repeat(43);
const INGEST = "I".repeat(43);

function registered(): RegisterShareTokenOutcome {
  return { kind: "registered" };
}

describe("registerPersistedShareToken", () => {
  it("with an existing unregistered token does not call generate", async () => {
    const generate = vi.fn(() => SHARE_B);
    const persistShareToken = vi.fn<(token: string) => Promise<void>>(async () => undefined);
    const markShareTokenRegistered = vi.fn(async () => true);
    const post = vi.fn(async () => registered());

    const outcome = await registerPersistedShareToken({
      baseUrl: () => "http://localhost",
      getState: async () => ({ registrationGeneration: 7, ingestToken: INGEST, shareToken: SHARE_A }),
      persistShareToken,
      markShareTokenRegistered,
      generate,
      post,
    });

    expect(outcome).toEqual({ kind: "registered" });
    expect(generate).not.toHaveBeenCalled();
    expect(persistShareToken).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ ingestToken: INGEST, shareToken: SHARE_A });
    expect(markShareTokenRegistered).toHaveBeenCalledExactlyOnceWith({
      registrationGeneration: 7, shareToken: SHARE_A,
    });
  });

  it("dropped 200: persist happened, mark not called, second ensure retries the same token", async () => {
    const persistShareToken = vi.fn<(token: string) => Promise<void>>(async () => undefined);
    const markShareTokenRegistered = vi.fn(async () => true);
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
      getState: async () => ({ registrationGeneration: 7, ingestToken: INGEST, shareToken: stored }),
      persistShareToken: async (token) => {
        stored = token;
        await persistShareToken(token);
      },
      markShareTokenRegistered,
      generate,
      post,
    });

    expect(first.kind).toBe("retryable");
    expect(persistShareToken).toHaveBeenCalledWith(SHARE_A);
    expect(markShareTokenRegistered).not.toHaveBeenCalled();
    expect(stored).toBe(SHARE_A);

    post.mockResolvedValueOnce(registered());
    const second = await registerPersistedShareToken({
      baseUrl: () => "http://localhost",
      getState: async () => ({ registrationGeneration: 7, ingestToken: INGEST, shareToken: stored }),
      persistShareToken,
      markShareTokenRegistered,
      generate,
      post,
    });

    expect(second).toEqual({ kind: "registered" });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenLastCalledWith({ ingestToken: INGEST, shareToken: SHARE_A });
    expect(markShareTokenRegistered).toHaveBeenCalledExactlyOnceWith({
      registrationGeneration: 7, shareToken: SHARE_A,
    });
  });

  it("after persist, posts the stored token even if generate returned a different one", async () => {
    const generate = vi.fn(() => SHARE_B);
    const persistShareToken = vi.fn<(token: string) => Promise<void>>(async () => undefined);
    const markShareTokenRegistered = vi.fn(async () => true);
    const post = vi.fn(async () => registered());
    let stored: string | null = null;

    const outcome = await registerPersistedShareToken({
      baseUrl: () => "http://localhost",
      getState: async () => ({ registrationGeneration: 7, ingestToken: INGEST, shareToken: stored }),
      persistShareToken: async (token) => {
        if (stored === null) stored = SHARE_A;
        await persistShareToken(token);
      },
      markShareTokenRegistered,
      generate,
      post,
    });

    expect(outcome).toEqual({ kind: "registered" });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(persistShareToken).toHaveBeenCalledWith(SHARE_B);
    expect(post).toHaveBeenCalledWith({ ingestToken: INGEST, shareToken: SHARE_A });
    expect(markShareTokenRegistered).toHaveBeenCalledExactlyOnceWith({
      registrationGeneration: 7, shareToken: SHARE_A,
    });
  });

  it("returns not_ready when ingestToken or baseUrl is missing", async () => {
    const generate = vi.fn(() => SHARE_A);
    const persistShareToken = vi.fn<(token: string) => Promise<void>>(async () => undefined);
    const markShareTokenRegistered = vi.fn(async () => true);
    const post = vi.fn(async () => registered());

    expect(
      await registerPersistedShareToken({
        baseUrl: () => null,
        getState: async () => ({ registrationGeneration: 7, ingestToken: INGEST, shareToken: null }),
        persistShareToken,
        markShareTokenRegistered,
        generate,
        post,
      }),
    ).toEqual({ kind: "not_ready" });

    expect(
      await registerPersistedShareToken({
        baseUrl: () => "http://localhost",
        getState: async () => ({ registrationGeneration: 7, ingestToken: null, shareToken: null }),
        persistShareToken,
        markShareTokenRegistered,
        generate,
        post,
      }),
    ).toEqual({ kind: "not_ready" });

    expect(generate).not.toHaveBeenCalled();
    expect(persistShareToken).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("returns not_ready when the publication fence rejects a stale success", async () => {
    const outcome = await registerPersistedShareToken({
      baseUrl: () => "http://localhost",
      getState: async () => ({ registrationGeneration: 7, ingestToken: INGEST, shareToken: SHARE_A }),
      persistShareToken: async () => undefined,
      markShareTokenRegistered: async () => false,
      post: async () => registered(),
    });

    expect(outcome).toEqual({ kind: "not_ready" });
  });

  it("reads the recovered credentials with the stored token after persistence", async () => {
    const getState = vi.fn<Parameters<typeof registerPersistedShareToken>[0]["getState"]>()
      .mockResolvedValueOnce({ registrationGeneration: 7, ingestToken: INGEST, shareToken: null })
      .mockResolvedValueOnce({ registrationGeneration: 8, ingestToken: "J".repeat(43), shareToken: SHARE_B });
    const post = vi.fn(async () => registered());
    const markShareTokenRegistered = vi.fn(async () => true);

    expect(await registerPersistedShareToken({
      baseUrl: () => "http://localhost",
      getState,
      persistShareToken: async () => undefined,
      markShareTokenRegistered,
      generate: () => SHARE_A,
      post,
    })).toEqual({ kind: "registered" });

    expect(post).toHaveBeenCalledExactlyOnceWith({ ingestToken: "J".repeat(43), shareToken: SHARE_B });
    expect(markShareTokenRegistered).toHaveBeenCalledExactlyOnceWith({
      registrationGeneration: 8, shareToken: SHARE_B,
    });
  });

  it("does not stamp on conflict, retryable, invalid, stopped, or auth_lost", async () => {
    const markShareTokenRegistered = vi.fn(async () => true);
    const persistShareToken = vi.fn<(token: string) => Promise<void>>(async () => undefined);
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
        getState: async () => ({ registrationGeneration: 7, ingestToken: INGEST, shareToken: SHARE_A }),
        persistShareToken,
        markShareTokenRegistered,
        generate,
        post,
      });
      expect(result).toEqual(outcome);
      expect(markShareTokenRegistered).not.toHaveBeenCalled();
    }
  });
});
