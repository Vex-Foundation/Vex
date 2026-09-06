/**
 * Vex launch-assets host client - publishing token launch art at a
 * CONTENT-ADDRESSED public URL.
 *
 * WHAT THIS IS. The launch-assets host is a separate Fastify app in the
 * `vex-agentscan` monorepo, served from the same origin as the AgentScan API
 * and authenticated with the SAME install credential the reporting lane
 * already holds (`agent_hash` + `ingest_token` in `agentscan_reporting_state`).
 * A token's picture is uploaded here once, and the URL that comes back is what
 * the launch writes into the token's metadata.
 *
 * WHY CONTENT ADDRESSING IS THE WHOLE POINT (coordinator decision I1). The
 * URL goes ON CHAIN. A mutable URL would mean the picture the user approved in
 * the launch form and the picture the world later sees could differ, with
 * nothing on chain able to tell them apart: the same link, different bytes,
 * no evidence. The mutable-URL fallback was therefore rejected. Here the URL
 * names the sha256 of the exact bytes, and this client RE-DERIVES that hash
 * locally and refuses any answer whose `cid`, `url` or `bytes` does not
 * address the bytes we sent. A host answering a different cid is refused by
 * name (`cid_mismatch`) and never trusted, because at that point the promise
 * the on-chain URL makes is one this client cannot verify.
 *
 * THESE BYTES BECOME PUBLIC. There is no private mode: an accepted upload is
 * readable by anyone who has the URL, and the URL is derivable from the bytes
 * by anyone holding the same file. The caller is responsible for only handing
 * this module art the user chose to publish. Deletion (`deleteAsset`) removes
 * the object, and a deleted cid is permanently burned: nobody, including its
 * original publisher, can ever publish those bytes again (HTTP 410).
 *
 * NOTHING THROWS. Every expected failure - a refusal, an unsupported image, a
 * quota, an unreachable host, a host that answered the wrong content address -
 * comes back as a named member of `UploadOutcome` / `DeleteOutcome`, exactly
 * like `agentscan/client.ts` and `agentscan/attest-client.ts`. The one
 * exception is documented on `resolveLaunchAssetsPublisher` below.
 *
 * NO RETRY LOOP LIVES HERE. Upload is idempotent by content (the server
 * answers 200 instead of 201 when these exact bytes are already published), so
 * a caller MAY safely re-run a failed upload. This module never loops on its
 * own: the outcome arms ARE the policy, and only `unavailable` describes a
 * failure that a later attempt could plausibly clear.
 *
 * TOKEN HYGIENE. The ingest token is a secret. It travels ONLY in the
 * `Authorization: Bearer` header - never in a URL, never in a log line, never
 * in an outcome `detail`. Only the server's closed-vocabulary error CODE ever
 * reaches a detail string, and every detail is scrubbed and length-capped by
 * `sanitize` before it can reach a log, the same discipline the two sibling
 * clients use.
 */

import { createHash } from "node:crypto";

import { fetchWithTimeout, readJson } from "@utils/http.js";
import { readRetryAfterSeconds } from "@utils/http/retry-after.js";
import { getReportingState } from "@vex-agent/db/repos/agentscan-reporting.js";
import { loadConfig } from "../../config/store.js";
import { resolveAgentscanBaseUrl } from "../sync/agentscan-report/production-deps.js";

/**
 * An image upload is an order of magnitude bigger than an events POST (which
 * uses 15 s), and it is a single user-visible step in a launch the user is
 * watching: 20 s is long enough for a 2 MiB body on a slow uplink and short
 * enough that a dead host does not hold the launch form hostage.
 */
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_DETAIL_LEN = 120;

/** Origin-relative endpoint of the upload (PUT) endpoint. */
export const LAUNCH_ASSET_UPLOAD_PATH = "/v1/assets";
/** Origin-relative prefix of the delete endpoint; the cid completes it. */
export const LAUNCH_ASSET_DELETE_PATH_PREFIX = "/v1/assets/";
/** Client-side body cap, 2 MiB. Exactly the cap is allowed; one byte more is refused locally. */
export const MAX_ASSET_BYTES = 2_097_152;

/** Lowercase-hex sha256, the only shape a content address may take. */
const CID_PATTERN = /^[0-9a-f]{64}$/;
/** Bounded, punctuation-restricted shape an untrusted correlation id must match. */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

// ── transport contract ──────────────────────────────────────────────────────

export interface UploadAssetInput {
  readonly ingestToken: string;
  /** The RAW image bytes. Sent verbatim as the request body; never base64, never multipart. */
  readonly bytes: Uint8Array;
}

export interface DeleteAssetInput {
  readonly ingestToken: string;
  /** Lowercase-hex sha256 of the published bytes. */
  readonly cid: string;
}

/** Which verification of the server's answer against our own bytes failed. */
export type CidMismatchReason =
  | "served_cid_differs"
  | "byte_length_differs"
  | "url_does_not_address_cid";

export type UploadOutcome =
  | {
      readonly kind: "ok";
      readonly cid: string;
      readonly url: string;
      readonly bytes: number;
      readonly type: string;
      readonly width: number;
      readonly height: number;
      /** True when the host answered 200: these exact bytes were already published. */
      readonly alreadyPublished: boolean;
    }
  /** HTTP 401. The install credential is not accepted; a re-handshake is needed. */
  | { readonly kind: "unauthorized"; readonly correlationId: string | null }
  /** A client bug: a 400 `validation_failed`, an unexpected 4xx, or a malformed success body. Never hot-retried. */
  | { readonly kind: "invalid"; readonly detail: string; readonly correlationId: string | null }
  /**
   * HTTP 400 `unsupported_image`: the bytes are not png/jpeg/webp/gif by magic
   * bytes, or the header carries no plausible dimensions. Distinct from
   * `invalid` because the USER can fix it by choosing another picture.
   */
  | { readonly kind: "unsupported_image"; readonly detail: string; readonly correlationId: string | null }
  | {
      readonly kind: "too_large";
      readonly byteLength: number;
      readonly maxBytes: number;
      /** Null for the local pre-flight refusal: no request was made, so no server id exists. */
      readonly correlationId: string | null;
    }
  /**
   * HTTP 410 `asset_deleted`. The owner of this content deleted it, and a
   * deleted content address is permanently burned: these bytes can never be
   * published again, by this install or by anyone else.
   */
  | { readonly kind: "deleted"; readonly correlationId: string | null }
  | {
      readonly kind: "quota_exceeded";
      readonly axis: "count" | "bytes" | "unknown";
      readonly correlationId: string | null;
    }
  /** The host's answer does not address the bytes we sent. Never trusted, never retried blind. */
  | {
      readonly kind: "cid_mismatch";
      readonly reason: CidMismatchReason;
      readonly expectedCid: string;
      readonly servedCid: string;
      readonly correlationId: string | null;
    }
  /** HTTP 429 without a quota code, any 5xx, a timeout, or a network failure. */
  | {
      readonly kind: "unavailable";
      readonly status: number | null;
      readonly retryAfterSeconds: number | null;
      readonly detail: string;
    };

export type DeleteOutcome =
  | { readonly kind: "ok"; readonly cid: string }
  | { readonly kind: "unauthorized"; readonly correlationId: string | null }
  /** HTTP 403: a different install published this asset, so this install cannot delete it. */
  | { readonly kind: "forbidden"; readonly correlationId: string | null }
  /** HTTP 404: no install ever published this cid. */
  | { readonly kind: "not_found"; readonly correlationId: string | null }
  | { readonly kind: "invalid"; readonly detail: string; readonly correlationId: string | null }
  | {
      readonly kind: "unavailable";
      readonly status: number | null;
      readonly retryAfterSeconds: number | null;
      readonly detail: string;
    };

export interface LaunchAssetsClient {
  uploadAsset(input: UploadAssetInput): Promise<UploadOutcome>;
  deleteAsset(input: DeleteAssetInput): Promise<DeleteOutcome>;
}

export function buildLaunchAssetsClient(baseUrl: string): LaunchAssetsClient {
  return {
    uploadAsset: (input) => uploadAsset(baseUrl, input),
    deleteAsset: (input) => deleteAsset(baseUrl, input),
  };
}

// ── upload ──────────────────────────────────────────────────────────────────

async function uploadAsset(baseUrl: string, input: UploadAssetInput): Promise<UploadOutcome> {
  const byteLength = input.bytes.byteLength;
  if (byteLength === 0) {
    return { kind: "invalid", detail: "empty image body", correlationId: null };
  }
  if (byteLength > MAX_ASSET_BYTES) {
    // Refused LOCALLY: sending a body the host will reject anyway wastes the
    // user's uplink and the host's quota window.
    return { kind: "too_large", byteLength, maxBytes: MAX_ASSET_BYTES, correlationId: null };
  }

  const endpoint = originUrl(baseUrl, LAUNCH_ASSET_UPLOAD_PATH);
  if (endpoint === null) {
    return { kind: "invalid", detail: "unusable base url", correlationId: null };
  }

  // Derived BEFORE the request so the comparison below can never be influenced
  // by anything the host said.
  const expectedCid = sha256Hex(input.bytes);

  let response: Response;
  try {
    response = await fetchWithTimeout(endpoint, {
      method: "PUT",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${input.ingestToken}`,
      },
      // The RAW bytes, copied into an exactly-sized ArrayBuffer. Two reasons,
      // both mechanical: `BodyInit` in the checked-in lib accepts an
      // `ArrayBuffer` but not a typed-array VIEW, and a bare `input.bytes.buffer`
      // would send the whole backing store whenever the caller handed us a
      // subarray (or a SharedArrayBuffer, which is not a valid body at all).
      // The copy is one pass over at most 2 MiB, and it is the same discipline
      // `tools/pools-fun/client.ts` uses for its image upload.
      body: new Uint8Array(input.bytes).buffer,
    });
  } catch (err) {
    return { kind: "unavailable", status: null, retryAfterSeconds: null, detail: safeDetail(err) };
  }

  const body = await readJson(response).catch(() => null);
  const correlationId = readCorrelationId(body, response.headers);

  if (response.ok) return readUploadSuccess(response.status, body, expectedCid, input.bytes.byteLength, correlationId);

  const code = errorCode(body);
  if (response.status === 401) return { kind: "unauthorized", correlationId };
  if (response.status === 400) {
    return code === "unsupported_image"
      ? { kind: "unsupported_image", detail: describeError(response.status, body), correlationId }
      : { kind: "invalid", detail: describeError(response.status, body), correlationId };
  }
  if (response.status === 413) {
    return { kind: "too_large", byteLength, maxBytes: MAX_ASSET_BYTES, correlationId };
  }
  if (response.status === 410) return { kind: "deleted", correlationId };
  if (response.status === 429 && code !== null && code.startsWith("quota_exceeded")) {
    return { kind: "quota_exceeded", axis: quotaAxis(code), correlationId };
  }
  if (response.status === 429 || response.status >= 500) {
    return {
      kind: "unavailable",
      status: response.status,
      retryAfterSeconds: readRetryAfterSeconds(response.headers, response.status) ?? null,
      detail: describeError(response.status, body),
    };
  }
  // Any other 4xx is a client bug, never hot-retried.
  return { kind: "invalid", detail: describeError(response.status, body), correlationId };
}

/**
 * Strict reader for the success body, then the three content-address checks.
 *
 * Strict, not tolerant, because every field here is load-bearing for a value
 * that goes on chain: a missing or malformed field must surface as `invalid`,
 * never as a silent default that would let an unverifiable URL through.
 */
function readUploadSuccess(
  status: number,
  body: unknown,
  expectedCid: string,
  sentByteLength: number,
  correlationId: string | null,
): UploadOutcome {
  if (status !== 200 && status !== 201) {
    return { kind: "invalid", detail: sanitize(`HTTP ${status} unexpected_success_status`), correlationId };
  }
  if (!isRecord(body)) {
    return { kind: "invalid", detail: "success body is not an object", correlationId };
  }

  const cid = body.cid;
  if (typeof cid !== "string" || !CID_PATTERN.test(cid)) {
    return { kind: "invalid", detail: "success body cid is not a sha256 hex digest", correlationId };
  }
  const url = body.url;
  if (typeof url !== "string" || url.length === 0) {
    return { kind: "invalid", detail: "success body url is missing", correlationId };
  }
  const bytes = body.bytes;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) {
    return { kind: "invalid", detail: "success body bytes is not a byte count", correlationId };
  }
  const type = body.type;
  if (typeof type !== "string" || type.trim().length === 0) {
    return { kind: "invalid", detail: "success body type is missing", correlationId };
  }
  const width = body.width;
  const height = body.height;
  if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
    return { kind: "invalid", detail: "success body dimensions are not positive integers", correlationId };
  }

  // THE SECURITY CORE. Ordinary string comparison is sufficient: a content
  // address is public information, so there is no secret whose comparison
  // timing could leak.
  if (cid !== expectedCid) {
    return { kind: "cid_mismatch", reason: "served_cid_differs", expectedCid, servedCid: cid, correlationId };
  }
  if (bytes !== sentByteLength) {
    return { kind: "cid_mismatch", reason: "byte_length_differs", expectedCid, servedCid: cid, correlationId };
  }
  if (!publicUrlAddressesCid(url, cid)) {
    return { kind: "cid_mismatch", reason: "url_does_not_address_cid", expectedCid, servedCid: cid, correlationId };
  }

  return {
    kind: "ok",
    cid,
    url,
    bytes,
    type,
    width,
    height,
    alreadyPublished: status === 200,
  };
}

/**
 * The public URL must be an absolute `https:` URL (or `http:` on loopback, the
 * same exception `resolveAgentscanBaseUrl` makes for local development) whose
 * path ends with `/a/<cid>.<ext>` for the SAME cid. Anything else is a URL
 * whose bytes we have not verified, and it must never reach the chain.
 *
 * A query string or fragment is refused as well: the content address IS the
 * whole address, so anything appended to it is either meaningless or an
 * attempt to make the link carry state the cid does not cover. The value goes
 * on chain unchanged, so it leaves here clean or not at all.
 */
function publicUrlAddressesCid(url: string, cid: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) return false;
  if (parsed.search.length > 0 || parsed.hash.length > 0) return false;
  return new RegExp(`/a/${cid}\\.[A-Za-z0-9]+$`).test(parsed.pathname);
}

// ── delete ──────────────────────────────────────────────────────────────────

async function deleteAsset(baseUrl: string, input: DeleteAssetInput): Promise<DeleteOutcome> {
  if (!CID_PATTERN.test(input.cid)) {
    // Refused locally: a non-address cannot name an asset, so there is nothing
    // to ask the host about.
    return { kind: "invalid", detail: "cid is not a sha256 hex digest", correlationId: null };
  }

  const endpoint = originUrl(baseUrl, `${LAUNCH_ASSET_DELETE_PATH_PREFIX}${input.cid}`);
  if (endpoint === null) {
    return { kind: "invalid", detail: "unusable base url", correlationId: null };
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(endpoint, {
      method: "DELETE",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${input.ingestToken}` },
    });
  } catch (err) {
    return { kind: "unavailable", status: null, retryAfterSeconds: null, detail: safeDetail(err) };
  }

  // Delete is idempotent server-side: deleting an already-deleted asset
  // succeeds, so the caller never has to distinguish the two.
  if (response.ok) return { kind: "ok", cid: input.cid };

  const body = await readJson(response).catch(() => null);
  const correlationId = readCorrelationId(body, response.headers);
  if (response.status === 401) return { kind: "unauthorized", correlationId };
  if (response.status === 403) return { kind: "forbidden", correlationId };
  if (response.status === 404) return { kind: "not_found", correlationId };
  if (response.status === 429 || response.status >= 500) {
    return {
      kind: "unavailable",
      status: response.status,
      retryAfterSeconds: readRetryAfterSeconds(response.headers, response.status) ?? null,
      detail: describeError(response.status, body),
    };
  }
  return { kind: "invalid", detail: describeError(response.status, body), correlationId };
}

// ── credential + base-url resolution ────────────────────────────────────────

export type LaunchAssetsPublisher =
  | {
      readonly kind: "ready";
      readonly client: LaunchAssetsClient;
      readonly agentHash: string;
      readonly ingestToken: string;
    }
  /** No usable AgentScan base URL is configured, so there is no host to publish to. */
  | { readonly kind: "agentscan_unconfigured" }
  /** This install has no accepted credential yet; the handshake has to run first. */
  | { readonly kind: "install_unregistered" };

/**
 * Resolve the host and the install credential in one place, so no caller has
 * to hand-roll either.
 *
 * REPORTING CONSENT IS NOT A GATE HERE, deliberately. `stoppedReason` (consent
 * revoked, quarantined, a wallet or agent conflict) stops the REPORTING lane
 * from sending activity events. It says nothing about whether this install may
 * host a picture for a token it is launching: the two are independent product
 * concerns, and the assets host itself does not gate on reporting status
 * either. Gating here would silently break launches for a user who merely
 * turned reporting off.
 *
 * The base URL policy (HTTPS only, except loopback) is NOT re-implemented
 * here: `resolveAgentscanBaseUrl` owns it, and a second copy of a security
 * rule is a second thing to get wrong.
 *
 * THE ONE THING THAT CAN THROW in this module: `getReportingState` reads the
 * local database, and a database outage is an infrastructure failure that none
 * of the three arms above can describe honestly (it is neither "not
 * configured" nor "not registered", and answering `install_unregistered` would
 * point the caller at a pointless re-handshake). It is left to propagate to
 * the caller's own error boundary rather than laundered into a wrong answer.
 */
export async function resolveLaunchAssetsPublisher(): Promise<LaunchAssetsPublisher> {
  const baseUrl = resolveAgentscanBaseUrl(loadConfig().services.agentscanApiUrl);
  if (baseUrl === null) return { kind: "agentscan_unconfigured" };

  const state = await getReportingState();
  if (state.registeredAt === null || state.agentHash === null || state.ingestToken === null) {
    return { kind: "install_unregistered" };
  }

  return {
    kind: "ready",
    client: buildLaunchAssetsClient(baseUrl),
    agentHash: state.agentHash,
    ingestToken: state.ingestToken,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The assets host lives at the ORIGIN of the configured AgentScan URL: its
 * endpoints are absolute paths, so any configured subpath is deliberately
 * dropped (unlike `client.ts`'s path-preserving join for the ingest API).
 * Returns null when the base cannot be parsed, so the caller can answer with
 * an outcome instead of throwing.
 */
function originUrl(baseUrl: string, absolutePath: string): string | null {
  try {
    return new URL(absolutePath, new URL(baseUrl).origin).toString();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function errorCode(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  return typeof body.error.code === "string" ? body.error.code : null;
}

function quotaAxis(code: string): "count" | "bytes" | "unknown" {
  if (code === "quota_exceeded_count") return "count";
  if (code === "quota_exceeded_bytes") return "bytes";
  return "unknown";
}

/**
 * The server's correlation id, read tolerantly and BOUNDED: an untrusted
 * server string must never become an unbounded log line, so anything that is
 * not a short, punctuation-restricted token reads as null. The error envelope
 * carries it first; the `x-correlation-id` response header is the fallback for
 * responses with no readable body.
 */
function readCorrelationId(body: unknown, headers: Headers): string | null {
  if (isRecord(body) && isRecord(body.error)) {
    const fromBody = body.error.correlationId;
    if (typeof fromBody === "string" && CORRELATION_ID_PATTERN.test(fromBody)) return fromBody;
  }
  const fromHeader = headers.get("x-correlation-id");
  if (fromHeader !== null && CORRELATION_ID_PATTERN.test(fromHeader)) return fromHeader;
  return null;
}

/** Status + the server's error CODE only - codes are a closed vocabulary, messages are never logged verbatim. */
function describeError(status: number, body: unknown): string {
  const code = errorCode(body);
  return sanitize(code === null ? `HTTP ${status}` : `HTTP ${status} ${code}`);
}

function safeDetail(err: unknown): string {
  return sanitize(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
}

/**
 * Bound and scrub an untrusted string before it can reach a log line: URLs,
 * long hex and base64url runs (the ingest token is exactly that shape) are
 * removed, whitespace is collapsed, and the result is length-capped.
 */
function sanitize(text: string): string {
  const scrubbed = text
    .replace(/\bhttps?:\/\/\S+/gi, "<url>")
    .replace(/\b0x[0-9a-fA-F]{16,}\b/g, "<hex>")
    .replace(/[A-Za-z0-9_-]{40,}/g, "<blob>")
    .replace(/\s+/g, " ")
    .trim();
  if (scrubbed.length === 0) return "no detail";
  return scrubbed.length > MAX_DETAIL_LEN ? `${scrubbed.slice(0, MAX_DETAIL_LEN)}...` : scrubbed;
}
