/**
 * `morpho.rewards.claim` through the PRODUCT SPINE against a Base fork.
 *
 * `executeProtocolTool` -> manifest gates -> handler -> Merkl read -> plan ->
 * decode-and-assert -> sign -> staged broadcast -> receipt -> the durable
 * `agent_activity` row and its `protocol_executions` parent. Nothing in that
 * chain is stubbed.
 *
 * TWO THINGS ARE SUPPLIED RATHER THAN REACHED FOR, and neither is on the path
 * under test:
 *
 *   - THE SIGNING KEY. `resolveSigningWallet` decrypts from the user's real
 *     keystore, which needs a password this test must never hold. A generated
 *     key stands in. Everything downstream - the address the claim is built
 *     for, the assertion that every entry names it, the signature - is real.
 *   - MERKL'S ANSWER. The live API cannot be made to publish a leaf for a
 *     throwaway address, so the response is served locally and the fork's
 *     distributor has its Merkle root set to match. The client, the tolerant
 *     validator, the attribution lookup and the planner all run unchanged on
 *     it, and the LEAF ENCODING was derived empirically from a real Merkl
 *     proof: `keccak256(abi.encode(user, token, amount))` in an
 *     OpenZeppelin sorted-pair tree, verified by climbing the live 20-node WELL
 *     proof back to the live root.
 *
 * OPT-IN. It needs `anvil --fork-url <base>` on 8545 and a database, so it runs
 * only when `VEX_MORPHO_FORK_RPC` is set:
 *
 *   anvil --fork-url https://base-mainnet.public.blastapi.io --port 8545
 *   VEX_MORPHO_FORK_RPC=http://127.0.0.1:8545 VEX_DB_URL=... \
 *     pnpm exec vitest run --config vitest/integration.config.ts \
 *     src/__tests__/integration/morpho/rewards-claim-fork.int.test.ts
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type {
  ProtocolExecuteRequest,
  ProtocolExecutionContext,
} from "@vex-agent/tools/protocols/types.js";

const FORK_RPC = process.env["VEX_MORPHO_FORK_RPC"];
const describeFork = FORK_RPC === undefined ? describe.skip : describe;

const DISTRIBUTOR = "0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae";
const WELL = getAddress("0xA88594D404727625A9437C3f886C7643872296AE");
const CLAIM_AMOUNT = 250_000_000_000_000_000_000n;

/** Slots located by scanning the live Base distributor for its two known roots. */
const SLOT_TREE = "0x65";
const SLOT_LAST_TREE = "0x67";

const PRIVATE_KEY = generatePrivateKey();
const WALLET = privateKeyToAccount(PRIVATE_KEY).address;

const LEAF = keccak256(
  encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint256" }],
    [WALLET, WELL, CLAIM_AMOUNT],
  ),
);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveSigningWallet: () => ({ family: "eip155", address: WALLET, privateKey: PRIVATE_KEY }),
  };
});

const ERC20 = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * The wallet a hostile (or merely forgotten) `setClaimRecipient` would send the
 * rewards to. The fork sets this redirect BEFORE the claim runs, so the claim
 * has to defeat it on chain rather than in an assertion.
 */
const REDIRECT_TARGET = getAddress("0x000000000000000000000000000000000000dEaD");

const DISTRIBUTOR_RECIPIENT_ABI = [
  {
    name: "setClaimRecipient",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "recipient", type: "address" }, { name: "token", type: "address" }],
    outputs: [],
  },
  {
    name: "claimRecipient",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }, { name: "token", type: "address" }],
    outputs: [{ type: "address" }],
  },
] as const;

async function anvil(method: string, params: readonly unknown[]): Promise<void> {
  await fetch(FORK_RPC as string, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

/**
 * What Merkl claims has ALREADY been claimed on-chain. Mutable so a test can
 * make the response go stale (the leaf spent underneath us) or settled (nothing
 * left), which are the two endings a live wallet actually reaches.
 */
let stubClaimedRaw = "0";

function merklResponse(): unknown {
  return [{
    chain: { id: 8453, name: "Base" },
    rewards: [{
      root: LEAF,
      recipient: WALLET,
      amount: CLAIM_AMOUNT.toString(),
      claimed: stubClaimedRaw,
      pending: "0",
      proofs: [],
      token: { chainId: 8453, address: WELL, decimals: 18, symbol: "WELL", price: 0.0028 },
      breakdowns: [{
        campaignId: "0xcampaign", opportunityId: "9836065204209028807", reason: "ERC20_test",
        amount: CLAIM_AMOUNT.toString(), claimed: stubClaimedRaw, pending: "0",
      }],
    }],
  }];
}

/** The dispatcher's own request shape, so a drift in it fails to compile here. */
const CLAIM_REQUEST: ProtocolExecuteRequest = {
  toolId: "morpho.rewards.claim",
  params: { chain: "base" },
};

describeFork("morpho.rewards.claim through the product spine, on a Base fork", () => {
  const sessionId = `morpho-claim-fork-${Date.now()}`;

  /**
   * The context the dispatcher hands the runtime for an already-authorized
   * call: a full-permission session whose approval has landed, which is the
   * state this fork proof runs the claim in. Spelled in full rather than
   * escaped, so the approval gate reads the same fields production gives it.
   */
  const claimContext = (): ProtocolExecutionContext => ({
    sessionPermission: "full",
    approved: true,
    sessionId,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
  });

  let realFetch: typeof globalThis.fetch;
  let executionId: number;
  let txHash: string;

  beforeAll(async () => {
    const rpc = FORK_RPC as string;

    const constants = await import("@tools/morpho/constants.js");
    (constants.MORPHO_DEFAULT_RPC as Record<number, string>)[8453] = rpc;
    (constants.MORPHO_RPC_FALLBACKS as Record<number, readonly string[]>)[8453] = [];

    await anvil("anvil_setBalance", [WALLET, `0x${parseEther("1").toString(16)}`]);
    await anvil("anvil_setStorageAt", [DISTRIBUTOR, SLOT_TREE, LEAF]);
    await anvil("anvil_setStorageAt", [DISTRIBUTOR, SLOT_LAST_TREE, LEAF]);

    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.merkl.xyz") && url.includes("/rewards")) {
        return new Response(JSON.stringify(merklResponse()), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("api.merkl.xyz") && url.includes("/opportunities")) {
        return new Response(
          JSON.stringify({ id: "9836065204209028807", name: "Morpho vault", action: "LEND", protocol: { id: "morpho", name: "Morpho" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return realFetch(input, init);
    }) as typeof fetch;

    // THE REDIRECT, ARMED ON CHAIN BEFORE THE CLAIM RUNS.
    //
    // Merkl's Distributor resolves a plain `claim()`'s destination from its own
    // `claimRecipient` state, so a `setClaimRecipient` executed at any earlier
    // point permanently redirects every later claim. Vex signs
    // `claimWithRecipient` with the destination bound in the calldata, which
    // overrides that state whenever msg.sender is the user. Setting the trap
    // here is what makes the balance assertions below a PROOF rather than an
    // assumption: with the old plain `claim()` the rewards would land on
    // REDIRECT_TARGET and the tool would report no credit.
    const walletClient = createWalletClient({
      account: privateKeyToAccount(PRIVATE_KEY), chain: base, transport: http(rpc),
    });
    const forkPublicClient = createPublicClient({ chain: base, transport: http(rpc) });
    const redirectHash = await walletClient.writeContract({
      address: DISTRIBUTOR as Address,
      abi: DISTRIBUTOR_RECIPIENT_ABI,
      functionName: "setClaimRecipient",
      args: [REDIRECT_TARGET, WELL],
    });
    await forkPublicClient.waitForTransactionReceipt({ hash: redirectHash });

    const armed = await forkPublicClient.readContract({
      address: DISTRIBUTOR as Address,
      abi: DISTRIBUTOR_RECIPIENT_ABI,
      functionName: "claimRecipient",
      args: [WALLET, WELL],
    });
    // The trap is real, on chain, before anything is claimed.
    expect(getAddress(armed)).toBe(REDIRECT_TARGET);

    const { query } = await import("@vex-agent/db/client.js");
    await query("INSERT INTO sessions (id, title) VALUES ($1, $2) ON CONFLICT DO NOTHING", [sessionId, "morpho claim fork proof"]);
  }, 120_000);

  afterAll(() => {
    if (realFetch !== undefined) globalThis.fetch = realFetch;
  });

  it("claims on-chain and returns the credit PROVEN from the receipt, DEFEATING a stored redirect", async () => {
    const publicClient = createPublicClient({ chain: base, transport: http(FORK_RPC as string) });
    const before = await publicClient.readContract({ address: WELL, abi: ERC20, functionName: "balanceOf", args: [WALLET] });
    const redirectBefore = await publicClient.readContract({
      address: WELL, abi: ERC20, functionName: "balanceOf", args: [REDIRECT_TARGET],
    });

    const { executeProtocolTool } = await import("@vex-agent/tools/protocols/runtime.js");
    const result = await executeProtocolTool(
      CLAIM_REQUEST,
      claimContext(),
    );

    expect(result.success, result.output).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data["status"]).toBe("confirmed");
    expect(data["claimed"]).toBe(true);

    const credited = data["credited"] as readonly Record<string, unknown>[];
    expect(credited).toHaveLength(1);
    expect(credited[0]).toMatchObject({
      tokenAddress: WELL.toLowerCase(),
      tokenSymbol: "WELL",
      tokenDecimals: 18,
      amountRaw: CLAIM_AMOUNT.toString(),
      amountHuman: formatUnits(CLAIM_AMOUNT, 18),
    });

    const after = await publicClient.readContract({ address: WELL, abi: ERC20, functionName: "balanceOf", args: [WALLET] });
    expect(after - before).toBe(CLAIM_AMOUNT);

    // The armed redirect got NOTHING. This is the assertion the old plain
    // `claim()` would have failed: the distributor would have paid the stored
    // recipient in full while the tool reported no credit to the wallet.
    const redirectAfter = await publicClient.readContract({
      address: WELL, abi: ERC20, functionName: "balanceOf", args: [REDIRECT_TARGET],
    });
    expect(redirectAfter - redirectBefore).toBe(0n);

    executionId = data["executionId"] as number;
    txHash = data["txHash"] as string;
    // The runtime's adoption key, without which capture writes a second row.
    expect(data["_executionId"]).toBe(executionId);
  }, 180_000);

  it("recorded ONE protocol_executions row and ONE anchored yield_claim leg", async () => {
    const { query } = await import("@vex-agent/db/client.js");

    const executions = await query<{ tool_id: string; namespace: string; success: boolean; execution_status: string }>(
      "SELECT tool_id, namespace, success, execution_status FROM protocol_executions WHERE session_id = $1",
      [sessionId],
    );
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      tool_id: "morpho.rewards.claim",
      namespace: "morpho",
      success: true,
    });
    expect(executions[0]?.execution_status).not.toBe("intent");

    const legs = await query<{
      kind: string; event_role: string; protocol: string; chain_family: string; status: string;
      token_out_address: string; executed_amount_out_raw: string; executed_amount_in_raw: string | null;
      tx_hash: string; settled_block_time: string | null;
    }>(
      `SELECT kind, event_role, protocol, chain_family, status, token_out_address,
              executed_amount_out_raw, executed_amount_in_raw, tx_hash, settled_block_time
         FROM agent_activity WHERE protocol_execution_id = $1 ORDER BY event_index`,
      [executionId],
    );

    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      // The ruling: kind describes the OPERATION, so a reward sweep is yield
      // even though the venue is Morpho.
      kind: "yield",
      event_role: "yield_claim",
      protocol: "morpho",
      chain_family: "eip155",
      status: "confirmed",
      token_out_address: WELL.toLowerCase(),
      executed_amount_out_raw: CLAIM_AMOUNT.toString(),
      // Out-only, as agent_activity_yield_confirmed_legs requires: a claim
      // spends nothing.
      executed_amount_in_raw: null,
      tx_hash: txHash,
    });
    // The B1 fix: the by-hash lookup, not a NULL.
    expect(legs[0]?.settled_block_time).not.toBeNull();

  }, 60_000);

  it("carries the full per-token breakdown on the durable row's route_provenance", async () => {
    // WHERE THE BREAKDOWN LIVES, AND WHY IT IS NOT `intent_params`. The
    // execution's `params` echo is run through `redactBugPayload`, whose
    // key detector matches `token`, `address` and `wallet` and whose tier-2
    // pass masks address-shaped values. That is aimed at auth tokens and
    // secrets, but it cannot tell an ERC20 token from a bearer token, so a
    // per-token breakdown stored there arrives redacted. The `agent_activity`
    // row's own `route_provenance` is the durable home that survives, and it is
    // the more correct one anyway: it belongs to the leg it describes.
    const { queryOne } = await import("@vex-agent/db/client.js");

    const execution = await queryOne<{ params: Record<string, unknown> }>(
      "SELECT params FROM protocol_executions WHERE id = $1", [executionId],
    );
    // What survives redaction still identifies the call.
    expect(execution?.params?.["chain"]).toBe("base");

    const leg = await queryOne<{ route_provenance: Record<string, unknown> }>(
      "SELECT route_provenance FROM agent_activity WHERE protocol_execution_id = $1", [executionId],
    );
    const provenance = leg?.route_provenance ?? {};
    expect(provenance["action"]).toBe("merkl_claim");
    expect(provenance["claimedTokenCount"]).toBe(1);
    // The anchor is NAMED as an anchor in the row itself, so a later reader
    // cannot mistake the one recorded leg for the whole sweep.
    expect(provenance["creditAnchor"]).toBe(WELL.toLowerCase());

    const claimed = provenance["claimedTokens"] as readonly Record<string, unknown>[];
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      tokenAddress: WELL.toLowerCase(),
      tokenSymbol: "WELL",
      tokenDecimals: 18,
      deliveredAmountRaw: CLAIM_AMOUNT.toString(),
    });
  }, 60_000);

  it("REFUSES to call a mined-but-uncredited claim a success", async () => {
    // The leaf is already spent on-chain, but Merkl's cached answer still says
    // it is claimable - exactly what a live race looks like when another
    // transaction claims the same leaf first, or a root turns over mid-flight.
    // The transaction mines successfully and transfers NOTHING. Reporting that
    // as a claim would book income that does not exist.
    const { executeProtocolTool } = await import("@vex-agent/tools/protocols/runtime.js");
    const result = await executeProtocolTool(
      CLAIM_REQUEST,
      claimContext(),
    );

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data["status"]).toBe("unproven");
    expect(data["reason"]).toBe("no_credit");
    expect(data["claimed"]).toBe(false);
    // The wording owes a refusal to retry: the transaction did land.
    expect(String(result.output)).toContain("Do not retry");
  }, 120_000);

  // THE HONEST EMPTY PATH IS PROVEN LIVE, NOT HERE. `MERKL_TTL.userRewards`
  // caches a wallet's rewards for 60 s, so a second call inside one run reads
  // the same answer whatever the stub now says - and forcing it would be
  // testing the stub rather than the product. The live dryRun on Vex's own
  // wallet, which genuinely has nothing claimable, is that proof; `planMerklClaim`
  // covers the selection itself in `src/__tests__/tools/merkl/claim-engine.test.ts`.
});
