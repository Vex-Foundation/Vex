/**
 * `pools.launch_preview` and `pools.launch_request_form`.
 *
 * Neither tool signs anything, so what these tests protect is the OTHER kind of
 * money-path property: that a preview stays advisory and non-live, that a form
 * request stays a proposal rather than a decision, and that the parameters the
 * launch surface deliberately does not have cannot be smuggled in through
 * either of them.
 *
 * The database is mocked at the repo seam - the DDL and the constraint behaviour
 * are proven separately against real Postgres by
 * `agents_dm/pools-fun-live/migration-082-apply-proof.ts`, which is the only
 * place they CAN be proven. Here the question is what the handler asks the repo
 * to write.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import * as intents from "@vex-agent/db/repos/token-launch-intents.js";
import * as dbClient from "@vex-agent/db/client.js";
import * as lease from "@vex-agent/engine/runtime/lease-and-status.js";
import * as walletResolve from "@vex-agent/tools/internal/wallet/resolve.js";
import { POOLS_HANDLERS } from "@vex-agent/tools/protocols/pools/handlers.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { makeProtocolContext } from "../../_test-context.js";

const WALLET = "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA";
const FEE_WEI = "1051674002092832";

/** Captured `createWith` inputs, so the tests can assert what was written. */
let written: Record<string, unknown>[] = [];

function context(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return makeProtocolContext({ sessionId: "sess-1", toolCallId: "call-1", ...over });
}

beforeEach(() => {
  written = [];
  vi.spyOn(walletResolve, "resolveSelectedAddress").mockReturnValue(WALLET);
  vi.spyOn(lease, "acquireSessionControlLock").mockResolvedValue(undefined as never);
  // `withTransaction` hands the callback a client; the repo call is stubbed, so
  // the client only has to exist.
  vi.spyOn(dbClient, "withTransaction").mockImplementation(
    async (fn: (client: never) => Promise<unknown>) => fn({} as never) as never,
  );
  vi.spyOn(intents, "createWith").mockImplementation(async (_client, input) => {
    written.push(input as unknown as Record<string, unknown>);
    return { intentId: (input as { intentId: string }).intentId } as never;
  });
  vi.spyOn(getPoolsFunClient(), "launchConfig").mockResolvedValue({
    deploymentFeeWei: FEE_WEI,
    gatewayVersion: 1,
  });
});

afterEach(() => vi.restoreAllMocks());

async function preview(params: Record<string, unknown>, ctx = context()) {
  return POOLS_HANDLERS["pools.launch_preview"]!(params, ctx);
}
async function requestForm(params: Record<string, unknown>, ctx = context()) {
  return POOLS_HANDLERS["pools.launch_request_form"]!(params, ctx);
}

const VALID = { name: "My Token", symbol: "MYT", pairedAsset: "weth" };

describe("shared launch input reading", () => {
  it.each(["name", "symbol"])("requires %s", async (key) => {
    const params: Record<string, unknown> = { ...VALID };
    delete params[key];
    expect((await preview(params)).success).toBe(false);
    expect((await requestForm(params)).success).toBe(false);
  });

  it("rejects an unlaunchable pair by naming the two that work", async () => {
    const res = await preview({ ...VALID, pairedAsset: "stock" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("weth");
    expect(res.output).toContain("usdg");
  });

  it("converts the prebuy from HUMAN ETH exactly once, against stated decimals", async () => {
    await preview({ ...VALID, prebuy: "0.01" });
    // 0.01 ETH, not 0.01 wei and not 1e16 read as human units.
    expect(written[0]!.prebuyRaw).toBe("10000000000000000");
    expect(written[0]!.prebuyDecimals).toBe(18);
  });

  it.each([["wei-looking integer string is still ETH", "1", "1000000000000000000"]])(
    "%s",
    async (_label, input, expected) => {
      await preview({ ...VALID, prebuy: input });
      expect(written[0]!.prebuyRaw).toBe(expected);
    },
  );

  it("rejects a non-string prebuy rather than coercing a float", async () => {
    const res = await preview({ ...VALID, prebuy: 0.01 });
    expect(res.success).toBe(false);
    expect(res.output).toContain("prebuy");
  });

  it("rejects a zero prebuy instead of writing a meaningless leg", async () => {
    const res = await preview({ ...VALID, prebuy: "0" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("greater than zero");
  });
});

describe("pools.launch_preview stays advisory and non-live", () => {
  it("writes a previewed pools_fun intent with NO authorization, hash or image lock", async () => {
    const res = await preview(VALID);
    expect(res.success).toBe(true);

    const row = written[0]!;
    expect(row.status).toBe("previewed");
    expect(row.protocol).toBe("pools_fun");
    // The three properties that make a preview unable to become a launch.
    expect(row.authorizationId).toBeUndefined();
    expect(row.txHash).toBeUndefined();
    expect(row.imageId).toBeUndefined();
  });

  it("says out loud that the token address is not knowable yet", async () => {
    const res = await preview(VALID);
    const data = JSON.parse(res.output) as { advisory: boolean; note: string };
    expect(data.advisory).toBe(true);
    // An agent that took a preview's address as final would act on a token that
    // will never exist at that address.
    expect(data.note).toContain("ADDRESS");
    expect(res.output).not.toContain("predictedTokenAddress");
  });

  it("reads the deployment fee LIVE and prices the Vex fee on the native launch value", async () => {
    const res = await preview({ ...VALID, prebuy: "0.01" });
    const data = JSON.parse(res.output) as {
      costs: {
        deploymentFee: { rawWei: string; decimals: number };
        prebuy: { rawWei: string };
        transactionValue: { rawWei: string };
        vexFee: { rawWei: string; bps: number; basis: string };
      };
    };
    expect(data.costs.deploymentFee.rawWei).toBe(FEE_WEI);
    expect(data.costs.deploymentFee.decimals).toBe(18);
    // msg.value is fee + native prebuy, and the Vex fee is 25 bps of THAT.
    const expectedValue = BigInt(FEE_WEI) + 10_000_000_000_000_000n;
    expect(data.costs.transactionValue.rawWei).toBe(expectedValue.toString());
    expect(data.costs.vexFee.rawWei).toBe(((expectedValue * 25n) / 10_000n).toString());
    expect(data.costs.vexFee.basis).toBe("launch_msg_value");
  });

  it("pins the fee recipient to the session wallet and says how to change it", async () => {
    const res = await preview(VALID);
    const data = JSON.parse(res.output) as { feeRecipient: { address: string; note: string } };
    expect(data.feeRecipient.address).toBe(WALLET);
    expect(data.feeRecipient.note).toContain("form");
  });

  it("names the provider failure rather than reporting a bare error", async () => {
    vi.spyOn(getPoolsFunClient(), "launchConfig").mockRejectedValue(new Error("gateway config unreachable"));
    const res = await preview(VALID);
    expect(res.success).toBe(false);
    expect(res.output).toContain("pools.launch_preview");
    expect(written).toHaveLength(0);
  });
});

describe("pools.launch_request_form stays a proposal", () => {
  it("parks the turn with pendingUserForm and an awaiting_user_form intent", async () => {
    const res = await requestForm(VALID);
    expect(res.success).toBe(true);
    // The turn loop's user-form arm keys off THIS field, not off the tool id.
    expect((res as { pendingUserForm?: { intentId: string } }).pendingUserForm?.intentId).toBeTruthy();

    const row = written[0]!;
    expect(row.status).toBe("awaiting_user_form");
    expect(row.origin).toBe("agent_requested_form");
    expect(row.protocol).toBe("pools_fun");
  });

  it("takes the tool call id from the HOST and refuses without one", async () => {
    const res = await requestForm(VALID, context({ toolCallId: null }));
    expect(res.success).toBe(false);
    expect(res.output).toContain("not something to retry");
    expect(written).toHaveLength(0);
  });

  it("ignores a toolCallId a model tries to supply as a parameter", async () => {
    await requestForm({ ...VALID, toolCallId: "attacker-call" }, context({ toolCallId: "call-1" }));
    expect(written[0]!.toolCallId).toBe("call-1");
  });

  it("writes NO fee recipient, because the user chooses it in the form", async () => {
    await requestForm(VALID);
    const pools = written[0]!.pools as Record<string, unknown>;
    // Writing a default here would make a proposal look like a decision.
    expect(pools.feeRecipientAddress).toBeUndefined();
    expect(pools.pairedAsset).toBe("weth");
  });

  it("carries the proposed fields back so the form can be pre-filled", async () => {
    const res = await requestForm({ ...VALID, prebuy: "0.02", imageId: "img_01" });
    const data = JSON.parse(res.output) as {
      proposed: { name: string; symbol: string; pairedAsset: string; prebuyEth: string; imageId: string };
      note: string;
    };
    expect(data.proposed).toMatchObject({
      name: "My Token", symbol: "MYT", pairedAsset: "weth", prebuyEth: "0.02", imageId: "img_01",
    });
    expect(data.note).toContain("editable");
  });

  it("surfaces a dangling image id as a named failure, not a silent form", async () => {
    vi.spyOn(intents, "createWith").mockRejectedValue(new Error("launch image img_gone no longer exists"));
    const res = await requestForm({ ...VALID, imageId: "img_gone" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("no funds moved");
  });
});

describe("the launch surface has no fee, value, recipient, deadline or gas input", () => {
  // The strict param boundary rejects undeclared keys before a handler runs, so
  // this asserts the DECLARATION rather than handler behaviour: none of these
  // keys may ever appear in the manifests.
  it.each(["feeRecipient", "value", "deadline", "gas", "minOut", "devBuyMinOut", "salt"])(
    "does not declare %s on either launch tool",
    async (key) => {
      const { getProtocolManifest } = await import("@vex-agent/tools/protocols/catalog.js");
      for (const toolId of ["pools.launch_preview", "pools.launch_request_form"]) {
        const keys = getProtocolManifest(toolId)?.params.map((p) => p.key) ?? [];
        expect(keys, `${toolId} must not accept ${key}`).not.toContain(key);
      }
    },
  );
});
