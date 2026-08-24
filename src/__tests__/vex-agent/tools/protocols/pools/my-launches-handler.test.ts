/**
 * `pools.my_launches` - the wallet is server-resolved and the emptiness is
 * honest.
 *
 * Two properties this suite holds:
 * 1. There is NO wallet parameter, and supplying one must not widen the read.
 *    A read tool that let the model name the wallet would let it read another
 *    wallet's launch history.
 * 2. An unresolvable wallet FAILS here rather than degrading. The discovery
 *    lists can afford to lose a flag; a tool whose whole answer is the word
 *    "yours" cannot.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { POOLS_HANDLERS } from "@vex-agent/tools/protocols/pools/handlers.js";
import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import { validateDiscoverPage } from "@tools/pools-fun/validation.js";
import * as walletResolve from "@vex-agent/tools/internal/wallet/resolve.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import { makeProtocolContext } from "../../_test-context.js";
import { captureResponse, CAPTURES } from "../../../../pools-fun/_captures.js";

const CTX: ProtocolExecutionContext = makeProtocolContext();
const SESSION_EVM = "0x5793b76e33669334701c60297500fd05300e13af";
const SOMEONE_ELSE = "0x1111111111111111111111111111111111111111";

function stubResolvedWallet(evm: string | null): void {
  const spy = vi.spyOn(walletResolve, "resolveSelectedAddressForRead");
  if (evm === null) {
    spy.mockImplementation(() => {
      throw new VexError(ErrorCodes.WALLET_NOT_CONFIGURED, "no wallet configured");
    });
  } else {
    spy.mockReturnValue(evm);
  }
}

function stubDiscover(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(getPoolsFunClient(), "discover").mockResolvedValue(
    validateDiscoverPage(captureResponse(CAPTURES.discoverPoolsFun)),
  );
}

async function myLaunches(params: Record<string, unknown>) {
  return POOLS_HANDLERS["pools.my_launches"]!(params, CTX);
}

afterEach(() => vi.restoreAllMocks());

describe("pools.my_launches resolves the wallet server-side", () => {
  it("queries the deployer index for the SESSION wallet", async () => {
    stubResolvedWallet(SESSION_EVM);
    const spy = stubDiscover();

    const res = await myLaunches({});
    expect(res.success).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ deployerAddress: SESSION_EVM }),
      { signal: CTX.abortSignal },
    );
    expect((JSON.parse(res.output) as { wallet: string }).wallet).toBe(SESSION_EVM);
  });

  it("ignores a wallet the model tries to smuggle in through params", async () => {
    stubResolvedWallet(SESSION_EVM);
    const spy = stubDiscover();

    await myLaunches({ walletAddress: SOMEONE_ELSE, deployerAddress: SOMEONE_ELSE });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ deployerAddress: SESSION_EVM }),
      { signal: CTX.abortSignal },
    );
  });

  it("fails loudly when the session wallet cannot be resolved", async () => {
    stubResolvedWallet(null);
    const res = await myLaunches({});
    expect(res.success).toBe(false);
    expect(res.output).toContain("pools__my_launches_list");
  });
});

describe("pools.my_launches output", () => {
  it("marks every returned row as the caller's own launch", async () => {
    stubResolvedWallet(SESSION_EVM);
    stubDiscover();

    const res = await myLaunches({});
    const data = JSON.parse(res.output) as {
      launches: { deployer: string | null; isOwnLaunch?: boolean }[];
      note: string;
    };
    const own = data.launches.filter((r) => r.deployer?.toLowerCase() === SESSION_EVM);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((r) => r.isOwnLaunch === true)).toBe(true);
  });

  it("paginates a longer launch history", async () => {
    stubResolvedWallet(SESSION_EVM);
    const spy = stubDiscover();

    const res = await myLaunches({ cursor: "eyJ2IjozfQ==" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ deployerAddress: SESSION_EVM, cursor: "eyJ2IjozfQ==" }),
      { signal: CTX.abortSignal },
    );
    expect(JSON.parse(res.output)).toHaveProperty("nextCursor");
  });

  it("says what an empty list does and does not prove", async () => {
    stubResolvedWallet(SESSION_EVM);
    vi.spyOn(getPoolsFunClient(), "discover").mockResolvedValue(
      validateDiscoverPage(captureResponse(CAPTURES.discoverEmpty)),
    );

    const res = await myLaunches({});
    const data = JSON.parse(res.output) as { count: number; note: string };
    expect(data.count).toBe(0);
    expect(data.note).toContain("not the same as");
  });

  it("does NOT warn that gateway launches are missing, because they are not", async () => {
    // Measured 2026-08-18: a token launched through the pools.fun gateway is
    // indexed under the LAUNCHING WALLET, not the gateway contract, so the
    // deployer query returns it. The capture below is that response; an earlier
    // version of this handler carried a caveat claiming the opposite, which
    // would have taught the agent to distrust a correct answer.
    const GATEWAY_LAUNCHER = "0x1111111111111111111111111111111111111111";
    const GATEWAY_CONTRACT = "0x3AB42e7dd316aF8854033bc216C657eD34961164";
    stubResolvedWallet(GATEWAY_LAUNCHER);
    vi.spyOn(getPoolsFunClient(), "discover").mockResolvedValue(
      validateDiscoverPage(captureResponse(CAPTURES.discoverDeployerGatewayLaunch)),
    );

    const res = await myLaunches({});
    const data = JSON.parse(res.output) as {
      count: number;
      note: string;
      launches: { token: string; deployer: string | null; isOwnLaunch?: boolean }[];
    };

    expect(data.count).toBe(1);
    expect(data.launches[0]!.deployer?.toLowerCase()).toBe(GATEWAY_LAUNCHER);
    expect(data.launches[0]!.deployer?.toLowerCase()).not.toBe(GATEWAY_CONTRACT.toLowerCase());
    expect(data.launches[0]!.isOwnLaunch).toBe(true);
    expect(data.note).toContain("gateway DO appear here");
  });
});
