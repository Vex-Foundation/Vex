/**
 * `executeUserSubmittedLaunch` — the launch the HUMAN deployed.
 *
 * This path's authorizing record is PERSISTED, because the consent happened in
 * another process minutes earlier. That makes the stored snapshot gate input —
 * the one deliberate exception to the doctrine in `authorization.ts` — so what
 * is pinned here is the discipline that makes reading it safe:
 *
 *   - the CAS is the exactly-once gate: a second Deploy refuses by name;
 *   - the stored record is UNTRUSTED: malformed or half-written refuses;
 *   - it must agree with its own intent row, or it is evidence of tampering;
 *   - the fresh re-derivation is compared against the SNAPSHOT, and drift —
 *     including a swapped image digest — refuses and settles the intent;
 *   - the fee ordering is unchanged: planned early, charged last.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { getAddress } from "viem";

import {
  registerLaunchImageByteResolver,
  resetLaunchImageByteResolver,
} from "@vex-agent/tools/protocols/trench/launch-image-byte-resolver.js";
import { TRENCH_CREATION_FEE_SLOT, TRENCH_CREATION_FEE_FIXTURE } from "@tools/trench-express/evm/creation-fee.js";
import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";

const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const FEE = TRENCH_CREATION_FEE_FIXTURE.feeWei;
const PREBUY = 300_000_000_000_000n;
const ANCHOR = 25_749_542n;
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const DIGEST = "0xstoreddigest";

let intentRow: Record<string, unknown> | null;
let consumeResult: unknown;
let mockConsume: Mock;
let mockBroadcast: Mock;
let mockSettleFailure: Mock;

function reset(): void {
  consumeResult = { intentId: "i1" };
  mockConsume = vi.fn(async () => consumeResult);
  mockBroadcast = vi.fn(async () => ({ success: true, output: "broadcast", data: {} }));
  mockSettleFailure = vi.fn(async () => undefined);
  intentRow = {
    intentId: "i1",
    sessionId: "sess-1",
    origin: "user",
    status: "authorized",
    chainId: TRENCH_CHAIN_ID,
    walletAddress: WALLET,
    name: "Vex x Trench",
    symbol: "VEXTE",
    description: "a launch",
    imageId: "img_01",
    prebuyRaw: PREBUY.toString(),
    prebuyDecimals: 18,
    authorizationKind: "user_submit",
    authorizationJson: storedBinding(),
  };
}

/** The persisted snapshot, optionally perturbed to simulate drift or tampering. */
let derivedBinding: Record<string, unknown> = {};
function storedBinding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...derivedBinding, ...over };
}

reset();

vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({}),
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  acquireSessionControlLock: async () => undefined,
}));
vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  getById: async () => intentRow,
  consumeIfAuthorizedWith: (...a: unknown[]) => mockConsume(...a),
}));
vi.mock("@vex-agent/tools/protocols/trench/handlers/launch/execute/authorize.js", () => ({
  settleLaunchFailure: (...a: unknown[]) => mockSettleFailure(...a),
}));
vi.mock("@vex-agent/tools/protocols/trench/handlers/launch/execute/broadcast.js", () => ({
  broadcastLaunch: (...a: unknown[]) => mockBroadcast(...a),
}));
function submitTimePublicClient() {
  return {
    async getBlockNumber() { return ANCHOR; },
    async getStorageAt(args: { slot: string }) {
      return args.slot.toLowerCase() === TRENCH_CREATION_FEE_SLOT.toLowerCase()
        ? TRENCH_CREATION_FEE_FIXTURE.rawWord
        : undefined;
    },
    async estimateGas() { return 2_000_000n; },
    async getGasPrice() { return 20_000_000n; },
    async getBalance() { return 10n ** 20n; },
  } as never;
}

vi.mock("@vex-agent/tools/protocols/trench/handlers/launch/execute/clients.js", () => ({
  openLaunchSigningClients: () => ({
    ok: true,
    clients: { publicClient: submitTimePublicClient(), walletClient: {} },
  }),
}));

const { executeUserSubmittedLaunch, USER_SUBMIT_LAUNCH_DEPS, parseStoredBinding } = await import(
  "@vex-agent/tools/protocols/trench/handlers/launch/execute-user-submit.js"
);
const { buildLaunchPlan } = await import(
  "@vex-agent/tools/protocols/trench/handlers/launch/plan.js"
);

/**
 * The snapshot main ACTUALLY persists: the binding produced by a real
 * `buildLaunchPlan` at submit time. Deriving it rather than hand-writing one is
 * the point — a hand-written calldata or fingerprint would make the drift gate
 * pass or fail for reasons unrelated to what this test is about.
 */
async function authorizedBinding(): Promise<Record<string, unknown>> {
  registerLaunchImageByteResolver(async () => ({ bytes: IMAGE_BYTES, digest: DIGEST }));
  const planned = await buildLaunchPlan({
    request: {
      name: "Vex x Trench",
      symbol: "VEXTE",
      description: "a launch",
      links: ["https://vex.example"],
      imageId: "img_01",
      prebuyWei: PREBUY,
    },
    sessionId: "sess-1",
    walletAddress: WALLET,
    permission: "full",
    publicClient: submitTimePublicClient(),
    planFeeLeg: USER_SUBMIT_LAUNCH_DEPS.planFeeLeg,
    nativeAddress: "0x0000000000000000000000000000000000000000",
  } as never);
  if (!planned.ok) throw new Error(`fixture plan failed: ${planned.reason}`);
  return planned.plan.binding as unknown as Record<string, unknown>;
}

function input(over: Record<string, unknown> = {}) {
  return {
    intentId: "i1",
    sessionId: "sess-1",
    walletResolution: {},
    walletPolicy: {},
    ...over,
  } as never;
}

beforeEach(async () => {
  derivedBinding = await authorizedBinding();
  reset();
  registerLaunchImageByteResolver(async () => ({ bytes: IMAGE_BYTES, digest: DIGEST }));
});

afterEach(() => {
  resetLaunchImageByteResolver();
});

describe("the exactly-once gate", () => {
  it("broadcasts when the snapshot matches the fresh derivation", async () => {
    const result = await executeUserSubmittedLaunch(input());
    expect(result.success).toBe(true);
    expect(mockConsume).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
  });

  it("refuses a SECOND Deploy by name — the CAS miss, not a race", async () => {
    consumeResult = null;
    const result = await executeUserSubmittedLaunch(input());
    expect(result.success).toBe(false);
    expect(result.output).toContain("already deployed");
    expect(result.output).toContain("Nothing was signed");
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("refuses an intent that is not awaiting deployment", async () => {
    intentRow = { ...intentRow!, status: "confirmed" };
    const result = await executeUserSubmittedLaunch(input());
    expect(result.success).toBe(false);
    expect(result.output).toContain("confirmed");
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it("refuses an intent belonging to another session", async () => {
    intentRow = null;
    const result = await executeUserSubmittedLaunch(input());
    expect(result.success).toBe(false);
    expect(result.output).toContain("belongs to this session");
  });

  it("refuses an agent-path authorization — those keep their mission gates", async () => {
    intentRow = { ...intentRow!, authorizationKind: "full_autonomy" };
    const result = await executeUserSubmittedLaunch(input());
    expect(result.success).toBe(false);
    expect(result.output).toContain("only the agent path may execute");
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe("the stored snapshot is untrusted input", () => {
  it("refuses when no authorization record was stored at all", async () => {
    intentRow = { ...intentRow!, authorizationJson: null };
    const result = await executeUserSubmittedLaunch(input());
    expect(result.success).toBe(false);
    expect(result.output).toContain("incomplete");
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it("names the missing fields of a half-written record instead of defaulting them", async () => {
    const partial = storedBinding();
    delete partial.creationFeeWei;
    delete partial.calldata;
    intentRow = { ...intentRow!, authorizationJson: partial };
    const result = await executeUserSubmittedLaunch(input());
    expect(result.success).toBe(false);
    expect(result.output).toContain("creationFeeWei");
    expect(result.output).toContain("calldata");
  });

  it("refuses a record naming another chain", async () => {
    intentRow = { ...intentRow!, authorizationJson: storedBinding({ chainId: 1 }) };
    const result = await executeUserSubmittedLaunch(input());
    expect(result.success).toBe(false);
    expect(result.output).toContain("not Robinhood Chain");
  });

  it("validates directly: a non-object, an array, and a good record", () => {
    expect(parseStoredBinding(null).ok).toBe(false);
    expect(parseStoredBinding([]).ok).toBe(false);
    expect(parseStoredBinding("{}").ok).toBe(false);
    expect(parseStoredBinding(storedBinding({ links: [1, 2] })).ok).toBe(false);
    expect(parseStoredBinding(storedBinding()).ok).toBe(true);
  });
});

describe("the record must agree with its own intent row", () => {
  it.each([
    ["symbol", { symbol: "OTHER" }],
    ["imageId", { imageId: "img_99" }],
    ["prebuyWei", { prebuyWei: "999" }],
    ["walletAddress", { walletAddress: "0x1111111111111111111111111111111111111111" }],
  ])("refuses when the record's %s disagrees with the row", async (field, over) => {
    intentRow = { ...intentRow!, authorizationJson: storedBinding(over) };
    const result = await executeUserSubmittedLaunch(input());
    expect(result.success).toBe(false);
    expect(result.output).toContain("disagrees with the launch it belongs to");
    expect(result.output).toContain(field);
    // Tampering is caught BEFORE the intent is consumed.
    expect(mockConsume).not.toHaveBeenCalled();
  });
});

describe("drift against the snapshot refuses and settles", () => {
  it("refuses when the locker image bytes changed — consent was for specific bytes", async () => {
    registerLaunchImageByteResolver(async () => ({
      bytes: new Uint8Array([0x00, 0x01]),
      digest: "0xDIFFERENTDIGEST",
    }));
    const result = await executeUserSubmittedLaunch(input());
    expect(result.success).toBe(false);
    expect(result.output).toContain("imageDigest");
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockSettleFailure).toHaveBeenCalledWith("i1", "sess-1", "AuthorizationDrift:user_submit");
  });

  it("refuses when the creation fee moved between consent and deployment", async () => {
    intentRow = {
      ...intentRow!,
      authorizationJson: storedBinding({ creationFeeWei: (FEE + 1n).toString() }),
    };
    const result = await executeUserSubmittedLaunch(input());
    expect(result.success).toBe(false);
    expect(result.output).toContain("creationFeeWei");
    expect(mockSettleFailure).toHaveBeenCalled();
  });
});

describe("the fee seam", () => {
  it("defaults to the WIRED fee deps — never the agent handler's no-fee default", () => {
    expect(USER_SUBMIT_LAUNCH_DEPS.runFeeLeg).not.toBeNull();
    expect(USER_SUBMIT_LAUNCH_DEPS.planFeeLeg).toBeTypeOf("function");
  });

  it("hands the same deps to the broadcast leg, so the fee still runs LAST", async () => {
    await executeUserSubmittedLaunch(input());
    expect(mockBroadcast.mock.calls[0]![0].deps).toBe(USER_SUBMIT_LAUNCH_DEPS);
  });
});
