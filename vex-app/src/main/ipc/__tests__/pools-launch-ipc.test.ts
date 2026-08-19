/**
 * pools.fun launch IPC — the SEAM, end to end, on a faked runtime.
 *
 * WHAT IS REAL HERE: `registerHandler` (so schema validation and the `Result`
 * envelope are the production ones), the whole of `main/pools-launch/index.ts`
 * (so the DTO mapping in both directions is the production one), and
 * `main/ipc/pools-launch.ts`'s refusal mapping. Only two things are faked: the
 * session's wallet scope, and `getPoolsLaunchRuntime`, which stands in for the
 * agent runtime so no provider, verifier or database is reached.
 *
 * WHAT IT PINS, and why each one is worth a test:
 *
 *  - all seven channels ACTUALLY REACH the runtime. Until the swap they refused
 *    in words; a channel left unwired would look identical to the renderer as a
 *    channel that is merely failing, so "the runtime was called" is asserted
 *    per channel rather than assumed;
 *  - every amount arrives as `{rawWei, decimals, assetAddress, assetSymbol}`.
 *    A preformatted or bare-number amount is the thousandfold-error shape
 *    rules/90 forbids, and this boundary is the last place it can be caught;
 *  - every refusal kind lands on an EXISTING wire code. P3 mints no new
 *    `VEX_ERROR_CODES` entry, so the table below is also the proof that none was
 *    needed;
 *  - `awaiting: null` and `claimable: null` stay SUCCESSES and stay distinct
 *    from "we looked and found nothing".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../sender-validation.js", () => ({ assertTrustedSender: () => undefined }));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const getSessionWalletScope = vi.fn();
vi.mock("../../database/sessions-db.js", () => ({
  getSessionWalletScope: (sessionId: string) => getSessionWalletScope(sessionId),
}));

const runtime = {
  prepare: vi.fn(),
  deploy: vi.fn(),
  cancel: vi.fn(),
  previewClaim: vi.fn(),
  claim: vi.fn(),
  myLaunches: vi.fn(),
  getAwaiting: vi.fn(),
};
vi.mock("../../pools-launch/runtime.js", () => ({ getPoolsLaunchRuntime: () => runtime }));

const { CH } = await import("@shared/ipc/channels.js");
const { registerPoolsLaunchHandlers } = await import("../pools-launch.js");

const SESSION_ID = "3f0d2f7a-1c2b-4b3c-8d4e-5f6a7b8c9d0e";
const WALLET = `0x${"1".repeat(40)}`;
const TOKEN = `0x${"a".repeat(40)}`;
const POOL = `0x${"b".repeat(40)}`;
const WETH = `0x${"c".repeat(40)}`;
const NATIVE = `0x${"0".repeat(40)}`;
const TX_HASH = `0x${"d".repeat(64)}`;

const FORM = {
  name: "Moon",
  symbol: "MOON",
  pairedAsset: "weth",
  image: { kind: "locker", imageId: "img_0123456789abcdef" },
  tweetUrl: null,
  websiteUrl: null,
  prebuy: { amountHuman: "0.01" },
  feeRecipient: { kind: "address", address: WALLET },
};

function amount(rawWei: string, decimals: number, assetAddress: string, assetSymbol: string) {
  return { rawWei, decimals, assetAddress, assetSymbol };
}

const DEPLOYMENT_FEE = amount("1050000000000000", 18, NATIVE, "ETH");
const PREBUY = amount("10000000000000000", 18, NATIVE, "ETH");
const VEX_FEE = amount("27500000000000", 18, NATIVE, "ETH");
const GAS_BOUND = amount("2025200000000000", 18, NATIVE, "ETH");
const TX_VALUE = amount("11050000000000000", 18, NATIVE, "ETH");
const TOKEN_LEG = amount("1047061", 6, TOKEN, "MOON");
const PAIRED_LEG = amount("500000000000000", 18, WETH, "WETH");

const PREPARED = {
  fingerprintId: "pf_1",
  predictedTokenAddress: TOKEN,
  predictedPoolAddress: POOL,
  resolvedFeeRecipient: WALLET,
  pairedAsset: "weth",
  pairedAssetAddress: WETH,
  costs: {
    deploymentFee: DEPLOYMENT_FEE,
    prebuy: PREBUY,
    vexFee: VEX_FEE,
    gasBound: GAS_BOUND,
    transactionValue: TX_VALUE,
  },
  metadataUri: "ipfs://bafy0000",
  imageLanded: true,
  expiresAt: "2026-08-19T10:01:00.000Z",
};

interface ErrorResult {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    userActionable: boolean;
  };
}

interface OkResult {
  ok: true;
  data: Record<string, unknown>;
}

function isError(value: unknown): value is ErrorResult {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

async function call(channel: string, payload: unknown): Promise<unknown> {
  const fn = handlers.get(channel);
  if (fn === undefined) throw new Error(`handler not registered: ${channel}`);
  return fn({ sender: {} }, { requestId: "11111111-2222-4333-8444-555555555555", payload });
}

function expectOk(value: unknown): OkResult {
  if (isError(value)) throw new Error(`expected ok, got ${value.error.code}: ${value.error.message}`);
  return value as OkResult;
}

function expectError(value: unknown, code: string): ErrorResult {
  expect(isError(value)).toBe(true);
  if (!isError(value)) throw new Error("unreachable");
  expect(value.error.code).toBe(code);
  return value;
}

let teardown: ReadonlyArray<() => void> = [];

beforeEach(() => {
  getSessionWalletScope.mockResolvedValue({ ok: true, data: { evm: { address: WALLET }, solana: null } });
  teardown = registerPoolsLaunchHandlers();
});

afterEach(() => {
  for (const off of teardown) off();
  handlers.clear();
  vi.clearAllMocks();
});

// ── The runtime is actually reached, on every channel ────────────────────────

describe("every channel reaches the runtime", () => {
  /** Channel, payload, the runtime method it must call, and a valid success. */
  const CHANNELS = [
    [CH.poolsLaunch.prepare, { sessionId: SESSION_ID, form: FORM }, runtime.prepare, PREPARED],
    [
      CH.poolsLaunch.deploy,
      { sessionId: SESSION_ID, fingerprintId: "pf_1" },
      runtime.deploy,
      {
        tokenAddress: TOKEN,
        poolAddress: POOL,
        txHash: TX_HASH,
        activityId: 42,
        resolvedFeeRecipient: WALLET,
      },
    ],
    [
      CH.poolsLaunch.cancel,
      { sessionId: SESSION_ID, fingerprintId: "pf_1" },
      runtime.cancel,
      { cancelled: true },
    ],
    [
      CH.poolsLaunch.myLaunches,
      { sessionId: SESSION_ID },
      runtime.myLaunches,
      { wallet: WALLET, launches: [] },
    ],
    [CH.poolsLaunch.getAwaiting, { sessionId: SESSION_ID }, runtime.getAwaiting, null],
    [
      CH.poolsLaunch.claimPreview,
      { sessionId: SESSION_ID, tokenAddress: TOKEN },
      runtime.previewClaim,
      {
        tokenAddress: TOKEN,
        tokenLeg: TOKEN_LEG,
        pairedLeg: PAIRED_LEG,
        alreadyCollected: { tokenLeg: TOKEN_LEG, pairedLeg: PAIRED_LEG },
        gasBound: GAS_BOUND,
      },
    ],
    [
      CH.poolsLaunch.claim,
      { sessionId: SESSION_ID, tokenAddress: TOKEN },
      runtime.claim,
      {
        tokenAddress: TOKEN,
        txHash: TX_HASH,
        activityId: 43,
        tokenLeg: TOKEN_LEG,
        pairedLeg: PAIRED_LEG,
      },
    ],
  ] as const;

  it.each(CHANNELS)("%s calls the runtime and succeeds", async (channel, payload, method, value) => {
    method.mockResolvedValue({ ok: true, value });
    const result = await call(channel, payload);
    expectOk(result);
    expect(method).toHaveBeenCalledTimes(1);
  });

  it("resolves the wallet SERVER-side and hands the runtime a session it never received", async () => {
    runtime.prepare.mockResolvedValue({ ok: true, value: PREPARED });
    await call(CH.poolsLaunch.prepare, { sessionId: SESSION_ID, form: FORM });
    expect(getSessionWalletScope).toHaveBeenCalledWith(SESSION_ID);
    expect(runtime.prepare.mock.calls[0]?.[0]).toEqual({
      sessionId: SESSION_ID,
      walletAddress: WALLET,
    });
  });
});

// ── Inward mapping: the renderer's form becomes logical inputs ───────────────

describe("the form maps to the runtime's logical inputs", () => {
  it("passes the locker pick, the human prebuy and the chosen recipient through unchanged", async () => {
    runtime.prepare.mockResolvedValue({ ok: true, value: PREPARED });
    await call(CH.poolsLaunch.prepare, { sessionId: SESSION_ID, form: FORM });

    expect(runtime.prepare.mock.calls[0]?.[1]).toEqual({
      name: "Moon",
      symbol: "MOON",
      pairedAsset: "weth",
      image: { kind: "locker", imageId: "img_0123456789abcdef" },
      tweetUrl: undefined,
      websiteUrl: undefined,
      // Still the decimal the user TYPED. A renderer-scaled raw amount here is
      // the bug this assertion exists to catch.
      prebuy: { amountHuman: "0.01" },
      feeRecipient: { kind: "address", address: WALLET },
    });
  });

  it("spells 'no image' and 'no prebuy' exactly one way inward", async () => {
    runtime.prepare.mockResolvedValue({ ok: true, value: { ...PREPARED, imageLanded: false } });
    await call(CH.poolsLaunch.prepare, {
      sessionId: SESSION_ID,
      form: { ...FORM, image: null, prebuy: null, feeRecipient: { kind: "session_wallet" } },
    });

    const inputs = runtime.prepare.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(inputs.image).toBeUndefined();
    expect(inputs.prebuy).toBeUndefined();
    expect(inputs.feeRecipient).toEqual({ kind: "session_wallet" });
  });
});

// ── Outward mapping: amounts stay readable, nothing is preformatted ──────────

describe("amounts reach the renderer whole", () => {
  it("prepare returns every cost leg with its decimals and asset, never a formatted string", async () => {
    runtime.prepare.mockResolvedValue({ ok: true, value: PREPARED });
    const result = expectOk(await call(CH.poolsLaunch.prepare, { sessionId: SESSION_ID, form: FORM }));

    expect(result.data).toEqual({ ...PREPARED, costs: { ...PREPARED.costs } });
    for (const leg of Object.values(result.data.costs as Record<string, unknown>)) {
      expect(leg).toEqual(
        expect.objectContaining({
          rawWei: expect.stringMatching(/^\d+$/),
          decimals: expect.any(Number),
          assetAddress: expect.any(String),
          assetSymbol: expect.any(String),
        }),
      );
    }
  });

  it("an ABSENT prebuy becomes null on the wire, not a zero amount", async () => {
    runtime.prepare.mockResolvedValue({
      ok: true,
      value: { ...PREPARED, costs: { ...PREPARED.costs, prebuy: undefined } },
    });
    const result = expectOk(await call(CH.poolsLaunch.prepare, { sessionId: SESSION_ID, form: FORM }));
    expect((result.data.costs as { prebuy: unknown }).prebuy).toBeNull();
  });

  it("deploy names the token and the recipient in the sentence the dialog shows", async () => {
    runtime.deploy.mockResolvedValue({
      ok: true,
      value: {
        tokenAddress: TOKEN,
        poolAddress: POOL,
        txHash: TX_HASH,
        activityId: 42,
        resolvedFeeRecipient: WALLET,
      },
    });
    const result = expectOk(
      await call(CH.poolsLaunch.deploy, { sessionId: SESSION_ID, fingerprintId: "pf_1" }),
    );
    expect(result.data.txHash).toBe(TX_HASH);
    expect(result.data.message).toContain(TOKEN);
    expect(result.data.message).toContain(WALLET);
  });

  it("claim reports BOTH legs, each with the decimals needed to read it", async () => {
    runtime.claim.mockResolvedValue({
      ok: true,
      value: {
        tokenAddress: TOKEN,
        txHash: TX_HASH,
        activityId: 43,
        tokenLeg: TOKEN_LEG,
        pairedLeg: PAIRED_LEG,
      },
    });
    const result = expectOk(
      await call(CH.poolsLaunch.claim, { sessionId: SESSION_ID, tokenAddress: TOKEN }),
    );
    expect(result.data.tokenLeg).toEqual(TOKEN_LEG);
    expect(result.data.pairedLeg).toEqual(PAIRED_LEG);
    expect(result.data.message).toContain("MOON");
    expect(result.data.message).toContain("WETH");
  });

  it("claimPreview keeps 'already collected' separate from what a claim would pay", async () => {
    const collected = { tokenLeg: amount("0", 6, TOKEN, "MOON"), pairedLeg: amount("0", 18, WETH, "WETH") };
    runtime.previewClaim.mockResolvedValue({
      ok: true,
      value: {
        tokenAddress: TOKEN,
        tokenLeg: TOKEN_LEG,
        pairedLeg: PAIRED_LEG,
        alreadyCollected: collected,
        gasBound: GAS_BOUND,
      },
    });
    const result = expectOk(
      await call(CH.poolsLaunch.claimPreview, { sessionId: SESSION_ID, tokenAddress: TOKEN }),
    );
    expect(result.data.pairedLeg).toEqual(PAIRED_LEG);
    expect(result.data.alreadyCollected).toEqual(collected);
  });
});

// ── The two nulls that must stay successes ───────────────────────────────────

describe("absence is a fact, not a failure", () => {
  it("getAwaiting returns awaiting: null as a SUCCESS for an idle session", async () => {
    runtime.getAwaiting.mockResolvedValue({ ok: true, value: null });
    const result = expectOk(await call(CH.poolsLaunch.getAwaiting, { sessionId: SESSION_ID }));
    expect(result.data).toEqual({ awaiting: null });
  });

  it("getAwaiting surfaces an open form with whatever the agent proposed", async () => {
    runtime.getAwaiting.mockResolvedValue({
      ok: true,
      value: {
        intentId: "int_1",
        sessionId: SESSION_ID,
        expiresAt: "2026-08-19T10:01:00.000Z",
        proposed: { name: "Moon", pairedAsset: "weth", prebuy: { amountHuman: "0.01" } },
      },
    });
    const result = expectOk(await call(CH.poolsLaunch.getAwaiting, { sessionId: SESSION_ID }));
    expect(result.data.awaiting).toEqual({
      intentId: "int_1",
      expiresAt: "2026-08-19T10:01:00.000Z",
      proposed: expect.objectContaining({ name: "Moon", prebuyAmountHuman: "0.01" }),
    });
  });

  it("an UNMEASURED claimable is null, and a measured one keeps both legs", async () => {
    runtime.myLaunches.mockResolvedValue({
      ok: true,
      value: {
        wallet: WALLET,
        launches: [
          {
            tokenAddress: TOKEN,
            poolAddress: POOL,
            name: "Moon",
            symbol: "MOON",
            pairedAsset: "weth",
            launchedAt: "2026-08-19T09:00:00.000Z",
            txHash: TX_HASH,
            feeRecipient: WALLET,
          },
          {
            tokenAddress: POOL,
            poolAddress: null,
            name: null,
            symbol: null,
            pairedAsset: "usdg",
            launchedAt: "2026-08-19T09:30:00.000Z",
            txHash: null,
            feeRecipient: null,
            claimable: { tokenLeg: TOKEN_LEG, pairedLeg: PAIRED_LEG },
          },
        ],
      },
    });
    const result = expectOk(await call(CH.poolsLaunch.myLaunches, { sessionId: SESSION_ID }));
    const launches = result.data.launches as ReadonlyArray<{ claimable: unknown }>;
    expect(launches[0]?.claimable).toBeNull();
    expect(launches[1]?.claimable).toEqual({ tokenLeg: TOKEN_LEG, pairedLeg: PAIRED_LEG });
  });
});

// ── Refusals map onto codes that ALREADY exist ───────────────────────────────

describe("every refusal kind lands on an existing wire code", () => {
  const REFUSALS = [
    // NOT retryable: retrying the same rejected form repeats the same refusal.
    // It is the user's to fix, which is what `userActionable` says.
    ["invalid_inputs", "validation.invalid_input", false, true],
    ["wallet_unavailable", "wallets.invalid_selection", false, false],
    ["insufficient_funds", "wallet.insufficient_funds", false, true],
    ["pair_not_allowlisted", "internal.unexpected", false, false],
    ["verifier_refused", "internal.unexpected", false, false],
    ["fingerprint_expired", "internal.unexpected", true, true],
    ["provider_unavailable", "internal.unexpected", true, false],
    ["claim_ceiling_exceeded", "internal.unexpected", false, false],
  ] as const;

  it.each(REFUSALS)(
    "%s -> %s (retryable=%s userActionable=%s), with the runtime's own message intact",
    async (kind, code, retryable, userActionable) => {
      const message = `refused because ${kind}`;
      runtime.prepare.mockResolvedValue({ ok: false, refusal: { kind, message } });

      const result = await call(CH.poolsLaunch.prepare, { sessionId: SESSION_ID, form: FORM });

      const error = expectError(result, code);
      expect(error.error.message).toBe(message);
      expect(error.error.retryable).toBe(retryable);
      expect(error.error.userActionable).toBe(userActionable);
    },
  );

  it("names the missing wallet WITHOUT calling the runtime or the session's address", async () => {
    getSessionWalletScope.mockResolvedValue({ ok: true, data: { evm: null, solana: null } });
    const result = await call(CH.poolsLaunch.deploy, { sessionId: SESSION_ID, fingerprintId: "pf_1" });
    const error = expectError(result, "wallets.invalid_selection");
    expect(error.error.message).toContain("wallet");
    expect(runtime.deploy).not.toHaveBeenCalled();
  });

  it("a failed wallet-scope read refuses rather than launching from an unknown account", async () => {
    getSessionWalletScope.mockResolvedValue({ ok: false });
    const result = await call(CH.poolsLaunch.deploy, { sessionId: SESSION_ID, fingerprintId: "pf_1" });
    expectError(result, "wallets.invalid_selection");
    expect(runtime.deploy).not.toHaveBeenCalled();
  });

  it("a THROWN runtime failure is structural and leaks no message", async () => {
    runtime.deploy.mockRejectedValue(
      new Error("connect ECONNREFUSED postgres://vex:hunter2@127.0.0.1:5432/vex"),
    );
    const result = await call(CH.poolsLaunch.deploy, { sessionId: SESSION_ID, fingerprintId: "pf_1" });
    const error = expectError(result, "internal.unexpected");
    expect(error.error.message).not.toContain("postgres");
    expect(error.error.message).not.toContain("hunter2");
    // A throw cannot prove nothing was signed, so the sentence must not claim it.
    expect(error.error.message).toContain("Agent Scan");
  });

  it("a main-side mapping bug never reaches the consent screen", async () => {
    // Output validation is the last guard: a negative or non-raw amount is
    // refused rather than rendered as a cost the user approves.
    runtime.prepare.mockResolvedValue({
      ok: true,
      value: { ...PREPARED, costs: { ...PREPARED.costs, transactionValue: amount("-1", 18, NATIVE, "ETH") } },
    });
    const result = await call(CH.poolsLaunch.prepare, { sessionId: SESSION_ID, form: FORM });
    expect(isError(result)).toBe(true);
  });
});

// ── The renderer still cannot name money ─────────────────────────────────────

describe("no money-shaped field can cross inward, even now the runtime is live", () => {
  it.each([
    ["value", { sessionId: SESSION_ID, form: { ...FORM, value: "1" } }],
    ["msgValueWei", { sessionId: SESSION_ID, form: { ...FORM, msgValueWei: "1" } }],
    ["gasLimit", { sessionId: SESSION_ID, form: { ...FORM, gasLimit: "1" } }],
    ["walletAddress", { sessionId: SESSION_ID, form: FORM, walletAddress: WALLET }],
  ])("prepare rejects a renderer-supplied %s before the runtime runs", async (_name, payload) => {
    const result = await call(CH.poolsLaunch.prepare, payload);
    expectError(result, "validation.invalid_input");
    expect(runtime.prepare).not.toHaveBeenCalled();
  });

  it("deploy carries the opaque fingerprint and nothing else", async () => {
    const result = await call(CH.poolsLaunch.deploy, {
      sessionId: SESSION_ID,
      fingerprintId: "pf_1",
      valueWei: "1",
    });
    expectError(result, "validation.invalid_input");
    expect(runtime.deploy).not.toHaveBeenCalled();
  });
});
