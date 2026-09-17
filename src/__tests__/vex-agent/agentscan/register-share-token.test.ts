import { describe, expect, it, vi } from "vitest";

import {
  registerPersistedShareToken,
  rotatePersistedShareToken,
  type ShareTokenProcedureDeps,
} from "../../../vex-agent/agentscan/register-share-token.js";
import type { RegisterShareTokenOutcome } from "../../../vex-agent/agentscan/share-token-client.js";

const SHARE_A = "A".repeat(43);
const SHARE_B = "B".repeat(43);
const CANDIDATE_N = "N".repeat(43);
const INGEST = "I".repeat(43);

function registered(): RegisterShareTokenOutcome {
  return { kind: "registered" };
}

function transportTimeout(): RegisterShareTokenOutcome {
  return { kind: "transport", reason: "timeout", detail: "VexError: Request timed out after 15000ms" };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function deps(overrides: Partial<Mutable<ShareTokenProcedureDeps>>): ShareTokenProcedureDeps {
  return {
    baseUrl: () => "http://localhost",
    getState: async () => ({
      registrationGeneration: 7,
      ingestToken: INGEST,
      shareToken: SHARE_A,
      shareTokenRegisteredAt: null,
      shareTokenRotationCandidate: null,
    }),
    persistShareToken: async () => undefined,
    persistRotationCandidate: async () => undefined,
    markShareTokenRegistered: async () => true,
    commitShareTokenRotation: async () => true,
    ...overrides,
  };
}

describe("registerPersistedShareToken", () => {
  it("with an existing unregistered token does not call generate", async () => {
    const generate = vi.fn(() => SHARE_B);
    const persistShareToken = vi.fn<(token: string) => Promise<void>>(async () => undefined);
    const markShareTokenRegistered = vi.fn(async () => true);
    const post = vi.fn(async () => registered());

    const outcome = await registerPersistedShareToken(deps({
      getState: async () => ({
        registrationGeneration: 7,
        ingestToken: INGEST,
        shareToken: SHARE_A,
        shareTokenRegisteredAt: null,
        shareTokenRotationCandidate: null,
      }),
      persistShareToken,
      markShareTokenRegistered,
      generate,
      post,
    }));

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
      kind: "http",
      status: 500,
      code: null,
      retryAfterSeconds: null,
      detail: "HTTP 500",
    }));
    let stored: string | null = null;

    const first = await registerPersistedShareToken(deps({
      getState: async () => ({
        registrationGeneration: 7,
        ingestToken: INGEST,
        shareToken: stored,
        shareTokenRegisteredAt: null,
        shareTokenRotationCandidate: null,
      }),
      persistShareToken: async (token) => {
        stored = token;
        await persistShareToken(token);
      },
      markShareTokenRegistered,
      generate,
      post,
    }));

    expect(first.kind).toBe("http");
    expect(persistShareToken).toHaveBeenCalledWith(SHARE_A);
    expect(markShareTokenRegistered).not.toHaveBeenCalled();
    expect(stored).toBe(SHARE_A);

    post.mockResolvedValueOnce(registered());
    const second = await registerPersistedShareToken(deps({
      getState: async () => ({
        registrationGeneration: 7,
        ingestToken: INGEST,
        shareToken: stored,
        shareTokenRegisteredAt: null,
        shareTokenRotationCandidate: null,
      }),
      persistShareToken,
      markShareTokenRegistered,
      generate,
      post,
    }));

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

    const outcome = await registerPersistedShareToken(deps({
      getState: async () => ({
        registrationGeneration: 7,
        ingestToken: INGEST,
        shareToken: stored,
        shareTokenRegisteredAt: null,
        shareTokenRotationCandidate: null,
      }),
      persistShareToken: async (token) => {
        if (stored === null) stored = SHARE_A;
        await persistShareToken(token);
      },
      markShareTokenRegistered,
      generate,
      post,
    }));

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
      await registerPersistedShareToken(deps({
        baseUrl: () => null,
        getState: async () => ({
          registrationGeneration: 7,
          ingestToken: INGEST,
          shareToken: null,
          shareTokenRegisteredAt: null,
          shareTokenRotationCandidate: null,
        }),
        persistShareToken,
        markShareTokenRegistered,
        generate,
        post,
      })),
    ).toEqual({ kind: "not_ready" });

    expect(
      await registerPersistedShareToken(deps({
        getState: async () => ({
          registrationGeneration: 7,
          ingestToken: null,
          shareToken: null,
          shareTokenRegisteredAt: null,
          shareTokenRotationCandidate: null,
        }),
        persistShareToken,
        markShareTokenRegistered,
        generate,
        post,
      })),
    ).toEqual({ kind: "not_ready" });

    expect(generate).not.toHaveBeenCalled();
    expect(persistShareToken).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("returns not_ready when the publication fence rejects a stale success", async () => {
    const outcome = await registerPersistedShareToken(deps({
      persistShareToken: async () => undefined,
      markShareTokenRegistered: async () => false,
      post: async () => registered(),
    }));

    expect(outcome).toEqual({ kind: "not_ready" });
  });

  it("reads the recovered credentials with the stored token after persistence", async () => {
    const getState = vi.fn<ShareTokenProcedureDeps["getState"]>()
      .mockResolvedValueOnce({
        registrationGeneration: 7,
        ingestToken: INGEST,
        shareToken: null,
        shareTokenRegisteredAt: null,
        shareTokenRotationCandidate: null,
      })
      .mockResolvedValueOnce({
        registrationGeneration: 8,
        ingestToken: "J".repeat(43),
        shareToken: SHARE_B,
        shareTokenRegisteredAt: null,
        shareTokenRotationCandidate: null,
      });
    const post = vi.fn(async () => registered());
    const markShareTokenRegistered = vi.fn(async () => true);

    expect(await registerPersistedShareToken(deps({
      getState,
      persistShareToken: async () => undefined,
      markShareTokenRegistered,
      generate: () => SHARE_A,
      post,
    }))).toEqual({ kind: "registered" });

    expect(post).toHaveBeenCalledExactlyOnceWith({ ingestToken: "J".repeat(43), shareToken: SHARE_B });
    expect(markShareTokenRegistered).toHaveBeenCalledExactlyOnceWith({
      registrationGeneration: 8, shareToken: SHARE_B,
    });
  });

  it("does not stamp on conflict, http, malformed_response, rate_limited, stopped, transport, or auth_lost", async () => {
    const markShareTokenRegistered = vi.fn(async () => true);
    const persistShareToken = vi.fn<(token: string) => Promise<void>>(async () => undefined);
    const generate = vi.fn(() => SHARE_A);

    for (const outcome of [
      { kind: "conflict" },
      { kind: "http", status: 400, code: "validation_failed", retryAfterSeconds: null, detail: "HTTP 400" },
      { kind: "malformed_response", detail: "malformed share-token response" },
      { kind: "rate_limited", retryAfterSeconds: 10, detail: "HTTP 429" },
      { kind: "auth_lost" },
      { kind: "stopped", reason: "quarantined" },
      transportTimeout(),
    ] as const) {
      markShareTokenRegistered.mockClear();
      const post = vi.fn(async () => outcome);
      const result = await registerPersistedShareToken(deps({
        getState: async () => ({
          registrationGeneration: 7,
          ingestToken: INGEST,
          shareToken: SHARE_A,
          shareTokenRegisteredAt: null,
          shareTokenRotationCandidate: null,
        }),
        persistShareToken,
        markShareTokenRegistered,
        generate,
        post,
      }));
      expect(result).toEqual(outcome);
      expect(markShareTokenRegistered).not.toHaveBeenCalled();
    }
  });

  it("with a candidate present retries the rotation instead of a plain bind", async () => {
    const post = vi.fn(async () => registered());
    const commitShareTokenRotation = vi.fn(async () => true);
    const markShareTokenRegistered = vi.fn(async () => true);

    const outcome = await registerPersistedShareToken(deps({
      getState: async () => ({
        registrationGeneration: 7,
        ingestToken: INGEST,
        shareToken: SHARE_A,
        shareTokenRegisteredAt: null,
        shareTokenRotationCandidate: CANDIDATE_N,
      }),
      markShareTokenRegistered,
      commitShareTokenRotation,
      post,
    }));

    expect(outcome).toEqual({ kind: "registered" });
    expect(post).toHaveBeenCalledExactlyOnceWith({
      ingestToken: INGEST,
      shareToken: CANDIDATE_N,
      replaces: SHARE_A,
    });
    expect(commitShareTokenRotation).toHaveBeenCalledExactlyOnceWith({
      registrationGeneration: 7,
      previousShareToken: SHARE_A,
      candidate: CANDIDATE_N,
    });
    expect(markShareTokenRegistered).not.toHaveBeenCalled();
  });

  it("an unknown rotation outcome keeps the candidate and the next call re-sends the same one", async () => {
    const post = vi.fn(async (): Promise<RegisterShareTokenOutcome> => transportTimeout());
    const commitShareTokenRotation = vi.fn(async () => true);
    const generate = vi.fn(() => SHARE_B);
    let candidate: string | null = null;

    const state = () => ({
      registrationGeneration: 7,
      ingestToken: INGEST,
      shareToken: SHARE_A,
      shareTokenRegisteredAt: "2026-09-07T00:00:00.000Z",
      shareTokenRotationCandidate: candidate,
    });

    const first = await rotatePersistedShareToken(deps({
      getState: async () => state(),
      persistRotationCandidate: async (token) => {
        if (candidate === null) candidate = token;
      },
      commitShareTokenRotation,
      generate,
      post,
    }));
    expect(first).toEqual(transportTimeout());
    expect(candidate).toBe(SHARE_B);
    expect(commitShareTokenRotation).not.toHaveBeenCalled();

    post.mockResolvedValueOnce(registered());
    const second = await registerPersistedShareToken(deps({
      getState: async () => state(),
      commitShareTokenRotation,
      generate,
      post,
    }));
    expect(second).toEqual({ kind: "registered" });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenLastCalledWith({
      ingestToken: INGEST,
      shareToken: SHARE_B,
      replaces: SHARE_A,
    });
    expect(commitShareTokenRotation).toHaveBeenCalledExactlyOnceWith({
      registrationGeneration: 7,
      previousShareToken: SHARE_A,
      candidate: SHARE_B,
    });
  });

  it("a late registered for an old generation commits nothing and returns not_ready", async () => {
    let releaseResponse!: (value: RegisterShareTokenOutcome) => void;
    const response = new Promise<RegisterShareTokenOutcome>((resolve) => {
      releaseResponse = resolve;
    });
    let generation = 7;
    const commitShareTokenRotation = vi.fn(async () => false);

    const pending = registerPersistedShareToken(deps({
      getState: async () => ({
        registrationGeneration: generation,
        ingestToken: INGEST,
        shareToken: SHARE_A,
        shareTokenRegisteredAt: null,
        shareTokenRotationCandidate: CANDIDATE_N,
      }),
      commitShareTokenRotation,
      post: () => response,
    }));

    generation = 8; // recovery commits while the request is in flight
    releaseResponse(registered());
    expect(await pending).toEqual({ kind: "not_ready" });
    expect(commitShareTokenRotation).toHaveBeenCalledExactlyOnceWith({
      registrationGeneration: 7,
      previousShareToken: SHARE_A,
      candidate: CANDIDATE_N,
    });
  });
});

describe("rotatePersistedShareToken", () => {
  it("refuses when the current key is not registered yet", async () => {
    const generate = vi.fn(() => CANDIDATE_N);
    const persistRotationCandidate = vi.fn<(token: string) => Promise<void>>(async () => undefined);
    const post = vi.fn(async () => registered());

    for (const state of [
      {
        registrationGeneration: 7,
        ingestToken: INGEST,
        shareToken: null,
        shareTokenRegisteredAt: null,
        shareTokenRotationCandidate: null,
      },
      {
        registrationGeneration: 7,
        ingestToken: INGEST,
        shareToken: SHARE_A,
        shareTokenRegisteredAt: null,
        shareTokenRotationCandidate: null,
      },
    ]) {
      const outcome = await rotatePersistedShareToken(deps({
        getState: async () => state,
        persistRotationCandidate,
        generate,
        post,
      }));
      expect(outcome).toEqual({ kind: "rotation_not_allowed", reason: "not_registered" });
    }
    expect(generate).not.toHaveBeenCalled();
    expect(persistRotationCandidate).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses without sending when ingestToken or baseUrl is missing", async () => {
    const post = vi.fn(async () => registered());
    expect(
      await rotatePersistedShareToken(deps({ baseUrl: () => null, post })),
    ).toEqual({ kind: "rotation_not_allowed", reason: "not_ready" });
    expect(
      await rotatePersistedShareToken(deps({
        getState: async () => ({
          registrationGeneration: 7,
          ingestToken: null,
          shareToken: SHARE_A,
          shareTokenRegisteredAt: "2026-09-07T00:00:00.000Z",
          shareTokenRotationCandidate: null,
        }),
        post,
      })),
    ).toEqual({ kind: "rotation_not_allowed", reason: "not_ready" });
    expect(post).not.toHaveBeenCalled();
  });

  it("never mints while a candidate exists: it retries the pending rotation", async () => {
    const generate = vi.fn(() => SHARE_B);
    const persistRotationCandidate = vi.fn<(token: string) => Promise<void>>(async () => undefined);
    const post = vi.fn(async () => registered());
    const commitShareTokenRotation = vi.fn(async () => true);

    const outcome = await rotatePersistedShareToken(deps({
      getState: async () => ({
        registrationGeneration: 7,
        ingestToken: INGEST,
        shareToken: SHARE_A,
        shareTokenRegisteredAt: "2026-09-07T00:00:00.000Z",
        shareTokenRotationCandidate: CANDIDATE_N,
      }),
      persistRotationCandidate,
      commitShareTokenRotation,
      generate,
      post,
    }));

    expect(outcome).toEqual({ kind: "registered" });
    expect(generate).not.toHaveBeenCalled();
    expect(persistRotationCandidate).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledExactlyOnceWith({
      ingestToken: INGEST,
      shareToken: CANDIDATE_N,
      replaces: SHARE_A,
    });
  });

  it("mints a candidate, persists it, and commits on acknowledgement", async () => {
    const generate = vi.fn(() => CANDIDATE_N);
    const persistRotationCandidate = vi.fn<(token: string) => Promise<void>>(async () => undefined);
    const post = vi.fn(async () => registered());
    const commitShareTokenRotation = vi.fn(async () => true);
    let candidate: string | null = null;

    const outcome = await rotatePersistedShareToken(deps({
      getState: async () => ({
        registrationGeneration: 7,
        ingestToken: INGEST,
        shareToken: SHARE_A,
        shareTokenRegisteredAt: "2026-09-07T00:00:00.000Z",
        shareTokenRotationCandidate: candidate,
      }),
      persistRotationCandidate: async (token) => {
        if (candidate === null) candidate = token;
        await persistRotationCandidate(token);
      },
      commitShareTokenRotation,
      generate,
      post,
    }));

    expect(outcome).toEqual({ kind: "registered" });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(persistRotationCandidate).toHaveBeenCalledExactlyOnceWith(CANDIDATE_N);
    expect(post).toHaveBeenCalledExactlyOnceWith({
      ingestToken: INGEST,
      shareToken: CANDIDATE_N,
      replaces: SHARE_A,
    });
    expect(commitShareTokenRotation).toHaveBeenCalledExactlyOnceWith({
      registrationGeneration: 7,
      previousShareToken: SHARE_A,
      candidate: CANDIDATE_N,
    });
  });

  it("a racing rotate adopts the persisted winner instead of its own mint", async () => {
    const post = vi.fn(async () => registered());
    const commitShareTokenRotation = vi.fn(async () => true);
    let candidate: string | null = null;

    const outcome = await rotatePersistedShareToken(deps({
      getState: async () => ({
        registrationGeneration: 7,
        ingestToken: INGEST,
        shareToken: SHARE_A,
        shareTokenRegisteredAt: "2026-09-07T00:00:00.000Z",
        shareTokenRotationCandidate: candidate,
      }),
      // Another caller won the write-once persist first.
      persistRotationCandidate: async () => {
        candidate = CANDIDATE_N;
      },
      commitShareTokenRotation,
      generate: () => SHARE_B,
      post,
    }));

    expect(outcome).toEqual({ kind: "registered" });
    expect(post).toHaveBeenCalledExactlyOnceWith({
      ingestToken: INGEST,
      shareToken: CANDIDATE_N,
      replaces: SHARE_A,
    });
    expect(commitShareTokenRotation).toHaveBeenCalledExactlyOnceWith({
      registrationGeneration: 7,
      previousShareToken: SHARE_A,
      candidate: CANDIDATE_N,
    });
  });
});
