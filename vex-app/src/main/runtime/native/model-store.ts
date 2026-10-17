/**
 * The embeddings model store: puts the pinned GGUF on disk, verified, before
 * the native embeddings server may start (plan D10).
 *
 * The model is downloaded on first run, not shipped in the installer:
 *
 *   - Resumable. Bytes land in `<file>.part`; a later attempt asks for the
 *     rest with an HTTP Range request and hashes the bytes already on disk
 *     first, so an interrupted 333 MB download never starts over.
 *   - Verified while streaming. The sha256 is computed as the bytes arrive and
 *     must equal the pin before `.part` is renamed into place, atomically. A
 *     mismatch deletes the partial file; nothing unverified is ever named
 *     like the model.
 *   - Cheap on every later start. `<file>.verified` records the hash together
 *     with the size and mtime it was computed for, so a start re-hashes only
 *     when the file changed underneath it.
 *   - Sources in order. Each source is tried until one yields the verified
 *     file; HTTP 429 / 5xx / network errors move on to the next one.
 *   - Through Electron's `net` by default, which honours the system proxy and
 *     the OS certificate store (corporate networks, TLS inspection).
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EMBEDDING_MODEL_FILENAME,
  EMBEDDING_MODEL_SHA256,
} from "../../onboarding/embedding-defaults.js";
import { AbortError } from "../../ipc/cancel-helpers.js";

export interface ModelSpec {
  readonly fileName: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Tried in order until one yields the verified file. */
  readonly urls: readonly string[];
}

/**
 * EmbeddingGemma 300M Q8_0, pinned by content AND by the HuggingFace commit
 * that serves it (ggml-org/embeddinggemma-300M-GGUF@0f741b5a, whose LFS oid is
 * this sha256 and whose size is this byte count; verified 2026-10-17).
 */
export const EMBEDDING_MODEL_SPEC: ModelSpec = {
  fileName: EMBEDDING_MODEL_FILENAME,
  sha256: EMBEDDING_MODEL_SHA256,
  bytes: 333_590_944,
  urls: [
    "https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/0f741b5a6585bd53aeb15cd1372c56f2a0f65e12/embeddinggemma-300M-Q8_0.gguf",
  ],
};

/** Free space kept beyond the bytes still to download. */
const DISK_MARGIN_BYTES = 64 * 1024 * 1024;

export type ModelProgress =
  | { readonly phase: "verifying"; readonly bytes: number }
  | {
      readonly phase: "downloading";
      readonly receivedBytes: number;
      readonly totalBytes: number;
      readonly sourceIndex: number;
    };

export type EnsureModelResult =
  | { readonly kind: "ready"; readonly path: string; readonly downloaded: boolean }
  | { readonly kind: "disk_full"; readonly requiredBytes: number; readonly availableBytes: number }
  /** Every source failed; `message` names the last failure. */
  | { readonly kind: "unavailable"; readonly message: string };

export interface ModelStoreDeps {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly freeBytes: (dir: string) => Promise<number>;
}

async function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  const { net } = await import("electron");
  return net.fetch(url, init);
}

async function defaultFreeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

interface VerifiedStamp {
  readonly sha256: string;
  readonly size: number;
  readonly mtimeMs: number;
}

async function readStamp(file: string): Promise<VerifiedStamp | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as VerifiedStamp;
  } catch {
    return null;
  }
}

async function sizeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

async function hashFile(file: string, hash = createHash("sha256")): Promise<ReturnType<typeof createHash>> {
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash;
}

/** Make the pinned model available in `dir`, downloading it if needed. */
export async function ensureModel(options: {
  readonly dir: string;
  readonly signal: AbortSignal;
  readonly spec?: ModelSpec;
  readonly onProgress?: (progress: ModelProgress) => void;
  readonly deps?: Partial<ModelStoreDeps>;
}): Promise<EnsureModelResult> {
  const spec = options.spec ?? EMBEDDING_MODEL_SPEC;
  const fetchImpl = options.deps?.fetch ?? defaultFetch;
  const freeBytes = options.deps?.freeBytes ?? defaultFreeBytes;
  const target = path.join(options.dir, spec.fileName);
  const part = `${target}.part`;
  const stampFile = `${target}.verified`;
  await mkdir(options.dir, { recursive: true });

  // ── Already present? ──────────────────────────────────────────────
  const existing = await stat(target).catch(() => null);
  if (existing !== null) {
    if (existing.size === spec.bytes) {
      const stamp = await readStamp(stampFile);
      if (stamp?.sha256 === spec.sha256 && stamp.size === existing.size && stamp.mtimeMs === existing.mtimeMs) {
        return { kind: "ready", path: target, downloaded: false };
      }
      options.onProgress?.({ phase: "verifying", bytes: existing.size });
      if ((await hashFile(target)).digest("hex") === spec.sha256) {
        await writeStamp(stampFile, spec.sha256, target);
        return { kind: "ready", path: target, downloaded: false };
      }
    }
    // Wrong size or wrong content: not the model, whatever its name says.
    await rm(target, { force: true });
    await rm(stampFile, { force: true });
  }

  // ── Download ──────────────────────────────────────────────────────
  let lastFailure = "no download source configured";
  for (const [sourceIndex, url] of spec.urls.entries()) {
    if (options.signal.aborted) throw new AbortError();
    let have = (await sizeOf(part)) ?? 0;
    if (have > spec.bytes) {
      await rm(part, { force: true });
      have = 0;
    }
    const required = spec.bytes - have + DISK_MARGIN_BYTES;
    const available = await freeBytes(options.dir);
    if (available < required) {
      return { kind: "disk_full", requiredBytes: required, availableBytes: available };
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        signal: options.signal,
        headers: have > 0 ? { Range: `bytes=${have}-` } : {},
      });
    } catch (error) {
      if (options.signal.aborted) throw new AbortError();
      lastFailure = `source ${sourceIndex + 1}: ${error instanceof Error ? error.message : String(error)}`;
      continue;
    }

    if (response.status === 416 && have === spec.bytes) {
      // The partial file already holds every byte; only verification is left.
    } else if (response.status !== 200 && response.status !== 206) {
      lastFailure = `source ${sourceIndex + 1}: HTTP ${response.status}`;
      await response.body?.cancel().catch(() => {});
      continue;
    } else if (response.status === 200 && have > 0) {
      // The server ignored the Range request and is sending everything.
      await rm(part, { force: true });
      have = 0;
    }

    const hash = have > 0 ? await hashFile(part) : createHash("sha256");
    let received = have;
    if (response.status !== 416) {
      if (response.body === null) {
        lastFailure = `source ${sourceIndex + 1}: empty response body`;
        continue;
      }
      const handle = await open(part, have > 0 ? "a" : "w");
      try {
        const reader = response.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (received + value.byteLength > spec.bytes) {
            throw new Error(`source ${sourceIndex + 1} sent more than the pinned ${spec.bytes} bytes`);
          }
          await handle.write(value);
          hash.update(value);
          received += value.byteLength;
          options.onProgress?.({ phase: "downloading", receivedBytes: received, totalBytes: spec.bytes, sourceIndex });
        }
        await handle.sync();
      } catch (error) {
        if (options.signal.aborted) throw new AbortError();
        // Keep what arrived: the next attempt resumes from it.
        lastFailure = `source ${sourceIndex + 1}: ${error instanceof Error ? error.message : String(error)}`;
        continue;
      } finally {
        await handle.close();
      }
    }

    if (received !== spec.bytes) {
      lastFailure = `source ${sourceIndex + 1}: ended after ${received} of ${spec.bytes} bytes`;
      continue;
    }
    const digest = hash.digest("hex");
    if (digest !== spec.sha256) {
      await rm(part, { force: true });
      lastFailure = `source ${sourceIndex + 1}: sha256 ${digest} does not match the pinned ${spec.sha256}`;
      continue;
    }
    await rename(part, target);
    await writeStamp(stampFile, spec.sha256, target);
    return { kind: "ready", path: target, downloaded: true };
  }
  return { kind: "unavailable", message: lastFailure };
}

async function writeStamp(stampFile: string, sha256: string, target: string): Promise<void> {
  const s = await stat(target);
  const stamp: VerifiedStamp = { sha256, size: s.size, mtimeMs: s.mtimeMs };
  await writeFile(`${stampFile}.tmp`, JSON.stringify(stamp));
  await rename(`${stampFile}.tmp`, stampFile);
}
