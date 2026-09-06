/**
 * PUBLISHING BYTES IS A CONSENT DECISION, and a launch tool is not where it is
 * taken.
 *
 * `launchpads__image_publish` is the approval-gated tool that asks a person
 * whether a picture may become fetchable by anyone, forever. The 2026-09-06
 * final review found the Virtuals launch resolving a Studio `imagePath` by
 * UPLOADING the project's bytes to the public launch-assets host - including
 * from `virtuals__agent_launch_preview`, which the manifest classifies
 * `local_write` and describes as spending nothing and sending nothing, and from
 * `simulateOnly`, which promises that nothing is claimed and nothing is
 * broadcast. A person reading either description would not learn that a private
 * file in their repository had just been published.
 *
 * So this lane never publishes. It requires a picture that is ALREADY public -
 * a `launch_images` row carrying the content id `launchpads__image_publish`
 * recorded - and refuses by name otherwise, pointing at the tool that owns the
 * decision. One owner for "bytes become public" means one place the question is
 * asked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadAsset = vi.fn();
const getLaunchImage = vi.fn();

vi.mock("@vex-agent/agentscan/assets-client.js", () => ({
  resolveLaunchAssetsPublisher: async () => ({
    kind: "ready",
    ingestToken: "t",
    client: { uploadAsset: (input: unknown) => uploadAsset(input) },
  }),
}));

vi.mock("@vex-agent/db/repos/launch-images.js", () => ({
  getLaunchImage: (imageId: string) => getLaunchImage(imageId),
}));

/**
 * The project-file reader is made to SUCCEED, so the refusal below can only be
 * about consent. Without this the studio case would refuse for an unrelated
 * reason (no project root on this machine) and would pass against the very code
 * that published - which is how the defect survived a green suite.
 */
vi.mock("@vex-agent/tools/protocols/shared/launch-image-input.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@vex-agent/tools/protocols/shared/launch-image-input.js")
  >();
  return {
    ...actual,
    resolveProjectFileLaunchImage: async () => ({
      ok: true,
      image: { bytes: new Uint8Array([1, 2, 3]), displayLabel: "assets/agent.png" },
    }),
  };
});

const { resolveLaunchImage } = await import(
  "@vex-agent/tools/protocols/virtuals/handlers/launch/image.js"
);

type ResolveInput = Parameters<typeof resolveLaunchImage>[0];

/** An APPROVED, full-permission dispatch: the refusals below are never about authority. */
function studioContext(): ResolveInput["context"] {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "s-1",
    approvalSurface: "studio_mcp",
    studioProjectId: "p-1",
  };
}

function appContext(): ResolveInput["context"] {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "s-1",
    approvalSurface: "in_app_form",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a Virtuals launch never publishes a picture itself", () => {
  it("refuses a Studio project file by name and uploads nothing", async () => {
    const result = await resolveLaunchImage({
      params: { imagePath: "assets/agent.png" },
      context: studioContext(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("launchpads__image_publish");
    expect(uploadAsset).not.toHaveBeenCalled();
  });

  it("accepts a locker picture that is already published", async () => {
    getLaunchImage.mockResolvedValue({
      imageId: "img-1",
      label: "otaku.jpeg",
      publicUrl: "https://assets.example/a/abc123.jpeg",
      publicCid: "abc123",
    });

    const result = await resolveLaunchImage({
      params: { imageId: "img-1" },
      context: appContext(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.url).toBe("https://assets.example/a/abc123.jpeg");
    expect(uploadAsset).not.toHaveBeenCalled();
  });

  it("refuses an unpublished locker picture by name and uploads nothing", async () => {
    getLaunchImage.mockResolvedValue({
      imageId: "img-2",
      label: "otaku.jpeg",
      publicUrl: null,
      publicCid: null,
    });

    const result = await resolveLaunchImage({
      params: { imageId: "img-2" },
      context: appContext(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("launchpads__image_publish");
    expect(uploadAsset).not.toHaveBeenCalled();
  });
});
