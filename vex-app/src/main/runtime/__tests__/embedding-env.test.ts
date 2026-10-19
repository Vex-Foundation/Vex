import { describe, expect, it } from "vitest";

import {
  applyNativeEmbeddingEnv,
  isBundledEmbeddingSelection,
  publishNativeEmbeddings,
} from "../native/embedding-env.js";

const LIVE = { baseUrl: "http://127.0.0.1:51234/v1", apiKey: "per-launch-key" };
const BUNDLED_FILE_TUPLE = {
  EMBEDDING_BASE_URL: "http://127.0.0.1:27134/v1",
  EMBEDDING_MODEL: "ai/embeddinggemma:300M-Q8_0",
  EMBEDDING_DIM: "768",
  EMBEDDING_PROVIDER: "local",
};

describe("native embeddings environment", () => {
  it("treats nothing configured, or the bundled tuple, as the bundled selection", () => {
    expect(isBundledEmbeddingSelection({})).toBe(true);
    expect(isBundledEmbeddingSelection({ ...BUNDLED_FILE_TUPLE })).toBe(true);
    expect(isBundledEmbeddingSelection({ ...BUNDLED_FILE_TUPLE, EMBEDDING_PROVIDER: "openrouter" })).toBe(false);
    expect(isBundledEmbeddingSelection({ ...BUNDLED_FILE_TUPLE, EMBEDDING_MODEL: "qwen3-embedding" })).toBe(false);
  });

  it("points the bundled selection at the live server, key included", () => {
    const env: NodeJS.ProcessEnv = { ...BUNDLED_FILE_TUPLE };
    publishNativeEmbeddings(LIVE, env);
    expect(env).toEqual({
      EMBEDDING_BASE_URL: LIVE.baseUrl,
      EMBEDDING_MODEL: "ai/embeddinggemma:300M-Q8_0",
      EMBEDDING_DIM: "768",
      EMBEDDING_PROVIDER: "local",
      EMBEDDING_API_KEY: "per-launch-key",
    });
  });

  it("leaves a user-configured remote provider untouched", () => {
    const remote: NodeJS.ProcessEnv = {
      EMBEDDING_BASE_URL: "https://api.example.com/v1",
      EMBEDDING_MODEL: "text-embedding-3-small",
      EMBEDDING_DIM: "1536",
      EMBEDDING_PROVIDER: "openai",
    };
    const before = { ...remote };
    publishNativeEmbeddings(LIVE, remote);
    expect(remote).toEqual(before);
  });

  it("withdraws the dead key during an outage but keeps the URL", () => {
    const env: NodeJS.ProcessEnv = { ...BUNDLED_FILE_TUPLE };
    publishNativeEmbeddings(LIVE, env);
    publishNativeEmbeddings(null, env);
    expect(env.EMBEDDING_API_KEY).toBeUndefined();
    expect(env.EMBEDDING_BASE_URL).toBe(LIVE.baseUrl);
  });

  it("re-applies the live endpoint after .env is reloaded over it", () => {
    const env: NodeJS.ProcessEnv = {};
    publishNativeEmbeddings(LIVE, env);
    Object.assign(env, BUNDLED_FILE_TUPLE); // loadProviderDotenv({ overwrite: true })
    applyNativeEmbeddingEnv(env);
    expect(env.EMBEDDING_BASE_URL).toBe(LIVE.baseUrl);
    expect(env.EMBEDDING_API_KEY).toBe("per-launch-key");
  });
});
