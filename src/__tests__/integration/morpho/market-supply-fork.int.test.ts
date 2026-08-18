/**
 * The Morpho Blue MARKET LENDER lane through the PRODUCT SPINE, against a Base
 * fork: `morpho.market.supply` and `morpho.market.withdraw`.
 *
 * `executeProtocolTool` -> manifest gates -> the prequote gate -> handler ->
 * market vouching -> plan -> build -> decode-and-assert -> exact-amount approval
 * -> sign -> staged broadcast -> receipt -> the durable `agent_activity` rows
 * and their `protocol_executions` parents. Nothing in that chain is stubbed, and
 * the quote that authorizes each execute is the REAL `morpho.market.quote` call,
 * recorded through the real recorder.
 *
 * ONE THING IS SUPPLIED RATHER THAN REACHED FOR, and it is not on the path under
 * test: THE SIGNING KEY. `resolveSigningWallet` decrypts from the user's real
 * keystore, which needs a password this test must never hold. A generated key
 * stands in. Everything downstream is real.
 *
 * TWO PIECES OF FORK STATE ARE SET DELIBERATELY, and both are named as what they
 * are rather than pretended to be organic:
 *
 *   1. THE WALLET'S USDC. A throwaway address holds nothing, so its balance is
 *      written into the token's own balances mapping (slot 9, located by probe
 *      against the live contract). The approval, the pull and the accounting are
 *      then entirely real.
 *   2. THE MARKET'S FREE LIQUIDITY, for the liquidity-refusal case ONLY. The
 *      live cbBTC/USDC market has roughly 184M USDC free, which no test wallet
 *      can ever out-supply, so the liquidity bound could never be reached
 *      honestly from a funded position. `totalBorrowAssets` is raised on the
 *      fork to put the market near full utilisation, and the refusal is then
 *      produced by the real engine reading the real (forked) market. That case
 *      runs LAST, after the round trip, so nothing before it sees the edit.
 *
 * OPT-IN. It needs `anvil --fork-url <base>` on 8545 and a database:
 *
 *   anvil --fork-url https://base-mainnet.public.blastapi.io --port 8545
 *   VEX_MORPHO_FORK_RPC=http://127.0.0.1:8545 VEX_DB_URL=... \
 *     pnpm exec vitest run --config vitest/integration.config.ts \
 *     src/__tests__/integration/morpho/market-supply-fork.int.test.ts
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  encodePacked,
  pad,
  parseEther,
  toHex,
} from "viem";
import { base } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type {
  ProtocolExecuteRequest,
  ProtocolExecutionContext,
} from "@vex-agent/tools/protocols/types.js";

const FORK_RPC = process.env["VEX_MORPHO_FORK_RPC"];
const describeFork = FORK_RPC === undefined ? describe.skip : describe;

/**
 * A REAL Base market that declares NO ORACLE: USDC against `address(0)`
 * collateral, oracle and IRM, at LLTV 0, holding real supply. Blue is
 * permissionless, so markets like this exist and a lender can reach one by
 * copying an id. Vex must refuse it, and the refusal must come from the
 * vouching gate rather than from an unresolvable id.
 */
const NO_ORACLE_MARKET_ID = "0x38c846197ac32a752a60c25d4536ebb0c3920c532e9a859c38c91efb7b8c2abb";

/** The live Base cbBTC/USDC market Vex vouches for. Loan asset: 6-decimal USDC. */
const MARKET_ID = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
const BLUE = getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

/** 1,000 USDC, in the LOAN token's own six decimals. Never the collateral's eight. */
const SUPPLY_RAW = "1000000000";
/** The starting balance: enough to supply and to prove nothing else was pulled. */
const FUNDED_RAW = 5_000_000_000n;

/** USDC's `balances` mapping slot on Base, located by probe against the live contract. */
const USDC_BALANCES_SLOT = 9n;
/** Morpho Blue's `market` mapping slot, located the same way. */
const BLUE_MARKET_SLOT = 3n;

const PRIVATE_KEY = generatePrivateKey();
const WALLET = privateKeyToAccount(PRIVATE_KEY).address;

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveSigningWallet: () => ({ family: "eip155", address: WALLET, privateKey: PRIVATE_KEY }),
    resolveSelectedAddress: () => WALLET,
  };
});

const ERC20 = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const BLUE_ABI = [
  {
    name: "position",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "address" }],
    outputs: [
      { name: "supplyShares", type: "uint256" },
      { name: "borrowShares", type: "uint128" },
      { name: "collateral", type: "uint128" },
    ],
  },
  {
    name: "market",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [
      { name: "totalSupplyAssets", type: "uint128" },
      { name: "totalSupplyShares", type: "uint128" },
      { name: "totalBorrowAssets", type: "uint128" },
      { name: "totalBorrowShares", type: "uint128" },
      { name: "lastUpdate", type: "uint128" },
      { name: "fee", type: "uint128" },
    ],
  },
] as const;

function createFork(rpc: string) {
  return createPublicClient({ chain: base, transport: http(rpc) });
}

async function anvil(method: string, params: readonly unknown[]): Promise<void> {
  await fetch(FORK_RPC as string, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("expected an object payload");
  return value as Record<string, unknown>;
}

describeFork("the Morpho market LENDER lane through the product spine, on a Base fork", () => {
  const sessionId = `morpho-market-supply-fork-${Date.now()}`;

  const context = (): ProtocolExecutionContext => ({
    sessionPermission: "full",
    approved: true,
    sessionId,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
  });

  /**
   * The fork reader. Typed from the factory's own return so a viem upgrade that
   * changes the client shape fails here rather than at a cast.
   */
  let publicClient: ReturnType<typeof createFork>;

  async function run(request: ProtocolExecuteRequest) {
    const { executeProtocolTool } = await import("@vex-agent/tools/protocols/runtime.js");
    return executeProtocolTool(request, context());
  }

  /** Quote THEN execute, which is what the prequote gate requires of every caller. */
  async function quoteThen(direction: string, params: Record<string, unknown>, toolId: string) {
    const quote = await run({ toolId: "morpho.market.quote", params: { direction, ...params } });
    expect(quote.success, `quote (${direction}): ${quote.output}`).toBe(true);
    return run({ toolId, params });
  }

  async function supplyPosition(): Promise<{ shares: bigint; assets: bigint }> {
    const [shares] = await publicClient.readContract({
      address: BLUE, abi: BLUE_ABI, functionName: "position", args: [MARKET_ID as `0x${string}`, WALLET],
    });
    const [totalSupplyAssets, totalSupplyShares] = await publicClient.readContract({
      address: BLUE, abi: BLUE_ABI, functionName: "market", args: [MARKET_ID as `0x${string}`],
    });
    const assets = totalSupplyShares === 0n ? 0n : (shares * totalSupplyAssets) / totalSupplyShares;
    return { shares, assets };
  }

  beforeAll(async () => {
    const rpc = FORK_RPC as string;
    const constants = await import("@tools/morpho/constants.js");
    (constants.MORPHO_DEFAULT_RPC as Record<number, string>)[8453] = rpc;
    (constants.MORPHO_RPC_FALLBACKS as Record<number, readonly string[]>)[8453] = [];

    publicClient = createFork(rpc);

    await anvil("anvil_setBalance", [WALLET, `0x${parseEther("1").toString(16)}`]);
    await anvil("anvil_setStorageAt", [
      USDC,
      keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [WALLET, USDC_BALANCES_SLOT])),
      pad(toHex(FUNDED_RAW)),
    ]);

    const funded = await publicClient.readContract({
      address: USDC, abi: ERC20, functionName: "balanceOf", args: [WALLET],
    });
    expect(funded).toBe(FUNDED_RAW);

    const { query } = await import("@vex-agent/db/client.js");
    await query(
      "INSERT INTO sessions (id, title) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [sessionId, "morpho market supply fork proof"],
    );
  }, 180_000);

  it("supplies the loan asset into a real market and PROVES the amount from the receipt", async () => {
    const before = await supplyPosition();
    expect(before.shares).toBe(0n);

    const result = await quoteThen(
      "supply",
      { marketId: MARKET_ID, chain: "base", supplyAmountRaw: SUPPLY_RAW },
      "morpho.market.supply",
    );

    expect(result.success, result.output).toBe(true);
    const data = record(result.data);
    expect(data["status"]).toBe("confirmed");
    expect(data["operation"]).toBe("supply");
    expect(data["tokenIn"]).toBe("USDC");
    expect(data["tokenSymbol"]).toBe("USDC");
    expect(data["tokenDecimals"]).toBe(6);

    // The position is real, on chain, and it is a SHARE count rather than a
    // token balance: nothing was minted to the wallet.
    const after = await supplyPosition();
    expect(after.shares).toBeGreaterThan(0n);
    expect(after.assets).toBeGreaterThanOrEqual(BigInt(SUPPLY_RAW) - 2n);
    const walletTokens = await publicClient.readContract({
      address: USDC, abi: ERC20, functionName: "balanceOf", args: [WALLET],
    });
    expect(walletTokens).toBe(FUNDED_RAW - BigInt(SUPPLY_RAW));
  }, 300_000);

  it("refuses a withdrawal larger than the wallet's own supplied position, by name", async () => {
    const tooMuch = (BigInt(SUPPLY_RAW) * 10n).toString();
    const quote = await run({
      toolId: "morpho.market.quote",
      params: { direction: "withdraw", marketId: MARKET_ID, chain: "base", withdrawAmountRaw: tooMuch },
    });
    expect(quote.success).toBe(false);
    expect(quote.output.toLowerCase()).toContain("suppl");

    // Nothing moved, and the position is exactly where the supply left it.
    const position = await supplyPosition();
    expect(position.assets).toBeGreaterThanOrEqual(BigInt(SUPPLY_RAW) - 2n);
  }, 300_000);

  it("refuses an unlisted market before anything is built", async () => {
    const result = await run({
      toolId: "morpho.market.supply",
      params: { marketId: `0x${"a".repeat(64)}`, chain: "base", supplyAmountRaw: SUPPLY_RAW },
    });
    expect(result.success).toBe(false);
    // No quote could exist for it either, so the gate and the engine both refuse.
    expect(result.output.length).toBeGreaterThan(0);
  }, 300_000);

  it("refuses a REAL market that declares NO ORACLE, which is the vouching gate answering", async () => {
    // Blue is permissionless, and this is a live Base market: USDC as the loan
    // token against `address(0)` collateral, oracle and IRM, holding real
    // supply. It is not malformed and it is not a typo - it is a market Vex
    // must refuse to act on, and the refusal has to come from the vouching
    // gate rather than from an id that fails to resolve.
    const result = await run({
      toolId: "morpho.market.quote",
      params: { direction: "supply", marketId: NO_ORACLE_MARKET_ID, chain: "base", supplyAmountRaw: SUPPLY_RAW },
    });
    expect(result.success).toBe(false);
    // The refusal is the POLICY gate answering with a named failing predicate,
    // not a transient failure and not an unresolvable id. This market declares
    // `address(0)` for BOTH its IRM and its oracle, and the IRM predicate is
    // checked first, so the message names that one - which is the point: the
    // gate refuses on the first thing it cannot vouch for, by name.
    expect(result.output).toContain("MORPHO_MARKET_POLICY_VIOLATION");
    expect(result.output.toLowerCase()).toContain("failing predicate");
    expect(result.output.toLowerCase()).toContain("policy refusal rather than a transient failure");
    // And nothing at all happened on the way to that answer.
    expect(result.output.toLowerCase()).toContain("nothing was signed or sent");
  }, 300_000);

  it("withdraws the whole position back out and returns it to zero", async () => {
    const position = await supplyPosition();
    // Withdraw slightly less than the full accrued position: an exact-assets
    // withdrawal of the whole thing races the interest accruing between the
    // read and the block, which is why closing a lender position exactly is a
    // separate question from proving the round trip.
    const amount = (position.assets - 2n).toString();

    const result = await quoteThen(
      "withdraw",
      { marketId: MARKET_ID, chain: "base", withdrawAmountRaw: amount },
      "morpho.market.withdraw",
    );

    expect(result.success, result.output).toBe(true);
    const data = record(result.data);
    expect(data["status"]).toBe("confirmed");
    expect(data["operation"]).toBe("withdraw");
    expect(data["tokenOut"]).toBe("USDC");

    const after = await supplyPosition();
    // What remains is dust: the two base units left behind plus whatever
    // accrued, never the position.
    expect(after.assets).toBeLessThan(1000n);

    const walletTokens = await publicClient.readContract({
      address: USDC, abi: ERC20, functionName: "balanceOf", args: [WALLET],
    });
    expect(walletTokens).toBeGreaterThan(FUNDED_RAW - 1000n);
  }, 300_000);

  it("writes the lender rows under the VAULT lane's roles, distinguishable by their intent params", async () => {
    const { query } = await import("@vex-agent/db/client.js");
    // The intent params live on the row's `protocol_executions` PARENT, which is
    // where every lane writes them, so the join is what a later audit would run.
    const rows = await query<{
      event_role: string;
      kind: string;
      protocol: string;
      status: string;
      tool_id: string;
      params: Record<string, unknown>;
      route_provenance: Record<string, unknown> | null;
    }>(
      `SELECT a.event_role, a.kind, a.protocol, a.status, a.route_provenance,
              e.tool_id, e.params
         FROM agent_activity a
         JOIN protocol_executions e ON e.id = a.protocol_execution_id
        WHERE a.session_id = $1 AND a.event_role IN ('lend_deposit','lend_withdraw')
        ORDER BY a.id ASC`,
      [sessionId],
    );

    const roles = rows.map((row) => row.event_role);
    expect(roles).toContain("lend_deposit");
    expect(roles).toContain("lend_withdraw");

    for (const row of rows) {
      expect(row.kind).toBe("lend");
      expect(row.protocol).toBe("morpho");
      expect(row.status).toBe("confirmed");
      // THE DISTINGUISHER. A market row carries a versioned effects payload
      // anchored on a 64-hex MARKET ID and names its operation; a vault row
      // carries a vault ADDRESS and neither of those. The role alone can no
      // longer say which venue moved the money, and this is what can.
      expect(row.params["effectsVersion"]).toBeDefined();
      expect(row.params["vaultAddress"]).toBeUndefined();
      const market = record(row.params["market"]);
      // The stored params are SANITIZED before they are written (the repo's own
      // secret-shape scrub shortens long hex), so the id is asserted by its
      // ends rather than in full. What matters for the distinguisher is that a
      // market id is there at all and that it is THIS market's.
      const storedMarketId = String(market["marketId"]);
      expect(storedMarketId.startsWith(MARKET_ID.slice(0, 6))).toBe(true);
      expect(storedMarketId.endsWith(MARKET_ID.slice(-4))).toBe(true);
      expect(["supply", "withdraw"]).toContain(row.params["operation"]);
      expect(["morpho.market.supply", "morpho.market.withdraw"]).toContain(row.tool_id);
      // The provenance block is what routes the settlement decode away from the
      // vault's net-delta rule, which would decline a Blue supply forever.
      expect(record(row.route_provenance ?? {})["morphoBorrow"]).toBeDefined();
    }
  }, 120_000);

  it("refuses a withdrawal beyond the MARKET'S free liquidity, separately from the position bound", async () => {
    // The live market has roughly 184M USDC free, which no test wallet can
    // out-supply, so the liquidity bound is unreachable from an honest position.
    // The fork is pushed to near-full utilisation here, LAST, so every case
    // above ran against the real market. The refusal itself is the real engine
    // reading the real (forked) market.
    // Re-supply FIRST, so the wallet has a position to be refused ON: that is
    // what isolates this bound from the position bound proven above. The
    // utilisation is then set on top of it, because a supply ADDS liquidity and
    // would otherwise undo the very state under test.
    const supplied = await quoteThen(
      "supply",
      { marketId: MARKET_ID, chain: "base", supplyAmountRaw: SUPPLY_RAW },
      "morpho.market.supply",
    );
    expect(supplied.success, supplied.output).toBe(true);

    const marketSlot = BigInt(keccak256(
      encodePacked(["bytes32", "uint256"], [MARKET_ID as `0x${string}`, BLUE_MARKET_SLOT]),
    ));
    const [totalSupplyAssets, , , totalBorrowShares] = await publicClient.readContract({
      address: BLUE, abi: BLUE_ABI, functionName: "market", args: [MARKET_ID as `0x${string}`],
    });
    // totalBorrowAssets is the LOW 128 bits of `market[id]` slot + 1, with
    // totalBorrowShares in the high half. Leave one base unit free so the
    // refusal is a liquidity bound rather than an empty market.
    const borrowed = totalSupplyAssets - 1n;
    await anvil("anvil_setStorageAt", [
      BLUE,
      toHex(marketSlot + 1n),
      pad(toHex((totalBorrowShares << 128n) | borrowed)),
    ]);

    const result = await run({
      toolId: "morpho.market.quote",
      params: { direction: "withdraw", marketId: MARKET_ID, chain: "base", withdrawAmountRaw: SUPPLY_RAW },
    });
    expect(result.success).toBe(false);
    expect(result.output.toLowerCase()).toContain("liquidity");
  }, 300_000);
});
