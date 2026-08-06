/**
 * CHARACTERIZATION FIRST, then the U1 behaviour change.
 *
 * `trench.launch_preview` is the surface the agent prices a launch from, and
 * nothing pinned its output shape before this file. The first block records the
 * shape as it was BEFORE U1 (empty-image simulation, raw wei only, no image
 * pricing, no balance verdict); the blocks after it pin the new fields.
 *
 * Gas provenance for the staged-bytes expectations: the funded live probe
 * `agents_dm/trench-live/attest-launch.result.json` launched with a 3.3 KB image
 * and burned 4,534,423 gas, an order of magnitude above the empty-image sim.
 * That gap is exactly what "priced with staged bytes" buys, and why an
 * empty-image simulation can never prove a real launch is affordable.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { TRENCH_HANDLERS } from "../../../vex-agent/tools/protocols/trench/handlers.js";
import type { ProtocolExecutionContext } from "../../../vex-agent/tools/protocols/types.js";
import * as walletResolve from "../../../vex-agent/tools/internal/wallet/resolve.js";
import * as evmClient from "@tools/evm-chains/evm-client.js";
import {
  registerLaunchImageByteResolver,
  resetLaunchImageByteResolver,
  type LaunchImageBytes,
} from "../../../vex-agent/tools/protocols/trench/launch-image-byte-resolver.js";
import { launchImageDigest } from "../../../vex-agent/tools/protocols/trench/handlers/launch/authorization.js";

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

const WALLET = "0x1111111111111111111111111111111111111111";
const PREDICTED = "0x0000000000000000000000002222222222222222222222222222222222222222";

const GAS_PRICE_WEI = 1_000_000_000n; // 1 gwei
const EMPTY_IMAGE_GAS = 1_000_000n;
const STAGED_IMAGE_GAS = 4_534_423n; // the live probe's real 3.3 KB figure

function parse(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

/**
 * A client whose gas estimate depends on the calldata SIZE, the way the chain's
 * does. Short calldata = the empty-image sim; long calldata = staged bytes.
 */
function mockClient(over: { balanceWei?: bigint; failBalance?: boolean } = {}): void {
  vi.spyOn(evmClient, "getLocalPublicClient").mockReturnValue({
    call: async () => ({ data: PREDICTED }),
    estimateGas: async ({ data }: { data: string }) =>
      data.length > 2_000 ? STAGED_IMAGE_GAS : EMPTY_IMAGE_GAS,
    getGasPrice: async () => GAS_PRICE_WEI,
    getBalance: async () => {
      if (over.failBalance === true) throw new Error("rpc down");
      return over.balanceWei ?? 10_000_000_000_000_000_000n;
    },
  } as unknown as ReturnType<typeof evmClient.getLocalPublicClient>);
}

/** 3.3 KB of bytes, the live probe's image size. */
const IMAGE_BYTES = new Uint8Array(3_300).fill(7);

/**
 * The digest is spelled the way the REAL locker spells it: node's `createHash`
 * output, BARE hex with no `0x`. Defaulting to this side's `0x`-prefixed
 * spelling is what hid the live defect - the fixture agreed with the code
 * instead of with the producer, so every image mismatched in production while
 * the suite stayed green (live report 2026-08-06).
 */
function lockerSpelling(bytes: Uint8Array): string {
  return launchImageDigest(bytes).replace(/^0x/, "");
}

function stageImage(bytes: Uint8Array = IMAGE_BYTES, digest?: string): void {
  const resolved: LaunchImageBytes = { bytes, digest: digest ?? lockerSpelling(bytes) };
  registerLaunchImageByteResolver(async (id) => (id === "img_1" ? resolved : null));
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLaunchImageByteResolver();
});

describe("trench.launch_preview output shape (characterization)", () => {
  it("keeps every pre-U1 field on the simulated empty-image path", async () => {
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockReturnValue(WALLET);
    mockClient();

    const res = await TRENCH_HANDLERS["trench.launch_preview"]!(
      { name: "My Token", symbol: "MYT" },
      READ_CTX,
    );
    expect(res.success).toBe(true);
    const data = parse(res.output);

    expect(data.chain).toBe("robinhood");
    expect(data.chainId).toBe(4663);
    expect(data.name).toBe("My Token");
    expect(data.symbol).toBe("MYT");
    expect(data.linksCount).toBe(0);
    expect(data.creationFeeWei).toBe("1000000000000000");
    expect(data.creationFeeEth).toBe("0.001");
    expect(data.costBeforeGasWei).toBe("1002500000000000");
    expect(data.costBeforeGasEth).toBe("0.0010025");
    expect(data.simulated).toBe(true);
    expect(data.from).toBe(WALLET);
    expect(data.predictedTokenAddress).toBe("0x2222222222222222222222222222222222222222");
    expect(data.gasEstimate).toBe(EMPTY_IMAGE_GAS.toString());
    expect(data.gasPriceWei).toBe(GAS_PRICE_WEI.toString());
    expect(typeof data.gasLimitWithHeadroom).toBe("string");
    expect(typeof data.estimatedGasCostWei).toBe("string");
    expect(typeof data.estimatedTotalCostWei).toBe("string");
    expect(typeof data.feeNote).toBe("string");
    expect(typeof data.note).toBe("string");
  });
});

describe("trench.launch_preview gas-price twin (U2)", () => {
  it("quotes the gas price in gwei alongside the raw wei", async () => {
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockReturnValue(WALLET);
    mockClient();

    const res = await TRENCH_HANDLERS["trench.launch_preview"]!(
      { name: "My Token", symbol: "MYT" },
      READ_CTX,
    );
    const data = parse(res.output);
    // 1000000000 wei is 1 gwei. The bare wei string is the number an agent
    // misreads as a gwei figure; the twin removes the guess.
    expect(data.gasPriceWei).toBe("1000000000");
    expect(data.gasPriceGwei).toBe("1");
  });

  it("does NOT invent gwei twins for the unitless gas figures", async () => {
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockReturnValue(WALLET);
    mockClient();

    const res = await TRENCH_HANDLERS["trench.launch_preview"]!(
      { name: "My Token", symbol: "MYT" },
      READ_CTX,
    );
    const data = parse(res.output);
    expect(data.gasEstimateGwei).toBeUndefined();
    expect(data.gasLimitWithHeadroomGwei).toBeUndefined();
  });
});

describe("trench.launch_preview image pricing (U1)", () => {
  it("prices the REAL staged bytes when imageId is given", async () => {
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockReturnValue(WALLET);
    mockClient();
    stageImage();

    const res = await TRENCH_HANDLERS["trench.launch_preview"]!(
      { name: "My Token", symbol: "MYT", imageId: "img_1" },
      READ_CTX,
    );
    expect(res.success).toBe(true);
    const data = parse(res.output);
    expect(data.imagePriced).toBe("staged_bytes");
    expect(data.imageId).toBe("img_1");
    expect(data.imageByteLengthPriced).toBe(3_300);
    expect(data.gasEstimate).toBe(STAGED_IMAGE_GAS.toString());
    expect(data.imagePricedFallbackReason).toBeUndefined();
  });

  it("degrades to the empty-image sim, labelled, when the image is not in the locker", async () => {
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockReturnValue(WALLET);
    mockClient();
    stageImage();

    const res = await TRENCH_HANDLERS["trench.launch_preview"]!(
      { name: "My Token", symbol: "MYT", imageId: "img_missing" },
      READ_CTX,
    );
    expect(res.success).toBe(true);
    const data = parse(res.output);
    expect(data.imagePriced).toBe("empty_fallback");
    expect(data.imagePricedFallbackReason).toBe("image_not_found");
    expect(data.gasEstimate).toBe(EMPTY_IMAGE_GAS.toString());
  });

  it("prices the staged bytes when the locker spells the digest WITHOUT 0x", async () => {
    // The regression: two producers, two spellings of one hash. A bare-hex
    // digest names the same bytes and must be priced, not called a mismatch.
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockReturnValue(WALLET);
    mockClient();
    stageImage(IMAGE_BYTES, lockerSpelling(IMAGE_BYTES).toUpperCase());

    const handler = TRENCH_HANDLERS["trench.launch_preview"];
    if (handler === undefined) throw new Error("trench.launch_preview is not registered");
    const res = await handler({ name: "My Token", symbol: "MYT", imageId: "img_1" }, READ_CTX);
    expect(res.success).toBe(true);
    const data = parse(res.output);
    expect(data.imagePriced).toBe("staged_bytes");
    expect(data.imagePricedFallbackReason).toBeUndefined();
  });

  it("degrades to the empty-image sim, labelled, when the stored digest disagrees", async () => {
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockReturnValue(WALLET);
    mockClient();
    stageImage(IMAGE_BYTES, "ab".repeat(32));

    const res = await TRENCH_HANDLERS["trench.launch_preview"]!(
      { name: "My Token", symbol: "MYT", imageId: "img_1" },
      READ_CTX,
    );
    expect(res.success).toBe(true);
    const data = parse(res.output);
    expect(data.imagePriced).toBe("empty_fallback");
    expect(data.imagePricedFallbackReason).toBe("image_digest_mismatch");
  });

  it("REFUSES by name when the image store is not mounted (never a silent fallback)", async () => {
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockReturnValue(WALLET);
    mockClient();
    // No resolver registered: the seam throws LaunchImageResolverUnavailableError.

    const res = await TRENCH_HANDLERS["trench.launch_preview"]!(
      { name: "My Token", symbol: "MYT", imageId: "img_1" },
      READ_CTX,
    );
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/no LaunchImageByteResolver is registered/);
  });

  it("rejects by name when imageByteLength contradicts the resolved bytes", async () => {
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockReturnValue(WALLET);
    mockClient();
    stageImage();

    const res = await TRENCH_HANDLERS["trench.launch_preview"]!(
      { name: "My Token", symbol: "MYT", imageId: "img_1", imageByteLength: 999 },
      READ_CTX,
    );
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/imageByteLength/);
    expect(res.output).toMatch(/3300/);
  });

  it("labels the plain no-imageId preview as an empty fallback", async () => {
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockReturnValue(WALLET);
    mockClient();

    const res = await TRENCH_HANDLERS["trench.launch_preview"]!(
      { name: "My Token", symbol: "MYT" },
      READ_CTX,
    );
    const data = parse(res.output);
    expect(data.imagePriced).toBe("empty_fallback");
    expect(data.imagePricedFallbackReason).toBe("no_image_id");
  });
});

describe("trench.launch_preview no-prebuy balance verdict (U1)", () => {
  it("is 'sufficient' when the staged-bytes total fits the wallet", async () => {
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockReturnValue(WALLET);
    mockClient({ balanceWei: 10_000_000_000_000_000_000n });
    stageImage();

    const res = await TRENCH_HANDLERS["trench.launch_preview"]!(
      { name: "My Token", symbol: "MYT", imageId: "img_1" },
      READ_CTX,
    );
    const data = parse(res.output);
    expect(data.noPrebuyBalanceVerdict).toBe("sufficient");
    expect(data.noPrebuyShortfallWei).toBeUndefined();
    // The balance itself travels with its ETH twin (Codex final review
    // 2026-08-05): a bare-wei balance would recreate the raw-unit trap this
    // arc exists to close.
    expect(data.walletBalanceEth).toBe("10");
  });

  it("is 'insufficient' with a shortfall twin when the wallet cannot cover it", async () => {
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockReturnValue(WALLET);
    mockClient({ balanceWei: 1n });
    stageImage();

    const res = await TRENCH_HANDLERS["trench.launch_preview"]!(
      { name: "My Token", symbol: "MYT", imageId: "img_1" },
      READ_CTX,
    );
    const data = parse(res.output);
    expect(data.noPrebuyBalanceVerdict).toBe("insufficient");
    expect(data.walletBalanceEth).toBe("0.000000000000000001");
    const shortfall = BigInt(data.noPrebuyShortfallWei as string);
    expect(shortfall).toBe(BigInt(data.estimatedTotalCostWei as string) - 1n);
    expect(data.noPrebuyShortfallEth).toBe(data.noPrebuyShortfallEth as string);
    expect(typeof data.noPrebuyShortfallEth).toBe("string");
  });

  it("is 'unpriced' with NO shortfall on EVERY empty-image fallback, however rich the wallet", async () => {
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockReturnValue(WALLET);
    mockClient({ balanceWei: 10_000_000_000_000_000_000n });

    const res = await TRENCH_HANDLERS["trench.launch_preview"]!(
      { name: "My Token", symbol: "MYT" },
      READ_CTX,
    );
    const data = parse(res.output);
    // Execute ALWAYS requires an image, so an empty-image sim can never prove
    // any real launch affordable — not even a wallet holding 10 ETH.
    expect(data.noPrebuyBalanceVerdict).toBe("unpriced");
    expect(data.noPrebuyShortfallWei).toBeUndefined();
    expect(data.noPrebuyShortfallEth).toBeUndefined();
  });

  it("is 'unpriced' with NO shortfall when the balance itself cannot be read", async () => {
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockReturnValue(WALLET);
    mockClient({ failBalance: true });
    stageImage();

    const res = await TRENCH_HANDLERS["trench.launch_preview"]!(
      { name: "My Token", symbol: "MYT", imageId: "img_1" },
      READ_CTX,
    );
    const data = parse(res.output);
    expect(data.imagePriced).toBe("staged_bytes");
    expect(data.noPrebuyBalanceVerdict).toBe("unpriced");
    expect(data.noPrebuyShortfallWei).toBeUndefined();
  });

  it("omits the verdict entirely when no wallet resolves", async () => {
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockImplementation(() => {
      throw new Error("WALLET_NOT_SELECTED");
    });

    const res = await TRENCH_HANDLERS["trench.launch_preview"]!(
      { name: "My Token", symbol: "MYT" },
      READ_CTX,
    );
    const data = parse(res.output);
    expect(data.simulated).toBe(false);
    expect(data.noPrebuyBalanceVerdict).toBeUndefined();
  });
});
