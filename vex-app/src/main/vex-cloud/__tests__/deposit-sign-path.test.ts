/**
 * The Vex Cloud deposit owner on the REAL signing path, with only the node
 * faked: `createErc20TransferPort` and `signStageBroadcast` with the deferred
 * signer run as shipped, over a viem client whose RPC methods are replaced.
 *
 * WHY THIS FILE EXISTS. The IPC suite's chain is a fake port that replays
 * `signStageBroadcast`'s order by hand, so it cannot prove WHERE in that order
 * a check runs. Here the order is the real one: the deferred gate
 * (`onBeforeSign`), then the key decryption, then the pending-nonce re-read
 * (`assertReservedNonceMatchesPending`, an RPC), then
 * `StagedBroadcastHooks.onBeforeSign` (the deposit's `onFinalCheck`), then the
 * offline signature. The nonce re-read is held open, and the world changes
 * while it is pending.
 *
 * WHAT IT PINS:
 *  - F1: a sender that is not linked to the signed-in account is refused at
 *    prepare, and again by the pre-sign gate when it was unlinked after
 *    prepare: no key is loaded, nothing is sent, and the wallet's next
 *    deposit still signs the same nonce;
 *  - F2: Stop pressed, or the approval expiring, while the nonce re-read is
 *    pending means nothing is signed or broadcast.
 *
 * DOES NOT PROVE: real node behaviour (the gated Anvil fork test does), or
 * the receipt path (a send here always fails, so a signed deposit ends
 * `pending`, which is all these tests need to see a signature happened).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createErc20TransferPort, transferChainClientsForRpc } from "@tools/evm-chains/erc20-transfer-port.js";
import { VEX_TOKEN_ADDRESS } from "@shared/vex-cloud-money.js";
import type { VexCloudAccountResponse, VexCloudCall } from "../api-client.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prepareDeposit, submitDeposit, __resetDepositStateForTests } = await import("../funding/deposit.js");
type DepositDeps = import("../funding/deposit-core.js").DepositDeps;

const KEY = `0x${"42".repeat(32)}` as Hex;
const WALLET = privateKeyToAccount(KEY).address;
const DEPOSIT = "0x00000000000000000000000000000000000D3905";
const NOW = new Date("2026-10-21T12:00:00.000Z");
const E18 = 10n ** 18n;
const NONCE = 7;

function accountWith(linked: readonly string[]): VexCloudAccountResponse {
  const amount = { wei: "0", usd_micro_estimate: "0" };
  return {
    account_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    status: { paused: false, drain_mode: false },
    wallets: linked.map((address) => ({ address, linked_at: NOW.toISOString() })),
    deposit_address: DEPOSIT,
    balances: { available: amount, provisional: amount, reserved: amount, pending_withdrawal: amount, claimable: amount },
    rate: {
      available: true,
      source: "twap",
      vex_wei_per_micro_usd: "1000000000000000",
      observed_at: NOW.toISOString(),
      age_seconds: 1,
      valid_until: new Date(NOW.getTime() + 600_000).toISOString(),
    },
    limits: { min_deposit_micro_usd: "5000000", min_withdraw_micro_usd: "5000000", provisional_cap_micro_usd: "25000000" },
  };
}

/** A gate the test opens: the pending-nonce re-read waits on it. */
function gateOpen(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

interface World {
  linked: string[];
  now: Date;
  keyLoads: number;
  nonceHold: Promise<void> | null;
  readonly nonceReads: number[];
  readonly sent: Hex[];
}

type Harness = World & { readonly deps: DepositDeps };

function harness(): Harness {
  const clients = transferChainClientsForRpc(4663, "http://127.0.0.1:1");
  const self: World = {
    linked: [WALLET.toLowerCase()],
    now: NOW,
    keyLoads: 0,
    nonceHold: null,
    nonceReads: [],
    sent: [],
  };
  Object.assign(clients.signingClient, {
    readContract: vi.fn(async () => 50_000n * E18),
    getBalance: vi.fn(async () => 10n ** 17n),
    estimateGas: vi.fn(async () => 60_000n),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 0n })),
    prepareTransactionRequest: vi.fn(async (args: Record<string, unknown>) => ({
      ...args,
      chainId: 4663,
      nonce: NONCE,
      type: "eip1559",
    })),
    getTransactionCount: vi.fn(async () => {
      self.nonceReads.push(self.nonceReads.length + 1);
      if (self.nonceHold !== null) await self.nonceHold;
      return NONCE;
    }),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      self.sent.push(serializedTransaction);
      throw new Error("the fake node drops every send");
    }),
  });
  const port = createErc20TransferPort(clients, VEX_TOKEN_ADDRESS);
  const entry = { id: "evm_00000000-0000-4000-8000-000000000001", address: WALLET, label: "Main", createdAt: NOW.toISOString() };
  const deps: DepositDeps = {
    api: {
      readAccount: async (): Promise<VexCloudCall<VexCloudAccountResponse>> => ({ ok: true, value: accountWith(self.linked) }),
      notifyDeposit: async () => ({ ok: true, value: { accepted: true as const } }),
    },
    readSession: async () => ({ ok: true, data: "vxs_test_bearer_000000000001" }),
    clearSession: async () => ({ ok: true, data: undefined }),
    chain: () => port,
    listEvmWallets: () => [entry],
    isVaultUnlocked: () => true,
    isExecutionReady: () => true,
    pinnedDepositAddress: () => DEPOSIT,
    loadPrivateKey: async () => {
      self.keyLoads += 1;
      return KEY;
    },
    now: () => self.now,
  };
  return Object.assign(self, { deps });
}

async function prepared(h: Harness): Promise<{ proposalId: string; walletAddress: string; amountWei: string }> {
  const proposal = await prepareDeposit(h.deps, { walletAddress: WALLET, amountText: "6000" }, new AbortController().signal);
  if (!proposal.ok) throw new Error(`prepare refused: ${proposal.refusal.kind}`);
  return { proposalId: proposal.value.proposalId, walletAddress: proposal.value.from, amountWei: proposal.value.amountWei };
}

beforeEach(() => {
  __resetDepositStateForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("F1: the deposit sender must be linked to the signed-in account", () => {
  it("prepare refuses an in-app wallet that is not linked, and says how to link it", async () => {
    const h = harness();
    h.linked = [];
    const outcome = await prepareDeposit(h.deps, { walletAddress: WALLET, amountText: "6000" }, new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.kind).toBe("sender_not_linked");
    expect(outcome.refusal.detail).toMatch(/Sign in again/);
    expect(h.keyLoads).toBe(0);
  });

  it("the pre-sign gate refuses a wallet unlinked after prepare: no key, nothing sent, the nonce unchanged", async () => {
    const h = harness();
    const input = await prepared(h);
    h.linked = [];
    const outcome = await submitDeposit(h.deps, input, new AbortController().signal, "c1");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.kind).toBe("sender_not_linked");
    expect(h.keyLoads).toBe(0);
    expect(h.sent).toHaveLength(0);

    // The refusal consumed nothing on chain: once linked again, the next deposit signs the SAME nonce.
    h.linked = [WALLET.toLowerCase()];
    const again = await submitDeposit(h.deps, await prepared(h), new AbortController().signal, "c2");
    expect(again.ok && again.value.status).toBe("pending");
    expect(h.sent).toHaveLength(1);
    expect(parseTransaction(h.sent[0] as Hex).nonce).toBe(NONCE);
  });
});

describe("F2: the final check runs after the nonce re-read, immediately before the signature", () => {
  it("Stop pressed while the nonce re-read is pending: nothing is signed or broadcast", async () => {
    const h = harness();
    const input = await prepared(h);
    const hold = gateOpen();
    h.nonceHold = hold.wait;
    const controller = new AbortController();
    const running = submitDeposit(h.deps, input, controller.signal, "c3");
    await vi.waitFor(() => expect(h.nonceReads).toHaveLength(1));
    // The deferred gate already passed and the key is decrypted; only the final check is left.
    expect(h.keyLoads).toBe(1);
    controller.abort();
    hold.open();
    const outcome = await running;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.kind).toBe("cancelled");
    expect(outcome.refusal.detail).toMatch(/Nothing was signed or sent/);
    expect(h.sent).toHaveLength(0);
  });

  it("the approval expiring while the nonce re-read is pending: nothing is signed or broadcast", async () => {
    const h = harness();
    const input = await prepared(h);
    const hold = gateOpen();
    h.nonceHold = hold.wait;
    const running = submitDeposit(h.deps, input, new AbortController().signal, "c4");
    await vi.waitFor(() => expect(h.nonceReads).toHaveLength(1));
    h.now = new Date(NOW.getTime() + 120_000);
    hold.open();
    const outcome = await running;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.kind).toBe("proposal_expired");
    expect(h.sent).toHaveLength(0);
  });

  it("with nothing changed in that window the same path signs and sends exactly once", async () => {
    const h = harness();
    const outcome = await submitDeposit(h.deps, await prepared(h), new AbortController().signal, "c5");
    expect(outcome.ok && outcome.value.status).toBe("pending");
    expect(h.sent).toHaveLength(1);
    expect(h.keyLoads).toBe(1);
  });
});
