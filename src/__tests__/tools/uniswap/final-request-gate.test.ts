/**
 * The Uniswap lane proves the FINAL request before it signs it.
 *
 * ## The defect this file pins
 *
 * `signUniswapTransaction` signs the object `prepareTransactionRequest`
 * returns, not the `BuiltSwapTx` the handler passed in: viem may fill fees or
 * route preparation through the node, and the reply is what gets serialized.
 * Until now nothing looked at that object. The handler's floor checks were all
 * statements about VARIABLES - a `to`, a `value` or an `amountOutMin` that
 * differed in the bytes about to be signed would have been signed anyway.
 *
 * Two seams, deliberately:
 *
 *   1. `prepareTransactionRequest` on a fake client, to prove the gate is shown
 *      PREPARATION's fields and that a refusal signs nothing (mirrors
 *      `staged-broadcast-final-request-gate.test.ts`).
 *   2. The REAL encoder: every `verifyFinalUniswapSwapRequest` case below is
 *      driven over bytes `buildSwapTx` actually produced, and the "altered"
 *      cases re-encode with the REAL encoder at a different floor. A test that
 *      compared a closure to itself would prove only that the encoder is
 *      deterministic, which is the exact non-proof this guard exists to replace.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseUnits,
  type Address,
  type Chain,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import { buildSwapTx, signUniswapTransaction } from "@tools/uniswap/execute.js";
import { getUniswapDeployment, type UniswapDeployment } from "@tools/uniswap/deployments.js";
import {
  assertFinalUniswapSwapRequest,
  decodeUniswapSwapFloor,
  UniswapFinalRequestRefusal,
  verifyFinalUniswapSwapRequest,
  type ApprovedFinalRequest,
} from "@tools/uniswap/final-request-guard.js";
import type { FinalSignedRequest } from "@tools/evm-chains/staged-broadcast.js";

const ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`);
const CHAIN: Chain = base;
const SERIALIZED = "0xdeadbeef" as Hex;

/** The REAL base deployment - routers and WETH come from the registry, never from a literal. */
const DEPLOYMENT = ((): UniswapDeployment & { v2: NonNullable<UniswapDeployment["v2"]>; v3: NonNullable<UniswapDeployment["v3"]> } => {
  const found = getUniswapDeployment(CHAIN.id);
  if (found === undefined || found.v2 === undefined || found.v3 === undefined) {
    throw new Error("test expects a base deployment with V2 and V3");
  }
  return { ...found, v2: found.v2, v3: found.v3 };
})();
const V2_ROUTER = getAddress(DEPLOYMENT.v2.router02);
const V3_ROUTER = getAddress(DEPLOYMENT.v3.swapRouter02);

const TOKEN_IN = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const TOKEN_OUT = getAddress("0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31");
const RECIPIENT = getAddress("0x1111111111111111111111111111111111111111");
const ATTACKER = getAddress("0x9999999999999999999999999999999999999999");
const OTHER_TOKEN = getAddress("0x4200000000000000000000000000000000000042");
const DEADLINE = 1_900_000_000n;

const AMOUNT_IN = parseUnits("1", 18);
/** The floor the human approved, and the ONLY one these bytes may carry. */
const APPROVED_FLOOR = parseUnits("990", 18);

function v2Route(path: readonly Address[] = [TOKEN_IN, TOKEN_OUT]) {
  return { version: "v2" as const, path: [...path], amountOut: parseUnits("1000", 18) };
}
function v3Route(path: readonly Address[] = [TOKEN_IN, TOKEN_OUT]) {
  return { version: "v3" as const, path: [...path], fees: [3000], amountOut: parseUnits("1000", 18) };
}

function builtWith(args: {
  route: ReturnType<typeof v2Route> | ReturnType<typeof v3Route>;
  minAmountOut?: bigint;
  amountIn?: bigint;
  recipient?: Address;
  tokenInIsNative?: boolean;
  tokenOutIsNative?: boolean;
}) {
  return buildSwapTx({
    deployment: DEPLOYMENT,
    route: args.route,
    amountIn: args.amountIn ?? AMOUNT_IN,
    minAmountOut: args.minAmountOut ?? APPROVED_FLOOR,
    recipient: args.recipient ?? RECIPIENT,
    deadline: DEADLINE,
    tokenInIsNative: args.tokenInIsNative ?? false,
    tokenOutIsNative: args.tokenOutIsNative ?? false,
  });
}

/** The approved trade's own transaction, for the fields a scenario does not vary. */
const built = builtWith;

function request(over: Partial<FinalSignedRequest> & { to?: Address }): FinalSignedRequest {
  return { to: V2_ROUTER, data: "0x" as Hex, value: 0n, gas: 300_000n, nonce: 3, ...over };
}

/**
 * The authority for a scenario. `builtTransaction` defaults to the transaction
 * the scenario itself built, which is what the handler passes: the equality
 * layer is anchored to the object being signed, never to a second literal.
 */
function approvedFor(
  builtTransaction: { to: Address; data: Hex; value: bigint },
  over: Partial<ApprovedFinalRequest> = {},
): ApprovedFinalRequest {
  return {
    expectedRouter: V2_ROUTER,
    approvedMinOutRaw: APPROVED_FLOOR.toString(),
    expectedValueRaw: "0",
    builtTransaction,
    ...over,
  };
}

describe("the floor is read out of the REAL encoded bytes", () => {
  it("reads a V2 token-to-token floor", () => {
    expect(decodeUniswapSwapFloor(built({ route: v2Route() }).data)).toBe(APPROVED_FLOOR);
  });

  it("reads a V2 native-input floor (a different argument position)", () => {
    expect(decodeUniswapSwapFloor(built({ route: v2Route(), tokenInIsNative: true }).data))
      .toBe(APPROVED_FLOOR);
  });

  it("reads a V2 native-output floor", () => {
    expect(decodeUniswapSwapFloor(built({ route: v2Route(), tokenOutIsNative: true }).data))
      .toBe(APPROVED_FLOOR);
  });

  it("reads a V3 floor through the multicall wrapper", () => {
    expect(decodeUniswapSwapFloor(built({ route: v3Route() }).data)).toBe(APPROVED_FLOOR);
  });

  it("reads a V3 native-output floor, where the unwrap carries it too", () => {
    expect(decodeUniswapSwapFloor(built({ route: v3Route(), tokenOutIsNative: true }).data))
      .toBe(APPROVED_FLOOR);
  });

  it("refuses to guess at calldata that is not a swap this venue builds", () => {
    expect(decodeUniswapSwapFloor("0xdeadbeef" as Hex)).toBeNull();
  });
});

describe("layer one: byte equality with the transaction this execute built", () => {
  it("passes the request the approved quote authorized", () => {
    const tx = built({ route: v2Route() });
    expect(verifyFinalUniswapSwapRequest(request({ to: tx.to, data: tx.data, value: tx.value }), approvedFor(tx)))
      .toEqual({ ok: true });
  });

  it("REFUSES an altered `to`: a router the route was not approved for", () => {
    const tx = built({ route: v2Route() });
    const verdict = verifyFinalUniswapSwapRequest(
      request({ to: V3_ROUTER, data: tx.data, value: tx.value }),
      approvedFor(tx),
    );
    expect(verdict).toMatchObject({ ok: false, kind: "build_integrity" });
    expect(verdict.ok === false && verdict.reason).toContain("not the router");
  });

  it("REFUSES an altered ERC-20 INPUT AMOUNT - the field no argument-by-argument guard was reading", () => {
    const tx = built({ route: v2Route() });
    // Same router, same floor, same path, same recipient: only the amount the
    // router is told to pull from the wallet differs. The floor decode passes
    // this one by construction, so equality is the only thing that can refuse it.
    const tampered = builtWith({ route: v2Route(), amountIn: AMOUNT_IN * 10n });
    expect(decodeUniswapSwapFloor(tampered.data)).toBe(APPROVED_FLOOR);

    const verdict = verifyFinalUniswapSwapRequest(
      request({ to: tampered.to, data: tampered.data, value: tampered.value }),
      approvedFor(tx),
    );
    expect(verdict).toMatchObject({ ok: false, kind: "build_integrity" });
    expect(verdict.ok === false && verdict.reason).toContain("byte-for-byte");
  });

  it("REFUSES an altered PATH, which is an altered OUTPUT TOKEN", () => {
    const tx = built({ route: v2Route() });
    const tampered = built({ route: v2Route([TOKEN_IN, OTHER_TOKEN]) });
    expect(decodeUniswapSwapFloor(tampered.data)).toBe(APPROVED_FLOOR);

    expect(verifyFinalUniswapSwapRequest(
      request({ to: tampered.to, data: tampered.data, value: tampered.value }),
      approvedFor(tx),
    )).toMatchObject({ ok: false, kind: "build_integrity" });
  });

  it("REFUSES an altered RECIPIENT - the output paid to someone else", () => {
    const tx = built({ route: v2Route() });
    const tampered = builtWith({ route: v2Route(), recipient: ATTACKER });
    expect(decodeUniswapSwapFloor(tampered.data)).toBe(APPROVED_FLOOR);

    expect(verifyFinalUniswapSwapRequest(
      request({ to: tampered.to, data: tampered.data, value: tampered.value }),
      approvedFor(tx),
    )).toMatchObject({ ok: false, kind: "build_integrity" });
  });

  it("REFUSES an altered CALL SHAPE: the V2 body swapped for the V3 multicall", () => {
    const tx = built({ route: v2Route() });
    const tampered = built({ route: v3Route() });
    // Decodable, at the approved floor, and still not the transaction this
    // execute decided on.
    expect(decodeUniswapSwapFloor(tampered.data)).toBe(APPROVED_FLOOR);

    expect(verifyFinalUniswapSwapRequest(
      // The V3 body sent to the V2 router the authority names, so the router
      // check cannot be what refuses it.
      request({ to: V2_ROUTER, data: tampered.data, value: tampered.value }),
      approvedFor(tx),
    )).toMatchObject({ ok: false, kind: "build_integrity" });
  });

  it("REFUSES altered `value`: native attached to a trade approved as ERC-20 input", () => {
    const tx = built({ route: v2Route() });
    const verdict = verifyFinalUniswapSwapRequest(
      request({ to: tx.to, data: tx.data, value: 1n }),
      approvedFor(tx),
    );
    expect(verdict).toMatchObject({ ok: false, kind: "build_integrity" });
    expect(verdict.ok === false && verdict.reason).toContain("native value");
  });

  it("binds the native input EXACTLY on a native-in trade", () => {
    const tx = built({ route: v2Route(), tokenInIsNative: true });
    const approved = approvedFor(tx, { expectedValueRaw: AMOUNT_IN.toString() });

    expect(verifyFinalUniswapSwapRequest(request({ to: tx.to, data: tx.data, value: tx.value }), approved))
      .toEqual({ ok: true });
    // One wei more than the approval covers is a different trade.
    expect(verifyFinalUniswapSwapRequest(request({ to: tx.to, data: tx.data, value: tx.value + 1n }), approved))
      .toMatchObject({ ok: false, kind: "build_integrity" });
  });

  it("REFUSES a request with no target or no calldata rather than describing it", () => {
    const tx = built({ route: v2Route() });
    expect(verifyFinalUniswapSwapRequest(request({ to: undefined, data: "0x" as Hex }), approvedFor(tx)))
      .toMatchObject({ ok: false, kind: "build_integrity" });
    expect(verifyFinalUniswapSwapRequest({ ...request({}), data: undefined }, approvedFor(tx)))
      .toMatchObject({ ok: false, kind: "build_integrity" });
  });

  it("throws the typed refusal, carrying the way forward", () => {
    const tx = built({ route: v2Route() });
    try {
      assertFinalUniswapSwapRequest(request({ to: V3_ROUTER, data: tx.data, value: tx.value }), approvedFor(tx));
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(UniswapFinalRequestRefusal);
      expect((err as Error).message).toContain("Nothing was signed");
      expect((err as Error).message).toContain("uniswap__swap_quote");
    }
  });
});

/**
 * Layer two is NOT redundant, and these cases are the proof: in every one of
 * them the bytes ARE the transaction that was built (equality passes), and the
 * floor read out of those bytes is still not the approved one. This is the
 * encoder-regression lane - a build that started writing the wrong floor would
 * satisfy provenance perfectly.
 */
describe("layer two: the floor is really in the bytes", () => {
  it("REFUSES a built transaction whose encoded floor is below the approved one", () => {
    const tampered = built({ route: v2Route(), minAmountOut: APPROVED_FLOOR / 100n });
    const verdict = verifyFinalUniswapSwapRequest(
      request({ to: tampered.to, data: tampered.data, value: tampered.value }),
      // Equality can only pass here, because the built transaction IS the
      // tampered one.
      approvedFor(tampered),
    );
    expect(verdict).toMatchObject({ ok: false, kind: "price_floor" });
    expect(verdict.ok === false && verdict.reason).toContain(APPROVED_FLOOR.toString());
  });

  it("REFUSES a floor that is HIGHER than approved too - the execute writes the approved one, not a better one", () => {
    const tampered = built({ route: v2Route(), minAmountOut: APPROVED_FLOOR + 1n });
    expect(verifyFinalUniswapSwapRequest(
      request({ to: tampered.to, data: tampered.data, value: tampered.value }),
      approvedFor(tampered),
    )).toMatchObject({ ok: false, kind: "price_floor" });
  });

  it("REFUSES calldata it cannot decode as this venue's swap, even when it is what was built", () => {
    const undecodable = { to: V2_ROUTER, data: "0xdeadbeef" as Hex, value: 0n };
    expect(verifyFinalUniswapSwapRequest(
      request(undecodable),
      approvedFor(undecodable),
    )).toMatchObject({ ok: false, kind: "build_integrity" });
  });
});

// ── The gate sees PREPARATION's request, and a refusal signs nothing ──────────

/** What the CALLER asks to sign. */
const REQUESTED = { to: V2_ROUTER, data: "0xaaaa" as Hex, value: 0n };
/** What PREPARATION returns instead - a different target, blob and value. */
const ALTERED = {
  to: "0x9999999999999999999999999999999999999999" as Address,
  data: "0xbbbb" as Hex,
  value: 777n,
};

function harness() {
  // A real `prepareTransactionRequest` always returns a priced request, and the
  // offline signature this venue takes needs the fee fields to infer the
  // transaction type - the same fields the pre-sign gate prices the leg from.
  const prepared = {
    ...ALTERED,
    gas: 30_000n,
    nonce: 7,
    chain: CHAIN,
    maxFeePerGas: 1_000_000n,
    maxPriorityFeePerGas: 1_000n,
  };
  const transport = (): Transport => http("http://127.0.0.1:1");

  const publicClient = Object.assign(
    createPublicClient({ chain: CHAIN, transport: transport() }),
    { estimateGas: vi.fn(async () => 21_000n) },
  );
  const signTransaction = vi.fn(async (_request: Record<string, unknown>) => SERIALIZED);
  const walletClient = Object.assign(
    createWalletClient({ account: ACCOUNT, chain: CHAIN, transport: transport() }),
    {
      chain: CHAIN,
      prepareTransactionRequest: vi.fn(async () => prepared),
      signTransaction,
    },
  );
  return { publicClient, walletClient, signTransaction };
}

const reserveNonce = async (r: { nodePendingNonce: number }) => r.nodePendingNonce;

describe("signUniswapTransaction's pre-sign fence", () => {
  it("hands the gate PREPARATION's to/data/value with the headroomed gas, not the caller's tx", async () => {
    const h = harness();
    const onBeforeSign = vi.fn(async (_r: FinalSignedRequest) => {});

    await signUniswapTransaction(
      h.publicClient, h.walletClient, REQUESTED,
      undefined, reserveNonce, onBeforeSign,
    );

    expect(onBeforeSign).toHaveBeenCalledTimes(1);
    expect(onBeforeSign).toHaveBeenCalledWith({
      to: ALTERED.to,
      data: ALTERED.data,
      value: ALTERED.value,
      gas: gasLimitWithHeadroom(21_000n),
      nonce: 7,
      // The PRICES the request carries, because gas units times an unknown
      // price is not money and the debit gate needs both.
      gasPrice: undefined,
      maxFeePerGas: 1_000_000n,
      maxPriorityFeePerGas: 1_000n,
    });
  });

  it("refuses to sign at all when the resolved wallet cannot sign locally", async () => {
    const h = harness();
    // A JSON-RPC account can only be signed for THROUGH the node, which is
    // exactly the round trip the fence exists to exclude. Refused, rather than
    // silently downgraded to the wallet action that reopens it.
    const remote = createWalletClient({
      account: getAddress("0x2222222222222222222222222222222222222222"),
      chain: CHAIN,
      transport: http("http://127.0.0.1:1"),
    });
    const walletClient = Object.assign(remote, {
      chain: CHAIN,
      prepareTransactionRequest: h.walletClient.prepareTransactionRequest,
      signTransaction: h.signTransaction,
    });

    await expect(signUniswapTransaction(
      h.publicClient, walletClient, REQUESTED, undefined, reserveNonce,
    )).rejects.toMatchObject({ name: "UniswapOfflineSignerUnavailableError" });

    expect(h.signTransaction).not.toHaveBeenCalled();
  });

  it("signs NOTHING when the gate refuses", async () => {
    const h = harness();

    await expect(signUniswapTransaction(
      h.publicClient, h.walletClient, REQUESTED,
      undefined, reserveNonce,
      async () => { throw new UniswapFinalRequestRefusal({ ok: false, kind: "price_floor", reason: "test refusal" }); },
    )).rejects.toBeInstanceOf(UniswapFinalRequestRefusal);

    expect(h.signTransaction).not.toHaveBeenCalled();
  });

  it("signs the prepared request when no gate is supplied - the allowance legs are unchanged", async () => {
    const h = harness();

    const signed = await signUniswapTransaction(
      h.publicClient, h.walletClient, REQUESTED, undefined, reserveNonce,
    );

    // Signed OFFLINE by the local account, so these are real signed bytes and
    // viem's wallet action - the one that would have asked the node for a chain
    // id between the fence and the signature - was never taken.
    expect(signed.serializedTransaction.startsWith("0x")).toBe(true);
    expect(signed.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.signTransaction).not.toHaveBeenCalled();
  });
});
