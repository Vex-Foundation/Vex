/**
 * On-chain metadata text policy: REJECT, never transform.
 *
 * The launchpad operator reported that a name, symbol or description carrying a
 * control character or a double quote writes BROKEN metadata on-chain. Those
 * fields are arguments to `create()` and are immutable once it runs, so the
 * damage is permanent for every consumer of the token, not only one indexer.
 *
 * The contract is a REFUSAL, not a silent normalization. `trench.launch_execute`
 * can sign under full autonomy with NO preview, so a rewrite would put text
 * on-chain that the user never reviewed, and the preview result carries no
 * canonical text today, so a normalized value would not even be visible.
 *
 * The load-bearing assertion in here is that `buildCreateCalldata` is NEVER
 * CALLED for rejected input. Asserting that a character is absent from calldata
 * would only prove the character was scrubbed; this proves the launch text never
 * reached the encoder at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import { rejectForbiddenTokenMetadataText } from "../../lib/token-metadata-text-policy.js";
import { validateLaunchRequest } from "@vex-agent/tools/protocols/trench/handlers/launch/validate.js";

const buildCreateCalldata = vi.fn(() => "0x00");

vi.mock("@tools/trench-express/evm/create-launch.js", () => ({
  buildCreateCalldata: (...args: unknown[]) => buildCreateCalldata(...(args as [])),
}));

/**
 * A wallet is only present when a test asks for one, so the no-wallet control
 * and the walleted ordering proof can live in the same file.
 */
let selectedAddress: string | null = null;
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddressForRead: () => {
    if (selectedAddress === null) throw new Error("no wallet selected");
    return selectedAddress;
  },
}));

/**
 * The image resolver is answered with real bytes whose digest matches, so the
 * preview takes its `staged_bytes` path and therefore REACHES
 * `buildCreateCalldata` for accepted input. Without that, an accepted launch
 * would encode through the empty-image fallback and "was never called" would
 * prove nothing at all.
 */
const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4]);
const { launchImageDigest } = await import(
  "@vex-agent/tools/protocols/trench/handlers/launch/authorization.js"
);
vi.mock("@vex-agent/tools/protocols/trench/launch-image-byte-resolver.js", () => ({
  LaunchImageResolverUnavailableError: class extends Error {},
  resolveLaunchImageBytes: async () => ({
    bytes: IMAGE_BYTES,
    digest: launchImageDigest(IMAGE_BYTES),
  }),
}));

/** The dry-run stops at "no data" — far past the point calldata is built. */
vi.mock("@tools/evm-chains/evm-client.js", () => ({
  getLocalPublicClient: () => ({
    call: async () => ({ data: undefined }),
    estimateGas: async () => 1_000_000n,
    getGasPrice: async () => 1_000_000_000n,
    getBalance: async () => 0n,
  }),
}));

const { trenchLaunchPreviewHandler } = await import(
  "@vex-agent/tools/protocols/trench/handlers/launch-preview.js"
);

/**
 * A real read context, not a cast: the preview needs nothing privileged, and a
 * typed value keeps the suite honest about the surface it calls.
 */
const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

const VALID = {
  name: "Vex x Trench",
  symbol: "VEXTE",
  description: "a launch",
  links: "https://vex.example",
  imageId: "img_01",
};

/** Each entry is one forbidden category, planted in one named field. */
const REJECTED = [
  { label: "a newline in description", field: "description", params: { description: "line one\nline two" } },
  { label: "a double quote in name", field: "name", params: { name: 'Vex "the" Token' } },
  { label: "DEL in symbol", field: "symbol", params: { symbol: "VEX\u007F" } },
  { label: "NUL in a link", field: "links", params: { links: "https://vex.example/\u0000x" } },
  { label: "a carriage return in name", field: "name", params: { name: "Vex\r\nToken" } },
  { label: "a tab in description", field: "description", params: { description: "a\tlaunch" } },
] as const;

beforeEach(() => {
  buildCreateCalldata.mockClear();
  selectedAddress = null;
});

describe("rejectForbiddenMetadataText", () => {
  it("returns null for text outside the forbidden set", () => {
    expect(rejectForbiddenTokenMetadataText("name", "Vex x Trench")).toBeNull();
    expect(rejectForbiddenTokenMetadataText("name", undefined)).toBeNull();
  });

  it("names the field and the remedy", () => {
    const reason = rejectForbiddenTokenMetadataText("description", "a\nb");
    expect(reason).not.toBeNull();
    expect(reason).toContain("description");
    expect(reason).toMatch(/line break/i);
    expect(reason).toMatch(/apostrophe/i);
  });

  it("inspects every element of a list field", () => {
    const reason = rejectForbiddenTokenMetadataText("links", [
      "https://a.example",
      "https://b.example/\u0001",
    ]);
    expect(reason).not.toBeNull();
    expect(reason).toContain("links");
  });
});

describe("validateLaunchRequest refuses forbidden metadata characters BY FIELD", () => {
  for (const entry of REJECTED) {
    it(`refuses ${entry.label}`, () => {
      const result = validateLaunchRequest({ ...VALID, ...entry.params });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toContain(entry.field);
      expect(result.reason).toMatch(/apostrophe/i);
    });
  }

  it("refuses the raw text BEFORE trimming it away", () => {
    // Trim-then-validate would accept this and submit a string the user never
    // saw validated; what is checked and what is submitted must be one string.
    const result = validateLaunchRequest({ ...VALID, name: "Vex\n" });
    expect(result.ok).toBe(false);
  });

  it("refuses a control character in a link BEFORE the https scheme check", () => {
    // A URL parser downstream can silently drop it, so the refusal must name the
    // control character rather than complain about the scheme.
    const result = validateLaunchRequest({ ...VALID, links: "http://vex.example/\u0007" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).not.toMatch(/https URL/);
  });

  it("PRESERVES valid Unicode and ordinary punctuation", () => {
    const result = validateLaunchRequest({
      ...VALID,
      name: "Vex 🚀 Café",
      symbol: "VÉX-1",
      description: "Vex's token - built for launches, ¡olé! 日本語 100%",
      links: "https://vex.example/a?b=c#f",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.name).toBe("Vex 🚀 Café");
    expect(result.value.symbol).toBe("VÉX-1");
    expect(result.value.description).toBe("Vex's token - built for launches, ¡olé! 日本語 100%");
    expect(result.value.links).toEqual(["https://vex.example/a?b=c#f"]);
  });
});

describe("trench.launch_preview refuses IDENTICALLY and never builds calldata", () => {
  it("control: clean params get PAST validation, so the refusals below are not vacuous", async () => {
    // No wallet in this context, so the preview degrades to validation-only.
    // That it answers at all proves the metadata gate let the clean text through.
    const result = await trenchLaunchPreviewHandler({ ...VALID, name: "Vex 🚀 Café" }, READ_CTX);
    expect(result.success).toBe(true);
  });

  for (const entry of REJECTED) {
    it(`refuses ${entry.label} without calling buildCreateCalldata`, async () => {
      const params = { ...VALID, ...entry.params };
      const result = await trenchLaunchPreviewHandler(params, READ_CTX);

      expect(result.success).toBe(false);
      const executionResult = validateLaunchRequest(params);
      expect(executionResult.ok).toBe(false);
      if (executionResult.ok) throw new Error("unreachable");
      // IDENTICAL refusal: one shared helper, one message, both paths.
      expect(result.output).toBe(executionResult.reason);
      expect(result.output).toContain(entry.field);

      // THE guarantee: the rejected text never reached the create() encoder.
      expect(buildCreateCalldata).not.toHaveBeenCalled();
    });
  }
});

describe("the ordering claim, with a wallet and a priced image", () => {
  const WALLET = "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA";

  it("REACHES buildCreateCalldata for accepted text", async () => {
    selectedAddress = WALLET;
    const result = await trenchLaunchPreviewHandler({ ...VALID }, READ_CTX);
    // The fake client answers the simulation with no data, so the preview
    // fails AFTER the calldata was built. That is the point: the encoder is
    // reachable, so the refusals below are proving the gate, not the fixture.
    expect(result.success).toBe(false);
    expect(buildCreateCalldata).toHaveBeenCalledTimes(1);
  });

  for (const entry of REJECTED) {
    it(`never reaches buildCreateCalldata for ${entry.label}`, async () => {
      selectedAddress = WALLET;
      const result = await trenchLaunchPreviewHandler({ ...VALID, ...entry.params }, READ_CTX);
      expect(result.success).toBe(false);
      expect(result.output).toContain(entry.field);
      expect(buildCreateCalldata).not.toHaveBeenCalled();
    });
  }
});
