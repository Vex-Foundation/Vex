/**
 * `pools.launch_execute` - THE AUTHORIZATION HALF.
 *
 * What these tests protect is the ORDER, because the order is the safety
 * property: the 13-point calldata verifier runs while NO authorization exists,
 * and an authorization is created ONLY over bytes it passed. Every adversarial
 * case here builds a launch that is valid in every respect, tampers with exactly
 * ONE thing, and requires that no intent row is ever written.
 *
 * The broadcast half is deliberately absent in this change. The default
 * broadcaster refuses and RELEASES the authorization to terminal failure, which
 * is also asserted: an authorization that sits consumed with nothing to consume
 * it would look like a launch in flight.
 *
 * The database is mocked at the repo seam - the DDL and the constraints are
 * proven separately against real Postgres by
 * `agents_dm/pools-fun-live/migration-082-apply-proof.ts`. Here the question is
 * what the handler asks the repo to write, and when it refuses to ask at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";

import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import { POOLS_GATEWAY_ABI } from "@tools/pools-fun/abi.js";
import {
  POOLS_CHAIN_ID,
  POOLS_FACTORY_ADDRESS,
  POOLS_GATEWAY_ADDRESS,
  POOLS_LOCKER_ADDRESS,
} from "@tools/pools-fun/constants.js";
import { nativeValueCallFingerprint } from "@tools/evm-chains/native-value-authorization/index.js";
import type { PoolsLaunchTuple } from "@tools/pools-fun/launch/verifier-types.js";
import type { PoolsPrepareResponse } from "@tools/pools-fun/types.js";
import * as evmClient from "@tools/evm-chains/evm-client.js";
import * as http from "@utils/http.js";
import * as intents from "@vex-agent/db/repos/token-launch-intents.js";
import * as dbClient from "@vex-agent/db/client.js";
import * as lease from "@vex-agent/engine/runtime/lease-and-status.js";
import * as walletResolve from "@vex-agent/tools/internal/wallet/resolve.js";
import * as signingClients from "@vex-agent/tools/protocols/shared/launch-signing-clients.js";
import * as ceilingModule from "@vex-agent/engine/mission/launch-ceiling.js";
import { poolsLaunchExecuteHandler } from "@vex-agent/tools/protocols/pools/handlers/launch/execute.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import {
  registerLaunchImageByteResolver,
  resetLaunchImageByteResolver,
} from "@vex-agent/tools/protocols/shared/launch-image-byte-resolver.js";
import { makeProtocolContext } from "../../_test-context.js";

/** A real PNG header - the sniffer reads magic bytes, not a file name. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

const GATEWAY = getAddress(POOLS_GATEWAY_ADDRESS);
const FACTORY = getAddress(POOLS_FACTORY_ADDRESS);
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const STRANGER = getAddress("0x9999999999999999999999999999999999999999");
const TOKEN = getAddress("0x01e685d39e6bf52ad0c421a4be1e092ce684e6bb");
const POOL = getAddress("0x50136d4174129585ec766eacf2f00cd1856690ca");
const SALT = `0x${"7a".repeat(32)}` as Hex;
const METADATA_URI = "ipfs://bafkreifaguifkgqdrrs2cwlbjejqblrguynowkm3zb77yvq3gsydqacywm";

const FEE_WEI = 1_051_674_002_092_832n;
const PREBUY_WEI = 10_000_000_000_000_000n;
const DEV_BUY_OUT = 112_657_539_798_287_513_447_808n;
const BLOCK = 39_620_464n;

// A VALID agent launch now carries an image. It did not until 2026-08-19, and
// that is exactly how PPV was launched blank: `imageId` was optional, the model
// omitted it, and the pinned metadata came back with no image key. The locker id
// is part of the valid shape here so no test in this suite can drift back to
// describing an imageless launch as the normal one.
const VALID_PARAMS = {
  name: "Vex Flamingo",
  symbol: "VEXFLAM",
  pairedAsset: "weth",
  prebuy: "0.01",
  imageId: "img-1",
};

/** The tuple the provider would return. Every test tampers with exactly one thing. */
function tuple(over: Partial<PoolsLaunchTuple> = {}): PoolsLaunchTuple {
  return {
    name: "Vex Flamingo",
    symbol: "VEXFLAM",
    metadataUri: METADATA_URI,
    userSalt: SALT,
    pairedAsset: WETH,
    expectedStartTick: -197_600,
    deadline: 1_787_054_575n,
    feeRecipient: WALLET,
    nativeDevBuyAmount: PREBUY_WEI,
    erc20DevBuyAmountIn: 0n,
    devBuyMinOut: DEV_BUY_OUT,
    expectedFeeWei: FEE_WEI,
    ...over,
  };
}

function encode(t: PoolsLaunchTuple): Hex {
  return encodeFunctionData({ abi: POOLS_GATEWAY_ABI, functionName: "launch", args: [t] });
}

function prepareResponse(
  t: PoolsLaunchTuple,
  over: Partial<PoolsPrepareResponse> = {},
): PoolsPrepareResponse {
  return {
    requiresReprepare: false,
    to: GATEWAY,
    data: encode(t),
    value: (t.expectedFeeWei + t.nativeDevBuyAmount).toString(),
    predictedTokenAddress: TOKEN,
    predictedPoolAddress: POOL,
    salt: t.userSalt,
    metadataUri: t.metadataUri,
    devBuyMinOut: t.devBuyMinOut.toString(),
    devBuyAmountIn: t.nativeDevBuyAmount.toString(),
    deploymentFeeWei: t.expectedFeeWei.toString(),
    nativeDevBuyWei: t.nativeDevBuyAmount.toString(),
    deadline: t.deadline.toString(),
    // Objects on the wire, not strings - the provider's 2026-08-19 contract.
    pairedAsset: { address: WETH, kind: "weth", symbol: "WETH", decimals: 18 },
    tokenSymbol: t.symbol,
    feeRecipient: { address: t.feeRecipient, display: `${t.feeRecipient.slice(0, 6)}…${t.feeRecipient.slice(-4)}` },
    ...over,
  };
}

/** The ten anchored reads, in the order `readPoolsChainAnchors` asks for them. */
function anchorReads(over: Partial<Record<number, unknown>> = {}): unknown[] {
  const results: unknown[] = [
    1n, // VERSION
    FACTORY,
    false, // paused
    FEE_WEI,
    1_000_000_000_000n, // MIN
    10_000_000_000_000_000n, // MAX
    WETH,
    TOKEN, // computeTokenAddress
    true, // allowedPairedAsset
    [-197_600, true], // startTickFor
  ];
  return results.map((result, index) =>
    index in over
      ? (over[index] === undefined
        ? { status: "failure" }
        : { status: "success", result: over[index] })
      : { status: "success", result },
  );
}

let written: Record<string, unknown>[] = [];
let consumed: string[] = [];
let failed: { intentId: string; reason: string }[] = [];
let anchors: unknown[];
let response: PoolsPrepareResponse;
let simulated: { tokenAddress: Address; poolAddress: Address; devBuyOut: bigint };
let balanceWei: bigint;

function context(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return makeProtocolContext({ sessionId: "sess-1", sessionPermission: "full", ...over });
}

beforeEach(() => {
  written = [];
  broadcastCalls = [];
  consumed = [];
  failed = [];
  anchors = anchorReads();
  response = prepareResponse(tuple());
  simulated = { tokenAddress: TOKEN, poolAddress: POOL, devBuyOut: DEV_BUY_OUT };
  balanceWei = 10n ** 18n;

  vi.spyOn(walletResolve, "resolveSelectedAddress").mockReturnValue(WALLET);
  vi.spyOn(lease, "acquireSessionControlLock").mockResolvedValue(undefined as never);
  vi.spyOn(dbClient, "withTransaction").mockImplementation(
    async (fn: (client: never) => Promise<unknown>) => fn({} as never) as never,
  );
  vi.spyOn(intents, "createWith").mockImplementation(async (_client, input) => {
    written.push(input as unknown as Record<string, unknown>);
    return { intentId: (input as { intentId: string }).intentId } as never;
  });
  vi.spyOn(intents, "consumeIfAuthorizedWith").mockImplementation(async (_c, intentId) => {
    consumed.push(intentId);
    return { intentId } as never;
  });
  vi.spyOn(intents, "failWith").mockImplementation(async (_c, intentId, _s, reason) => {
    failed.push({ intentId, reason });
    return { intentId } as never;
  });

  vi.spyOn(getPoolsFunClient(), "launchConfig").mockImplementation(async () => ({
    deploymentFeeWei: FEE_WEI.toString(),
    gatewayVersion: 1,
  }));
  vi.spyOn(getPoolsFunClient(), "prepareLaunch").mockImplementation(async () => response);

  // The locker leg of the happy path, now that every valid agent launch has an
  // image: a real PNG resolves and the launchpad accepts the upload. Individual
  // tests still re-register their own resolver to prove the refusals.
  registerLaunchImageByteResolver(async () => ({ bytes: PNG_BYTES, digest: "0xdeadbeef" }));
  vi.spyOn(getPoolsFunClient(), "uploadLaunchImage").mockResolvedValue({
    url: "https://example.test/flamingo.png",
  });

  // The metadata document the launch pins, read over a public gateway.
  vi.spyOn(http, "fetchWithTimeout").mockResolvedValue({
    ok: true,
    text: async () =>
      JSON.stringify({
        name: "Vex Flamingo",
        symbol: "VEXFLAM",
        image: "ipfs://bafkreiavjuxoyk5yoglksbl5gty2mkg74fsao6g2blr5mmjf3wr2kyosma",
        initial_deployer: { address: WALLET },
        initial_fee_recipient: { address: WALLET },
      }),
  } as unknown as Response);

  // The signing seam is STUBBED, never exercised: this suite must be incapable
  // of reaching a real key, and the public client the plan reads from is the
  // fake below.
  vi.spyOn(signingClients, "openLaunchSigningClients").mockImplementation(() => ({
    ok: true,
    clients: {
      publicClient: evmClient.getLocalPublicClient({} as never),
      walletClient: {} as never,
    },
  }));

  vi.spyOn(evmClient, "getLocalPublicClient").mockReturnValue({
    getBlockNumber: async () => BLOCK,
    multicall: async () => anchors,
    getBalance: async () => balanceWei,
    simulateContract: async () => ({
      result: [simulated.tokenAddress, simulated.poolAddress, simulated.devBuyOut],
    }),
    estimateGas: async () => 1_800_000n,
    getGasPrice: async () => 22_518_000n,
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetLaunchImageByteResolver();
});

/**
 * The broadcaster is INJECTED as a capture, never the real one: this suite is
 * about what happens BEFORE anything is signed, and a test that could reach a
 * signer is a test that could spend.
 */
let broadcastCalls: { intentId: string; fingerprint: string }[] = [];

const captureBroadcast = async (input: {
  intentId: string;
  plan: { call: { fingerprint: string } };
}) => {
  broadcastCalls.push({ intentId: input.intentId, fingerprint: input.plan.call.fingerprint });
  return { success: true, output: "broadcast captured" };
};

async function execute(params: Record<string, unknown> = VALID_PARAMS, ctx = context()) {
  return poolsLaunchExecuteHandler(params, ctx, {
    broadcast: captureBroadcast as never,
  });
}

describe("a verified launch is authorized over the exact bytes that were verified", () => {
  it("writes an authorized pools_fun intent bound to the calldata fingerprint", async () => {
    await execute();

    expect(written).toHaveLength(1);
    const row = written[0]!;
    expect(row.protocol).toBe("pools_fun");
    expect(row.status).toBe("authorized");
    expect(row.chainId).toBe(POOLS_CHAIN_ID);
    expect(row.authorizationKind).toBe("session_full");

    const binding = (row.authorizationJson as { binding: Record<string, string> }).binding;
    // THE handshake: what the verifier proved is what the authorization names.
    expect(binding.callFingerprint).toBe(
      nativeValueCallFingerprint({
        chainId: POOLS_CHAIN_ID,
        to: GATEWAY,
        data: response.data as Hex,
        valueWei: BigInt(response.value),
      }),
    );
    expect(binding.calldata).toBe(response.data);
    expect(binding.msgValueWei).toBe((FEE_WEI + PREBUY_WEI).toString());
    expect(binding.predictedTokenAddress).toBe(TOKEN);
  });

  it("records the pools block so an audit can read the launch back", async () => {
    await execute();
    const pools = written[0]!.pools as Record<string, string>;
    expect(pools.pairedAsset).toBe("weth");
    expect(pools.pairedAssetAddress).toBe(WETH);
    expect(pools.feeRecipientAddress).toBe(WALLET);
    expect(pools.metadataUri).toBe(METADATA_URI);
    expect(pools.gatewayAddress).toBe(GATEWAY);
  });

  it("CAS-consumes the intent it just authorized - the exactly-once gate", async () => {
    await execute();
    expect(consumed).toEqual([written[0]!.intentId]);
  });

  it("hands the broadcaster the SAME fingerprint the authorization names", async () => {
    await execute();
    const binding = (written[0]!.authorizationJson as { binding: Record<string, string> }).binding;
    expect(broadcastCalls).toHaveLength(1);
    expect(broadcastCalls[0]!.intentId).toBe(written[0]!.intentId);
    // The handshake, end to end: verified bytes -> authorized fingerprint ->
    // broadcast. Nothing in between may substitute a different transaction.
    expect(broadcastCalls[0]!.fingerprint).toBe(binding.callFingerprint);
  });

  it("pins the creator fee stream to the session wallet, never to a parameter", async () => {
    await execute();
    const binding = (written[0]!.authorizationJson as { binding: Record<string, string> }).binding;
    expect(binding.feeRecipient).toBe(WALLET);
  });
});

/**
 * THE PPV INCIDENT (2026-08-19). The agent called `pools.launch_execute` with no
 * `imageId`, the launch succeeded, and the token renders blank on pools.fun
 * forever - an irreversible on-chain outcome. The param was optional and both the
 * manifest and the system prompt only WARNED about it; prose did not stop it.
 *
 * The product rule is now Trench's: a launch through the AGENT requires an image,
 * enforced in OUR handler rather than assumed from the provider's contract (the
 * launchpad itself is happy to pin imageless metadata, which is what made this
 * possible). The user's own manual form keeps the image optional, matching the
 * pools.fun site where a human may choose to launch without one.
 */
describe("the agent path REQUIRES a locker image", () => {
  it("refuses BY NAME when imageId is absent, before anything is authorized", async () => {
    const { imageId: _omitted, ...noImage } = VALID_PARAMS;
    const result = await execute(noImage);

    expect(result.success).toBe(false);
    expect(result.output).toContain("requires a picture");
    // The remedy has to be actionable: the locker is SHARED between the two
    // launchpads, so the tool that lists it is the launchpad-neutral
    // `launchpads.images`.
    //
    // INTENTIONAL CONTRACT CHANGE (launchpads arc PR2): this assertion pinned
    // `trench__images_list`, a Trench-prefixed name for a store that was never
    // Trench's. The remedy sentence must name the tool that actually exists, or
    // the agent is sent to a tool it cannot find.
    expect(result.output).toContain("launchpads__images_list");
    // Nothing may exist after this refusal - no intent row, no authorization,
    // no broadcast. A refusal that had already written one would be a leak.
    expect(written).toHaveLength(0);
    expect(broadcastCalls).toHaveLength(0);
  });

  it("refuses an imageId that is only whitespace, rather than treating it as given", async () => {
    const result = await execute({ ...VALID_PARAMS, imageId: "   " });
    expect(result.success).toBe(false);
    expect(result.output).toContain("requires a picture");
    expect(written).toHaveLength(0);
  });

  it("proceeds to authorization when a valid imageId is supplied", async () => {
    const result = await execute();
    expect(result.success).toBe(true);
    expect(written).toHaveLength(1);
    expect(
      (written[0]!.authorizationJson as { binding: Record<string, string> }).binding.imageId,
    ).toBe("img-1");
  });

  // An UNKNOWN id keeps its own refusal: "you named one that is not there" is a
  // different fact from "you named none", and collapsing them would send the
  // agent to the wrong remedy.
  it("keeps the distinct not-found refusal for an id the locker does not hold", async () => {
    registerLaunchImageByteResolver(async () => null);
    const result = await execute({ ...VALID_PARAMS, imageId: "img_gone" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("img_gone");
    expect(result.output).not.toContain("requires a picture");
  });
});

describe("with no broadcast leg, the authorization is RELEASED rather than left in flight", () => {
  it("refuses, says nothing was signed, and settles the intent to failure", async () => {
    const result = await poolsLaunchExecuteHandler(VALID_PARAMS, context(), { broadcast: null });
    expect(result.success).toBe(false);
    expect(result.output).toContain("NOTHING WAS SIGNED");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.intentId).toBe(written[0]!.intentId);
    // Structural label only: a settle reason must never carry provider detail.
    expect(failed[0]!.reason).toBe("BroadcastUnavailable:not_wired");
  });
});

describe("the verifier gates BEFORE any authorization exists", () => {
  /** Assert the launch refused and that NOTHING was written or consumed. */
  async function expectRefusedWithoutAuthorization(
    params: Record<string, unknown> = VALID_PARAMS,
    ctx = context(),
  ): Promise<string> {
    const result = await poolsLaunchExecuteHandler(params, ctx, {
      broadcast: captureBroadcast as never,
    });
    expect(result.success).toBe(false);
    expect(broadcastCalls, "a refused launch must never reach the broadcaster").toHaveLength(0);
    expect(written, "no intent may be created when the launch was refused").toHaveLength(0);
    expect(consumed).toHaveLength(0);
    return String(result.output);
  }

  it("refuses a value that is not exactly fee + native prebuy", async () => {
    response = prepareResponse(tuple(), { value: (FEE_WEI + PREBUY_WEI + 1n).toString() });
    expect(await expectRefusedWithoutAuthorization()).toContain("value_exact");
  });

  it("refuses a fee recipient the response redirected to someone else", async () => {
    response = prepareResponse(tuple({ feeRecipient: STRANGER }));
    expect(await expectRefusedWithoutAuthorization()).toContain("feeRecipient");
  });

  it("refuses a dev-buy floor that is not the EXACT simulated fill", async () => {
    response = prepareResponse(tuple({ devBuyMinOut: DEV_BUY_OUT - 1n }));
    expect(await expectRefusedWithoutAuthorization()).toContain("dev_buy_consistent");
  });

  it("refuses when the provider itself says the quote is stale", async () => {
    response = prepareResponse(tuple(), { requiresReprepare: true });
    expect(await expectRefusedWithoutAuthorization()).toContain("requires_reprepare");
  });

  it("refuses when the gateway's live fee has moved away from the quote", async () => {
    anchors = anchorReads({ 3: 263_000_000_000_000n });
    expect(await expectRefusedWithoutAuthorization()).toContain("gateway_identity");
  });

  it("refuses when the pair is no longer allowlisted on-chain", async () => {
    anchors = anchorReads({ 8: false });
    expect(await expectRefusedWithoutAuthorization()).toContain("paired_asset_allowlisted");
  });

  it("refuses when the wallet cannot cover value, gas and the Vex fee", async () => {
    balanceWei = FEE_WEI;
    expect(await expectRefusedWithoutAuthorization()).toContain("balance_covers_total");
  });

  it("refuses when the pinned metadata carries no image although one was requested", async () => {
    // THE PROVIDER TRAP, end to end: the request was accepted, the launch would
    // succeed, and the token would render blank forever. The locker resolves a
    // real PNG, the upload succeeds, and the metadata comes back imageless.
    registerLaunchImageByteResolver(async () => ({ bytes: PNG_BYTES, digest: "0xdeadbeef" }));
    vi.spyOn(getPoolsFunClient(), "uploadLaunchImage").mockResolvedValue({
      url: "https://example.test/flamingo.png",
    });
    vi.spyOn(http, "fetchWithTimeout").mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          name: "Vex Flamingo",
          symbol: "VEXFLAM",
          initial_deployer: { address: WALLET },
          initial_fee_recipient: { address: WALLET },
        }),
    } as unknown as Response);

    const output = await expectRefusedWithoutAuthorization({ ...VALID_PARAMS, imageId: "img-1" });
    expect(output).toContain("metadata_matches_request");
  });

  it("refuses a locker image whose bytes are not an image format the launchpad renders", async () => {
    // Sniffed, not assumed: uploading unknown bytes under a guessed MIME type is
    // the same blank-token outcome by another route.
    registerLaunchImageByteResolver(async () => ({
      bytes: new Uint8Array([0x00, 0x01, 0x02, 0x03]),
      digest: "0xdeadbeef",
    }));
    const output = await expectRefusedWithoutAuthorization({ ...VALID_PARAMS, imageId: "img-1" });
    expect(output).toContain("PNG, JPEG, GIF or WebP");
  });

  it("refuses, naming the read, when an anchored fact does not answer", async () => {
    anchors = anchorReads({ 2: undefined });
    expect(await expectRefusedWithoutAuthorization()).toContain("paused flag");
  });

  it("refuses when the launch does not simulate", async () => {
    // The signing seam is STUBBED, never exercised: this suite must be incapable
  // of reaching a real key, and the public client the plan reads from is the
  // fake below.
  vi.spyOn(signingClients, "openLaunchSigningClients").mockImplementation(() => ({
    ok: true,
    clients: {
      publicClient: evmClient.getLocalPublicClient({} as never),
      walletClient: {} as never,
    },
  }));

  vi.spyOn(evmClient, "getLocalPublicClient").mockReturnValue({
      getBlockNumber: async () => BLOCK,
      multicall: async () => anchors,
      getBalance: async () => balanceWei,
      simulateContract: async () => {
        throw Object.assign(new Error("x"), { shortMessage: "execution reverted: PairNotAllowed" });
      },
      estimateGas: async () => 1_800_000n,
      getGasPrice: async () => 22_518_000n,
    } as never);
    expect(await expectRefusedWithoutAuthorization()).toContain("PairNotAllowed");
  });

  it("refuses a restricted session BY NAME, pointing at the launch form", async () => {
    const output = await expectRefusedWithoutAuthorization(
      VALID_PARAMS,
      context({ sessionPermission: "restricted" }),
    );
    expect(output).toContain("pools.launch_request_form");
  });

  it("refuses when the mission's launch VALUE ceiling would be exceeded", async () => {
    vi.spyOn(ceilingModule, "readMissionLaunchCeilings").mockResolvedValue({
      ok: true,
      // 1 wei of authority against a launch that costs a real fee. The decimals
      // travel with the raw amount: the ceiling is never rescaled.
      ceilings: { maxLaunchValueRaw: "1", maxLaunchValueDecimals: 18, maxLaunchCount: 5 },
    } as never);
    const output = await expectRefusedWithoutAuthorization(
      VALID_PARAMS,
      context({ missionId: "m-1", missionRunId: "r-1" }),
    );
    expect(output.toLowerCase()).toContain("mission");
  });
});

describe("the X-handle recipient: manual path only, and sanity-checked", () => {
  /** Build a plan directly, the way the desktop lane does, with a handle recipient. */
  async function planWithHandle(responseRecipient: string) {
    const { buildPoolsLaunchPlan } = await import(
      "@vex-agent/tools/protocols/pools/handlers/launch/execute/plan.js"
    );
    // The pinned metadata names the same recipient the tuple does - point 7
    // checks it, and a disagreement there is its own (real) refusal.
    vi.spyOn(http, "fetchWithTimeout").mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          name: "Vex Flamingo",
          symbol: "VEXFLAM",
          initial_deployer: { address: WALLET },
          initial_fee_recipient: { address: responseRecipient },
        }),
    } as unknown as Response);
    const tupleWithRecipient = tuple({ feeRecipient: getAddress(responseRecipient) });
    response = prepareResponse(tupleWithRecipient);
    return buildPoolsLaunchPlan({
      name: "Vex Flamingo",
      symbol: "VEXFLAM",
      pairedAsset: "weth",
      image: { kind: "none" },
      prebuyWei: PREBUY_WEI,
      prebuyHuman: "0.01",
      sessionId: "sess-1",
      walletAddress: WALLET,
      feeRecipient: { kind: "x_username", username: "vex" },
      permission: "full",
      publicClient: evmClient.getLocalPublicClient({} as never),
    });
  }

  it("takes the launchpad's resolved address as the expectation, and the tuple must mirror it", async () => {
    // Vex cannot prove a handle maps to an address - only the launchpad knows.
    // What IS proven is that the tuple, the response and the address shown to
    // the user are the same address (point 4), and that those bytes are what
    // gets signed.
    const resolved = "0x1234567890123456789012345678901234567890";
    const planned = await planWithHandle(resolved);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.binding.feeRecipient).toBe(getAddress(resolved));
  });

  it("refuses a resolution to the ZERO address instead of letting the gateway substitute msg.sender", async () => {
    const planned = await planWithHandle("0x0000000000000000000000000000000000000000");
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.reason).toContain("zero address");
  });

  it.each([
    ["the launch gateway itself", POOLS_GATEWAY_ADDRESS],
    ["the launchpad factory", POOLS_FACTORY_ADDRESS],
    ["the fee locker", POOLS_LOCKER_ADDRESS],
  ])("refuses a resolution to %s - fees there can never be claimed", async (_label, address) => {
    const planned = await planWithHandle(address);
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.reason).toContain("never be claimed");
  });

  it("NEVER coerces a handle into the session wallet", async () => {
    const resolved = "0x1234567890123456789012345678901234567890";
    const planned = await planWithHandle(resolved);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // A fee stream that quietly went to the launching wallet instead of where
    // the user aimed it is the exact defect this path exists to avoid.
    expect(planned.plan.binding.feeRecipient).not.toBe(WALLET);
  });
});
