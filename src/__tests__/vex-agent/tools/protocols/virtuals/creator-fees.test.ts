/**
 * `virtuals.creator_fees` through the real handler chain, and the genesis
 * participation refusal in the calendar's own reply.
 *
 * WHAT IS FAKED AND WHY. Only the two EXTERNAL boundaries: the viem public
 * client (a chain) and the Virtuals REST client (a provider). Everything the
 * lane owns runs for real - the param refusals, the token resolution, the
 * two-round read, the pending derivation, the threshold and balance
 * comparisons, the contract's own fee clamping and the whole projection. A test
 * that faked `readVirtualsCreatorFeeStatus` would prove the handler can copy
 * fields, which is not where this lane's risk is.
 *
 * The fake client dispatches by FUNCTION NAME, never by call index, so a
 * reordering of the multicalls cannot silently repoint an assertion at the
 * wrong getter - and every fixture is a live capture (provenance inside each
 * file), so the numbers being asserted are numbers the chain actually returned.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { getAddress } from "viem";

import { VIRTUALS_HANDLERS } from "@vex-agent/tools/protocols/virtuals/handlers.js";
import { getVirtualsClient } from "@tools/virtuals/client.js";
import { getVirtualsTaxPublicClient } from "@tools/virtuals/creator-fees/evm-client.js";
import { readVirtualsRevenueConnectSummary } from "@tools/virtuals/creator-fees/revenue-connect.js";
import { validateVirtualDetail, validateGeneses } from "@tools/virtuals/validation.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import CULTOS from "../../../../virtuals/fixtures/creator-fees/base-cultos.json" with { type: "json" };
import MONVERA from "../../../../virtuals/fixtures/creator-fees/robinhood-monvera-partner.json" with { type: "json" };
import UNREGISTERED from "../../../../virtuals/fixtures/creator-fees/base-unregistered.json" with { type: "json" };
import REVENUE from "../../../../virtuals/fixtures/creator-fees/revenue-connect-summary.json" with { type: "json" };
import DETAIL from "../../../../virtuals/fixtures/agent-detail.json" with { type: "json" };
import GENESES from "../../../../virtuals/fixtures/geneses-page.json" with { type: "json" };
import GENESIS_PARAMS from "../../../../virtuals/fixtures/geneses-parameters.json" with { type: "json" };

vi.mock("@tools/virtuals/client.js", () => ({ getVirtualsClient: vi.fn() }));
vi.mock("@tools/virtuals/creator-fees/evm-client.js", () => ({ getVirtualsTaxPublicClient: vi.fn() }));
vi.mock("@tools/virtuals/creator-fees/revenue-connect.js", () => ({
  readVirtualsRevenueConnectSummary: vi.fn(),
}));
vi.mock("@utils/logger.js", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type Mock = ReturnType<typeof vi.fn>;
const CTX = { sessionPermission: "restricted", approved: false } as unknown as ProtocolExecutionContext;
const AGENT = validateVirtualDetail(DETAIL)!;
const GENESIS_LIST = validateGeneses(GENESES);

/**
 * The live-captured chain state one fixture describes.
 *
 * The role fields are widened to `boolean | null` because the unregistered
 * fixture legitimately has no creator to ask about, and JSON import types the
 * two files' literals differently.
 */
type ChainFixture = Omit<typeof CULTOS, "creatorHasSwapRole" | "tbaHasSwapRole"> & {
  readonly creatorHasSwapRole: boolean | null;
  readonly tbaHasSwapRole: boolean | null;
};

/**
 * A public client that answers exactly what the fixture recorded, keyed by the
 * function the caller asked for. `unknownCall` collects anything the fixture
 * has no answer for, so a new read added to the module without a recorded value
 * fails loudly instead of arriving as `undefined`.
 */
function fakeChain(fixture: ChainFixture, options: { storageThrows?: boolean } = {}) {
  const unknownCall: string[] = [];
  const answer = (functionName: string, args: readonly unknown[] | undefined): unknown => {
    switch (functionName) {
      case "taxVault": return fixture.taxVault;
      case "taxToken": return fixture.taxToken;
      case "assetToken": return fixture.assetToken;
      case "treasury": return fixture.treasury;
      case "feeRate": return fixture.feeRate;
      case "minSwapThreshold": return BigInt(fixture.minSwapThreshold);
      case "maxSwapThreshold": return BigInt(fixture.maxSwapThreshold);
      case "getTokenTaxAmounts": return [BigInt(fixture.amountCollected), BigInt(fixture.amountSwapped)];
      case "getTokenRecipient": return [fixture.tba, fixture.creator];
      case "getTokenPartnerConfig": return [fixture.partnerId, fixture.partnerFeeRate];
      case "partnerRecipients": return fixture.partnerRecipient;
      case "hasRole": {
        const account = String(args?.[1] ?? "").toLowerCase();
        if (account === fixture.creator.toLowerCase()) return fixture.creatorHasSwapRole;
        if (account === fixture.tba.toLowerCase()) return fixture.tbaHasSwapRole;
        unknownCall.push(`hasRole(${account})`);
        return undefined;
      }
      default:
        unknownCall.push(functionName);
        return undefined;
    }
  };
  const erc20 = (address: string, functionName: string): unknown => {
    const isTax = address.toLowerCase() === fixture.taxToken.toLowerCase();
    if (functionName === "symbol") return isTax ? fixture.taxTokenSymbol : fixture.assetTokenSymbol;
    if (functionName === "decimals") return isTax ? fixture.taxTokenDecimals : fixture.assetTokenDecimals;
    if (functionName === "balanceOf") return BigInt(fixture.vaultTaxTokenBalance);
    unknownCall.push(`erc20.${functionName}`);
    return undefined;
  };
  const isErc20 = (address: string) =>
    address.toLowerCase() === fixture.taxToken.toLowerCase()
    || address.toLowerCase() === fixture.assetToken.toLowerCase();

  const resolve = (call: { address: string; functionName: string; args?: readonly unknown[] }) =>
    isErc20(call.address) ? erc20(call.address, call.functionName) : answer(call.functionName, call.args);

  const client = {
    getBlockNumber: vi.fn().mockResolvedValue(BigInt(fixture.blockNumber)),
    readContract: vi.fn(async (call: { address: string; functionName: string; args?: readonly unknown[] }) =>
      resolve(call),
    ),
    multicall: vi.fn(async ({ contracts }: { contracts: { address: string; functionName: string; args?: readonly unknown[] }[] }) =>
      contracts.map((call) => {
        const result = resolve(call);
        return result === undefined
          ? { status: "failure", error: new Error(`no fixture value for ${call.functionName}`) }
          : { status: "success", result };
      }),
    ),
    getStorageAt: vi.fn(async () => {
      if (options.storageThrows === true) throw new Error("archive method not served");
      return fixture.implementationSlot;
    }),
  };
  return { client, unknownCall };
}

function mockApi(overrides: Record<string, unknown> = {}) {
  const client = {
    getVirtual: vi.fn().mockResolvedValue(AGENT),
    listVirtuals: vi.fn().mockResolvedValue({ agents: [], pagination: null }),
    listGeneses: vi.fn().mockResolvedValue(GENESIS_LIST),
    getGenesisParameters: vi.fn().mockResolvedValue({
      reserveAmountTiers: GENESIS_PARAMS.data.reserveAmountTiers,
    }),
    ...overrides,
  };
  (getVirtualsClient as Mock).mockReturnValue(client);
  return client;
}

async function run(params: Record<string, unknown>) {
  return VIRTUALS_HANDLERS["virtuals.creator_fees"]!(params, CTX);
}
function data(result: Awaited<ReturnType<typeof run>>): Record<string, any> {
  return (result as unknown as { data: Record<string, any> }).data ?? {};
}
function refusal(result: Awaited<ReturnType<typeof run>>): string {
  const r = result as unknown as { success?: boolean; output?: unknown };
  expect(r.success, "expected a refusal, got a success").toBe(false);
  return String(r.output ?? "");
}

/** Point the chain factory at one fixture's recorded answers. */
function useChain(fixture: ChainFixture, options: { storageThrows?: boolean } = {}) {
  const fake = fakeChain(fixture, options);
  (getVirtualsTaxPublicClient as Mock).mockReturnValue(fake.client);
  return fake;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi();
  (readVirtualsRevenueConnectSummary as Mock).mockResolvedValue({
    measured: true,
    summary: REVENUE.data,
  });
});

describe("the amounts, and the two scales they live at", () => {
  it("reports collected, swapped and pending in the TAX asset with its own decimals", async () => {
    const fake = useChain(CULTOS);
    const result = await run({ chain: "base", tokenAddress: CULTOS.agentToken });
    expect(fake.unknownCall, "the module asked for a value no fixture records").toEqual([]);
    const out = data(result);

    expect(out.supported).toBe(true);
    expect(out.blockNumber).toBe(CULTOS.blockNumber);
    expect(out.accrued.collected).toMatchObject({
      assetAddress: getAddress(CULTOS.taxToken),
      assetSymbol: "VIRTUAL",
      decimals: 18,
      amountRaw: CULTOS.amountCollected,
      human: "2324.279670585735688706",
    });
    expect(out.accrued.swapped.amountRaw).toBe(CULTOS.amountSwapped);
    // Derived, not read: collected - swapped, exact in integer arithmetic.
    expect(out.accrued.pending.amountRaw).toBe("9145184610328727314");
    expect(out.accrued.pending.human).toBe("9.145184610328727314");
  });

  it("names the PAYOUT asset separately, at its own scale, so the two are never one number", async () => {
    useChain(CULTOS);
    const out = data(await run({ chain: "base", tokenAddress: CULTOS.agentToken }));
    expect(out.assets.taxAsset).toMatchObject({ symbol: "VIRTUAL", decimals: 18 });
    expect(out.assets.payoutAsset).toMatchObject({
      address: getAddress(CULTOS.assetToken),
      symbol: "USDC",
      decimals: 6,
    });
    expect(out.split.appliesTo).toContain("USDC");
  });

  it("reads Robinhood's own payout asset rather than assuming Base's", async () => {
    useChain(MONVERA);
    const out = data(await run({ chain: "robinhood", tokenAddress: MONVERA.agentToken }));
    expect(out.assets.payoutAsset).toMatchObject({ symbol: "USDG", decimals: 6 });
    expect(out.chainId).toBe(4663);
  });
});

describe("whether the next backend swap can move the pending amount", () => {
  it("says NO, and says why, when pending is below the contract's own minSwapThreshold", async () => {
    useChain(CULTOS);
    const out = data(await run({ chain: "base", tokenAddress: CULTOS.agentToken }));
    // 9.145 VIRTUAL pending against a 10 VIRTUAL floor: accrued, but immovable.
    expect(out.accrued.pendingReachesSwapThreshold).toBe(false);
    expect(out.accrued.nextSwapWouldMove.amountRaw).toBe("0");
    expect(String(out.notes.join(" "))).toContain("minSwapThreshold");
    // And it is NEVER reported as zero accrual.
    expect(out.accrued.pending.amountRaw).not.toBe("0");
  });

  it("caps what one swap would move at maxSwapThreshold and discloses the remainder", async () => {
    // Same live configuration, one field moved: a pending far above the cap.
    const huge = { ...CULTOS, amountSwapped: "0", amountCollected: "5000000000000000000000" };
    useChain(huge);
    const out = data(await run({ chain: "base", tokenAddress: CULTOS.agentToken }));
    expect(out.accrued.pendingReachesSwapThreshold).toBe(true);
    expect(out.accrued.nextSwapWouldMove.amountRaw).toBe(CULTOS.maxSwapThreshold);
    expect(String(out.notes.join(" "))).toContain("maxSwapThreshold");
  });

  it("reports the contract's own balance as a separate fact, never as this agent's share", async () => {
    useChain(CULTOS);
    const out = data(await run({ chain: "base", tokenAddress: CULTOS.agentToken }));
    expect(out.accrued.contractTaxAssetBalance.amountRaw).toBe(CULTOS.vaultTaxTokenBalance);
    expect(out.accrued.contractBalanceNote).toContain("shared across every token");
  });

  it("flags a pending the contract's balance cannot cover, because the swap returns early there", async () => {
    const short = { ...CULTOS, amountSwapped: "0", amountCollected: "900000000000000000000", vaultTaxTokenBalance: "1" };
    useChain(short);
    const out = data(await run({ chain: "base", tokenAddress: CULTOS.agentToken }));
    expect(out.accrued.contractBalanceCoversNextSwap).toBe(false);
    expect(String(out.notes.join(" "))).toContain("returns early");
  });
});

describe("the split, exactly as _swapAndDistribute computes it", () => {
  it("gives the creator the remainder after the protocol fee when no partner is configured", async () => {
    useChain(CULTOS);
    const out = data(await run({ chain: "base", tokenAddress: CULTOS.agentToken }));
    expect(out.split).toMatchObject({
      denominator: 10000,
      protocolFeeRate: 3000,
      protocolFeePercent: "30%",
      partner: null,
      creatorShareRate: 7000,
      creatorSharePercent: "70%",
    });
    expect(out.split.treasury).toBe(getAddress(CULTOS.treasury));
  });

  it("subtracts a REAL partner fee and names its recipient", async () => {
    useChain(MONVERA);
    const out = data(await run({ chain: "robinhood", tokenAddress: MONVERA.agentToken }));
    expect(out.split.partner).toMatchObject({
      partnerId: MONVERA.partnerId,
      feeRate: 2000,
      feePercent: "20%",
      recipient: getAddress(MONVERA.partnerRecipient),
    });
    expect(out.split.creatorShareRate).toBe(5000);
    expect(out.split.creatorSharePercent).toBe("50%");
  });

  it("clamps the way the contract clamps when protocol plus partner would exceed the whole", async () => {
    const overweight = { ...MONVERA, feeRate: 9000, partnerFeeRate: 5000 };
    useChain(overweight);
    const out = data(await run({ chain: "robinhood", tokenAddress: MONVERA.agentToken }));
    // The contract caps each fee at what is left, so the creator's share floors
    // at zero rather than underflowing.
    expect(out.split.protocolFeeRate).toBe(9000);
    expect(out.split.partner.feeRate).toBe(5000);
    expect(out.split.creatorShareRate).toBe(0);
  });

  it("warns when a partner fee is configured with no recipient, because the payout REVERTS there", async () => {
    const noRecipient = { ...MONVERA, partnerRecipient: "0x0000000000000000000000000000000000000000" };
    useChain(noRecipient);
    const out = data(await run({ chain: "robinhood", tokenAddress: MONVERA.agentToken }));
    expect(out.split.partner.recipient).toBeNull();
    expect(String(out.notes.join(" "))).toContain("Partner recipient not set");
  });
});

describe("the claim is refused with a measurement, not an assertion", () => {
  it("reads SWAP_ROLE off the contract and reports both answers with the reason and the venue", async () => {
    useChain(CULTOS);
    const out = data(await run({ chain: "base", tokenAddress: CULTOS.agentToken }));
    expect(out.claim.supported).toBe(false);
    expect(out.claim.measured).toMatchObject({
      creatorHasSwapRole: false,
      tokenBoundAccountHasSwapRole: false,
    });
    expect(out.claim.reason).toContain("SWAP_ROLE");
    expect(out.claim.reason).toContain("no transaction Vex could sign");
    expect(out.claim.venue).toContain("app.virtuals.io");
    // And it never reads as "there is nothing there": the payout is automatic.
    expect(out.claim.payoutIsAutomatic).toContain("TRANSFERRED to the creator");
  });

  it("carries the measured role answers into the reason string, so the refusal cites its own evidence", async () => {
    useChain(CULTOS);
    const out = data(await run({ chain: "base", tokenAddress: CULTOS.agentToken }));
    expect(out.claim.reason).toContain(`block ${CULTOS.blockNumber}`);
    expect(out.claim.reason).toContain("hasRole(SWAP_ROLE, creator) = false");
  });
});

describe("states that must never collapse into each other", () => {
  it("an UNREGISTERED token is reported as such, with the contract's own refusal, not as 'no fees'", async () => {
    useChain(UNREGISTERED);
    const out = data(await run({ chain: "base", tokenAddress: UNREGISTERED.agentToken }));
    expect(out.creator.registered).toBe(false);
    expect(out.creator.address).toBeNull();
    expect(String(out.notes.join(" "))).toContain("Token not registered");
    // There is no creator to ask about, so the role answer is NOT MEASURED
    // rather than a false that would read as "checked, and no".
    expect(out.claim.measured.creatorHasSwapRole).toBeNull();
  });

  it("a chain with no AgentTaxV2 answers supported:false with the reason, never a zero balance", async () => {
    const out = data(await run({ chain: "solana", id: 96200 }));
    expect(out.supported).toBe(false);
    expect(out.reason).toContain("EVM contract");
    expect(out.supportedChains).toEqual(["base", "robinhood"]);
    expect(out.reason).toContain("not a statement that the creator has earned nothing");
    expect(out.accrued).toBeUndefined();
    expect(getVirtualsTaxPublicClient as Mock).not.toHaveBeenCalled();
  });

  it("a chain that will not answer is a failure that explicitly denies saying anything about earnings", async () => {
    (getVirtualsTaxPublicClient as Mock).mockReturnValue({
      getBlockNumber: vi.fn().mockRejectedValue(new Error("boom")),
      readContract: vi.fn(),
      multicall: vi.fn(),
      getStorageAt: vi.fn(),
    });
    const message = refusal(await run({ chain: "base", tokenAddress: CULTOS.agentToken }));
    expect(message).toContain("NOT a statement that the creator has earned nothing");
  });
});

describe("identity, and the provider cross-check", () => {
  // The committed agent-detail fixture is VEX on ROBINHOOD, so the id path is
  // exercised on that chain against the Robinhood tax deployment.
  it("resolves the bonding token from an agent id and cross-checks the provider's creator wallet", async () => {
    const api = mockApi();
    useChain({ ...MONVERA, creator: AGENT.walletAddress!, tba: AGENT.walletAddress! });
    const out = data(await run({ chain: "robinhood", id: Number(AGENT.id) }));
    expect(api.getVirtual).toHaveBeenCalled();
    expect(out.agentTokenSource).toBe("agent id lookup");
    expect(out.creator.matchesProviderWalletAddress).toBe(true);
  });

  it("REPORTS a disagreement between the contract's creator and the provider's wallet instead of picking one", async () => {
    useChain(MONVERA);
    const out = data(await run({ chain: "robinhood", id: Number(AGENT.id) }));
    expect(out.creator.matchesProviderWalletAddress).toBe(false);
    expect(String(out.notes.join(" "))).toContain("is NOT the address AgentTaxV2 pays");
    // The contract's answer is still the one presented as the payee.
    expect(out.creator.address).toBe(getAddress(MONVERA.creator));
  });

  it("answers from the chain alone when the provider is down, and says the cross-check did not happen", async () => {
    mockApi({ listVirtuals: vi.fn().mockRejectedValue(new Error("provider down")) });
    useChain(CULTOS);
    const out = data(await run({ chain: "base", tokenAddress: CULTOS.agentToken }));
    expect(out.supported).toBe(true);
    expect(out.accrued.collected.amountRaw).toBe(CULTOS.amountCollected);
    expect(String(out.notes.join(" "))).toContain("could not be cross-checked");
  });

  it("refuses two identities, no identity, a non-address and a chain the agent does not live on - each by name", async () => {
    useChain(CULTOS);
    expect(refusal(await run({ chain: "base" }))).toContain("either tokenAddress");
    expect(refusal(await run({ chain: "base", id: 1, tokenAddress: CULTOS.agentToken })))
      .toContain("EITHER tokenAddress OR id");
    expect(refusal(await run({ chain: "base", tokenAddress: "nope" }))).toContain("not an EVM contract address");
    // The fixture agent is on ROBINHOOD; asking for it on base must refuse.
    expect(refusal(await run({ chain: "base", id: Number(AGENT.id) }))).toContain("not on base");
  });
});

describe("the provider's revenue number is a labelled claim, never the answer", () => {
  it("carries it under its own key with the measurement that it is a different stream", async () => {
    useChain(MONVERA);
    const out = data(await run({ chain: "robinhood", id: Number(AGENT.id) }));
    expect(out.providerRevenueClaim).toMatchObject({ measured: true, totalRevenue: 0 });
    expect(out.providerRevenueClaim.note).toContain("says nothing about the creator's trading fees");
    // A zero there sits beside a non-zero here, and neither contradicts the other.
    expect(out.accrued.collected.amountRaw).not.toBe("0");
  });

  it("says NOT MEASURED rather than zero when the endpoint cannot be asked", async () => {
    (readVirtualsRevenueConnectSummary as Mock).mockResolvedValue({ measured: false, reason: "api2 down" });
    useChain(MONVERA);
    const out = data(await run({ chain: "robinhood", id: Number(AGENT.id) }));
    expect(out.providerRevenueClaim).toEqual({ measured: false, reason: "api2 down" });
  });

  it("is not asked at all when only a token address was given, because the endpoint is keyed by agent id", async () => {
    useChain(CULTOS);
    const out = data(await run({ chain: "base", tokenAddress: CULTOS.agentToken }));
    expect(readVirtualsRevenueConnectSummary as Mock).not.toHaveBeenCalled();
    expect(out.providerRevenueClaim.measured).toBe(false);
  });
});

describe("the pins are checked, not assumed", () => {
  it("confirms the vault, the implementation and both assets against what this tool measured", async () => {
    useChain(CULTOS);
    const out = data(await run({ chain: "base", tokenAddress: CULTOS.agentToken }));
    expect(out.pins).toMatchObject({
      taxVaultMatchesPin: true,
      implementationMatchesPin: true,
      taxAssetMatchesPin: true,
      payoutAssetMatchesPin: true,
    });
    expect(out.contract.address).toBe(getAddress(CULTOS.taxVault));
    expect(out.contract.source).toContain("FFactoryV2.taxVault()");
  });

  it("reports an upgraded implementation as a difference instead of a silent pass", async () => {
    useChain({
      ...CULTOS,
      implementationSlot: "0x000000000000000000000000000000000000000000000000000000000000beef",
    });
    const out = data(await run({ chain: "base", tokenAddress: CULTOS.agentToken }));
    expect(out.pins.implementationMatchesPin).toBe(false);
    expect(out.contract.implementationNote).toContain("DIFFERS");
    expect(String(out.notes.join(" "))).toContain("differs from what this tool was measured against");
  });

  it("says the implementation was NOT MEASURED when the node will not serve the slot, and still answers", async () => {
    useChain(CULTOS, { storageThrows: true });
    const out = data(await run({ chain: "base", tokenAddress: CULTOS.agentToken }));
    expect(out.contract.implementation).toBeNull();
    expect(out.contract.implementationNote).toContain("NOT MEASURED");
    expect(out.accrued.collected.amountRaw).toBe(CULTOS.amountCollected);
  });
});

describe("the genesis calendar refuses participation by name", () => {
  it("carries the measured reason, the privileged path behind it and the supported half", async () => {
    const result = await VIRTUALS_HANDLERS["virtuals.geneses"]!({ limit: 1 }, CTX);
    const out = (result as unknown as { data: Record<string, any> }).data;
    expect(out.participation.supported).toBe(false);
    expect(out.participation.reason).toContain("does not validate `pointAmt`");
    expect(out.participation.reason).toContain("onGenesisSuccessSalt");
    expect(out.participation.reason).toContain("factory role");
    expect(out.participation.venue).toContain("app.virtuals.io");
    expect(out.participation.supportedHere).toContain("virtuals__genesis_launches_list");
    // The calendar itself still answers.
    expect(Array.isArray(out.geneses)).toBe(true);
  });
});
