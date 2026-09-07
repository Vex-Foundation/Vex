/**
 * A Studio agent launches a Virtuals agent with a picture it ALREADY published.
 *
 * Lane D closed the hole where the launch lane published project bytes itself,
 * and closed it by refusing every `imagePath`. That refusal was honest and it
 * also closed the product path: an external coding agent could never launch a
 * Virtuals agent at all. Lane G reopened the front door - `launchpads__image_publish`
 * now takes an `imagePath` on the Studio surface, asks the consent question
 * there, and records the publication as a `launch_images` row whose `public_cid`
 * is the sha256 of exactly those bytes.
 *
 * So this lane's job is RETRIEVAL, never publication: read the file through the
 * same contained reader, hash the bytes with the same content-address function
 * the publish tool uses, and ask our own record whether those exact bytes are
 * already public. A hit is the launch's picture. A miss is a refusal that names
 * the publishing tool and the caller's own path - never an upload.
 *
 * The shape is `github-mcp-server`'s `create_or_update_file`: a write against
 * content the caller does not prove they have seen is refused, and the refusal
 * carries the exact command that produces the missing hash. Here the missing
 * step is a consent decision rather than a stale-write check, which is why the
 * remedy names a tool and not a flag.
 *
 * WHY REAL FILES. The subject is a MODEL-SUPPLIED PATH reaching a filesystem
 * sink, so this suite uses a real temp project root with real files and a real
 * symbolic link, in the style of the Lane G Studio suite. Three boundaries are
 * faked and nothing else: the project-root lookup, the locker repo, and the
 * asset publisher - which is faked ONLY so every case can assert it was never
 * reached.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Address, type Hex } from "viem";

import { virtualsCurveDeployment } from "@tools/virtuals/curve/index.js";
import { publicClientDouble } from "../../../../_test-evm-clients.js";
import { definedValue } from "../../../../_test-value-guards.js";
import { makeProtocolContext } from "../../_test-context.js";

const resolveProjectRootPath = vi.fn();

vi.mock("@vex-agent/mcp/project-root.js", () => ({
  resolveProjectRootPath: (projectId: string) => resolveProjectRootPath(projectId),
}));

const getLaunchImage = vi.fn();
const findLaunchImageByPublicCid = vi.fn();

vi.mock("@vex-agent/db/repos/launch-images.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/db/repos/launch-images.js")>();
  return {
    ...actual,
    getLaunchImage: (imageId: string) => getLaunchImage(imageId),
    findLaunchImageByPublicCid: (cid: string) => findLaunchImageByPublicCid(cid),
  };
});

/**
 * The publisher, faked only to be watched. Every assertion below is that this
 * lane NEVER reaches it: "refused" and "refused after the bytes left the
 * machine" are not the same outcome, and the second one is the defect the
 * 2026-09-06 final review found.
 */
const resolveLaunchAssetsPublisher = vi.fn();
const uploadAsset = vi.fn();

vi.mock("@vex-agent/agentscan/assets-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/agentscan/assets-client.js")>();
  return {
    ...actual,
    resolveLaunchAssetsPublisher: () => resolveLaunchAssetsPublisher(),
  };
});

/**
 * The wallet INVENTORY, faked to one address. Nothing in this suite is about
 * which key is selected, and the real resolver reads a keystore this process
 * has no business opening; every case below runs with the same address so a
 * refusal can only ever be about the picture.
 */
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@vex-agent/tools/internal/wallet/resolve.js")
  >();
  return { ...actual, resolveSelectedAddress: () => WALLET };
});

const getVirtualsCurvePublicClient = vi.fn();

vi.mock("@tools/virtuals/curve/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tools/virtuals/curve/index.js")>();
  return {
    ...actual,
    getVirtualsCurvePublicClient: () => getVirtualsCurvePublicClient(),
  };
});

const createLaunchPreviewIntent = vi.fn();

vi.mock("@vex-agent/tools/protocols/virtuals/handlers/launch/intent.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@vex-agent/tools/protocols/virtuals/handlers/launch/intent.js")
  >();
  return {
    ...actual,
    createLaunchPreviewIntent: (input: unknown) => createLaunchPreviewIntent(input),
  };
});

const { resolveLaunchImage } = await import(
  "@vex-agent/tools/protocols/virtuals/handlers/launch/image.js"
);
const { virtualsLaunchPreview } = await import(
  "@vex-agent/tools/protocols/virtuals/handlers/launch-preview.js"
);
const { virtualsLaunchExecute } = await import(
  "@vex-agent/tools/protocols/virtuals/handlers/launch-execute.js"
);

// ── fixtures ───────────────────────────────────────────────────────────────

const PROJECT_ID = "proj_studio_1";
const WALLET = getAddress("0x33Ef6673bd80CB11fCc41B82BC2181e65cc4D2fa");
const BASE = definedValue(virtualsCurveDeployment("base"), "the Base Virtuals deployment");

/** A real, minimal PNG: the 8-byte signature is what the reader sniffs. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
/** The content id the publish tool derived for these exact bytes. */
const PNG_CID = createHash("sha256").update(PNG_BYTES).digest("hex");
const PNG_URL = `https://cdn.example.test/a/${PNG_CID}.png`;

/** The row `launchpads__image_publish` writes on the Studio surface. */
function publishedRow() {
  return {
    imageId: "img_studio_1",
    label: "assets/agent.png",
    byteLength: PNG_BYTES.byteLength,
    mime: "image/png",
    width: 640,
    height: 480,
    digest: PNG_CID,
    onchainByteLength: null,
    onchainDigest: null,
    publicCid: PNG_CID,
    publicUrl: PNG_URL,
    publicUploadedAt: new Date("2026-09-06T00:00:00.000Z"),
    createdAt: new Date("2026-09-06T00:00:00.000Z"),
  };
}

let root = "";

function studio(overrides?: Record<string, unknown>) {
  return makeProtocolContext({
    sessionId: "s-1",
    sessionPermission: "full",
    approved: true,
    approvalSurface: "studio_mcp",
    studioProjectId: PROJECT_ID,
    ...overrides,
  });
}

function launchParams(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    chain: "base",
    name: "Otaku Analyst",
    symbol: "OTAKU",
    description: "reads anime sentiment",
    cores: ["0", "1", "2"],
    amountIn: "1",
    imagePath: "assets/agent.png",
    ...overrides,
  };
}

/** The EIP-1967 slot word for one implementation address. */
function slotWord(implementation: Address): Hex {
  return `0x${"0".repeat(24)}${implementation.slice(2)}`;
}

/** The repo's own scripted double, at one pinned block. */
function chainDouble() {
  return publicClientDouble({
    getBlockNumber: async () => 50_870_256n,
    getBlock: async () => ({ timestamp: 1_788_600_000n }),
    getStorageAt: async ({ address }: { address: Address }): Promise<Hex> =>
      getAddress(address) === getAddress(BASE.bondingV5)
        ? slotWord(getAddress(BASE.implementations.bondingV5))
        : slotWord(getAddress(BASE.implementations.frouterV3)),
    call: async () => ({ data: "0x" as Hex }),
    readContract: async ({ functionName }: { functionName: string }): Promise<unknown> => {
      switch (functionName) {
        case "bondingConfig": return getAddress(BASE.bondingConfig);
        case "router": return getAddress(BASE.frouterV3);
        case "calculateLaunchFee": return 0n;
        case "getScheduledLaunchParams":
          return { startTimeDelay: 86_400n, normalLaunchFee: 0n, acfFee: 10_000_000_000_000_000_000n };
        case "feeTo": return getAddress("0x86CbAC9d9Ac726F729eEf6627Dc4817BcBB03A9c");
        case "initialSupply": return 1_000_000_000n;
        case "decimals": return 18;
        case "balanceOf": return 10_000_000_000_000_000_000n;
        case "allowance": return 0n;
        default: throw new Error(`this test double has no script for the read ${functionName}`);
      }
    },
  }, BASE.chainId);
}

function parsed(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

/** The one side effect that would mean project bytes left the machine. */
function expectNothingUploaded(): void {
  expect(resolveLaunchAssetsPublisher).not.toHaveBeenCalled();
  expect(uploadAsset).not.toHaveBeenCalled();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vex-virtuals-launch-"));
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(path.join(root, "assets", "agent.png"), PNG_BYTES);
  resolveProjectRootPath.mockReset();
  resolveProjectRootPath.mockResolvedValue({ kind: "ok", rootPath: root });
  getLaunchImage.mockReset();
  findLaunchImageByPublicCid.mockReset();
  findLaunchImageByPublicCid.mockResolvedValue(null);
  resolveLaunchAssetsPublisher.mockReset();
  uploadAsset.mockReset();
  getVirtualsCurvePublicClient.mockReset();
  getVirtualsCurvePublicClient.mockImplementation(() => chainDouble());
  createLaunchPreviewIntent.mockReset();
  createLaunchPreviewIntent.mockResolvedValue("prev_1");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ── the published project file, which is the whole point of the lane ───────

describe("a Studio imagePath whose bytes are already published", () => {
  it("resolves to the recorded public URL and content id, uploading nothing", async () => {
    findLaunchImageByPublicCid.mockResolvedValue(publishedRow());

    const result = await resolveLaunchImage({
      params: { imagePath: "assets/agent.png" },
      context: studio(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.url).toBe(PNG_URL);
    expect(result.image.cid).toBe(PNG_CID);
    expect(result.image.imageId).toBe("img_studio_1");
    // The project-relative path, never the absolute one: the label is shown to
    // a person and read by the model, and neither needs the user's disk layout.
    expect(result.image.label).toBe("assets/agent.png");
    expect(result.image.label).not.toContain(root);
    expectNothingUploaded();
  });

  it("asks the record for the sha256 of the FILE'S OWN bytes", async () => {
    findLaunchImageByPublicCid.mockResolvedValue(publishedRow());

    await resolveLaunchImage({ params: { imagePath: "assets/agent.png" }, context: studio() });

    expect(findLaunchImageByPublicCid).toHaveBeenCalledWith(PNG_CID);
  });

  it("refuses when the file's bytes changed after publication", async () => {
    // The row exists for the OLD bytes; this file now hashes to something else,
    // so the lookup misses. A launch must never point at an address that does
    // not hold the bytes on disk.
    await fs.writeFile(
      path.join(root, "assets", "agent.png"),
      new Uint8Array([...PNG_BYTES, 0x01, 0x02]),
    );

    const result = await resolveLaunchImage({
      params: { imagePath: "assets/agent.png" },
      context: studio(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("launchpads__image_publish");
    expectNothingUploaded();
  });
});

// ── the unpublished file: a refusal that names the next step ───────────────

describe("a Studio imagePath that was never published", () => {
  it("refuses by name, quoting the caller's own path, and uploads nothing", async () => {
    const result = await resolveLaunchImage({
      params: { imagePath: "./assets/agent.png" },
      context: studio(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("launchpads__image_publish");
    // The path AS THE AGENT GAVE IT, so the remedy is a call it can make
    // verbatim - and never the resolved absolute path, which would hand the
    // model the user's directory layout.
    expect(result.reason).toContain('"./assets/agent.png"');
    expect(result.reason).not.toContain(root);
    expect(result.reason).toContain("imagePath");
    expectNothingUploaded();
  });

  it("refuses when the record itself cannot be read, rather than assuming unpublished", async () => {
    findLaunchImageByPublicCid.mockRejectedValue(new Error("connection terminated"));

    const result = await resolveLaunchImage({
      params: { imagePath: "assets/agent.png" },
      context: studio(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Nothing was signed");
    expectNothingUploaded();
  });

  it("refuses a row recorded without a public address", async () => {
    findLaunchImageByPublicCid.mockResolvedValue({
      ...publishedRow(),
      publicCid: null,
      publicUrl: null,
    });

    const result = await resolveLaunchImage({
      params: { imagePath: "assets/agent.png" },
      context: studio(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("launchpads__image_publish");
    expectNothingUploaded();
  });
});

// ── containment stays the reader's, and it still holds ─────────────────────

describe("containment is the no-follow reader's, on this lane exactly as on publish", () => {
  it("refuses a path outside the project by name", async () => {
    const result = await resolveLaunchImage({
      params: { imagePath: "../outside.png" },
      context: studio(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("outside this project");
    expect(findLaunchImageByPublicCid).not.toHaveBeenCalled();
    expectNothingUploaded();
  });

  it("refuses a symbolic link by name and never follows it", async () => {
    const outside = path.join(os.tmpdir(), `vex-outside-${process.pid}.png`);
    await fs.writeFile(outside, PNG_BYTES);
    await fs.symlink(outside, path.join(root, "assets", "linked.png"));

    const result = await resolveLaunchImage({
      params: { imagePath: "assets/linked.png" },
      context: studio(),
    });

    await fs.rm(outside, { force: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("symbolic link");
    expect(findLaunchImageByPublicCid).not.toHaveBeenCalled();
    expectNothingUploaded();
  });

  it("refuses a file that is not an image by name", async () => {
    await fs.writeFile(path.join(root, "assets", "notes.png"), "plain text, not a picture");

    const result = await resolveLaunchImage({
      params: { imagePath: "assets/notes.png" },
      context: studio(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(findLaunchImageByPublicCid).not.toHaveBeenCalled();
    expectNothingUploaded();
  });

  it("refuses a file past the byte ceiling by name", async () => {
    const { NO_FOLLOW_IMAGE_MAX_BYTES } = await import(
      "@vex-agent/studio/files/no-follow-open.js"
    );
    const oversized = new Uint8Array(NO_FOLLOW_IMAGE_MAX_BYTES + 1);
    oversized.set(PNG_BYTES, 0);
    await fs.writeFile(path.join(root, "assets", "huge.png"), oversized);

    const result = await resolveLaunchImage({
      params: { imagePath: "assets/huge.png" },
      context: studio(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("limit is");
    expect(findLaunchImageByPublicCid).not.toHaveBeenCalled();
    expectNothingUploaded();
  });

  it("refuses when the dispatch carries no Studio project at all", async () => {
    const result = await resolveLaunchImage({
      params: { imagePath: "assets/agent.png" },
      context: studio({ studioProjectId: undefined }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(findLaunchImageByPublicCid).not.toHaveBeenCalled();
    expectNothingUploaded();
  });
});

// ── the surface, end to end ────────────────────────────────────────────────

describe("virtuals__agent_launch_preview on the Studio surface", () => {
  it("seals a plan carrying the published URL and content id", async () => {
    findLaunchImageByPublicCid.mockResolvedValue(publishedRow());

    const result = await virtualsLaunchPreview(launchParams(), studio());

    if (!result.success) throw new Error(`refused: ${result.output}`);
    const data = parsed(result.output);
    expect(data.agent).toMatchObject({ imageUrl: PNG_URL, imageContentId: PNG_CID });
    expect(data.previewId).toBe("prev_1");
    expect(createLaunchPreviewIntent).toHaveBeenCalledTimes(1);
    expectNothingUploaded();
  });

  it("refuses an unpublished file and records no preview", async () => {
    const result = await virtualsLaunchPreview(launchParams(), studio());

    expect(result.success).toBe(false);
    expect(result.output).toContain("launchpads__image_publish");
    expect(createLaunchPreviewIntent).not.toHaveBeenCalled();
    expectNothingUploaded();
  });
});

describe("virtuals__agent_launch_execute simulateOnly on the Studio surface", () => {
  it("reaches the simulation with the published picture and launches nothing", async () => {
    findLaunchImageByPublicCid.mockResolvedValue(publishedRow());

    const result = await virtualsLaunchExecute(
      launchParams({ simulateOnly: true }),
      studio(),
    );

    if (!result.success) throw new Error(`refused: ${result.output}`);
    const data = parsed(result.output);
    expect(data.launched).toBe(false);
    expect(data.simulateOnly).toBe(true);
    expect(Array.isArray(data.wouldSend)).toBe(true);
    expect(data.agent).toMatchObject({ imageUrl: PNG_URL, imageContentId: PNG_CID });
    expectNothingUploaded();
  });

  it("refuses an unpublished file before any simulation", async () => {
    const result = await virtualsLaunchExecute(
      launchParams({ simulateOnly: true }),
      studio(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("launchpads__image_publish");
    expectNothingUploaded();
  });
});

// ── the structural guarantee Lane D established ────────────────────────────

describe("the launch lane holds no publishing machinery at all", () => {
  it("names neither the publisher nor an upload anywhere in its source", async () => {
    const source = await fs.readFile(
      new URL(
        "../../../../../vex-agent/tools/protocols/virtuals/handlers/launch/image.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).not.toContain("resolveLaunchAssetsPublisher");
    expect(source).not.toContain("uploadAsset");
  });
});
