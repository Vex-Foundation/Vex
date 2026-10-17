/**
 * Bundled embedding service — main-only constants (M11.5.4).
 *
 * User-facing defaults (port, alias, dim, provider, base URL builder)
 * live in `src/shared/embedding-defaults.ts` so the renderer can use
 * them in placeholders + skip-card copy without a main → renderer
 * leak path. This file re-exports the shared symbols and adds the
 * server-only metadata: image references (digest-pinned), GGUF
 * download URL + SHA256, and the on-disk filename inside the named
 * volume.
 *
 * Bumping image tag → regenerate `digest`:
 *   TOKEN=$(curl -fsSL 'https://ghcr.io/token?scope=repository:ggml-org/llama.cpp:pull&service=ghcr.io' | jq -r .token)
 *   curl -fsSI -H "Authorization: Bearer $TOKEN" \
 *     -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
 *     'https://ghcr.io/v2/ggml-org/llama.cpp/manifests/<TAG>' | grep -i docker-content-digest
 *
 * Bumping the GGUF SHA256 → HF LFS metadata:
 *   curl -fsSL 'https://huggingface.co/api/models/ggml-org/embeddinggemma-300M-GGUF/tree/main' \
 *     | jq '.[] | select(.path=="embeddinggemma-300M-Q8_0.gguf").lfs.oid'
 */

export {
  DEFAULT_EMBED_PORT,
  EMBEDDING_MODEL_ALIAS,
  EMBEDDING_DIM,
  EMBEDDING_PROVIDER,
  buildEmbeddingBaseUrl,
  defaultEmbeddingEnv,
} from "@shared/embedding-defaults.js";

export const EMBEDDING_MODEL_FILENAME = "embeddinggemma-300M-Q8_0.gguf";

/**
 * SHA256 of `embeddinggemma-300M-Q8_0.gguf` as published by HuggingFace
 * LFS for `ggml-org/embeddinggemma-300M-GGUF`. Verified 2026-05-12 via
 * `/api/models/.../tree/main`. HF does not publish a signed manifest;
 * treat this as a pinned-at-build-time constant.
 */
export const EMBEDDING_MODEL_SHA256 =
  "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63";

export const EMBEDDING_MODEL_DOWNLOAD_URL =
  "https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf";

/**
 * Image references used by the previous release's compose template
 * (digest-pinned), which the migration still renders.
 */
export const COMPOSE_IMAGES = {
  llamaServer: {
    tag: "ghcr.io/ggml-org/llama.cpp:server-b9115",
    digest:
      "sha256:6b0a9b4fd7e3a9a55e959e5a74d47e11f8ccd4dfbc2556b7382a6516255dcc73",
  },
  curlInit: {
    tag: "curlimages/curl:8.11.0",
    digest:
      "sha256:83a505ba2ba62f208ed6e410c268b7b9aa48f0f7b403c8108b9773b44199dbba",
  },
} as const;
