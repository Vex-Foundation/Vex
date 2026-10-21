/**
 * Vex Cloud FUNDING IPC (phase 2), end to end on a fake gateway that speaks
 * plan section 15.2 over HTTP.
 *
 * WHAT IS REAL: `registerHandler` (sender seam, envelope, strict schemas, the
 * execution gate, cancellation, output validation), the HTTP client
 * (`createVexCloudApi`, bearer header, `Idempotency-Key`, bounded bodies,
 * every refusal reason mapped), the deposit, withdraw, cashback and history
 * owners, the proposal store and the money arithmetic. FAKED: the gateway
 * (an in-memory implementation of 15.2: auth, the account, idempotent
 * withdrawals, the daily limit, cursors, notify), Robinhood Chain (a port
 * that runs the pre-sign gate and the key load in `signStageBroadcast`'s own
 * order) and the vault. The real chain path is pinned on an Anvil fork by
 * `vex-cloud/__tests__/deposit-anvil-fork.test.ts`.
 *
 * WHAT IT PINS:
 *  - per method: positive, invalid input, wrong sender or subframe,
 *    cancellation, and every 15.2 refusal reason by name;
 *  - approval binding: a changed amount, wallet or pinned address after
 *    prepare refuses submit; an expired proposal refuses; a locked vault
 *    refuses before any key is touched; a proposal is single use; one
 *    deposit per wallet at a time;
 *  - an unknown deposit outcome stays pending, is never re-sent, and the
 *    notify hint carries the hash;
 *  - withdrawal idempotency: an answer that does not prove a refusal is an
 *    unknown outcome, and Check status of the SAME proposal reuses its key
 *    and gets the same withdrawal; a new proposal gets a new key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, getAddress, pad, type Hex } from "viem";
import type { FinalSignedRequest, StagedBroadcastOutcome } from "@tools/evm-chains/staged-broadcast.js";

const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
}));

const assertTrustedSender = vi.fn<(event: unknown) => void>(() => undefined);
vi.mock("../sender-validation.js", () => ({
  assertTrustedSender: (event: unknown) => assertTrustedSender(event),
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../vex-cloud/production.js", () => ({
  productionVexCloudDeps: () => {
    throw new Error("production deps must not be used in this suite");
  },
}));

const { CH } = await import("@shared/ipc/channels.js");
const { openExecutionGate, closeExecutionGateForShutdown } = await import("../../lifecycle/execution-gate.js");
const { registerVexCloudHandlers } = await import("../vex-cloud.js");
const { getCancelController } = await import("../register-handler.js");
const { createVexCloudApi } = await import("../../vex-cloud/api-client.js");
const { __resetDepositStateForTests } = await import("../../vex-cloud/funding/deposit.js");
const { __resetWithdrawStateForTests } = await import("../../vex-cloud/funding/withdraw.js");
const { __resetCashbackStateForTests } = await import("../../vex-cloud/funding/cashback.js");
import type { TransferBroadcastRequest, Erc20TransferPort } from "@tools/evm-chains/erc20-transfer-port.js";
import type { VexCloudDeps } from "../../vex-cloud/production.js";

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
const NOW = new Date("2026-10-21T12:00:00.000Z");
const VEX = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b";
const DEPOSIT = getAddress("0x00000000000000000000000000000000000d3905");
const OTHER_DEPOSIT = getAddress("0x00000000000000000000000000000000000ba0ba");
const W1 = getAddress("0x1111111111111111111111111111111111111111");
const W2 = getAddress("0x2222222222222222222222222222222222222222");
const NOT_LOCAL = getAddress("0x3333333333333333333333333333333333333333");
const BEARER = "vxs_test_bearer_000000000001";
const E18 = 10n ** 18n;
/** 10^15 VEX wei per micro-USD: 1 VEX = $0.001, so $5 is 5,000 VEX. */
const RATE = "1000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;

// ── the fake gateway (plan 15.2) ─────────────────────────────────────────

interface StoredWithdrawal {
  readonly body: string;
  readonly withdrawal: Record<string, unknown>;
}

class FakeGateway {
  linked: string[] = [W1.toLowerCase()];
  depositAddress: string | null = DEPOSIT;
  rateAvailable = true;
  rate = RATE;
  paused = false;
  availableWei = 20_000n * E18;
  withdrawableWei: bigint | undefined = 10_000n * E18;
  dailyRemainingWei: bigint | null = 8_000n * E18;
  claimableWei = 12n * E18;
  readonly withdrawals = new Map<string, StoredWithdrawal>();
  readonly byId = new Map<string, Record<string, unknown>>();
  readonly notified: string[] = [];
  readonly seenKeys: string[] = [];
  /** The next withdrawal POST commits, then the answer is lost (a 502). */
  loseNextWithdrawalAnswer = false;
  /** Force the next request to this path to answer with this status and reason. */
  readonly forced = new Map<string, { status: number; reason: string; extra?: Record<string, unknown> }>();
  readonly activity = Array.from({ length: 5 }, (_, i) => ({
    id: `act_${i}`,
    kind: "deposit",
    amount_wei: String(BigInt(i + 1) * E18),
    status: "credited",
    tx_hash: null,
    created_at: NOW.toISOString(),
  }));
  calls = 0;

  readonly fetch = vi.fn<typeof fetch>(async (input, requestInit) => {
    this.calls += 1;
    const init: RequestInit = requestInit ?? {};
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init.headers);
    if (headers.get("authorization") !== `Bearer ${BEARER}`) return this.error(401, "session_invalid");
    const route = `${init.method ?? "GET"} ${url.pathname}`;
    const forced = this.forced.get(route);
    if (forced !== undefined) {
      this.forced.delete(route);
      return this.error(forced.status, forced.reason, forced.extra);
    }
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (route === "GET /v1/account") return this.json(this.account());
    if (route === "POST /v1/deposits/notify") {
      if (typeof body.tx_hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.tx_hash)) return this.error(400, "invalid_tx_hash");
      this.notified.push(body.tx_hash);
      return this.json({ accepted: true }, 202);
    }
    if (route === "POST /v1/withdrawals") return this.createWithdrawal(headers, typeof init.body === "string" ? init.body : "", body);
    if (route.startsWith("GET /v1/withdrawals/")) {
      const found = this.byId.get(url.pathname.slice("/v1/withdrawals/".length));
      return found === undefined ? this.error(404, "withdrawal_not_found") : this.json({ withdrawal: found });
    }
    if (route === "POST /v1/cashback/claim") {
      const key = headers.get("idempotency-key");
      if (key === null || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) return this.error(400, "invalid_idempotency_key");
      this.seenKeys.push(key);
      if (body.to !== "balance") return this.error(400, "unsupported_destination");
      const claimed = this.claimableWei;
      this.claimableWei = 0n;
      return this.json({ claimed_wei: claimed.toString() });
    }
    if (route === "GET /v1/account/activity") return this.page(url, this.activity);
    if (route === "GET /v1/account/usage") {
      return this.page(url, [
        {
          request_id: "req_1",
          model: "deepseek/deepseek-v4",
          effort: "medium",
          status: "settled",
          upstream_cost_micro_usd: "1234",
          charged_wei: "1500000000000000000",
          clamp_reason: null,
          created_at: NOW.toISOString(),
        },
      ]);
    }
    if (route === "GET /v1/deposits") {
      return this.page(url, [
        {
          id: "dep_1",
          tx_hash: TX_HASH,
          log_index: 3,
          from: W1,
          amount_wei: String(6_000n * E18),
          status: "provisional",
          spendable_now_wei: String(6_000n * E18),
          observed_at: NOW.toISOString(),
          finalized_at: null,
        },
      ]);
    }
    return this.error(404, "not_found");
  });

  account(): Record<string, unknown> {
    const amount = (wei: bigint) => ({ wei: wei.toString(), usd_micro_estimate: this.rateAvailable ? (wei / 10n ** 15n).toString() : null });
    return {
      account_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      status: { paused: this.paused, drain_mode: false },
      wallets: this.linked.map((address) => ({ address, linked_at: NOW.toISOString() })),
      deposit_address: this.depositAddress,
      balances: {
        available: amount(this.availableWei),
        provisional: amount(0n),
        reserved: amount(0n),
        pending_withdrawal: amount(0n),
        claimable: amount(this.claimableWei),
        cashback_pending: amount(2n * E18),
      },
      ...(this.withdrawableWei === undefined ? {} : { withdrawable_wei: this.withdrawableWei.toString() }),
      rate: this.rateAvailable
        ? {
            available: true,
            source: "twap",
            vex_wei_per_micro_usd: this.rate,
            observed_at: NOW.toISOString(),
            age_seconds: 30,
            valid_until: new Date(NOW.getTime() + 600_000).toISOString(),
          }
        : { available: false, reason: "warming" },
      limits: {
        min_deposit_micro_usd: "5000000",
        min_withdraw_micro_usd: "5000000",
        provisional_cap_micro_usd: "25000000",
        withdraw_daily_limit_micro_usd: "500000000",
        withdraw_daily_remaining_wei: this.dailyRemainingWei === null ? null : this.dailyRemainingWei.toString(),
      },
    };
  }

  private createWithdrawal(headers: Headers, raw: string, body: Record<string, unknown>): Response {
    const key = headers.get("idempotency-key");
    if (key === null || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) return this.error(400, "invalid_idempotency_key");
    this.seenKeys.push(key);
    const previous = this.withdrawals.get(key);
    if (previous !== undefined) {
      return previous.body === raw ? this.json({ withdrawal: previous.withdrawal }, 202) : this.error(409, "idempotency_key_reused");
    }
    if (!this.rateAvailable) return this.error(503, "rate_unavailable");
    if (this.paused) return this.error(403, "account_paused");
    const destination = String(body.destination).toLowerCase();
    if (!this.linked.includes(destination)) return this.error(403, "destination_not_linked");
    const amount = BigInt(String(body.amount_wei));
    if (amount < 5_000n * E18) return this.error(400, "below_minimum");
    if (this.withdrawableWei !== undefined && amount > this.withdrawableWei) return this.error(409, "insufficient_withdrawable");
    if (this.dailyRemainingWei !== null && amount > this.dailyRemainingWei) {
      return this.error(429, "daily_limit_exceeded", { remaining_wei: this.dailyRemainingWei.toString() });
    }
    const withdrawal = {
      id: `wd_${this.withdrawals.size + 1}`,
      status: "requested",
      amount_wei: amount.toString(),
      destination: String(body.destination),
      tx_hash: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    this.withdrawals.set(key, { body: raw, withdrawal });
    this.byId.set(withdrawal.id, withdrawal);
    if (this.loseNextWithdrawalAnswer) {
      this.loseNextWithdrawalAnswer = false;
      return this.error(502, "upstream_lost");
    }
    return this.json({ withdrawal }, 202);
  }

  private page(url: URL, items: readonly unknown[]): Response {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const cursor = url.searchParams.get("cursor");
    let start = 0;
    if (cursor !== null) {
      const match = /^c_([0-9]+)$/.exec(cursor);
      if (match === null) return this.error(400, "invalid_cursor");
      start = Number(match[1]);
    }
    const slice = items.slice(start, start + limit);
    const next = start + limit < items.length ? `c_${start + limit}` : null;
    return this.json({ items: slice, next_cursor: next });
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private error(status: number, reason: string, extra: Record<string, unknown> = {}): Response {
    return this.json({ error: { code: status, message: "refused", metadata: { reason, ...extra } } }, status);
  }
}

type Receipt = Extract<StagedBroadcastOutcome, { kind: "confirmed" }>["receipt"];
const BLOCK_HASH = `0x${"cd".repeat(32)}` as const;

/** A whole receipt, every field typed: the proof reads only the VEX Transfer logs. */
function receiptOf(status: "success" | "reverted", logs: ReadonlyArray<{ readonly topics: readonly [Hex, Hex, Hex]; readonly data: Hex }>): Receipt {
  return {
    blockHash: BLOCK_HASH,
    blockNumber: 1n,
    contractAddress: null,
    cumulativeGasUsed: 60_000n,
    effectiveGasPrice: 20_000_000n,
    from: W1,
    gasUsed: 60_000n,
    logs: logs.map((log, index) => ({
      address: VEX,
      blockHash: BLOCK_HASH,
      blockNumber: 1n,
      data: log.data,
      logIndex: index,
      removed: false,
      topics: [...log.topics],
      transactionHash: TX_HASH,
      transactionIndex: 0,
    })),
    logsBloom: `0x${"00".repeat(256)}`,
    status,
    to: VEX,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    type: "eip1559",
  };
}

// ── the fake chain: the gate, then the key, in signStageBroadcast's order ──

class FakeChain implements Erc20TransferPort {
  vex = new Map<string, bigint>([[W1.toLowerCase(), 50_000n * E18], [W2.toLowerCase(), 50_000n * E18]]);
  native = 10n ** 17n;
  outcome: "confirmed" | "reverted" | "ambiguous" = "confirmed";
  /** Called between prepare and the gate, to move the world after the user approved. */
  beforeGate: (() => void) | null = null;
  readonly gateRequests: FinalSignedRequest[] = [];
  readonly broadcasts: TransferBroadcastRequest[] = [];
  keyLoads = 0;
  signedHashes: Hex[] = [];
  /** Hold the broadcast until released (single-flight and cancellation tests). */
  hold: Promise<void> | null = null;

  async readVexBalance(owner: string): Promise<bigint> {
    return this.vex.get(owner.toLowerCase()) ?? 0n;
  }
  async readNativeBalance(): Promise<bigint> {
    return this.native;
  }
  async quoteTransferFees(): Promise<{ gasEstimate: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    return { gasEstimate: 60_000n, maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 0n };
  }
  async broadcastTransfer(request: TransferBroadcastRequest): Promise<StagedBroadcastOutcome> {
    this.broadcasts.push(request);
    if (this.hold !== null) await this.hold;
    this.beforeGate?.();
    const finalRequest: FinalSignedRequest = {
      to: VEX,
      data: request.data,
      value: 0n,
      gas: 120_000n,
      nonce: 7,
      gasPrice: undefined,
      maxFeePerGas: 20_000_000n,
      maxPriorityFeePerGas: 0n,
    };
    this.gateRequests.push(finalRequest);
    await request.onBeforeSign(finalRequest);
    this.keyLoads += 1;
    await request.loadPrivateKey();
    // The pending-nonce re-read, then the final check, then the signature.
    await request.onFinalCheck(finalRequest);
    request.onHashStaged(TX_HASH);
    this.signedHashes.push(TX_HASH);
    if (this.outcome === "ambiguous") return { kind: "ambiguous", txHash: TX_HASH, stage: "confirm", reason: "receipt wait timed out" };
    const amount = BigInt(`0x${request.data.slice(74)}`);
    const receipt = receiptOf(
      this.outcome === "confirmed" ? "success" : "reverted",
      this.outcome === "confirmed" ? [{ topics: [TRANSFER_TOPIC, pad(request.from), pad(DEPOSIT)], data: pad(`0x${amount.toString(16)}`) }] : [],
    );
    return this.outcome === "confirmed"
      ? { kind: "confirmed", txHash: TX_HASH, receipt }
      : { kind: "reverted", txHash: TX_HASH, receipt };
  }
}

// ── the world ────────────────────────────────────────────────────────────

interface World {
  readonly gateway: FakeGateway;
  readonly chain: FakeChain;
  session: string | null;
  vaultUnlocked: boolean;
  executionReady: boolean;
  pinned: string | null;
  keyMismatch: boolean;
  keysMinted: number;
  readonly deps: VexCloudDeps;
}

function entry(address: string, index: number) {
  return { id: `evm_00000000-0000-4000-8000-00000000000${index}`, address, label: `Wallet ${index}`, createdAt: NOW.toISOString() };
}

function world(): World {
  const gateway = new FakeGateway();
  const chain = new FakeChain();
  const self: World = {
    gateway,
    chain,
    session: BEARER,
    vaultUnlocked: true,
    executionReady: true,
    pinned: DEPOSIT,
    keyMismatch: false,
    keysMinted: 0,
    deps: {
      api: createVexCloudApi({ origin: () => "http://127.0.0.1:8787", fetch: gateway.fetch, timeoutMs: 2_000 }),
      signIn: {
        listEvmWallets: () => [entry(W1, 1), entry(W2, 2)],
        isVaultUnlocked: () => self.vaultUnlocked,
        signMessage: async () => {
          throw new Error("no signing in this suite");
        },
        binding: () => ({ domain: "localhost", uri: "http://localhost:8787" }),
        storeSession: async () => ({ ok: true, data: undefined }),
        now: () => NOW,
      },
      account: {
        readSession: async () => ({ ok: true, data: self.session }),
        clearSession: async () => {
          self.session = null;
          return { ok: true, data: undefined };
        },
        localWallets: () => [W1, W2],
        pinnedDepositAddress: () => self.pinned,
        now: () => NOW,
      },
      clearSession: async () => {
        self.session = null;
        return { ok: true, data: undefined };
      },
      deposit: {
        chain: () => chain,
        listEvmWallets: () => [entry(W1, 1), entry(W2, 2)],
        isVaultUnlocked: () => self.vaultUnlocked,
        isExecutionReady: () => self.executionReady,
        pinnedDepositAddress: () => self.pinned,
        loadPrivateKey: async () => {
          if (self.keyMismatch) throw Object.assign(new Error("EVM keystore does not match the recorded wallet address."), { code: "SIGNER_MISMATCH" });
          return `0x${"11".repeat(32)}` as Hex;
        },
        now: () => NOW,
      },
    },
  };
  return self;
}

let current: World;
let teardown: ReadonlyArray<() => void> = [];

function mount(w: World = world()): World {
  current = w;
  teardown = registerVexCloudHandlers(w.deps);
  return w;
}

async function call(channel: string, payload: unknown, requestId = REQUEST_ID): Promise<unknown> {
  const fn = handlers.get(channel);
  if (fn === undefined) throw new Error(`handler not registered: ${channel}`);
  return fn({ sender: {} }, { requestId, payload });
}

interface Ok {
  ok: true;
  data: Record<string, unknown>;
}
interface Err {
  ok: false;
  error: { code: string; message: string; retryable: boolean };
}

function expectOk(value: unknown): Ok {
  const result = value as Ok | Err;
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result;
}

function expectError(value: unknown, code: string, message?: RegExp): Err {
  const result = value as Ok | Err;
  if (result.ok) throw new Error(`expected ${code}, got ok`);
  expect(result.error.code).toBe(code);
  if (message !== undefined) expect(result.error.message).toMatch(message);
  return result;
}

async function prepare(amountText = "6000", walletAddress: string = W1): Promise<Ok> {
  return expectOk(await call(CH.vexCloud.prepareDeposit, { walletAddress, amountText }));
}

function submitOf(proposal: Ok, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposalId: proposal.data.proposalId,
    walletAddress: proposal.data.from,
    amountWei: proposal.data.amountWei,
    ...overrides,
  };
}

beforeEach(() => {
  assertTrustedSender.mockImplementation(() => undefined);
  openExecutionGate();
  __resetDepositStateForTests();
  __resetWithdrawStateForTests();
  __resetCashbackStateForTests();
});

afterEach(() => {
  for (const off of teardown) off();
  handlers.clear();
  vi.clearAllMocks();
});

// ── depositWallets ───────────────────────────────────────────────────────

describe("depositWallets", () => {
  it("lists every in-app EVM wallet with its live VEX balance; a failed read is null, never zero", async () => {
    const w = mount();
    w.chain.readVexBalance = async (owner: string) => {
      if (owner.toLowerCase() === W2.toLowerCase()) throw new Error("rpc down");
      return 42n * E18;
    };
    const result = expectOk(await call(CH.vexCloud.depositWallets, {}));
    expect(result.data.chainId).toBe(4663);
    expect(result.data.wallets).toEqual([
      { address: W1, label: "Wallet 1", vexWei: String(42n * E18) },
      { address: W2, label: "Wallet 2", vexWei: null },
    ]);
  });

  it("refuses an unexpected field", async () => {
    mount();
    expectError(await call(CH.vexCloud.depositWallets, { wallet: W1 }), "validation.invalid_input");
  });
});

// ── prepareDeposit ───────────────────────────────────────────────────────

describe("prepareDeposit", () => {
  it("binds every approval field and signs nothing", async () => {
    const w = mount();
    const proposal = await prepare("6000.5");
    expect(proposal.data).toMatchObject({
      actor: "user",
      chainId: 4663,
      token: { address: VEX, symbol: "VEX", decimals: 18 },
      amountWei: String(6_000n * E18 + E18 / 2n),
      from: W1,
      to: DEPOSIT,
      usdMicroEstimate: "6000500",
      minimumWei: String(5_000n * E18),
      minimumMicroUsd: "5000000",
      provisionalCapMicroUsd: "25000000",
      expiresAt: new Date(NOW.getTime() + 120_000).toISOString(),
    });
    expect(proposal.data.feeBound).toEqual({
      gasLimit: "180000",
      maxFeePerGasWei: "40000000",
      maxPriorityFeePerGasWei: "0",
      maxNetworkFeeWei: String(180_000n * 40_000_000n),
      nativeSymbol: "ETH",
      nativeDecimals: 18,
    });
    expect(w.chain.broadcasts).toHaveLength(0);
    expect(w.chain.keyLoads).toBe(0);
  });

  it.each([
    ["a malformed wallet", { walletAddress: "0x123", amountText: "6000" }],
    ["a missing amount", { walletAddress: W1 }],
    ["a caller-supplied destination", { walletAddress: W1, amountText: "6000", to: OTHER_DEPOSIT }],
    ["a caller-supplied fee", { walletAddress: W1, amountText: "6000", maxFeePerGasWei: "1" }],
  ])("refuses %s at the schema", async (_name, payload) => {
    const w = mount();
    expectError(await call(CH.vexCloud.prepareDeposit, payload), "validation.invalid_input");
    expect(w.gateway.calls).toBe(0);
  });

  it.each([
    ["an empty amount", " ", /Enter an amount/],
    ["a comma separator", "6,000", /without separators/],
    ["19 decimals", "1.0000000000000000001", /18 digits/],
    ["zero", "0.0", /above zero/],
  ])("refuses %s in words", async (_name, amountText, message) => {
    mount();
    expectError(await call(CH.vexCloud.prepareDeposit, { walletAddress: W1, amountText }), "validation.invalid_input", message);
  });

  it("says Deposits open soon when the build pins no address, without calling Vex Cloud", async () => {
    const w = world();
    w.pinned = null;
    mount(w);
    expectError(await call(CH.vexCloud.prepareDeposit, { walletAddress: W1, amountText: "6000" }), "wallet.policy_blocked", /Deposits open soon/);
    expect(w.gateway.calls).toBe(0);
  });

  it("a backend with no deposit address is Deposits not open, the same state as an empty pin", async () => {
    const w = mount();
    w.gateway.depositAddress = null;
    expectError(await call(CH.vexCloud.prepareDeposit, { walletAddress: W1, amountText: "6000" }), "wallet.policy_blocked", /not open yet/);
    const view = expectOk(await call(CH.vexCloud.account, {}));
    expect(view.data.depositPin).toEqual({ state: "not_open" });
    expect((view.data.account as { balances: { cashbackPending: unknown } }).balances.cashbackPending).toEqual({
      wei: String(2n * E18),
      decimals: 18,
      symbol: "VEX",
      usdMicroEstimate: "2000",
    });
  });

  it("disables funding when the pinned address differs from the backend's", async () => {
    const w = mount();
    w.gateway.depositAddress = OTHER_DEPOSIT;
    expectError(await call(CH.vexCloud.prepareDeposit, { walletAddress: W1, amountText: "6000" }), "wallet.policy_blocked", /does not match/);
  });

  it("refuses an amount under the minimum at the backend's rate", async () => {
    mount();
    expectError(await call(CH.vexCloud.prepareDeposit, { walletAddress: W1, amountText: "4999.99" }), "validation.invalid_input", /\$5\.00, which is 5,000 VEX/);
  });

  it("refuses more VEX than the wallet holds, naming both figures", async () => {
    const w = mount();
    w.chain.vex.set(W1.toLowerCase(), 5_500n * E18);
    expectError(await call(CH.vexCloud.prepareDeposit, { walletAddress: W1, amountText: "6000" }), "wallet.insufficient_funds", /5,500 VEX, less than the 6,000 VEX/);
  });

  it("refuses when the wallet cannot pay the network fee", async () => {
    const w = mount();
    w.chain.native = 1n;
    expectError(await call(CH.vexCloud.prepareDeposit, { walletAddress: W1, amountText: "6000" }), "wallet.insufficient_funds", /ETH/);
  });

  it("refuses without a valid rate", async () => {
    const w = mount();
    w.gateway.rateAvailable = false;
    expectError(await call(CH.vexCloud.prepareDeposit, { walletAddress: W1, amountText: "6000" }), "provider.unavailable", /no current VEX price/);
  });

  it("refuses a wallet that is not in the app", async () => {
    mount();
    expectError(await call(CH.vexCloud.prepareDeposit, { walletAddress: NOT_LOCAL, amountText: "6000" }), "wallets.invalid_selection");
  });

  it("signed out: says how to sign in", async () => {
    const w = world();
    w.session = null;
    mount(w);
    expectError(await call(CH.vexCloud.prepareDeposit, { walletAddress: W1, amountText: "6000" }), "permissions.denied", /Sign in/);
  });

  it("a 401 clears the stored session and asks to sign in again", async () => {
    const w = world();
    w.session = "vxs_other_bearer_00000000001";
    mount(w);
    expectError(await call(CH.vexCloud.prepareDeposit, { walletAddress: W1, amountText: "6000" }), "permissions.denied", /expired/);
    expect(w.session).toBeNull();
  });
});

// ── submitDeposit: the approval binding ──────────────────────────────────

describe("submitDeposit", () => {
  it("sends exactly the approved transfer, proves the Transfer log and sends the notify hint", async () => {
    const w = mount();
    const proposal = await prepare();
    const result = expectOk(await call(CH.vexCloud.submitDeposit, submitOf(proposal)));
    expect(result.data).toEqual({ status: "confirmed", txHash: TX_HASH, transferProven: true, notified: true });
    expect(w.gateway.notified).toEqual([TX_HASH]);
    const expected = encodeFunctionData({
      abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }],
      functionName: "transfer",
      args: [DEPOSIT, 6_000n * E18],
    });
    expect(w.chain.broadcasts[0]?.data).toBe(expected);
    expect(w.chain.broadcasts[0]?.feeBound).toEqual({ gasLimit: 180_000n, maxFeePerGas: 40_000_000n, maxPriorityFeePerGas: 0n, maxNetworkFeeWei: 180_000n * 40_000_000n });
  });

  it("an unknown outcome stays pending, is sent once, and Vex Cloud is told the hash", async () => {
    const w = mount();
    w.chain.outcome = "ambiguous";
    const result = expectOk(await call(CH.vexCloud.submitDeposit, submitOf(await prepare())));
    expect(result.data).toEqual({ status: "pending", txHash: TX_HASH, transferProven: false, notified: true });
    expect(w.chain.signedHashes).toHaveLength(1);
    expect(w.gateway.notified).toEqual([TX_HASH]);
  });

  it("a reverted transfer is reported as such, without a notify", async () => {
    const w = mount();
    w.chain.outcome = "reverted";
    const result = expectOk(await call(CH.vexCloud.submitDeposit, submitOf(await prepare())));
    expect(result.data.status).toBe("reverted");
    expect(w.gateway.notified).toEqual([]);
  });

  it.each([
    [429, "rate_limited"],
    [503, "deposits_unavailable"],
  ])("a notify refused with %s %s does not turn a sent deposit into a failure", async (status, reason) => {
    const w = mount();
    w.gateway.forced.set("POST /v1/deposits/notify", { status, reason });
    const result = expectOk(await call(CH.vexCloud.submitDeposit, submitOf(await prepare())));
    expect(result.data).toMatchObject({ status: "confirmed", notified: false });
  });

  it("a notify the backend refuses does not turn a sent deposit into a failure", async () => {
    const w = mount();
    w.gateway.forced.set("POST /v1/deposits/notify", { status: 429, reason: "rate_limited" });
    const result = expectOk(await call(CH.vexCloud.submitDeposit, submitOf(await prepare())));
    expect(result.data).toMatchObject({ status: "confirmed", notified: false });
  });

  it("a changed amount after prepare refuses submit and touches no key", async () => {
    const w = mount();
    const proposal = await prepare();
    expectError(await call(CH.vexCloud.submitDeposit, submitOf(proposal, { amountWei: String(7_000n * E18) })), "validation.invalid_input", /differs/);
    expect(w.chain.broadcasts).toHaveLength(0);
    expect(w.chain.keyLoads).toBe(0);
  });

  it("a changed wallet after prepare refuses submit", async () => {
    const w = mount();
    const proposal = await prepare();
    expectError(await call(CH.vexCloud.submitDeposit, submitOf(proposal, { walletAddress: W2 })), "validation.invalid_input", /differs/);
    expect(w.chain.broadcasts).toHaveLength(0);
  });

  it("a pinned address changed after prepare refuses before the key", async () => {
    const w = mount();
    const proposal = await prepare();
    w.pinned = OTHER_DEPOSIT;
    expectError(await call(CH.vexCloud.submitDeposit, submitOf(proposal)), "wallet.policy_blocked", /changed after you reviewed/);
    expect(w.chain.keyLoads).toBe(0);
    expect(w.chain.signedHashes).toHaveLength(0);
  });

  it("a backend deposit address changed after prepare refuses before the key", async () => {
    const w = mount();
    const proposal = await prepare();
    w.gateway.depositAddress = OTHER_DEPOSIT;
    expectError(await call(CH.vexCloud.submitDeposit, submitOf(proposal)), "wallet.policy_blocked", /does not match/);
    expect(w.chain.keyLoads).toBe(0);
  });

  it("an amount no longer at the minimum at the backend's CURRENT rate refuses before the key", async () => {
    const w = mount();
    const proposal = await prepare("6000");
    w.gateway.rate = "2000000000000000"; // VEX halved: $5 is now 10,000 VEX
    expectError(await call(CH.vexCloud.submitDeposit, submitOf(proposal)), "validation.invalid_input", /under the \$5\.00 minimum \(10,000 VEX\)/);
    expect(w.chain.keyLoads).toBe(0);
  });

  it("a balance spent elsewhere after prepare refuses before the key", async () => {
    const w = mount();
    const proposal = await prepare("6000");
    w.chain.beforeGate = () => w.chain.vex.set(W1.toLowerCase(), 100n * E18);
    expectError(await call(CH.vexCloud.submitDeposit, submitOf(proposal)), "wallet.insufficient_funds", /now holds 100 VEX/);
    expect(w.chain.keyLoads).toBe(0);
  });

  it("an expired proposal refuses", async () => {
    const w = world();
    let now = NOW;
    const deposit = { ...w.deps.deposit, now: () => now };
    mount({ ...w, deps: { ...w.deps, deposit } });
    const proposal = await prepare();
    now = new Date(NOW.getTime() + 120_001);
    expectError(await call(CH.vexCloud.submitDeposit, submitOf(proposal)), "approvals.expired");
  });

  it("a locked vault refuses before any key is touched", async () => {
    const w = mount();
    const proposal = await prepare();
    w.vaultUnlocked = false;
    expectError(await call(CH.vexCloud.submitDeposit, submitOf(proposal)), "wallet.keystore_locked", /locked/);
    expect(w.chain.keyLoads).toBe(0);
    expect(w.chain.signedHashes).toHaveLength(0);
  });

  it("an execution gate that closed after prepare refuses inside the pre-sign gate", async () => {
    const w = mount();
    const proposal = await prepare();
    w.executionReady = false;
    expectError(await call(CH.vexCloud.submitDeposit, submitOf(proposal)), "services.runtime_starting");
    expect(w.chain.keyLoads).toBe(0);
  });

  it("a key that does not derive its address is a typed signer mismatch, nothing sent", async () => {
    const w = mount();
    w.keyMismatch = true;
    expectError(await call(CH.vexCloud.submitDeposit, submitOf(await prepare())), "wallet.signer_mismatch");
    expect(w.chain.signedHashes).toHaveLength(0);
  });

  it("a proposal is single use: a second press finds nothing", async () => {
    const w = mount();
    const proposal = await prepare();
    expectOk(await call(CH.vexCloud.submitDeposit, submitOf(proposal)));
    expectError(await call(CH.vexCloud.submitDeposit, submitOf(proposal), "22222222-2222-4333-8444-555555555555"), "approvals.already_resolved");
    expect(w.chain.signedHashes).toHaveLength(1);
  });

  it("one deposit per wallet at a time", async () => {
    const w = mount();
    const first = await prepare();
    const second = await prepare("7000");
    let release: () => void = () => undefined;
    w.chain.hold = new Promise((resolve) => {
      release = resolve;
    });
    const running = call(CH.vexCloud.submitDeposit, submitOf(first));
    await vi.waitFor(() => expect(w.chain.broadcasts).toHaveLength(1));
    expectError(await call(CH.vexCloud.submitDeposit, submitOf(second), "33333333-2222-4333-8444-555555555555"), "validation.invalid_input", /already being sent/);
    release();
    expectOk(await running);
    expect(w.chain.signedHashes).toHaveLength(1);
  });

  it("cancellation before the signature signs nothing", async () => {
    const w = mount();
    const proposal = await prepare();
    let release: () => void = () => undefined;
    w.chain.hold = new Promise((resolve) => {
      release = resolve;
    });
    const pending = call(CH.vexCloud.submitDeposit, submitOf(proposal));
    await vi.waitFor(() => expect(w.chain.broadcasts).toHaveLength(1));
    getCancelController(REQUEST_ID)?.abort();
    release();
    expectError(await pending, "internal.cancelled");
    expect(w.chain.keyLoads).toBe(0);
  });
});

// ── withdrawals ──────────────────────────────────────────────────────────

describe("prepareWithdrawal", () => {
  it("binds amount, destination, the withdrawable and the daily limit left", async () => {
    mount();
    const result = expectOk(await call(CH.vexCloud.prepareWithdrawal, { destination: W1, amountText: "6000" }));
    expect(result.data).toMatchObject({
      actor: "user",
      chainId: 4663,
      amountWei: String(6_000n * E18),
      destination: W1,
      usdMicroEstimate: "6000000",
      withdrawableWei: String(10_000n * E18),
      dailyRemainingWei: String(8_000n * E18),
      dailyLimitMicroUsd: "500000000",
    });
  });

  it("refuses a wallet that is in the app but not linked", async () => {
    mount();
    expectError(await call(CH.vexCloud.prepareWithdrawal, { destination: W2, amountText: "6000" }), "permissions.denied", /linked/);
  });

  it("refuses a linked wallet that is not in the app", async () => {
    const w = mount();
    w.gateway.linked.push(NOT_LOCAL.toLowerCase());
    expectError(await call(CH.vexCloud.prepareWithdrawal, { destination: NOT_LOCAL, amountText: "6000" }), "permissions.denied", /in this app/);
  });

  it.each([
    ["under the minimum", "100", "validation.invalid_input", /minimum withdrawal/],
    ["above the withdrawable", "11000", "wallet.insufficient_funds", /10,000 VEX now/],
  ])("refuses an amount %s", async (_name, amountText, code, message) => {
    mount();
    expectError(await call(CH.vexCloud.prepareWithdrawal, { destination: W1, amountText }), code, message);
  });

  it("refuses above the daily limit left", async () => {
    mount();
    expectError(await call(CH.vexCloud.prepareWithdrawal, { destination: W1, amountText: "9000" }), "wallet.policy_blocked", /8,000 VEX more today/);
  });

  it("refuses a paused account", async () => {
    const w = mount();
    w.gateway.paused = true;
    expectError(await call(CH.vexCloud.prepareWithdrawal, { destination: W1, amountText: "6000" }), "permissions.denied", /paused/);
  });

  it("refuses a free-form extra field", async () => {
    mount();
    expectError(await call(CH.vexCloud.prepareWithdrawal, { destination: W1, amountText: "6000", toAddress: NOT_LOCAL }), "validation.invalid_input");
  });
});

describe("submitWithdrawal and idempotency", () => {
  async function prepared(amountText = "6000"): Promise<Ok> {
    return expectOk(await call(CH.vexCloud.prepareWithdrawal, { destination: W1, amountText }));
  }
  const submit = (p: Ok, overrides: Record<string, unknown> = {}) => ({
    proposalId: p.data.proposalId,
    destination: p.data.destination,
    amountWei: p.data.amountWei,
    ...overrides,
  });

  it("creates the withdrawal with an Idempotency-Key and maps its status", async () => {
    const w = mount();
    const result = expectOk(await call(CH.vexCloud.submitWithdrawal, submit(await prepared())));
    expect(result.data.outcome).toBe("accepted");
    expect(result.data.withdrawal).toMatchObject({ id: "wd_1", status: "requested", amountWei: String(6_000n * E18), destination: W1 });
    expect(w.gateway.seenKeys).toHaveLength(1);
    expect(w.gateway.seenKeys[0]).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it("a lost answer is an UNKNOWN outcome; Check status replays the SAME key and gets the same withdrawal", async () => {
    const w = mount();
    const p = await prepared();
    w.gateway.loseNextWithdrawalAnswer = true;
    const unknown = expectOk(await call(CH.vexCloud.submitWithdrawal, submit(p)));
    expect(unknown.data).toEqual({ outcome: "unknown", proposalId: p.data.proposalId, amountWei: p.data.amountWei, destination: W1 });
    const retried = expectOk(await call(CH.vexCloud.submitWithdrawal, submit(p), "44444444-2222-4333-8444-555555555555"));
    expect(w.gateway.seenKeys).toHaveLength(2);
    expect(w.gateway.seenKeys[1]).toBe(w.gateway.seenKeys[0]);
    expect(w.gateway.withdrawals.size).toBe(1);
    expect(retried.data.withdrawal).toMatchObject({ id: "wd_1" });
  });

  it("a new proposal gets a new key", async () => {
    const w = mount();
    expectOk(await call(CH.vexCloud.submitWithdrawal, submit(await prepared("6000"))));
    expectOk(await call(CH.vexCloud.submitWithdrawal, submit(await prepared("6000")), "55555555-2222-4333-8444-555555555555"));
    expect(w.gateway.seenKeys).toHaveLength(2);
    expect(w.gateway.seenKeys[1]).not.toBe(w.gateway.seenKeys[0]);
    expect(w.gateway.withdrawals.size).toBe(2);
  });

  it("a changed amount or destination refuses and sends nothing", async () => {
    const w = mount();
    const p = await prepared();
    expectError(await call(CH.vexCloud.submitWithdrawal, submit(p, { amountWei: String(7_000n * E18) })), "validation.invalid_input", /differs/);
    expect(w.gateway.seenKeys).toHaveLength(0);
  });

  it.each([
    ["below_minimum", 400, "validation.invalid_input", /\$5 minimum/],
    ["destination_not_linked", 403, "permissions.denied", /not linked/],
    ["account_paused", 403, "permissions.denied", /paused/],
    ["insufficient_withdrawable", 409, "wallet.insufficient_funds", /finalized deposits/],
    ["idempotency_key_reused", 409, "internal.unexpected", /different figures/],
    ["rate_unavailable", 503, "provider.unavailable", /no current VEX price/],
  ])("maps the backend refusal %s by name", async (reason, status, code, message) => {
    const w = mount();
    const p = await prepared();
    w.gateway.forced.set("POST /v1/withdrawals", { status, reason });
    expectError(await call(CH.vexCloud.submitWithdrawal, submit(p)), code, message);
  });

  it.each([
    ["forbidden_field", 400, "destination_address", "internal.unexpected", /field "destination_address".*forbidden_field/],
    ["invalid_field", 400, "amount_wei", "internal.unexpected", /field "amount_wei".*invalid_field/],
    ["invalid_idempotency_key", 400, undefined, "internal.unexpected", /invalid_idempotency_key/],
    ["withdrawals_unavailable", 503, undefined, "wallet.policy_blocked", /Withdrawals are not open yet/],
  ])("maps %s by name", async (reason, status, field, code, message) => {
    const w = mount();
    const p = await prepared();
    w.gateway.forced.set("POST /v1/withdrawals", { status, reason, ...(field === undefined ? {} : { extra: { field } }) });
    expectError(await call(CH.vexCloud.submitWithdrawal, submit(p)), code, message);
  });

  it("maps daily_limit_exceeded with the remaining amount", async () => {
    const w = mount();
    const p = await prepared();
    w.gateway.forced.set("POST /v1/withdrawals", { status: 429, reason: "daily_limit_exceeded", extra: { remaining_wei: String(1_234n * E18) } });
    expectError(await call(CH.vexCloud.submitWithdrawal, submit(p)), "wallet.policy_blocked", /1,234 VEX more today/);
  });

  it("an unknown backend reason is named, never an unexpected error", async () => {
    const w = mount();
    w.gateway.forced.set("GET /v1/account", { status: 400, reason: "brand_new_reason" });
    expectError(await call(CH.vexCloud.prepareWithdrawal, { destination: W1, amountText: "6000" }), "internal.unexpected", /brand_new_reason/);
  });

  it("an unknown reason on the withdrawal POST does not prove a refusal: the outcome is unknown and the key is kept", async () => {
    const w = mount();
    const p = await prepared();
    w.gateway.forced.set("POST /v1/withdrawals", { status: 400, reason: "brand_new_reason" });
    expect(expectOk(await call(CH.vexCloud.submitWithdrawal, submit(p))).data.outcome).toBe("unknown");
    const replayed = expectOk(await call(CH.vexCloud.submitWithdrawal, submit(p), "77777777-2222-4333-8444-555555555555"));
    expect(replayed.data.outcome).toBe("accepted");
    const sentKeys = w.gateway.fetch.mock.calls
      .filter(([, init]) => init?.method === "POST" && new Headers(init.headers).has("idempotency-key"))
      .map(([, init]) => new Headers(init?.headers).get("idempotency-key"));
    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[1]).toBe(sentKeys[0]);
  });

  it("reads a withdrawal's status, and a missing one by name", async () => {
    mount();
    expectOk(await call(CH.vexCloud.submitWithdrawal, submit(await prepared())));
    const status = expectOk(await call(CH.vexCloud.withdrawal, { withdrawalId: "wd_1" }));
    expect(status.data.withdrawal).toMatchObject({ id: "wd_1", status: "requested" });
    expectError(await call(CH.vexCloud.withdrawal, { withdrawalId: "wd_404" }), "validation.invalid_input", /no such withdrawal/);
    expectError(await call(CH.vexCloud.withdrawal, { withdrawalId: "../../account" }), "validation.invalid_input");
  });
});

// ── cashback ─────────────────────────────────────────────────────────────

describe("claimCashback", () => {
  it("claims to the balance with an idempotency key; a second claim moves nothing", async () => {
    const w = mount();
    expect(expectOk(await call(CH.vexCloud.claimCashback, {})).data).toEqual({ outcome: "claimed", claimedWei: String(12n * E18) });
    expect(expectOk(await call(CH.vexCloud.claimCashback, {}, "66666666-2222-4333-8444-555555555555")).data).toEqual({ outcome: "claimed", claimedWei: "0" });
    expect(w.gateway.seenKeys).toHaveLength(2);
  });

  it("maps unsupported_destination by name", async () => {
    const w = mount();
    w.gateway.forced.set("POST /v1/cashback/claim", { status: 400, reason: "unsupported_destination" });
    expectError(await call(CH.vexCloud.claimCashback, {}), "internal.unexpected", /cashback destination/);
  });

  it("offers no wallet destination", async () => {
    mount();
    expectError(await call(CH.vexCloud.claimCashback, { to: "wallet" }), "validation.invalid_input");
  });
});

// ── history ──────────────────────────────────────────────────────────────

describe("history", () => {
  it("pages activity with the backend's cursor and reports when there is more", async () => {
    mount();
    const first = expectOk(await call(CH.vexCloud.activity, { cursor: null, limit: 2 }));
    expect((first.data.items as unknown[]).length).toBe(2);
    expect(first.data.nextCursor).toBe("c_2");
    const last = expectOk(await call(CH.vexCloud.activity, { cursor: "c_4", limit: 2 }));
    expect((last.data.items as unknown[]).length).toBe(1);
    expect(last.data.nextCursor).toBeNull();
  });

  it("maps usage and deposits whole", async () => {
    mount();
    const usage = expectOk(await call(CH.vexCloud.usage, { cursor: null }));
    expect(usage.data.items).toEqual([
      {
        requestId: "req_1",
        model: "deepseek/deepseek-v4",
        effort: "medium",
        status: "settled",
        upstreamCostMicroUsd: "1234",
        chargedWei: "1500000000000000000",
        clampReason: null,
        createdAt: NOW.toISOString(),
      },
    ]);
    const deposits = expectOk(await call(CH.vexCloud.deposits, { cursor: null }));
    expect(deposits.data.items).toMatchObject([{ id: "dep_1", status: "provisional", logIndex: 3 }]);
  });

  it("maps invalid_limit by name", async () => {
    const w = mount();
    w.gateway.forced.set("GET /v1/account/usage", { status: 400, reason: "invalid_limit" });
    expectError(await call(CH.vexCloud.usage, { cursor: null }), "validation.invalid_input", /page size/);
  });

  it("maps invalid_cursor by name", async () => {
    mount();
    expectError(await call(CH.vexCloud.activity, { cursor: "bogus" }), "validation.invalid_input", /no longer available/);
  });

  it("refuses an out-of-range page size", async () => {
    mount();
    expectError(await call(CH.vexCloud.usage, { cursor: null, limit: 0 }), "validation.invalid_input");
    expectError(await call(CH.vexCloud.deposits, { cursor: null, limit: 101 }), "validation.invalid_input");
  });
});

// ── the sender seam, for every funding channel ───────────────────────────

describe("sender validation", () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    [CH.vexCloud.depositWallets, {}],
    [CH.vexCloud.prepareDeposit, { walletAddress: W1, amountText: "6000" }],
    [CH.vexCloud.submitDeposit, { proposalId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", walletAddress: W1, amountWei: "1" }],
    [CH.vexCloud.prepareWithdrawal, { destination: W1, amountText: "6000" }],
    [CH.vexCloud.submitWithdrawal, { proposalId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", destination: W1, amountWei: "1" }],
    [CH.vexCloud.withdrawal, { withdrawalId: "wd_1" }],
    [CH.vexCloud.claimCashback, {}],
    [CH.vexCloud.activity, { cursor: null }],
    [CH.vexCloud.usage, { cursor: null }],
    [CH.vexCloud.deposits, { cursor: null }],
  ];

  it.each(cases)("%s refuses a wrong sender or subframe before any call", async (channel, payload) => {
    const w = mount();
    assertTrustedSender.mockImplementation(() => {
      throw new Error("Untrusted IPC sender: subframe of https://evil.example/frame");
    });
    const error = expectError(await call(channel, payload), "validation.invalid_sender");
    expect(error.error.message).not.toContain("evil.example");
    expect(w.gateway.calls).toBe(0);
    expect(w.chain.broadcasts).toHaveLength(0);
  });
});

// ── cancellation of the reads ────────────────────────────────────────────

describe("cancellation", () => {
  it("a cancelled prepare is cancelled, never a refusal of the user's input", async () => {
    const w = mount();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = w.gateway.fetch.getMockImplementation();
    if (original === undefined) throw new Error("the fake gateway has no implementation");
    w.gateway.fetch.mockImplementationOnce(async (input, init) => {
      await gate;
      if (init?.signal?.aborted === true) throw new DOMException("aborted", "AbortError");
      return original(input, init);
    });
    const pending = call(CH.vexCloud.prepareDeposit, { walletAddress: W1, amountText: "6000" });
    await vi.waitFor(() => expect(w.gateway.fetch).toHaveBeenCalled());
    getCancelController(REQUEST_ID)?.abort();
    release();
    expectError(await pending, "internal.cancelled");
  });
});

// ── the execution gate (LAST: closing it is one-way for this process) ────

describe("execution gate", () => {
  it("refuses the money-moving channels while the runtime is not ready, and calls nothing", async () => {
    const w = mount();
    closeExecutionGateForShutdown();
    expectError(await call(CH.vexCloud.submitDeposit, { proposalId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", walletAddress: W1, amountWei: "1" }), "services.runtime_starting");
    expectError(await call(CH.vexCloud.submitWithdrawal, { proposalId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", destination: W1, amountWei: "1" }), "services.runtime_starting");
    expectError(await call(CH.vexCloud.claimCashback, {}), "services.runtime_starting");
    expect(w.gateway.calls).toBe(0);
    // Reads stay available: a user can always see their own money.
    expectOk(await call(CH.vexCloud.activity, { cursor: null }));
  });
});
