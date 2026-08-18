/**
 * The LANE discriminator at the GATE, which is where a mis-wire would actually
 * cost money.
 *
 * `../morpho-lend-lane.test.ts` proves the two lanes hash differently. This file
 * proves the gate READS the registration's lane to decide which identity to
 * build, rather than inferring it from whichever amount key happened to be
 * present. That distinction is the whole point: a gate that guessed the lane
 * from the params would let a caller choose its own identity path, and the four
 * cases below are the ones that would then be possible.
 *
 * `resolveSelectedAddress` is mocked because the gate resolves the SELECTED
 * wallet, which needs no chain and no key material but does need a session.
 */

import { describe, expect, it, vi } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => WALLET,
}));

const WALLET = "0x1111111111111111111111111111111111111111";
const VAULT = "0x4200000000000000000000000000000000000006";
const MARKET_ID = "0xb323495f7e4148be5643a4ea4a8221eef163e4bccfdedc2a6f4696baacbc86cc";
const SESSION = "00000000-0000-4000-8000-000000000001";
const AMOUNT = "1047061";

const { computeGateMatch } = await import("@vex-agent/tools/protocols/prequote/gate/identity.js");
const { EXECUTE_GATE_TOOLS } = await import("@vex-agent/tools/protocols/prequote/registry.js");
const { computePrequoteMatchHash } = await import(
  "@vex-agent/tools/protocols/prequote/identity/hash.js"
);
const { buildMorphoLendDepositIdentity } = await import(
  "@vex-agent/tools/protocols/prequote/identity/morpho-lend.js"
);
const { buildMorphoMarketSupplyIdentity } = await import(
  "@vex-agent/tools/protocols/prequote/identity/morpho-borrow.js"
);

const CONTEXT: ProtocolExecutionContext = {
  sessionPermission: "full",
  approved: true,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
  sessionId: SESSION,
};

function registration(toolId: string) {
  const found = EXECUTE_GATE_TOOLS[toolId];
  if (found === undefined) throw new Error(`${toolId} is not registered on the execute gate`);
  return found;
}

const VAULT_DEPOSIT_PARAMS = {
  vaultAddress: VAULT,
  chain: "base",
  depositAmountRaw: AMOUNT,
  slippageBps: 50,
};

const MARKET_SUPPLY_PARAMS = {
  marketId: MARKET_ID,
  chain: "base",
  supplyAmountRaw: AMOUNT,
  slippageBps: 50,
};

describe("the gate builds the identity its registration's lane names", () => {
  it("builds a VAULT identity for morpho.vault.deposit", async () => {
    const gated = await computeGateMatch(
      registration("morpho.vault.deposit"), SESSION, VAULT_DEPOSIT_PARAMS, CONTEXT,
    );
    expect(gated.matchHash).toBe(
      computePrequoteMatchHash(buildMorphoLendDepositIdentity(SESSION, VAULT_DEPOSIT_PARAMS, CONTEXT)),
    );
  });

  it("builds a MARKET identity for morpho.market.supply, under the SAME kind", async () => {
    expect(registration("morpho.market.supply").kind).toBe("lend_deposit");
    const gated = await computeGateMatch(
      registration("morpho.market.supply"), SESSION, MARKET_SUPPLY_PARAMS, CONTEXT,
    );
    expect(gated.matchHash).toBe(
      computePrequoteMatchHash(buildMorphoMarketSupplyIdentity(SESSION, MARKET_SUPPLY_PARAMS, CONTEXT)),
    );
  });

  it("a vault deposit quote cannot authorize a market supply execute", async () => {
    // The recorded prequote's digest, and what the market execute's gate asks
    // for. They share a kind, so the row IS looked at; the digests are what
    // refuse it.
    const recorded = computePrequoteMatchHash(
      buildMorphoLendDepositIdentity(SESSION, VAULT_DEPOSIT_PARAMS, CONTEXT),
    );
    const asked = await computeGateMatch(
      registration("morpho.market.supply"), SESSION, MARKET_SUPPLY_PARAMS, CONTEXT,
    );
    expect(asked.matchHash).not.toBe(recorded);
  });

  it("a market supply quote cannot authorize a vault deposit execute", async () => {
    const recorded = computePrequoteMatchHash(
      buildMorphoMarketSupplyIdentity(SESSION, MARKET_SUPPLY_PARAMS, CONTEXT),
    );
    const asked = await computeGateMatch(
      registration("morpho.vault.deposit"), SESSION, VAULT_DEPOSIT_PARAMS, CONTEXT,
    );
    expect(asked.matchHash).not.toBe(recorded);
  });

  it("refuses a market supply whose params carry no marketId, rather than falling back to the vault path", async () => {
    // The lane is a property of the REGISTRATION. Params that look like the
    // other lane's must fail closed, not silently switch identity paths.
    await expect(
      computeGateMatch(
        registration("morpho.market.supply"), SESSION, VAULT_DEPOSIT_PARAMS, CONTEXT,
      ),
    ).rejects.toThrow();
  });

  it("refuses a vault deposit whose params carry no vaultAddress", async () => {
    await expect(
      computeGateMatch(
        registration("morpho.vault.deposit"), SESSION, MARKET_SUPPLY_PARAMS, CONTEXT,
      ),
    ).rejects.toThrow();
  });
});
