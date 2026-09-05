/**
 * `launchpads.image_publish` - the handler that makes a user's bytes PUBLIC.
 *
 * Only three boundaries are faked here: the locker repo, the credential/host
 * resolution (`resolveLaunchAssetsPublisher`), and the byte resolver - and the
 * byte resolver is installed through the REAL registration seam
 * (`registerLaunchImageByteResolver` / `resetLaunchImageByteResolver`), so the
 * fail-closed throw this handler branches on is the production one. The
 * handler itself, its refusal wording and its outcome mapping are real.
 *
 * The four properties worth stating out loud, because each of them is a real
 * failure this suite is here to catch:
 *
 *  1. AN ALREADY-PUBLISHED ROW UPLOADS NOTHING. Re-uploading on every launch
 *     would burn the install's quota and put a second copy of the user's bytes
 *     in flight for no reason. The absence assertions are the contract.
 *  2. EVERY non-ok upload outcome names its REAL cause. `cid_mismatch` in
 *     particular is a security outcome: a message that read like a transient
 *     failure would invite exactly the retry that must never happen.
 *  3. A FAILED FILING DOES NOT LOSE THE URL. The bytes are public the instant
 *     the host answers; reporting a failure there would tell the agent nothing
 *     happened, which is false and invites a second upload.
 *  4. THE SURFACE GUARD IS THE PRIVILEGED EXECUTOR'S OWN RECHECK. Over Studio
 *     MCP the handler refuses before it reads the locker or touches a network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UploadOutcome } from "@vex-agent/agentscan/assets-client.js";
import {
  registerLaunchImageByteResolver,
  resetLaunchImageByteResolver,
  type LaunchImageBytes,
} from "@vex-agent/tools/protocols/shared/launch-image-byte-resolver.js";
import { makeProtocolContext } from "../../_test-context.js";

const getLaunchImage = vi.fn();
const recordPublicAsset = vi.fn();

vi.mock("@vex-agent/db/repos/launch-images.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/db/repos/launch-images.js")>();
  return {
    ...actual,
    getLaunchImage: (imageId: string) => getLaunchImage(imageId),
    recordPublicAsset: (imageId: string, asset: unknown) => recordPublicAsset(imageId, asset),
  };
});

const resolveLaunchAssetsPublisher = vi.fn();

vi.mock("@vex-agent/agentscan/assets-client.js", () => ({
  resolveLaunchAssetsPublisher: () => resolveLaunchAssetsPublisher(),
}));

const { PublicAssetConflictError } = await import("@vex-agent/db/repos/launch-images.js");
const { launchpadsImagePublishHandler } = await import(
  "@vex-agent/tools/protocols/launchpads/handlers/image-publish.js"
);

// ── fixtures ───────────────────────────────────────────────────────────────

/** A secret. It must never appear in any payload this handler returns. */
const INGEST_TOKEN = `tok_${"T".repeat(43)}`;
const CID = "c".repeat(64);
const PUBLIC_URL = `https://cdn.example.test/a/${CID}.png`;
const IMAGE_ID = "img_0123456789abcdef0123456789abcdef";
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42]);

function lockerRow(published: { cid: string; url: string } | null = null) {
  return {
    imageId: IMAGE_ID,
    label: "moon.png",
    byteLength: BYTES.byteLength,
    mime: "image/png",
    width: 320,
    height: 200,
    digest: "d".repeat(64),
    onchainByteLength: null,
    onchainDigest: null,
    uploadedAt: "2026-08-02T12:00:00.000Z",
    publicCid: published?.cid ?? null,
    publicUrl: published?.url ?? null,
    publicUploadedAt: published === null ? null : "2026-08-03T10:00:00.000Z",
  };
}

const OK_OUTCOME: UploadOutcome = {
  kind: "ok",
  cid: CID,
  url: PUBLIC_URL,
  bytes: BYTES.byteLength,
  type: "image/png",
  width: 320,
  height: 200,
  alreadyPublished: false,
};

const uploadAsset = vi.fn();
const deleteAsset = vi.fn();

/** The credential + host, resolved. The token is the secret under test. */
function readyPublisher() {
  return {
    kind: "ready" as const,
    client: { uploadAsset, deleteAsset },
    agentHash: "agent-hash",
    ingestToken: INGEST_TOKEN,
  };
}

/** Bytes served through the REAL resolver seam, counted so absence is provable. */
const resolveBytes = vi.fn<(imageId: string) => Promise<LaunchImageBytes | null>>();

function mountResolver(): void {
  registerLaunchImageByteResolver((imageId) => resolveBytes(imageId));
}

function context(overrides?: Parameters<typeof makeProtocolContext>[0]) {
  return makeProtocolContext(overrides);
}

function parsed(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

/** Every side effect that would mean bytes left the machine, or a record changed. */
function expectNothingUploaded(): void {
  expect(uploadAsset).not.toHaveBeenCalled();
  expect(recordPublicAsset).not.toHaveBeenCalled();
}

beforeEach(() => {
  getLaunchImage.mockReset();
  recordPublicAsset.mockReset();
  resolveLaunchAssetsPublisher.mockReset();
  uploadAsset.mockReset();
  deleteAsset.mockReset();
  resolveBytes.mockReset();
  resolveBytes.mockResolvedValue({ bytes: BYTES, digest: "d".repeat(64) });
  resolveLaunchAssetsPublisher.mockResolvedValue(readyPublisher());
  uploadAsset.mockResolvedValue(OK_OUTCOME);
  recordPublicAsset.mockResolvedValue(lockerRow({ cid: CID, url: PUBLIC_URL }));
});

afterEach(() => {
  // The seam is process-global: leaving it mounted would let the next suite
  // pass on this suite's fake.
  resetLaunchImageByteResolver();
  vi.clearAllMocks();
});

// ── the short circuit that stops a second upload ───────────────────────────

describe("a picture that is already published", () => {
  beforeEach(() => {
    mountResolver();
    getLaunchImage.mockResolvedValue(lockerRow({ cid: CID, url: PUBLIC_URL }));
  });

  it("answers from the locker row with alreadyPublished:true and the recorded URL", async () => {
    const result = await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());

    expect(result.success).toBe(true);
    const data = parsed(result.output);
    expect(data.alreadyPublished).toBe(true);
    expect(data.imageUrl).toBe(PUBLIC_URL);
    expect(data.contentId).toBe(CID);
    expect(data.imageId).toBe(IMAGE_ID);
  });

  it("uploads NOTHING, reads no bytes, and never resolves a credential", async () => {
    await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());

    expectNothingUploaded();
    expect(resolveBytes).not.toHaveBeenCalled();
    expect(resolveLaunchAssetsPublisher).not.toHaveBeenCalled();
  });

  it("still states the public disclosure: the bytes are public whoever published them", async () => {
    const data = parsed((await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context())).output);
    expect(String(data.disclosure)).toMatch(/public/i);
  });
});

// ── the ordinary success ───────────────────────────────────────────────────

describe("a fresh picture", () => {
  beforeEach(() => {
    mountResolver();
    getLaunchImage.mockResolvedValue(lockerRow());
  });

  it("uploads the locker bytes and returns the host's answer", async () => {
    const result = await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());

    expect(result.success).toBe(true);
    const data = parsed(result.output);
    expect(data).toMatchObject({
      imageId: IMAGE_ID,
      imageUrl: PUBLIC_URL,
      contentId: CID,
      alreadyPublished: false,
      byteLength: BYTES.byteLength,
      mime: "image/png",
    });
    expect(String(data.disclosure)).toMatch(/public/i);
    expect(data.warning).toBeUndefined();
  });

  it("sends exactly the resolved bytes with the install's credential", async () => {
    await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());

    expect(resolveBytes).toHaveBeenCalledWith(IMAGE_ID);
    const input = uploadAsset.mock.calls[0]?.[0] as { bytes: Uint8Array; ingestToken: string };
    expect(Array.from(input.bytes)).toEqual(Array.from(BYTES));
    expect(input.ingestToken).toBe(INGEST_TOKEN);
  });

  it("files the address against the locker row only AFTER the host answered", async () => {
    await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());

    expect(recordPublicAsset).toHaveBeenCalledWith(IMAGE_ID, { cid: CID, url: PUBLIC_URL });
  });

  it("reports the host's own alreadyPublished when identical bytes were on the host", async () => {
    uploadAsset.mockResolvedValue({ ...OK_OUTCOME, alreadyPublished: true });

    const data = parsed((await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context())).output);
    expect(data.alreadyPublished).toBe(true);
  });

  it("never echoes the ingest token back to the model", async () => {
    const result = await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());
    expect(result.output).not.toContain(INGEST_TOKEN);
  });
});

// ── the surface guard ──────────────────────────────────────────────────────

describe("the Studio MCP surface", () => {
  it("refuses BY NAME and performs no repo read, no byte read and no upload", async () => {
    mountResolver();
    const result = await launchpadsImagePublishHandler(
      { imageId: IMAGE_ID },
      context({ approvalSurface: "studio_mcp" }),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("launchpads__image_publish");
    expect(result.output).toMatch(/imagePath/);
    expect(getLaunchImage).not.toHaveBeenCalled();
    expect(resolveBytes).not.toHaveBeenCalled();
    expect(resolveLaunchAssetsPublisher).not.toHaveBeenCalled();
    expectNothingUploaded();
  });

  it("runs normally when the surface is the in-app form, and when it is omitted", async () => {
    mountResolver();
    getLaunchImage.mockResolvedValue(lockerRow());

    const omitted = await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());
    const explicit = await launchpadsImagePublishHandler(
      { imageId: IMAGE_ID },
      context({ approvalSurface: "in_app_form" }),
    );

    expect(omitted.success).toBe(true);
    expect(explicit.success).toBe(true);
  });
});

// ── the input ──────────────────────────────────────────────────────────────

describe("the imageId parameter", () => {
  beforeEach(() => {
    mountResolver();
  });

  it.each([
    ["missing", {}],
    ["blank", { imageId: "   " }],
    ["not a string", { imageId: 42 }],
  ])("refuses a %s imageId by name and uploads nothing", async (_label, params) => {
    const result = await launchpadsImagePublishHandler(params, context());

    expect(result.success).toBe(false);
    expect(result.output).toContain("imageId");
    expect(getLaunchImage).not.toHaveBeenCalled();
    expectNothingUploaded();
  });

  it("refuses an unknown imageId by name and points at the listing tool", async () => {
    getLaunchImage.mockResolvedValue(null);

    const result = await launchpadsImagePublishHandler({ imageId: "img_nope" }, context());

    expect(result.success).toBe(false);
    expect(result.output).toContain("img_nope");
    expect(result.output).toContain("launchpads__images_list");
    expectNothingUploaded();
  });

  it("reports an unreadable locker as its own failure, having uploaded nothing", async () => {
    getLaunchImage.mockRejectedValue(new Error("connection refused"));

    const result = await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/image locker could not be read/i);
    expect(result.output).toMatch(/nothing was uploaded/i);
    expectNothingUploaded();
  });
});

// ── the credential and the host ────────────────────────────────────────────

describe("no host to publish to", () => {
  beforeEach(() => {
    mountResolver();
    getLaunchImage.mockResolvedValue(lockerRow());
  });

  it("refuses distinctly when no image host is configured", async () => {
    resolveLaunchAssetsPublisher.mockResolvedValue({ kind: "agentscan_unconfigured" });

    const result = await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/no image host configured/i);
    expect(resolveBytes).not.toHaveBeenCalled();
    expectNothingUploaded();
  });

  it("refuses distinctly when this install holds no accepted credential", async () => {
    resolveLaunchAssetsPublisher.mockResolvedValue({ kind: "install_unregistered" });

    const result = await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/handshake/i);
    expect(resolveBytes).not.toHaveBeenCalled();
    expectNothingUploaded();
  });

  it("gives the two states different reasons: they have different remedies", async () => {
    resolveLaunchAssetsPublisher.mockResolvedValue({ kind: "agentscan_unconfigured" });
    const unconfigured = await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());
    resolveLaunchAssetsPublisher.mockResolvedValue({ kind: "install_unregistered" });
    const unregistered = await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());

    expect(unconfigured.output).not.toBe(unregistered.output);
  });
});

// ── the bytes ──────────────────────────────────────────────────────────────

describe("resolving the bytes", () => {
  beforeEach(() => {
    getLaunchImage.mockResolvedValue(lockerRow());
  });

  it("names an UNMOUNTED resolver as a Vex startup problem, not a locker problem", async () => {
    // No resolver registered: the real seam throws by name.
    const result = await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/image store is not mounted/i);
    expect(result.output).toMatch(/startup problem/i);
    expectNothingUploaded();
  });

  it("distinguishes MISSING BYTES for a row that does have metadata", async () => {
    mountResolver();
    resolveBytes.mockResolvedValue(null);

    const result = await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/bytes are missing/i);
    expect(result.output).toMatch(/re-add the picture/i);
    // Distinct from the unmounted-store refusal above.
    expect(result.output).not.toMatch(/startup problem/i);
    expectNothingUploaded();
  });

  it("reports a resolver failure as its own refusal", async () => {
    mountResolver();
    resolveBytes.mockRejectedValue(new Error("store read failed"));

    const result = await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/could not be read/i);
    expect(result.output).toMatch(/nothing was uploaded/i);
    expectNothingUploaded();
  });
});

// ── every non-ok upload outcome ────────────────────────────────────────────

describe("upload outcomes", () => {
  beforeEach(() => {
    mountResolver();
    getLaunchImage.mockResolvedValue(lockerRow());
  });

  async function refusalFor(outcome: UploadOutcome): Promise<string> {
    uploadAsset.mockResolvedValue(outcome);
    const result = await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());
    expect(result.success).toBe(false);
    expect(recordPublicAsset).not.toHaveBeenCalled();
    expect(result.output).not.toContain(INGEST_TOKEN);
    return result.output;
  }

  it("unauthorized: the install's credential was rejected, and looping will not fix it", async () => {
    const output = await refusalFor({ kind: "unauthorized", correlationId: null });
    expect(output).toMatch(/credential/i);
    expect(output).toMatch(/rather than retrying in a loop/i);
  });

  it("unsupported_image: the USER can fix it by choosing another picture", async () => {
    const output = await refusalFor({
      kind: "unsupported_image",
      detail: "HTTP 400 unsupported_image",
      correlationId: null,
    });
    expect(output).toMatch(/could not read this file as a picture/i);
    expect(output).toMatch(/PNG, JPEG, WebP or GIF/);
  });

  it("too_large: the refusal names both the size and the cap", async () => {
    const output = await refusalFor({
      kind: "too_large",
      byteLength: 3_000_000,
      maxBytes: 2_097_152,
      correlationId: null,
    });
    expect(output).toContain("3000000");
    expect(output).toContain("2097152");
    expect(output).toMatch(/smaller picture/i);
  });

  it("deleted: those bytes are permanently burned, for everyone", async () => {
    const output = await refusalFor({ kind: "deleted", correlationId: null });
    expect(output).toMatch(/withdrawn/i);
    expect(output).toMatch(/never serve it again/i);
  });

  it.each(["count", "bytes"] as const)("quota_exceeded names the %s axis", async (axis) => {
    const output = await refusalFor({ kind: "quota_exceeded", axis, correlationId: null });
    expect(output).toMatch(/quota/i);
    expect(output).toContain(`(${axis})`);
    expect(output).toMatch(/withdraw a picture/i);
  });

  it("quota_exceeded with an unknown axis states the quota without inventing one", async () => {
    const output = await refusalFor({ kind: "quota_exceeded", axis: "unknown", correlationId: null });
    expect(output).toMatch(/quota/i);
    expect(output).not.toContain("(unknown)");
  });

  // A SECURITY OUTCOME. The host answered an address that does not name the
  // bytes Vex sent, so the URL was refused. A message that read like a
  // transient failure would invite the retry that must never happen here.
  it("cid_mismatch: says the URL was REFUSED and tells the agent not to retry", async () => {
    const output = await refusalFor({
      kind: "cid_mismatch",
      reason: "served_cid_differs",
      expectedCid: CID,
      servedCid: "a".repeat(64),
      correlationId: null,
    });
    expect(output).toMatch(/REFUSED/);
    expect(output).toMatch(/does not match the bytes/i);
    expect(output).toMatch(/do not retry/i);
    expect(output).not.toMatch(/try again/i);
  });

  it("invalid: carries the host's own detail and forbids an identical retry", async () => {
    const output = await refusalFor({
      kind: "invalid",
      detail: "HTTP 400 validation_failed",
      correlationId: null,
    });
    expect(output).toContain("HTTP 400 validation_failed");
    expect(output).toMatch(/do not retry the identical call/i);
  });

  it("unavailable without a status is the one outcome worth trying again", async () => {
    const output = await refusalFor({
      kind: "unavailable",
      status: null,
      retryAfterSeconds: null,
      detail: "TypeError: fetch failed",
    });
    expect(output).toMatch(/could not be reached/i);
    expect(output).toMatch(/worth trying again/i);
    expect(output).not.toContain("HTTP");
  });

  it("unavailable names the status when the host gave one", async () => {
    const output = await refusalFor({
      kind: "unavailable",
      status: 503,
      retryAfterSeconds: null,
      detail: "HTTP 503",
    });
    expect(output).toContain("HTTP 503");
  });

  it("unavailable states the host's own retry delay when it gave one", async () => {
    const output = await refusalFor({
      kind: "unavailable",
      status: 429,
      retryAfterSeconds: 30,
      detail: "HTTP 429",
    });
    expect(output).toContain("30s");
  });

  it("every non-ok outcome produces a DISTINCT sentence", async () => {
    const outcomes: UploadOutcome[] = [
      { kind: "unauthorized", correlationId: null },
      { kind: "unsupported_image", detail: "HTTP 400 unsupported_image", correlationId: null },
      { kind: "too_large", byteLength: 3_000_000, maxBytes: 2_097_152, correlationId: null },
      { kind: "deleted", correlationId: null },
      { kind: "quota_exceeded", axis: "count", correlationId: null },
      { kind: "cid_mismatch", reason: "served_cid_differs", expectedCid: CID, servedCid: "a".repeat(64), correlationId: null },
      { kind: "invalid", detail: "HTTP 400 validation_failed", correlationId: null },
      { kind: "unavailable", status: 503, retryAfterSeconds: null, detail: "HTTP 503" },
    ];
    const messages: string[] = [];
    for (const outcome of outcomes) messages.push(await refusalFor(outcome));

    expect(new Set(messages).size).toBe(outcomes.length);
  });
});

// ── the filing failure that must NOT lose the URL ──────────────────────────

describe("the address could not be filed against the locker row", () => {
  beforeEach(() => {
    mountResolver();
    getLaunchImage.mockResolvedValue(lockerRow());
  });

  it("is a SUCCESS carrying the real URL plus a warning: the bytes are already public", async () => {
    recordPublicAsset.mockRejectedValue(new Error("connection refused"));

    const result = await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());

    expect(result.success).toBe(true);
    const data = parsed(result.output);
    expect(data.imageUrl).toBe(PUBLIC_URL);
    expect(data.contentId).toBe(CID);
    expect(String(data.warning)).toMatch(/could not record the address/i);
    expect(String(data.warning)).toMatch(/publishing\s+again would return the same one/i);
    expect(String(data.disclosure)).toMatch(/public/i);
    expect(result.output).not.toContain(INGEST_TOKEN);
  });

  it("does the same for a PublicAssetConflictError, which is a hard refusal to overwrite", async () => {
    recordPublicAsset.mockRejectedValue(
      new PublicAssetConflictError(IMAGE_ID, `launch_images: ${IMAGE_ID} already records a different publication`),
    );

    const result = await launchpadsImagePublishHandler({ imageId: IMAGE_ID }, context());

    expect(result.success).toBe(true);
    const data = parsed(result.output);
    expect(data.imageUrl).toBe(PUBLIC_URL);
    expect(String(data.warning)).toMatch(/could not record the address/i);
  });
});
