/**
 * The Vex Cloud DEPOSIT executor against an Anvil fork of Robinhood Chain.
 *
 * GATED: runs only with `VEX_CLOUD_ANVIL_FORK=1`, and needs `anvil` on PATH
 * (or `VEX_ANVIL_BIN`). The fork is pinned (`--fork-block-number`), so the
 * only network use is the fork's own lazy state reads from
 * `https://rpc.mainnet.chain.robinhood.com`; nothing is ever broadcast to the
 * real chain.
 *
 * WHICH BLOCK. The official endpoint is not an archive node: measured
 * 2026-10-21, state 11k blocks (about 20 minutes) old was already refused
 * ("historical state ... is not available"). A fixed block number therefore
 * stops working within the hour. Each run pins the head minus a small margin
 * (`VEX_CLOUD_FORK_BLOCK` overrides it, for an archive endpoint), and the
 * block it used is part of the failure message.
 *
 *   VEX_CLOUD_ANVIL_FORK=1 VEX_ANVIL_BIN=$HOME/.foundry/bin/anvil \
 *     pnpm exec vitest run src/main/vex-cloud/__tests__/deposit-anvil-fork.test.ts
 *
 * REAL: the deposit owner (prepare and submit, every pre-sign check), the
 * chain port, `signStageBroadcast` with the deferred signer, the nonce owner,
 * viem, the forked VEX contract and its Transfer log, and the agent send
 * tool's `proveErc20Transfer` on the real receipt. FAKED: the Vex Cloud
 * gateway (it reports the dev deposit address and a fixed rate, and records
 * the notify hint) and the vault (a throwaway key generated per run).
 *
 * TWO PIECES OF FORK STATE ARE SET DELIBERATELY: the throwaway wallet's ETH
 * (`anvil_setBalance`) and its VEX, sent from the V3 VEX/USDG pool by
 * impersonation (the pool holds about 25M VEX and is not the taxed V2 pair).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPublicClient, encodeFunctionData, getAddress, http, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const enabled = process.env.VEX_CLOUD_ANVIL_FORK === "1";
const ANVIL_BIN = process.env.VEX_ANVIL_BIN ?? "anvil";
const FORK_URL = "https://rpc.mainnet.chain.robinhood.com";
/** Blocks behind the head the fork is pinned at (about 5 seconds at 106 ms a block). */
const FORK_MARGIN = 50;
let forkBlock = 0;
const PORT = 18_000 + Math.floor(Math.random() * 1_000);
const RPC = `http://127.0.0.1:${PORT}`;

const VEX = getAddress("0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b");
const V3_POOL = getAddress("0x4fA27693a052863bb5e9D3E63bA02857442A1Ecf");
/** A throwaway dev deposit address: nothing holds its key, which is fine for a fork. */
const DEV_DEPOSIT = getAddress("0x00000000000000000000000000000000d3905a11");
const E18 = 10n ** 18n;
const FUNDED = 20_000n * E18;
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);

const PRIVATE_KEY = generatePrivateKey();
const WALLET = privateKeyToAccount(PRIVATE_KEY).address;

let anvil: ChildProcess | null = null;

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function waitForAnvil(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await rpc("eth_chainId", [])) === "0x1237") return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("anvil did not start");
}

const describeFork = enabled ? describe : describe.skip;

describeFork("Vex Cloud deposit on an Anvil fork of Robinhood Chain", () => {
  beforeAll(async () => {
    const pinned = process.env.VEX_CLOUD_FORK_BLOCK;
    if (pinned !== undefined) {
      forkBlock = Number(pinned);
    } else {
      const head = await createPublicClient({ transport: http(FORK_URL) }).getBlockNumber();
      forkBlock = Number(head) - FORK_MARGIN;
    }
    anvil = spawn(
      ANVIL_BIN,
      ["--fork-url", FORK_URL, "--fork-block-number", String(forkBlock), "--port", String(PORT), "--silent"],
      { stdio: "ignore" },
    );
    await waitForAnvil();
    await rpc("anvil_setBalance", [WALLET, "0xDE0B6B3A7640000"]);
    await rpc("anvil_setBalance", [V3_POOL, "0xDE0B6B3A7640000"]);
    await rpc("anvil_impersonateAccount", [V3_POOL]);
    const hash = (await rpc("eth_sendTransaction", [
      {
        from: V3_POOL,
        to: VEX,
        data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [WALLET, FUNDED] }),
      },
    ])) as Hex;
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as { status: string };
    expect(receipt.status).toBe("0x1");
    await rpc("anvil_stopImpersonatingAccount", [V3_POOL]);
  }, 120_000);

  afterAll(() => {
    anvil?.kill("SIGTERM");
  });

  it("transfers the approved VEX to the deposit address, proves the Transfer log and sends the notify hint", async () => {
    const { createErc20TransferPort, transferChainClientsForRpc } = await import("@tools/evm-chains/erc20-transfer-port.js");
    const { prepareDeposit, submitDeposit } = await import("../funding/deposit.js");
    const { proveErc20Transfer } = await import("@vex-agent/tools/internal/wallet/send/transfer-settlement.js");

    const notified: string[] = [];
    const account = {
      account_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      status: { paused: false, drain_mode: false },
      wallets: [{ address: WALLET.toLowerCase(), linked_at: "2026-10-21T12:00:00.000Z" }],
      deposit_address: DEV_DEPOSIT,
      balances: {
        available: { wei: "0", usd_micro_estimate: "0" },
        provisional: { wei: "0", usd_micro_estimate: "0" },
        reserved: { wei: "0", usd_micro_estimate: "0" },
        pending_withdrawal: { wei: "0", usd_micro_estimate: "0" },
        claimable: { wei: "0", usd_micro_estimate: "0" },
      },
      rate: {
        available: true as const,
        source: "fixed",
        vex_wei_per_micro_usd: "1000000000000000",
        observed_at: new Date().toISOString(),
        age_seconds: 1,
        valid_until: new Date(Date.now() + 600_000).toISOString(),
      },
      limits: { min_deposit_micro_usd: "5000000", min_withdraw_micro_usd: "5000000", provisional_cap_micro_usd: "25000000" },
    };
    const port = createErc20TransferPort(transferChainClientsForRpc(4663, RPC), VEX);
    const entry = { id: "evm_00000000-0000-4000-8000-000000000001", address: WALLET, label: "Fork wallet", createdAt: new Date().toISOString() };
    const deps = {
      api: {
        readAccount: async () => ({ ok: true as const, value: account }),
        notifyDeposit: async (_bearer: string, txHash: string) => {
          notified.push(txHash);
          return { ok: true as const, value: { accepted: true as const } };
        },
      },
      readSession: async () => ({ ok: true as const, data: "vxs_fork_bearer_0000000001" }),
      clearSession: async () => ({ ok: true as const, data: undefined }),
      chain: () => port,
      listEvmWallets: () => [entry],
      isVaultUnlocked: () => true,
      isExecutionReady: () => true,
      pinnedDepositAddress: () => DEV_DEPOSIT,
      loadPrivateKey: async () => PRIVATE_KEY,
      now: () => new Date(),
    };
    const signal = new AbortController().signal;
    const amountWei = 6_000n * E18;

    const proposal = await prepareDeposit(deps, { walletAddress: WALLET, amountText: "6000" }, signal);
    if (!proposal.ok) throw new Error(`prepare refused at fork block ${forkBlock}: ${proposal.refusal.kind}: ${proposal.refusal.detail}`);
    expect(proposal.value).toMatchObject({ from: WALLET, to: DEV_DEPOSIT, amountWei: amountWei.toString(), walletVexWei: FUNDED.toString() });

    const reader = createPublicClient({ transport: http(RPC) });
    const before = await reader.readContract({ address: VEX, abi: ERC20, functionName: "balanceOf", args: [DEV_DEPOSIT] });

    const sent = await submitDeposit(
      deps,
      { proposalId: proposal.value.proposalId, walletAddress: WALLET, amountWei: amountWei.toString() },
      signal,
      "fork-correlation",
    );
    if (!sent.ok) throw new Error(`submit refused at fork block ${forkBlock}: ${sent.refusal.kind}: ${sent.refusal.detail}`);
    expect(sent.value).toMatchObject({ status: "confirmed", transferProven: true, notified: true });
    expect(notified).toEqual([sent.value.txHash]);

    // The world, not the executor's word: the receipt and the balances.
    const receipt = await reader.getTransactionReceipt({ hash: sent.value.txHash as Hex });
    expect(receipt.status).toBe("success");
    expect(proveErc20Transfer({ logs: receipt.logs, tokenAddress: VEX, from: WALLET, to: DEV_DEPOSIT, expectedAmountRaw: amountWei })).toBe(amountWei);
    const after = await reader.readContract({ address: VEX, abi: ERC20, functionName: "balanceOf", args: [DEV_DEPOSIT] });
    expect(after - before).toBe(amountWei);
    const left = await reader.readContract({ address: VEX, abi: ERC20, functionName: "balanceOf", args: [WALLET] });
    expect(left).toBe(FUNDED - amountWei);
  }, 180_000);

  it("refuses a pinned address that changed after prepare, and nothing reaches the chain", async () => {
    const { createErc20TransferPort, transferChainClientsForRpc } = await import("@tools/evm-chains/erc20-transfer-port.js");
    const { prepareDeposit, submitDeposit } = await import("../funding/deposit.js");
    const port = createErc20TransferPort(transferChainClientsForRpc(4663, RPC), VEX);
    let pinned: string = DEV_DEPOSIT;
    let keyLoads = 0;
    const entry = { id: "evm_00000000-0000-4000-8000-000000000001", address: WALLET, label: "Fork wallet", createdAt: new Date().toISOString() };
    const account = {
      account_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      status: { paused: false, drain_mode: false },
      wallets: [],
      deposit_address: DEV_DEPOSIT,
      balances: {
        available: { wei: "0", usd_micro_estimate: "0" },
        provisional: { wei: "0", usd_micro_estimate: "0" },
        reserved: { wei: "0", usd_micro_estimate: "0" },
        pending_withdrawal: { wei: "0", usd_micro_estimate: "0" },
        claimable: { wei: "0", usd_micro_estimate: "0" },
      },
      rate: {
        available: true as const,
        source: "fixed",
        vex_wei_per_micro_usd: "1000000000000000",
        observed_at: new Date().toISOString(),
        age_seconds: 1,
        valid_until: new Date(Date.now() + 600_000).toISOString(),
      },
      limits: { min_deposit_micro_usd: "5000000", min_withdraw_micro_usd: "5000000", provisional_cap_micro_usd: "25000000" },
    };
    const deps = {
      api: {
        readAccount: async () => ({ ok: true as const, value: account }),
        notifyDeposit: async () => ({ ok: true as const, value: { accepted: true as const } }),
      },
      readSession: async () => ({ ok: true as const, data: "vxs_fork_bearer_0000000001" }),
      clearSession: async () => ({ ok: true as const, data: undefined }),
      chain: () => port,
      listEvmWallets: () => [entry],
      isVaultUnlocked: () => true,
      isExecutionReady: () => true,
      pinnedDepositAddress: () => pinned,
      loadPrivateKey: async () => {
        keyLoads += 1;
        return PRIVATE_KEY;
      },
      now: () => new Date(),
    };
    const signal = new AbortController().signal;
    const nonceBefore = await createPublicClient({ transport: http(RPC) }).getTransactionCount({ address: WALLET });
    const proposal = await prepareDeposit(deps, { walletAddress: WALLET, amountText: "5000" }, signal);
    if (!proposal.ok) throw new Error(proposal.refusal.detail);
    pinned = getAddress("0x00000000000000000000000000000000000ba0ba");
    const sent = await submitDeposit(
      deps,
      { proposalId: proposal.value.proposalId, walletAddress: WALLET, amountWei: proposal.value.amountWei },
      signal,
      "fork-correlation-2",
    );
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.refusal.kind).toBe("deposit_address_mismatch");
    expect(keyLoads).toBe(0);
    const nonceAfter = await createPublicClient({ transport: http(RPC) }).getTransactionCount({ address: WALLET });
    expect(nonceAfter).toBe(nonceBefore);
  }, 120_000);
});
