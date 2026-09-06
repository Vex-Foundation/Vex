/**
 * Launch-assets client - wire shape, content-address verification, outcome mapping.
 *
 * Pinned here:
 *   - the exact request the host receives: PUT to the ORIGIN's `/v1/assets`,
 *     the RAW bytes as the body (never multipart, never base64), the bearer
 *     token in the header and NEVER in the URL;
 *   - CONTENT ADDRESSING, which is the security core of this module: the
 *     client re-derives sha256 over the bytes it sent and refuses any answer
 *     whose cid, byte count or public URL does not address them. The
 *     "different cid" case below is deliberately revert-proof: delete the
 *     sha256 comparison in `readUploadSuccess` and it turns red, because the
 *     body is otherwise perfectly well formed;
 *   - every server answer maps to the arm the launch flow keys off, including
 *     the two distinct 429 families (quota vs plain rate limit);
 *   - nothing throws: a network failure and a timeout are named outcomes;
 *   - no failure detail ever carries the ingest token, a URL, or an
 *     unbounded server string.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const mockLoadConfig = vi.fn();
vi.mock("@config/store.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, loadConfig: () => mockLoadConfig() };
});

const mockGetReportingState = vi.fn();
vi.mock("@vex-agent/db/repos/agentscan-reporting.js", () => ({
  getReportingState: () => mockGetReportingState(),
}));

import {
  buildLaunchAssetsClient,
  resolveLaunchAssetsPublisher,
  MAX_ASSET_BYTES,
} from "../../../vex-agent/agentscan/assets-client.js";

const TOKEN = "T".repeat(43);
const BASE = "https://scan.example.test";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22]);
const CID = createHash("sha256").update(PNG).digest("hex");
const OTHER_CID = "a".repeat(64);

function successBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cid: CID,
    url: `https://cdn.example.test/a/${CID}.png`,
    bytes: PNG.byteLength,
    type: "image/png",
    width: 512,
    height: 512,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function stubFetch(response: Response | Error): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function client() {
  return buildLaunchAssetsClient(BASE);
}

function upload() {
  return client().uploadAsset({ ingestToken: TOKEN, bytes: PNG });
}

beforeEach(() => {
  mockLoadConfig.mockReset();
  mockGetReportingState.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadAsset - wire shape", () => {
  it("PUTs the raw bytes to the origin's /v1/assets with the bearer token, never in the URL", async () => {
    const mock = stubFetch(jsonResponse(201, successBody()));
    const outcome = await upload();

    expect(outcome).toEqual({
      kind: "ok",
      cid: CID,
      url: `https://cdn.example.test/a/${CID}.png`,
      bytes: PNG.byteLength,
      type: "image/png",
      width: 512,
      height: 512,
      alreadyPublished: false,
    });

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://scan.example.test/v1/assets");
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe("PUT");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    // The body is the RAW bytes, byte for byte - not multipart, not base64.
    expect(init.body).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(init.body as ArrayBuffer))).toEqual(Array.from(PNG));
  });

  it("reads a 200 as an idempotent re-publish of the same bytes", async () => {
    stubFetch(jsonResponse(200, successBody()));
    expect(await upload()).toMatchObject({ kind: "ok", alreadyPublished: true });
  });
});

describe("uploadAsset - content-address verification", () => {
  it("refuses a host that answers a DIFFERENT cid for these bytes", async () => {
    // Deliberately revert-proof: the body is internally consistent (its url
    // and byte count match the cid it claims), so ONLY the local sha256
    // comparison can catch it.
    stubFetch(
      jsonResponse(201, successBody({ cid: OTHER_CID, url: `https://cdn.example.test/a/${OTHER_CID}.png` })),
    );
    const outcome = await upload();
    expect(outcome.kind).not.toBe("ok");
    expect(outcome).toEqual({
      kind: "cid_mismatch",
      reason: "served_cid_differs",
      expectedCid: CID,
      servedCid: OTHER_CID,
      correlationId: null,
    });
  });

  it("refuses a url whose path addresses another cid", async () => {
    stubFetch(jsonResponse(201, successBody({ url: `https://cdn.example.test/a/${OTHER_CID}.png` })));
    expect(await upload()).toMatchObject({
      kind: "cid_mismatch",
      reason: "url_does_not_address_cid",
      expectedCid: CID,
    });
  });

  it.each([
    ["a relative url", "/a/x.png"],
    ["a non-https scheme on a public host", `ftp://cdn.example.test/a/${CID}.png`],
    ["a url carrying a query string", `https://cdn.example.test/a/${CID}.png?v=2`],
    ["a path that does not end in the cid", `https://cdn.example.test/a/${CID}.png/thumb`],
    ["a path with no extension", `https://cdn.example.test/a/${CID}`],
  ])("refuses %s", async (_label, url) => {
    stubFetch(jsonResponse(201, successBody({ url })));
    expect(await upload()).toMatchObject({ kind: "cid_mismatch", reason: "url_does_not_address_cid" });
  });

  it("refuses a byte count that does not match the bytes we sent", async () => {
    stubFetch(jsonResponse(201, successBody({ bytes: PNG.byteLength + 1 })));
    expect(await upload()).toMatchObject({ kind: "cid_mismatch", reason: "byte_length_differs" });
  });

  it.each([
    ["missing cid", { cid: undefined }],
    ["cid is not 64 hex", { cid: "abc123" }],
    ["cid is uppercase hex", { cid: CID.toUpperCase() }],
    ["width is zero", { width: 0 }],
    ["height is a string", { height: "512" }],
    ["type is blank", { type: "  " }],
    ["bytes is not a number", { bytes: "10" }],
    ["url is missing", { url: undefined }],
  ])("reads a malformed success body (%s) as invalid, never ok", async (_label, override) => {
    const body = successBody(override);
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) delete body[key];
    }
    stubFetch(jsonResponse(201, body));
    const outcome = await upload();
    expect(outcome.kind).toBe("invalid");
  });
});

describe("uploadAsset - local pre-flight", () => {
  it("sends a body of exactly the cap and refuses one byte more without a request", async () => {
    const atCap = new Uint8Array(MAX_ASSET_BYTES).fill(7);
    const atCapCid = createHash("sha256").update(atCap).digest("hex");
    const mock = stubFetch(
      jsonResponse(201, {
        cid: atCapCid,
        url: `https://cdn.example.test/a/${atCapCid}.png`,
        bytes: MAX_ASSET_BYTES,
        type: "image/png",
        width: 1,
        height: 1,
      }),
    );
    expect(await client().uploadAsset({ ingestToken: TOKEN, bytes: atCap })).toMatchObject({ kind: "ok" });
    expect(mock).toHaveBeenCalledTimes(1);

    const overCap = new Uint8Array(MAX_ASSET_BYTES + 1).fill(7);
    const overMock = stubFetch(jsonResponse(201, successBody()));
    expect(await client().uploadAsset({ ingestToken: TOKEN, bytes: overCap })).toEqual({
      kind: "too_large",
      byteLength: MAX_ASSET_BYTES + 1,
      maxBytes: MAX_ASSET_BYTES,
      correlationId: null,
    });
    expect(overMock).not.toHaveBeenCalled();
  });

  it("refuses zero-length bytes without a request", async () => {
    const mock = stubFetch(jsonResponse(201, successBody()));
    const outcome = await client().uploadAsset({ ingestToken: TOKEN, bytes: new Uint8Array(0) });
    expect(outcome.kind).toBe("invalid");
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("uploadAsset - outcome mapping", () => {
  it.each([
    [401, { error: { code: "unauthorized", message: "unknown token" } }, { kind: "unauthorized" }],
    [400, { error: { code: "validation_failed", message: "bad body" } }, { kind: "invalid" }],
    [400, { error: { code: "unsupported_image", message: "not an image" } }, { kind: "unsupported_image" }],
    [413, { error: { code: "payload_too_large", message: "big" } }, { kind: "too_large", maxBytes: MAX_ASSET_BYTES }],
    [410, { error: { code: "asset_deleted", message: "gone" } }, { kind: "deleted" }],
    [429, { error: { code: "quota_exceeded_count", message: "cap" } }, { kind: "quota_exceeded", axis: "count" }],
    [429, { error: { code: "quota_exceeded_bytes", message: "cap" } }, { kind: "quota_exceeded", axis: "bytes" }],
    [429, { error: { code: "quota_exceeded", message: "cap" } }, { kind: "quota_exceeded", axis: "unknown" }],
    [429, { error: { code: "rate_limited", message: "slow down" } }, { kind: "unavailable", status: 429 }],
    [500, { error: { code: "internal_error", message: "boom" } }, { kind: "unavailable", status: 500 }],
    [418, { error: { code: "teapot", message: "no" } }, { kind: "invalid" }],
  ])("maps %s %o", async (status, body, expected) => {
    stubFetch(jsonResponse(status as number, body));
    expect(await upload()).toMatchObject(expected as Record<string, unknown>);
  });

  it("surfaces Retry-After on a plain 429", async () => {
    stubFetch(jsonResponse(429, { error: { code: "rate_limited" } }, { "retry-after": "30" }));
    expect(await upload()).toMatchObject({ kind: "unavailable", status: 429, retryAfterSeconds: 30 });
  });

  it("maps a network failure and a timeout to unavailable, never a throw", async () => {
    stubFetch(new Error("fetch failed"));
    expect(await upload()).toMatchObject({ kind: "unavailable", status: null, retryAfterSeconds: null });

    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    stubFetch(abort);
    expect(await upload()).toMatchObject({ kind: "unavailable", status: null });
  });
});

describe("uploadAsset - correlation id", () => {
  it("reads the id from the error envelope", async () => {
    stubFetch(jsonResponse(401, { error: { code: "unauthorized", correlationId: "req_01HZ.abc-9" } }));
    expect(await upload()).toMatchObject({ kind: "unauthorized", correlationId: "req_01HZ.abc-9" });
  });

  it("falls back to the x-correlation-id header", async () => {
    stubFetch(jsonResponse(401, { error: { code: "unauthorized" } }, { "x-correlation-id": "hdr-42" }));
    expect(await upload()).toMatchObject({ kind: "unauthorized", correlationId: "hdr-42" });
  });

  it.each([
    ["a number", 12345],
    ["an object", { id: "x" }],
    ["an over-long string", "x".repeat(5000)],
    ["a string with control characters", "req\n drop"],
    ["a string with spaces", "req 42"],
  ])("reads a hostile shape (%s) as null", async (_label, correlationId) => {
    stubFetch(jsonResponse(401, { error: { code: "unauthorized", correlationId } }));
    expect(await upload()).toMatchObject({ kind: "unauthorized", correlationId: null });
  });
});

describe("deleteAsset", () => {
  it("DELETEs the cid at the origin and reports ok", async () => {
    const mock = stubFetch(jsonResponse(200, { cid: CID, status: "deleted" }));
    expect(await client().deleteAsset({ ingestToken: TOKEN, cid: CID })).toEqual({ kind: "ok", cid: CID });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://scan.example.test/v1/assets/${CID}`);
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    [403, { kind: "forbidden" }],
    [404, { kind: "not_found" }],
    [401, { kind: "unauthorized" }],
    [503, { kind: "unavailable", status: 503 }],
    [400, { kind: "invalid" }],
  ])("maps %s", async (status, expected) => {
    stubFetch(jsonResponse(status as number, { error: { code: "x" } }));
    expect(await client().deleteAsset({ ingestToken: TOKEN, cid: CID })).toMatchObject(
      expected as Record<string, unknown>,
    );
  });

  it("refuses a non-hex cid locally, without a request", async () => {
    const mock = stubFetch(jsonResponse(200, { cid: CID, status: "deleted" }));
    const outcome = await client().deleteAsset({ ingestToken: TOKEN, cid: "not-a-cid" });
    expect(outcome.kind).toBe("invalid");
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("secret hygiene", () => {
  const HOSTILE_MESSAGE = `failed for token ${TOKEN} at https://internal.host/admin?key=${TOKEN}`;

  it.each([400, 401, 410, 413, 418, 429, 500])(
    "never leaks the ingest token into a %s detail",
    async (status) => {
      stubFetch(jsonResponse(status, { error: { code: "validation_failed", message: HOSTILE_MESSAGE } }));
      const outcome = await upload();
      const detail = "detail" in outcome ? outcome.detail : "";
      expect(detail).not.toContain(TOKEN);
      expect(detail).not.toContain("https://");
    },
  );

  it("scrubs a url and a token-shaped blob out of a delete detail", async () => {
    stubFetch(jsonResponse(400, { error: { code: HOSTILE_MESSAGE } }));
    const outcome = await client().deleteAsset({ ingestToken: TOKEN, cid: CID });
    expect(outcome.kind).toBe("invalid");
    const detail = "detail" in outcome ? outcome.detail : "";
    expect(detail).not.toContain(TOKEN);
    expect(detail).not.toContain("https://");
    expect(detail).toContain("<url>");
  });

  it("never leaks the token from a network failure detail", async () => {
    stubFetch(new Error(HOSTILE_MESSAGE));
    const outcome = await upload();
    const detail = "detail" in outcome ? outcome.detail : "";
    expect(detail).not.toContain(TOKEN);
    expect(detail).not.toContain("https://");
  });
});

describe("resolveLaunchAssetsPublisher", () => {
  const READY_STATE = {
    agentHash: "c".repeat(64),
    ingestToken: TOKEN,
    registeredAt: "2026-09-01T00:00:00.000Z",
    stoppedReason: null,
  };

  function configWith(url: string): { services: { agentscanApiUrl: string } } {
    return { services: { agentscanApiUrl: url } };
  }

  it("reports agentscan_unconfigured when no usable url is configured", async () => {
    mockLoadConfig.mockReturnValue(configWith("   "));
    expect(await resolveLaunchAssetsPublisher()).toEqual({ kind: "agentscan_unconfigured" });
    expect(mockGetReportingState).not.toHaveBeenCalled();
  });

  it("reports agentscan_unconfigured for a plaintext non-loopback url (the shared policy refuses it)", async () => {
    mockLoadConfig.mockReturnValue(configWith("http://scan.example.test"));
    expect(await resolveLaunchAssetsPublisher()).toEqual({ kind: "agentscan_unconfigured" });
  });

  it.each([
    ["registeredAt is null", { registeredAt: null }],
    ["agentHash is null", { agentHash: null }],
    ["ingestToken is null", { ingestToken: null }],
  ])("reports install_unregistered when %s", async (_label, override) => {
    mockLoadConfig.mockReturnValue(configWith(BASE));
    mockGetReportingState.mockResolvedValue({ ...READY_STATE, ...override });
    expect(await resolveLaunchAssetsPublisher()).toEqual({ kind: "install_unregistered" });
  });

  it("is ready with the credential when the install is registered", async () => {
    mockLoadConfig.mockReturnValue(configWith(BASE));
    mockGetReportingState.mockResolvedValue(READY_STATE);
    const publisher = await resolveLaunchAssetsPublisher();
    expect(publisher).toMatchObject({
      kind: "ready",
      agentHash: READY_STATE.agentHash,
      ingestToken: TOKEN,
    });
  });

  it.each(["consent_revoked", "quarantined", "wallet_conflict"])(
    "is still ready when reporting is stopped (%s)",
    async (stoppedReason) => {
      // DECIDED PRODUCT POINT, pinned deliberately: reporting consent and the
      // ability to host a launch image are independent concerns, and the
      // assets host does not gate on reporting status either. Gating here
      // would silently break launches for a user who merely turned reporting
      // off, so a stopped reporting lane must NOT block publishing.
      mockLoadConfig.mockReturnValue(configWith(BASE));
      mockGetReportingState.mockResolvedValue({ ...READY_STATE, stoppedReason });
      expect(await resolveLaunchAssetsPublisher()).toMatchObject({ kind: "ready" });
    },
  );
});
