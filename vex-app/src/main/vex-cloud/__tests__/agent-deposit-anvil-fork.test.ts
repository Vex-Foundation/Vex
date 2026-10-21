/**
 * The AGENT deposit owner and the auto top-up poller against an Anvil fork of
 * Robinhood Chain: the agent tool's chat-approval mode (an approved card),
 * its rule mode (an active auto top-up rule, no card), and one poller
 * execution, each proven by the Transfer log on the real receipt, with the
 * rule's caps counted on the execution record.
 *
 * GATED like `deposit-anvil-fork.test.ts`: runs only with
 * `VEX_CLOUD_ANVIL_FORK=1` and `anvil` on PATH (or `VEX_ANVIL_BIN`). The fork
 * is pinned near the head; nothing is broadcast to the real chain.
 *
 *   VEX_CLOUD_ANVIL_FORK=1 VEX_ANVIL_BIN=$HOME/.foundry/bin/anvil \
 *     pnpm exec vitest run src/main/vex-cloud/__tests__/agent-deposit-anvil-fork.test.ts
 *
 * REAL: the agent deposit owner, the recorded execution owner, the poller,
 * the shared deposit core (every check), the chain port, `signStageBroadcast`
 * with the deferred signer, the nonce owner, viem, the forked VEX contract.
 * FAKED: the gateway (the dev deposit address and a fixed rate), the vault (a
 * throwaway key) and the store (in memory, the repository contract).
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
const FUNDED = 40_000n * E18;
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

describeFork("the agent deposit and auto top-up on an Anvil fork of Robinhood Chain", () => {
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
      { from: V3_POOL, to: VEX, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [WALLET, FUNDED] }) },
    ])) as Hex;
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as { status: string };
    expect(receipt.status).toBe("0x1");
    await rpc("anvil_stopImpersonatingAccount", [V3_POOL]);
  }, 120_000);

  afterAll(() => {
    anvil?.kill("SIGTERM");
  });

  it("chat approval, rule mode and a poller top-up each move exactly the approved VEX, proven on the receipt, with the caps counted", async () => {
    const { createErc20TransferPort, transferChainClientsForRpc } = await import("@tools/evm-chains/erc20-transfer-port.js");
    const { confirmAgentDeposit, prepareAgentDeposit } = await import("../funding/agent-deposit.js");
    const { markRecoveryComplete } = await import("../auto-top-up/executor.js");
    const { createAutoTopUpPoller } = await import("../auto-top-up/poller.js");
    const { proveErc20Transfer } = await import("@vex-agent/tools/internal/wallet/send/transfer-settlement.js");
    const { MemoryFundingStore } = await import("./support/funding-fakes.js");

    const ACCOUNT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let availableWei = 100_000n * E18;
    const account = () => ({
      account_id: ACCOUNT,
      status: { paused: false, drain_mode: false },
      wallets: [{ address: WALLET.toLowerCase(), linked_at: new Date().toISOString() }],
      deposit_address: DEV_DEPOSIT,
      balances: {
        available: { wei: String(availableWei), usd_micro_estimate: "0" },
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
    });
    const port = createErc20TransferPort(transferChainClientsForRpc(4663, RPC), VEX);
    const entry = { id: "evm_00000000-0000-4000-8000-000000000001", address: WALLET, label: "Fork wallet", createdAt: new Date().toISOString() };
    const deposit = {
      api: {
        readAccount: async () => ({ ok: true as const, value: account() }),
        notifyDeposit: async () => ({ ok: true as const, value: { accepted: true as const } }),
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
    const store = new MemoryFundingStore();
    const conditions = () => ({ now: new Date(), vaultUnlocked: true, quitting: false, executionReady: true, signedInAccountId: ACCOUNT });
    const agent = { deposit, store, conditions };
    await markRecoveryComplete(store, new Date());
    const reader = createPublicClient({ transport: http(RPC) });
    const depositBalance = () => reader.readContract({ address: VEX, abi: ERC20, functionName: "balanceOf", args: [DEV_DEPOSIT] });
    const signal = new AbortController().signal;
    const prove = async (hash: string, amountWei: bigint) => {
      const receipt = await reader.getTransactionReceipt({ hash: hash as Hex });
      expect(receipt.status).toBe("success");
      expect(proveErc20Transfer({ logs: receipt.logs, tokenAddress: VEX, from: WALLET, to: DEV_DEPOSIT, expectedAmountRaw: amountWei })).toBe(amountWei);
    };
    const prepare = async (vex: string) => {
      const intent = await prepareAgentDeposit(agent, { sessionId: "fork-session", walletAddress: WALLET, amount: { unit: "VEX", value: vex } }, signal);
      if (!intent.ok) throw new Error(`prepare refused at fork block ${forkBlock}: ${intent.refusal.kind}: ${intent.refusal.detail}`);
      return intent.value;
    };
    const confirm = (intentId: string, authority: { kind: "none" } | { kind: "approved_card"; approvalId: string }) =>
      confirmAgentDeposit(agent, { sessionId: "fork-session", intentId, authority, sourceWalletStillAllowed: () => null }, signal);

    // 1. Chat approval: no rule, so the first answer is the card; the approved resume sends.
    const before1 = await depositBalance();
    const chat = await prepare("5000");
    expect(await confirm(chat.intentId, { kind: "none" })).toMatchObject({ ok: true, value: { kind: "needs_user_approval" } });
    const approved = await confirm(chat.intentId, { kind: "approved_card", approvalId: "fork-approval" });
    if (!approved.ok || approved.value.kind !== "executed") throw new Error(`chat approval did not execute: ${JSON.stringify(approved)}`);
    expect(approved.value).toMatchObject({ status: "confirmed", transferProven: true, authority: "approved_card" });
    await prove(approved.value.txHash, 5_000n * E18);
    expect((await depositBalance()) - before1).toBe(5_000n * E18);

    // 2. Rule mode: an active rule (two per day, 12,000 VEX per 30 days) covers it without a card.
    const rule = store.seedRule({ accountId: ACCOUNT, sourceWallet: WALLET.toLowerCase(), amountWei: 6_000n * E18, maxPerDay: 2, monthlyCapWei: 12_000n * E18, expiresAt: new Date(Date.now() + 86_400_000) });
    const before2 = await depositBalance();
    const ruled = await confirm((await prepare("6000")).intentId, { kind: "none" });
    if (!ruled.ok || ruled.value.kind !== "executed") throw new Error(`rule mode did not execute: ${JSON.stringify(ruled)}`);
    expect(ruled.value).toMatchObject({ status: "confirmed", authority: "auto_top_up_rule", ruleId: rule.ruleId });
    await prove(ruled.value.txHash, 6_000n * E18);
    expect((await depositBalance()) - before2).toBe(6_000n * E18);

    // 3. The poller: the balance falls under the 20% alert of its reference, and it tops up once.
    const poller = createAutoTopUpPoller({
      deposit,
      store,
      conditions,
      api: { readAccount: deposit.api.readAccount, listDeposits: async () => ({ ok: true as const, value: { items: [], next_cursor: null } }) },
      watch: { store, emitCrossing: () => undefined },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t),
    });
    expect(await poller.tickNow()).toBe("not_triggered");
    availableWei = 10_000n * E18;
    const before3 = await depositBalance();
    expect(await poller.tickNow()).toBe("executed");
    const pollerRow = store.executions.at(-1);
    expect(pollerRow).toMatchObject({ authority: "auto_top_up_poller", status: "confirmed" });
    await prove(pollerRow?.txHash ?? "", 6_000n * E18);
    expect((await depositBalance()) - before3).toBe(6_000n * E18);

    // The caps: two executions in 24 hours and 12,000 VEX used; a third is refused and nothing moves.
    expect(await store.readRuleUsage(rule.ruleId, new Date())).toEqual({ countLastDay: 2, sumLast30DaysWei: 12_000n * E18 });
    const before4 = await depositBalance();
    expect(await confirm((await prepare("5000")).intentId, { kind: "none" })).toMatchObject({ ok: true, value: { kind: "needs_user_approval" } });
    expect(await poller.tickNow()).toBe("suspended");
    expect(await depositBalance()).toBe(before4);
    expect(await reader.readContract({ address: VEX, abi: ERC20, functionName: "balanceOf", args: [WALLET] })).toBe(FUNDED - 17_000n * E18);
  }, 240_000);
});
