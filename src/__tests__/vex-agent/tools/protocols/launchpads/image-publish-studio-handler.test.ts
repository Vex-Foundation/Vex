/**
 * `launchpads.image_publish` on the VEX STUDIO MCP surface - a file in the
 * agent's own project becomes a permanent public URL.
 *
 * The subject is a MODEL-SUPPLIED PATH reaching a filesystem sink and then a
 * public host, so this suite uses a REAL temp project root with REAL files and
 * a REAL symbolic link, in the style of the no-follow suite the handler leans
 * on. A mocked `fs` would only prove our branches call our branches. Three
 * boundaries are faked and nothing else: the project-root lookup (a database
 * read), the locker repo (a database write), and the host client - and every
 * refusal case asserts that NO upload and NO row happened, because "refused"
 * and "refused after the bytes left the machine" are not the same outcome.
 *
 * The properties worth stating out loud:
 *
 *  1. THE APPROVAL COMES FIRST. The card is raised by the manifest's own
 *     classification, on this surface exactly as in the app, and it is raised
 *     BEFORE the handler reads a single byte off disk.
 *  2. CONTAINMENT IS THE READER'S, and it holds: outside the root, a symlink,
 *     an oversized file and a non-image are each refused BY NAME with nothing
 *     uploaded.
 *  3. THE WRONG SURFACE'S PARAMETER IS REFUSED BY NAME, both directions.
 *  4. ALREADY PUBLIC BY CONTENT COSTS NOTHING: the content id is derived
 *     locally, so a second call for the same bytes uploads nothing.
 *  5. THE BYTES ARE PUBLIC THE INSTANT THE HOST ANSWERS. A record that could
 *     not be written is a warning on a SUCCESS, never a failure that would
 *     invite a second upload.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UploadOutcome } from "@vex-agent/agentscan/assets-client.js";
import { evaluateApprovalGate } from "@vex-agent/tools/protocols/runtime/gates.js";
import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";
import { makeProtocolContext } from "../../_test-context.js";

const resolveProjectRootPath = vi.fn();

vi.mock("@vex-agent/mcp/project-root.js", () => ({
  resolveProjectRootPath: (projectId: string) => resolveProjectRootPath(projectId),
}));

const getLaunchImage = vi.fn();
const findLaunchImageByPublicCid = vi.fn();
const insertLaunchImage = vi.fn();
const recordPublicAsset = vi.fn();

vi.mock("@vex-agent/db/repos/launch-images.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/db/repos/launch-images.js")>();
  return {
    ...actual,
    getLaunchImage: (imageId: string) => getLaunchImage(imageId),
    findLaunchImageByPublicCid: (cid: string) => findLaunchImageByPublicCid(cid),
    insertLaunchImage: (input: unknown) => insertLaunchImage(input),
    recordPublicAsset: (imageId: string, asset: unknown) => recordPublicAsset(imageId, asset),
  };
});

const resolveLaunchAssetsPublisher = vi.fn();

vi.mock("@vex-agent/agentscan/assets-client.js", () => ({
  resolveLaunchAssetsPublisher: () => resolveLaunchAssetsPublisher(),
}));

const { launchpadsImagePublishHandler } = await import(
  "@vex-agent/tools/protocols/launchpads/handlers/image-publish.js"
);

// ── fixtures ───────────────────────────────────────────────────────────────

/** A secret. It must never appear in any payload this handler returns. */
const INGEST_TOKEN = `tok_${"T".repeat(43)}`;
const PROJECT_ID = "proj_studio_1";

/** A real, minimal PNG: the 8-byte signature is what the reader sniffs. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const PNG_CID = createHash("sha256").update(PNG_BYTES).digest("hex");
const PNG_URL = `https://cdn.example.test/a/${PNG_CID}.png`;

/** A real GIF header. The reader sniffs it; the locker's table has no room for it. */
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);

const uploadAsset = vi.fn();
const deleteAsset = vi.fn();

function readyPublisher() {
  return {
    kind: "ready" as const,
    client: { uploadAsset, deleteAsset },
    agentHash: "agent-hash",
    ingestToken: INGEST_TOKEN,
  };
}

function okOutcome(): UploadOutcome {
  return {
    kind: "ok",
    cid: PNG_CID,
    url: PNG_URL,
    bytes: PNG_BYTES.byteLength,
    type: "image/png",
    width: 640,
    height: 480,
    alreadyPublished: false,
  };
}

let root = "";

function studio(overrides?: Record<string, unknown>) {
  return makeProtocolContext({
    approvalSurface: "studio_mcp",
    studioProjectId: PROJECT_ID,
    ...overrides,
  });
}

function parsed(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

/** Every side effect that would mean bytes left the machine, or a record changed. */
function expectNothingPublished(): void {
  expect(uploadAsset).not.toHaveBeenCalled();
  expect(insertLaunchImage).not.toHaveBeenCalled();
  expect(recordPublicAsset).not.toHaveBeenCalled();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vex-image-publish-"));
  await fs.writeFile(path.join(root, "logo.png"), PNG_BYTES);
  resolveProjectRootPath.mockReset();
  resolveProjectRootPath.mockResolvedValue({ kind: "ok", rootPath: root });
  getLaunchImage.mockReset();
  findLaunchImageByPublicCid.mockReset();
  findLaunchImageByPublicCid.mockResolvedValue(null);
  insertLaunchImage.mockReset();
  insertLaunchImage.mockImplementation(async (input: Record<string, unknown>) => input);
  recordPublicAsset.mockReset();
  recordPublicAsset.mockResolvedValue({});
  resolveLaunchAssetsPublisher.mockReset();
  resolveLaunchAssetsPublisher.mockResolvedValue(readyPublisher());
  uploadAsset.mockReset();
  uploadAsset.mockResolvedValue(okOutcome());
  deleteAsset.mockReset();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ── the approval, which is the whole reason this tool exists ───────────────

describe("the approval card on the Studio surface", () => {
  it("is raised for this tool under a restricted project, before the handler runs", () => {
    const manifest = getProtocolManifest("launchpads.image_publish");
    if (manifest === undefined) throw new Error("launchpads.image_publish has no manifest");

    const pending = evaluateApprovalGate(
      manifest,
      { toolId: "launchpads.image_publish" },
      { imagePath: "logo.png" },
      studio({ sessionPermission: "restricted", approved: false }),
      // Every prequote channel absent: this tool has no quote, no fee preview
      // and no safety verdict - what raises the card is its own classification.
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
    );

    expect(pending?.pendingApproval).toBe(true);
    expectNothingPublished();
  });

  it("classifies the act as an external post that mutates, on both surfaces alike", () => {
    const manifest = getProtocolManifest("launchpads.image_publish");
    expect(manifest?.mutating).toBe(true);
    expect(manifest?.actionKind).toBe("external_post");
  });

  it("states the public consequence in the text a human and a model both read", () => {
    const manifest = getProtocolManifest("launchpads.image_publish");
    expect(manifest?.description).toContain("THE BYTES BECOME PUBLIC");
    expect(manifest?.description).toContain("imagePath");
  });
});

// ── the ordinary Studio success ────────────────────────────────────────────

describe("publishing a project file", () => {
  it("uploads exactly the file's bytes with the install's credential", async () => {
    const result = await launchpadsImagePublishHandler({ imagePath: "logo.png" }, studio());

    expect(result.success).toBe(true);
    const input = uploadAsset.mock.calls[0]?.[0] as { bytes: Uint8Array; ingestToken: string };
    expect(Array.from(input.bytes)).toEqual(Array.from(PNG_BYTES));
    expect(input.ingestToken).toBe(INGEST_TOKEN);
  });

  it("returns the content-addressed URL, the cid and the public disclosure", async () => {
    const data = parsed(
      (await launchpadsImagePublishHandler({ imagePath: "logo.png" }, studio())).output,
    );

    expect(data).toMatchObject({
      imageUrl: PNG_URL,
      contentId: PNG_CID,
      alreadyPublished: false,
      byteLength: PNG_BYTES.byteLength,
      mime: "image/png",
      imagePath: "logo.png",
    });
    expect(String(data.disclosure)).toMatch(/public/i);
    expect(data.warning).toBeUndefined();
  });

  it("records the publication as a launch_images row whose digest IS the content id", async () => {
    const data = parsed(
      (await launchpadsImagePublishHandler({ imagePath: "logo.png" }, studio())).output,
    );

    const written = insertLaunchImage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written).toMatchObject({
      label: "logo.png",
      byteLength: PNG_BYTES.byteLength,
      mime: "image/png",
      width: 640,
      height: 480,
      digest: PNG_CID,
      onchainByteLength: null,
      onchainDigest: null,
    });
    expect(String(written.imageId)).toMatch(/^img_[0-9a-f]{32}$/);
    expect(data.imageId).toBe(written.imageId);
    expect(recordPublicAsset).toHaveBeenCalledWith(written.imageId, {
      cid: PNG_CID,
      url: PNG_URL,
    });
  });

  it("files the address only AFTER the host answered", async () => {
    const order: string[] = [];
    uploadAsset.mockImplementation(async () => {
      order.push("upload");
      return okOutcome();
    });
    insertLaunchImage.mockImplementation(async (input: Record<string, unknown>) => {
      order.push("insert");
      return input;
    });
    recordPublicAsset.mockImplementation(async () => {
      order.push("record");
      return {};
    });

    await launchpadsImagePublishHandler({ imagePath: "logo.png" }, studio());

    expect(order).toEqual(["upload", "insert", "record"]);
  });

  it("accepts an absolute path inside the project and shows the relative one", async () => {
    const data = parsed(
      (
        await launchpadsImagePublishHandler(
          { imagePath: path.join(root, "logo.png") },
          studio(),
        )
      ).output,
    );

    // The absolute path is never echoed: it would reveal the user's directory
    // layout to the model, and the approval card shows the relative one.
    expect(data.imagePath).toBe("logo.png");
    expect(String(data.imagePath)).not.toContain(root);
  });

  it("never echoes the ingest token back to the model", async () => {
    const result = await launchpadsImagePublishHandler({ imagePath: "logo.png" }, studio());
    expect(result.output).not.toContain(INGEST_TOKEN);
  });
});

// ── already public, by content ─────────────────────────────────────────────

describe("bytes this install already published", () => {
  beforeEach(() => {
    findLaunchImageByPublicCid.mockResolvedValue({
      imageId: "img_0123456789abcdef0123456789abcdef",
      label: "logo.png",
      byteLength: PNG_BYTES.byteLength,
      mime: "image/png",
      width: 640,
      height: 480,
      digest: PNG_CID,
      onchainByteLength: null,
      onchainDigest: null,
      uploadedAt: "2026-09-01T10:00:00.000Z",
      publicCid: PNG_CID,
      publicUrl: PNG_URL,
      publicUploadedAt: "2026-09-01T10:00:01.000Z",
    });
  });

  it("answers from the record with alreadyPublished:true and the same URL", async () => {
    const data = parsed(
      (await launchpadsImagePublishHandler({ imagePath: "logo.png" }, studio())).output,
    );

    expect(data.alreadyPublished).toBe(true);
    expect(data.imageUrl).toBe(PNG_URL);
    expect(data.contentId).toBe(PNG_CID);
    expect(data.imageId).toBe("img_0123456789abcdef0123456789abcdef");
    expect(String(data.disclosure)).toMatch(/public/i);
  });

  it("looks the record up by the LOCALLY derived content id, and uploads nothing", async () => {
    await launchpadsImagePublishHandler({ imagePath: "logo.png" }, studio());

    expect(findLaunchImageByPublicCid).toHaveBeenCalledWith(PNG_CID);
    expect(uploadAsset).not.toHaveBeenCalled();
    expect(insertLaunchImage).not.toHaveBeenCalled();
    expect(resolveLaunchAssetsPublisher).not.toHaveBeenCalled();
  });
});

// ── containment: every refusal, and nothing uploaded ───────────────────────

describe("a path the reader refuses", () => {
  it("refuses a path outside the project without naming the resolved location", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vex-outside-"));
    await fs.writeFile(path.join(outside, "secret.png"), PNG_BYTES);
    try {
      const result = await launchpadsImagePublishHandler(
        { imagePath: path.join(outside, "secret.png") },
        studio(),
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("outside this project");
      expect(result.output).toContain("Nothing was uploaded");
      expect(result.output).not.toContain(outside);
      expectNothingPublished();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a symbolic link rather than following it", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vex-outside-"));
    await fs.writeFile(path.join(outside, "secret.png"), PNG_BYTES);
    await fs.symlink(path.join(outside, "secret.png"), path.join(root, "link.png"));
    try {
      const result = await launchpadsImagePublishHandler({ imagePath: "link.png" }, studio());

      expect(result.success).toBe(false);
      expect(result.output).toMatch(/symbolic link/i);
      expect(result.output).toContain("Nothing was uploaded");
      expectNothingPublished();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a file over the byte ceiling, from its size and not from its bytes", async () => {
    const big = Buffer.alloc(2_097_153, 1);
    PNG_BYTES.forEach((byte, index) => {
      big[index] = byte;
    });
    await fs.writeFile(path.join(root, "huge.png"), big);

    const result = await launchpadsImagePublishHandler({ imagePath: "huge.png" }, studio());

    expect(result.success).toBe(false);
    expect(result.output).toContain("2097152");
    expect(result.output).toContain("Nothing was uploaded");
    expectNothingPublished();
  });

  it("refuses a file that is not an image, whatever its extension claims", async () => {
    await fs.writeFile(path.join(root, "notes.png"), "these are not pixels");

    const result = await launchpadsImagePublishHandler({ imagePath: "notes.png" }, studio());

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/not a PNG, JPEG, WebP, or GIF/);
    expect(result.output).toContain("Nothing was uploaded");
    expectNothingPublished();
  });

  it("refuses a missing file", async () => {
    const result = await launchpadsImagePublishHandler({ imagePath: "absent.png" }, studio());

    expect(result.success).toBe(false);
    expect(result.output).toContain("No file exists at that path");
    expectNothingPublished();
  });

  it("refuses a GIF BY NAME, before the upload, because the record cannot hold one", async () => {
    await fs.writeFile(path.join(root, "spin.gif"), GIF_BYTES);

    const result = await launchpadsImagePublishHandler({ imagePath: "spin.gif" }, studio());

    expect(result.success).toBe(false);
    expect(result.output).toContain("GIF");
    expect(result.output).toMatch(/PNG, JPEG or WebP/);
    expect(result.output).toContain("Nothing was uploaded");
    expectNothingPublished();
  });

  it("refuses when the call carries no Studio project at all", async () => {
    const result = await launchpadsImagePublishHandler(
      { imagePath: "logo.png" },
      makeProtocolContext({ approvalSurface: "studio_mcp" }),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Nothing was uploaded");
    expectNothingPublished();
  });
});

// ── the per-surface parameter table ────────────────────────────────────────

describe("the parameter each surface accepts", () => {
  it("refuses imageId BY NAME on the Studio surface, and says to pass imagePath", async () => {
    const result = await launchpadsImagePublishHandler(
      { imageId: "img_0123456789abcdef0123456789abcdef" },
      studio(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain('"imageId" is not accepted here');
    expect(result.output).toContain("imagePath");
    expect(result.output).toContain("Nothing was uploaded");
    expect(getLaunchImage).not.toHaveBeenCalled();
    expectNothingPublished();
  });

  it("refuses imagePath BY NAME in the Vex app, and says to pass imageId", async () => {
    const result = await launchpadsImagePublishHandler(
      { imagePath: "logo.png" },
      makeProtocolContext(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain('"imagePath" is not accepted here');
    expect(result.output).toContain("launchpads__images_list");
    expect(result.output).toContain("Nothing was uploaded");
    expect(resolveProjectRootPath).not.toHaveBeenCalled();
    expectNothingPublished();
  });

  it("names the missing parameter per surface when neither is given", async () => {
    const onStudio = await launchpadsImagePublishHandler({}, studio());
    const inApp = await launchpadsImagePublishHandler({}, makeProtocolContext());

    expect(onStudio.output).toContain('"imagePath" is required');
    expect(inApp.output).toContain('"imageId" is required');
    expectNothingPublished();
  });
});

// ── after the bytes are public ─────────────────────────────────────────────

describe("a publication Vex could not record", () => {
  it("still returns the URL, with imageId null and a warning, when the row cannot be inserted", async () => {
    insertLaunchImage.mockRejectedValue(new Error("db down"));

    const result = await launchpadsImagePublishHandler({ imagePath: "logo.png" }, studio());

    expect(result.success).toBe(true);
    const data = parsed(result.output);
    expect(data.imageUrl).toBe(PNG_URL);
    expect(data.imageId).toBeNull();
    // The scrubbed cause is CARRIED, not swallowed: the agent must be able to
    // tell "the picture is public but unrecorded" from a failed publish.
    expect(String(data.warning)).toMatch(/published successfully/);
    expect(String(data.warning)).toContain("db down");
  });

  it("still returns the URL, with the id and a warning, when the address cannot be filed", async () => {
    recordPublicAsset.mockRejectedValue(new Error("db down"));

    const result = await launchpadsImagePublishHandler({ imagePath: "logo.png" }, studio());

    expect(result.success).toBe(true);
    const data = parsed(result.output);
    expect(data.imageUrl).toBe(PNG_URL);
    expect(String(data.imageId)).toMatch(/^img_[0-9a-f]{32}$/);
    expect(String(data.warning)).toMatch(/published successfully/);
  });
});

// ── the host's own failures, on this surface ───────────────────────────────

describe("a host that will not take the picture", () => {
  it("names an unconfigured host and writes no record", async () => {
    resolveLaunchAssetsPublisher.mockResolvedValue({ kind: "agentscan_unconfigured" });

    const result = await launchpadsImagePublishHandler({ imagePath: "logo.png" }, studio());

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/no image host configured/i);
    expectNothingPublished();
  });

  it("names an install that has not handshaken yet", async () => {
    resolveLaunchAssetsPublisher.mockResolvedValue({ kind: "install_unregistered" });

    const result = await launchpadsImagePublishHandler({ imagePath: "logo.png" }, studio());

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/handshake/i);
    expect(insertLaunchImage).not.toHaveBeenCalled();
  });

  it("REFUSES a host whose answer does not address the bytes that were read", async () => {
    uploadAsset.mockResolvedValue({ ...okOutcome(), cid: "e".repeat(64) });

    const result = await launchpadsImagePublishHandler({ imagePath: "logo.png" }, studio());

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/does not match the bytes/);
    expect(result.output).toMatch(/Do not retry/);
    expect(insertLaunchImage).not.toHaveBeenCalled();
    expect(recordPublicAsset).not.toHaveBeenCalled();
  });

  it("names a quota refusal and writes no record", async () => {
    uploadAsset.mockResolvedValue({ kind: "quota_exceeded", axis: "bytes", correlationId: null });

    const result = await launchpadsImagePublishHandler({ imagePath: "logo.png" }, studio());

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/quota/i);
    expect(insertLaunchImage).not.toHaveBeenCalled();
  });
});
