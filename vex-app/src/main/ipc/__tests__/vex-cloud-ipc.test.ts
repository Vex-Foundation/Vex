/**
 * Vex Cloud IPC - the seam, end to end, on a faked gateway.
 *
 * WHAT IS REAL HERE: `registerHandler` (sender check seam, envelope, schema
 * validation, the execution gate, cancellation, output validation), the whole
 * sign-in owner (`main/vex-cloud/sign-in.ts`), the account mapping, the
 * refusal mapping, and the strict EIP-4361 template builder and shape check.
 * Faked: the gateway (an in-memory `VexCloudApi` that enforces the backend's
 * own sign-in rules from `VexVirtualsCompute/src/auth/service.ts`), the
 * wallet inventory, the vault-backed session store, and the key: a
 * throwaway viem account per wallet, signing only after the real shape check.
 *
 * WHAT IT PINS:
 *  - all three intents of the flow (create, sign in, link with a co-signer),
 *    with every message byte-checked by the real shape check and recovered;
 *  - nothing is signed when the input is invalid, the sender untrusted, the
 *    gate closed, the vault locked, the wallet set changed, or the server's
 *    challenge names another host;
 *  - cancellation before the session is stored stores nothing;
 *  - a 401 on `account` leaves a CLEAN signed-out state (the session removed);
 *  - money crosses whole: wei strings with decimals, micro-USD or null.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, verifyMessage, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import { closeExecutionGateForShutdown } from "../../lifecycle/execution-gate.js";

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

// Production wiring reaches the vault and the wallet inventory; every test
// injects its own deps instead.
vi.mock("../../vex-cloud/production.js", () => ({
  productionVexCloudDeps: () => {
    throw new Error("production deps must not be used in this suite");
  },
}));

const { CH } = await import("@shared/ipc/channels.js");
const { openExecutionGate } = await import("../../lifecycle/execution-gate.js");
const { registerVexCloudHandlers } = await import("../vex-cloud.js");
const { assertVexCloudSiweMessage } = await import("@tools/wallet/siwe-signing.js");
const { getCancelController } = await import("../register-handler.js");
const { memoryWithdrawalOrigins } = await import("../../vex-cloud/__tests__/support/funding-fakes.js");
import type { VexCloudDeps } from "../../vex-cloud/production.js";
import type { SignedSiweItem, VexCloudApi, VexCloudCall, VexCloudChallenge } from "../../vex-cloud/api-client.js";

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
const BINDING = { domain: "localhost", uri: "http://localhost:8787" } as const;
const NOW = new Date("2026-10-20T12:00:00.000Z");

interface FakeWallet {
  readonly entry: { id: string; address: string; label: string; createdAt: string };
  readonly account: PrivateKeyAccount;
}

function wallet(index: number): FakeWallet {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    account,
    entry: {
      id: `evm_00000000-0000-4000-8000-00000000000${index}`,
      address: account.address,
      label: `wallet ${index}`,
      createdAt: NOW.toISOString(),
    },
  };
}

/**
 * An in-memory gateway enforcing the backend's sign-in rules: nonces single
 * use, signatures recovered, signin needs every signer linked to ONE account,
 * create needs signers == link set none linked, link needs the session, the
 * new wallets' signatures AND a linked co-signer.
 */
class FakeGateway implements VexCloudApi {
  readonly owners = new Map<string, string>();
  readonly sessions = new Map<string, string>();
  readonly verified: SignedSiweItem[][] = [];
  readonly nonces = new Set<string>();
  challengeOverride: Partial<VexCloudChallenge> = {};
  accountStatus: 200 | 401 | 503 = 200;
  private counter = 0;
  issueNonce = vi.fn(async (signal: AbortSignal): Promise<VexCloudCall<VexCloudChallenge>> => {
    if (signal.aborted) return { ok: false, failure: { kind: "cancelled" } };
    const nonce = `NONCE${String(++this.counter).padStart(27, "0")}`;
    this.nonces.add(nonce);
    return {
      ok: true,
      value: {
        nonce,
        expires_at: new Date(NOW.getTime() + 300_000).toISOString(),
        domain: BINDING.domain,
        uri: BINDING.uri,
        chain_id: 4663,
        version: "1",
        statement: "Sign in to Vex Cloud with this wallet.",
        max_validity_seconds: 600,
        ...this.challengeOverride,
      },
    };
  });

  verify = vi.fn(async (items: readonly SignedSiweItem[], bearer: string | null) => {
    this.verified.push([...items]);
    const first = parseSiweMessage(items[0]?.message ?? "");
    if (first.nonce === undefined || !this.nonces.delete(first.nonce)) return reject(401, "nonce_invalid");
    for (const item of items) {
      assertVexCloudSiweMessage(item.message);
      const valid = await verifyMessage({ address: getAddress(item.address), message: item.message, signature: item.signature as Hex });
      if (!valid) return reject(401, "signature_invalid", item.address);
    }
    const resources = first.resources ?? [];
    const intent = resources[0] ?? "";
    const linkSet = resources.slice(1).map((r) => r.slice("urn:vex:link:".length));
    const signers = items.map((item) => item.address.toLowerCase());
    if (intent === "urn:vex:intent:signin") {
      const accounts = new Set<string>();
      for (const signer of signers) {
        const owner = this.owners.get(signer);
        if (owner === undefined) return reject(401, "wallet_not_linked", signer);
        accounts.add(owner);
      }
      if (accounts.size !== 1) return reject(409, "signers_span_accounts");
      return this.session([...accounts][0] ?? "", false);
    }
    if (intent === "urn:vex:intent:create") {
      for (const address of linkSet) if (this.owners.has(address)) return reject(409, "address_already_linked", address);
      const accountId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      for (const address of linkSet) this.owners.set(address, accountId);
      return this.session(accountId, true);
    }
    const accountId = intent.slice("urn:vex:intent:link:".length);
    if (bearer === null || this.sessions.get(bearer) !== accountId) return reject(401, "session_required");
    const coSigners = signers.filter((signer) => !linkSet.includes(signer));
    if (coSigners.length === 0) return reject(403, "cosignature_required");
    if (coSigners.some((signer) => this.owners.get(signer) !== accountId)) return reject(403, "cosigner_not_linked");
    for (const address of linkSet) this.owners.set(address, accountId);
    return { ok: true as const, value: { kind: "linked" as const, accountId, linked: linkSet } };
  });

  readAccount = vi.fn(async (bearer: string) => {
    if (this.accountStatus === 401 || !this.sessions.has(bearer)) {
      return { ok: false as const, failure: { kind: "unauthorized" as const, reason: "session_invalid", address: null } };
    }
    if (this.accountStatus === 503) return { ok: false as const, failure: { kind: "unavailable" as const, status: 503 } };
    const accountId = this.sessions.get(bearer) ?? "";
    const amount = (wei: string, usd: string | null) => ({ wei, usd_micro_estimate: usd });
    return {
      ok: true as const,
      value: {
        account_id: accountId,
        status: { paused: false, drain_mode: false },
        wallets: [...this.owners.entries()]
          .filter(([, owner]) => owner === accountId)
          .map(([address]) => ({ address, linked_at: NOW.toISOString() })),
        deposit_address: null,
        balances: {
          available: amount("1000000000000000000000", "1000000"),
          provisional: amount("0", "0"),
          reserved: amount("0", null),
          pending_withdrawal: amount("0", "0"),
          claimable: amount("0", "0"),
        },
        rate: {
          available: true as const,
          source: "fixed",
          vex_wei_per_micro_usd: "1000000000000000",
          observed_at: NOW.toISOString(),
          age_seconds: 42,
          valid_until: new Date(NOW.getTime() + 300_000).toISOString(),
        },
        limits: { min_deposit_micro_usd: "5000000", min_withdraw_micro_usd: "5000000", provisional_cap_micro_usd: "25000000" },
      },
    };
  });

  // The funding calls are pinned by `vex-cloud-funding-ipc.test.ts`; this
  // suite never reaches them.
  listActivity = vi.fn(async () => notUsed());
  listUsage = vi.fn(async () => notUsed());
  listDeposits = vi.fn(async () => notUsed());
  listModels = vi.fn(async () => notUsed());
  notifyDeposit = vi.fn(async () => notUsed());
  createWithdrawal = vi.fn(async () => notUsed());
  readWithdrawal = vi.fn(async () => notUsed());
  claimCashbackToBalance = vi.fn(async () => notUsed());
  listWithdrawals = vi.fn(async () => notUsed());
  cancelWithdrawal = vi.fn(async () => notUsed());

  private session(accountId: string, created: boolean) {
    const token = `vxs_${"t".repeat(20)}${++this.counter}`;
    this.sessions.set(token, accountId);
    return {
      ok: true as const,
      value: { kind: "session" as const, accountId, created, token, expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString() },
    };
  }
}

function notUsed(): never {
  throw new Error("funding call not used in this suite");
}

function reject(status: number, reason: string, address?: string) {
  return {
    ok: false as const,
    failure:
      status === 401
        ? { kind: "unauthorized" as const, reason, address: address ?? null }
        : { kind: "rejected" as const, status, reason, address: address ?? null },
  };
}

interface World {
  readonly gateway: FakeGateway;
  readonly wallets: FakeWallet[];
  readonly stored: { token: string | null };
  readonly signed: string[];
  vaultUnlocked: boolean;
  readonly deps: VexCloudDeps;
}

function world(count: number): World {
  const gateway = new FakeGateway();
  const wallets = Array.from({ length: count }, (_, index) => wallet(index + 1));
  const stored = { token: null as string | null };
  const signed: string[] = [];
  const self: World = {
    gateway,
    wallets,
    stored,
    signed,
    vaultUnlocked: true,
    deps: {
      api: gateway,
      signIn: {
        listEvmWallets: () => wallets.map((w) => w.entry),
        isVaultUnlocked: () => self.vaultUnlocked,
        signMessage: async (entry, message) => {
          // The real shape check runs before the key, as in production.
          assertVexCloudSiweMessage(message);
          const owner = wallets.find((w) => w.entry.address === entry.address);
          if (owner === undefined) throw new Error("unknown wallet");
          signed.push(message);
          return owner.account.signMessage({ message });
        },
        binding: () => BINDING,
        storeSession: async (token) => {
          stored.token = token;
          return { ok: true, data: undefined };
        },
        now: () => NOW,
      },
      account: {
        readSession: async () => ({ ok: true, data: stored.token }),
        clearSession: async () => {
          stored.token = null;
          return { ok: true, data: undefined };
        },
        localWallets: () => wallets.map((w) => getAddress(w.entry.address)),
        pinnedDepositAddress: () => null,
        now: () => NOW,
      },
      clearSession: async () => {
        stored.token = null;
        return { ok: true, data: undefined };
      },
      deposit: {
        chain: () => notUsed(),
        listEvmWallets: () => wallets.map((w) => w.entry),
        isVaultUnlocked: () => self.vaultUnlocked,
        isExecutionReady: () => true,
        pinnedDepositAddress: () => null,
        loadPrivateKey: async () => notUsed(),
        now: () => NOW,
      },
      withdrawalOrigins: memoryWithdrawalOrigins(() => NOW).guard,
    },
  };
  return self;
}

interface ErrorResult {
  ok: false;
  error: { code: string; message: string; retryable: boolean; domain: string };
}
interface OkResult {
  ok: true;
  data: Record<string, unknown>;
}

async function call(channel: string, payload: unknown, requestId = REQUEST_ID): Promise<unknown> {
  const fn = handlers.get(channel);
  if (fn === undefined) throw new Error(`handler not registered: ${channel}`);
  return fn({ sender: {} }, { requestId, payload });
}

function expectOk(value: unknown): OkResult {
  const result = value as OkResult | ErrorResult;
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result;
}

function expectError(value: unknown, code: string): ErrorResult {
  const result = value as OkResult | ErrorResult;
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.code).toBe(code);
  return result;
}

let current: World;
let teardown: ReadonlyArray<() => void> = [];

function mount(w: World): void {
  current = w;
  teardown = registerVexCloudHandlers(w.deps);
}

beforeEach(() => {
  assertTrustedSender.mockImplementation(() => undefined);
  openExecutionGate();
});

afterEach(() => {
  for (const off of teardown) off();
  handlers.clear();
  vi.clearAllMocks();
});

const addresses = (w: World): string[] => w.wallets.map((x) => getAddress(x.entry.address));

describe("signIn: the three intents", () => {
  it("creates the account with every wallet when none is linked", async () => {
    mount(world(2));
    const result = expectOk(await call(CH.vexCloud.signIn, { wallets: addresses(current) }));

    expect(result.data.created).toBe(true);
    expect(result.data.linkedNow).toEqual(addresses(current).map((a) => a.toLowerCase()));
    expect(current.stored.token).toMatch(/^vxs_/);
    // Round 1 signin was refused for the first unlinked wallet, round 2 for
    // the second, then the create batch: every message carried the binding.
    const intents = current.gateway.verified.map((batch) => parseSiweMessage(batch[0]?.message ?? "").resources?.[0]);
    expect(intents).toEqual(["urn:vex:intent:signin", "urn:vex:intent:signin", "urn:vex:intent:create"]);
    for (const message of current.signed) {
      const parsed = parseSiweMessage(message);
      expect(parsed.domain).toBe("localhost");
      expect(parsed.uri).toBe("http://localhost:8787");
      expect(parsed.chainId).toBe(4663);
    }
    // The account read came with the session; money stays whole.
    const account = result.data.account as { balances: { available: unknown; reserved: unknown } };
    expect(account.balances.available).toEqual({
      wei: "1000000000000000000000",
      decimals: 18,
      symbol: "VEX",
      usdMicroEstimate: "1000000",
    });
    expect(account.balances.reserved).toEqual({ wei: "0", decimals: 18, symbol: "VEX", usdMicroEstimate: null });
  });

  it("signs in and links a new wallet with a co-signature from the linked one", async () => {
    const w = world(2);
    w.gateway.owners.set(w.wallets[0]?.entry.address.toLowerCase() ?? "", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    mount(w);

    const result = expectOk(await call(CH.vexCloud.signIn, { wallets: addresses(w) }));

    expect(result.data.created).toBe(false);
    const second = w.wallets[1]?.entry.address.toLowerCase();
    expect(result.data.linkedNow).toEqual([second]);
    const linkBatch = w.gateway.verified.at(-1) ?? [];
    expect(parseSiweMessage(linkBatch[0]?.message ?? "").resources).toEqual([
      "urn:vex:intent:link:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      `urn:vex:link:${second}`,
    ]);
    // Both wallets signed the link batch: the new one and the co-signer.
    expect(linkBatch.map((item) => item.address.toLowerCase()).sort()).toEqual(
      w.wallets.map((x) => x.entry.address.toLowerCase()).sort(),
    );
    expect(w.gateway.verify.mock.calls.at(-1)?.[1]).toBe(w.stored.token);
  });

  it("signs in without linking when every wallet is already linked", async () => {
    const w = world(1);
    w.gateway.owners.set(w.wallets[0]?.entry.address.toLowerCase() ?? "", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    mount(w);
    const result = expectOk(await call(CH.vexCloud.signIn, { wallets: addresses(w) }));
    expect(result.data).toMatchObject({ created: false, linkedNow: [] });
    expect(w.gateway.verify).toHaveBeenCalledOnce();
  });
});

describe("signIn: nothing is signed when it must not be", () => {
  it.each([
    ["no wallets", { wallets: [] }],
    ["a malformed address", { wallets: ["0x1234"] }],
    ["four wallets", { wallets: Array.from({ length: 4 }, (_, i) => `0x${String(i).repeat(40)}`) }],
    ["a smuggled message field", { wallets: [`0x${"1".repeat(40)}`], message: "anything" }],
  ])("refuses %s at the schema", async (_name, payload) => {
    mount(world(1));
    expectError(await call(CH.vexCloud.signIn, payload), "validation.invalid_input");
    expect(current.gateway.issueNonce).not.toHaveBeenCalled();
    expect(current.signed).toHaveLength(0);
  });

  it("refuses an untrusted sender by name", async () => {
    mount(world(1));
    assertTrustedSender.mockImplementation(() => {
      throw new Error("Untrusted IPC sender: https://evil.example");
    });
    const error = expectError(await call(CH.vexCloud.signIn, { wallets: addresses(current) }), "validation.invalid_sender");
    expect(error.error.message).not.toContain("evil.example");
    expect(current.gateway.issueNonce).not.toHaveBeenCalled();
  });

  it("refuses a locked vault", async () => {
    const w = world(1);
    w.vaultUnlocked = false;
    mount(w);
    expectError(await call(CH.vexCloud.signIn, { wallets: addresses(w) }), "wallet.keystore_locked");
    expect(w.gateway.issueNonce).not.toHaveBeenCalled();
  });

  it("refuses when the inventory differs from the wallets the user saw", async () => {
    mount(world(2));
    const error = expectError(
      await call(CH.vexCloud.signIn, { wallets: [addresses(current)[0]] }),
      "wallets.invalid_selection",
    );
    expect(error.error.message).toMatch(/wallets changed/);
    expect(current.signed).toHaveLength(0);
  });

  it.each([
    ["another domain", { domain: "evil.example" }],
    ["another uri", { uri: "https://evil.example" }],
    ["another chain", { chain_id: 1 }],
    ["another statement", { statement: "Approve all transfers." }],
  ])("refuses a challenge naming %s, before any key", async (_name, override) => {
    const w = world(1);
    w.gateway.challengeOverride = override;
    mount(w);
    const error = expectError(await call(CH.vexCloud.signIn, { wallets: addresses(w) }), "internal.unexpected");
    expect(error.error.message).toMatch(/Nothing was signed/);
    expect(w.signed).toHaveLength(0);
    expect(w.gateway.verify).not.toHaveBeenCalled();
  });

  it("names a wallet linked to another account and stores nothing", async () => {
    const w = world(2);
    w.gateway.owners.set(w.wallets[0]?.entry.address.toLowerCase() ?? "", "11111111-2222-4333-8444-555555555555");
    w.gateway.owners.set(w.wallets[1]?.entry.address.toLowerCase() ?? "", "99999999-2222-4333-8444-555555555555");
    mount(w);
    const error = expectError(await call(CH.vexCloud.signIn, { wallets: addresses(w) }), "permissions.denied");
    expect(error.error.message).toMatch(/different Vex Inference accounts/);
    expect(w.stored.token).toBeNull();
  });

  it("refuses a second sign-in while one runs", async () => {
    const w = world(1);
    let release = (): void => undefined;
    w.gateway.issueNonce.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: false, failure: { kind: "unavailable", status: null } });
        }),
    );
    mount(w);
    const first = call(CH.vexCloud.signIn, { wallets: addresses(w) });
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    expectError(
      await call(CH.vexCloud.signIn, { wallets: addresses(w) }, "22222222-2222-4333-8444-555555555555"),
      "validation.invalid_input",
    );
    release();
    expectError(await first, "provider.unavailable");
  });
});

describe("signIn: cancellation", () => {
  it("a cancel before the session is stored stores nothing and answers cancelled", async () => {
    const w = world(1);
    w.gateway.owners.set(w.wallets[0]?.entry.address.toLowerCase() ?? "", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    let release = (): void => undefined;
    const realVerify = w.gateway.verify.getMockImplementation();
    w.gateway.verify.mockImplementationOnce(async (items: readonly SignedSiweItem[], bearer: string | null) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (realVerify === undefined) throw new Error("no verify");
      return realVerify(items, bearer);
    });
    mount(w);

    const pending = call(CH.vexCloud.signIn, { wallets: addresses(w) });
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    getCancelController(REQUEST_ID)?.abort();
    release();

    expectError(await pending, "internal.cancelled");
    expect(w.stored.token).toBeNull();
  });
});

describe("account", () => {
  it("is signed out with the local wallets listed when nothing is stored", async () => {
    mount(world(2));
    const result = expectOk(await call(CH.vexCloud.account, {}));
    expect(result.data).toEqual({ state: "signed_out", reason: "not_signed_in", localWallets: addresses(current) });
  });

  it("reads the account with the stored session", async () => {
    const w = world(1);
    mount(w);
    expectOk(await call(CH.vexCloud.signIn, { wallets: addresses(w) }));
    const result = expectOk(await call(CH.vexCloud.account, {}));
    expect(result.data.state).toBe("signed_in");
    const account = result.data.account as { rate: unknown; wallets: unknown[] };
    expect(account.rate).toEqual({
      available: true,
      source: "fixed",
      observedAt: NOW.toISOString(),
      ageSeconds: 42,
      vexWeiPerMicroUsd: "1000000000000000",
      validUntil: new Date(NOW.getTime() + 300_000).toISOString(),
    });
    expect(account.wallets).toHaveLength(1);
    expect(w.gateway.readAccount.mock.calls.at(-1)?.[0]).toBe(w.stored.token);
  });

  it("a 401 removes the stored session and answers session_expired", async () => {
    const w = world(1);
    mount(w);
    expectOk(await call(CH.vexCloud.signIn, { wallets: addresses(w) }));
    w.gateway.accountStatus = 401;
    const result = expectOk(await call(CH.vexCloud.account, {}));
    expect(result.data).toMatchObject({ state: "signed_out", reason: "session_expired" });
    expect(w.stored.token).toBeNull();
  });

  it("an outage is retryable and keeps the session", async () => {
    const w = world(1);
    mount(w);
    expectOk(await call(CH.vexCloud.signIn, { wallets: addresses(w) }));
    w.gateway.accountStatus = 503;
    const error = expectError(await call(CH.vexCloud.account, {}), "provider.unavailable");
    expect(error.error.retryable).toBe(true);
    expect(w.stored.token).not.toBeNull();
  });

  it("refuses extra fields", async () => {
    mount(world(1));
    expectError(await call(CH.vexCloud.account, { token: "x" }), "validation.invalid_input");
  });
});

describe("signOut", () => {
  it("removes the stored session, idempotently", async () => {
    const w = world(1);
    mount(w);
    expectOk(await call(CH.vexCloud.signIn, { wallets: addresses(w) }));
    expect(w.stored.token).not.toBeNull();
    expect(expectOk(await call(CH.vexCloud.signOut, {})).data).toEqual({ signedOut: true });
    expect(w.stored.token).toBeNull();
    expectOk(await call(CH.vexCloud.signOut, {}));
  });
});

// LAST on purpose: closing the gate for shutdown is one-way for the process,
// so every case after it would be refused too.
describe("the execution gate", () => {
  it("refuses signIn once the gate is closed (it signs), and signs nothing", async () => {
    mount(world(1));
    closeExecutionGateForShutdown();
    expectError(await call(CH.vexCloud.signIn, { wallets: addresses(current) }), "services.runtime_starting");
    expect(current.gateway.issueNonce).not.toHaveBeenCalled();
    expect(current.signed).toHaveLength(0);
  });
});
