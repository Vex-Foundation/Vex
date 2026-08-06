/**
 * Token-launch IPC (C5-main) — contract and NEGATIVE-path tests.
 *
 * The positive paths are cheap to believe; these exist for the ways the
 * boundary is supposed to REFUSE, and for the one thing this surface must never
 * do — let a renderer name money. Specifically pinned:
 *
 *  - a renderer-supplied `value`, `fee`, `recipient` or wallet address is
 *    rejected BY SHAPE, before any handler body runs, on every channel;
 *  - "no EVM wallet selected" is a NAMED refusal, not a zero-cost preview;
 *  - a chain that will not price the launch is `internal.unexpected` and
 *    RETRYABLE — never `validation.invalid_input`, which would tell the user to
 *    fix a field that is already correct;
 *  - an unaffordable launch is `wallet.insufficient_funds` and NOT retryable;
 *  - `submit` and `cancel` refuse in plain words and say nothing was signed;
 *  - `myLaunches` resolves its wallet scope SERVER-side and returns an honest
 *    empty list for an empty inventory, while a failed READ is an error rather
 *    than an empty list (an empty list is a factual claim about the user's
 *    history that a degraded read cannot make);
 *  - no refusal message leaks a wallet address or a database detail.
 *
 * The main-side launch owner is mocked; `registerHandler` runs for real, so
 * schema validation and the `Result` envelope are the production ones.
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

const previewLaunch = vi.fn();
const listMyLaunches = vi.fn();
const submitLaunch = vi.fn();
const cancelLaunch = vi.fn();

vi.mock("../../token-launch/index.js", () => ({
  previewLaunch: (input: unknown) => previewLaunch(input),
  submitLaunch: (input: unknown, executor: unknown) => submitLaunch(input, executor),
  cancelLaunch: (input: unknown) => cancelLaunch(input),
  listMyLaunches: (addresses: unknown, chainId: unknown, limit: unknown) =>
    listMyLaunches(addresses, chainId, limit),
  TRENCH_LAUNCH_CHAIN_ID: 4663,
}));

const buildSubmittedLaunchExecutor = vi.fn(() => async () => ({
  kind: "refused" as const,
  message: "not used",
}));
vi.mock("../../token-launch/execute-seam.js", () => ({
  buildSubmittedLaunchExecutor: () => buildSubmittedLaunchExecutor(),
}));

const listWallets = vi.fn();
vi.mock("@vex-lib/wallet.js", () => ({ listWallets: (family: string) => listWallets(family) }));

const { CH } = await import("@shared/ipc/channels.js");
const { registerTokenLaunchHandlers } = await import("../token-launch.js");

const SESSION_ID = "3f0d2f7a-1c2b-4b3c-8d4e-5f6a7b8c9d0e";
const OWNER = "0x1111111111111111111111111111111111111111";

const FORM = {
  name: "Moon",
  symbol: "MOON",
  description: "",
  links: [],
  imageId: "img_0123456789abcdef0123456789abcdef",
  prebuy: "0.01",
};

const PREVIEW = {
  previewId: "lp_100_1000000000000000",
  creationFeeWei: "1000000000000000",
  prebuyWei: "10000000000000000",
  msgValueWei: "11000000000000000",
  vexFeeWei: "27500000000000",
  vexFeeCharged: true,
  estimatedGasLimit: "2000000",
  estimatedGasPriceWei: "1000000000",
  estimatedNetworkFeeWei: "2025200000000000",
  anchorBlockNumber: "100",
  predictedTokenAddress: null,
  chainId: 4663,
  imageId: FORM.imageId,
  expiresAt: "2026-08-02T10:01:00.000Z",
  note: "You authorize 0.011 ETH (creation fee + prebuy).",
};

interface ErrorResult {
  ok: false;
  error: {
    code: string;
    message: string;
    domain: string;
    retryable: boolean;
    userActionable: boolean;
  };
}

function isError(value: unknown): value is ErrorResult {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

async function call(channel: string, payload: unknown): Promise<unknown> {
  const fn = handlers.get(channel);
  if (fn === undefined) throw new Error(`handler not registered: ${channel}`);
  return fn({ sender: {} }, { requestId: "11111111-2222-4333-8444-555555555555", payload });
}

function expectError(value: unknown, code: string): ErrorResult {
  expect(isError(value)).toBe(true);
  if (!isError(value)) throw new Error("unreachable");
  expect(value.error.code).toBe(code);
  return value;
}

let teardown: ReadonlyArray<() => void> = [];

beforeEach(() => {
  teardown = registerTokenLaunchHandlers();
});

afterEach(() => {
  for (const off of teardown) off();
  handlers.clear();
  vi.clearAllMocks();
});

// ── The renderer cannot name money, by shape ─────────────────────────────

describe("no money-shaped field can cross inward", () => {
  it.each([
    ["value", { sessionId: SESSION_ID, form: { ...FORM, value: "1" } }],
    ["fee", { sessionId: SESSION_ID, form: { ...FORM, fee: "1" } }],
    ["recipient", { sessionId: SESSION_ID, form: { ...FORM, recipient: OWNER } }],
    ["msgValueWei", { sessionId: SESSION_ID, form: { ...FORM, msgValueWei: "1" } }],
    ["walletAddress", { sessionId: SESSION_ID, form: FORM, walletAddress: OWNER }],
  ])("preview rejects a renderer-supplied %s before the handler runs", async (_name, payload) => {
    const result = await call(CH.tokenLaunch.preview, payload);
    expectError(result, "validation.invalid_input");
    expect(previewLaunch).not.toHaveBeenCalled();
  });

  it("myLaunches has no address parameter to supply", async () => {
    const result = await call(CH.tokenLaunch.myLaunches, { limit: 25, walletAddress: OWNER });
    expectError(result, "validation.invalid_input");
    expect(listMyLaunches).not.toHaveBeenCalled();
  });

  it.each([0, 101, -1, 1.5])("myLaunches rejects an out-of-contract limit %s", async (limit) => {
    const result = await call(CH.tokenLaunch.myLaunches, { limit });
    expectError(result, "validation.invalid_input");
    expect(listMyLaunches).not.toHaveBeenCalled();
  });

  it("preview rejects a session id that is not a uuid", async () => {
    const result = await call(CH.tokenLaunch.preview, { sessionId: "not-a-uuid", form: FORM });
    expectError(result, "validation.invalid_input");
    expect(previewLaunch).not.toHaveBeenCalled();
  });
});

// ── preview refusals are named, not collapsed ────────────────────────────

describe("preview refusals keep their meaning", () => {
  it("names the missing wallet instead of pricing a launch from nothing", async () => {
    previewLaunch.mockResolvedValue({
      ok: false,
      refusal: { kind: "no_wallet", detail: "No EVM wallet is selected for this session." },
    });
    const result = await call(CH.tokenLaunch.preview, { sessionId: SESSION_ID, form: FORM });
    const error = expectError(result, "wallets.invalid_selection");
    expect(error.error.message).toContain("wallet");
  });

  it("an unpriceable launch is retryable and NOT a validation error", async () => {
    previewLaunch.mockResolvedValue({
      ok: false,
      refusal: { kind: "unpriceable", detail: "The creation fee could not be proven on-chain." },
    });
    const result = await call(CH.tokenLaunch.preview, { sessionId: SESSION_ID, form: FORM });
    const error = expectError(result, "internal.unexpected");
    expect(error.error.retryable).toBe(true);
    // Nothing the user can fix by editing the form — saying otherwise sends
    // them to change a field that is already correct.
    expect(error.error.userActionable).toBe(false);
  });

  it("an unaffordable launch is wallet.insufficient_funds and is NOT retryable", async () => {
    previewLaunch.mockResolvedValue({
      ok: false,
      refusal: { kind: "insufficient_funds", detail: "This wallet cannot cover the launch." },
    });
    const result = await call(CH.tokenLaunch.preview, { sessionId: SESSION_ID, form: FORM });
    const error = expectError(result, "wallet.insufficient_funds");
    expect(error.error.retryable).toBe(false);
  });

  it("a missing image is images.not_found, so the dialog can point at the locker", async () => {
    previewLaunch.mockResolvedValue({
      ok: false,
      refusal: { kind: "image_not_found", detail: "That image is not in the Trench locker." },
    });
    const result = await call(CH.tokenLaunch.preview, { sessionId: SESSION_ID, form: FORM });
    expectError(result, "images.not_found");
  });

  it("a stale preview stays tokenLaunch.preview_stale and retryable", async () => {
    previewLaunch.mockResolvedValue({
      ok: false,
      refusal: { kind: "preview_stale", detail: "The launch cost changed since you were shown it." },
    });
    const result = await call(CH.tokenLaunch.preview, { sessionId: SESSION_ID, form: FORM });
    const error = expectError(result, "tokenLaunch.preview_stale");
    expect(error.error.retryable).toBe(true);
  });

  it("passes the validated session and form through untouched and returns the priced preview", async () => {
    previewLaunch.mockResolvedValue({ ok: true, preview: PREVIEW });
    const result = await call(CH.tokenLaunch.preview, { sessionId: SESSION_ID, form: FORM });
    expect(result).toEqual({ ok: true, data: PREVIEW });
    expect(previewLaunch).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      form: FORM,
    });
  });

  it("refuses a preview whose priced reply does not satisfy the wire contract", async () => {
    // Output validation is the last guard: a main-side bug that produced a
    // negative or non-wei amount must not reach the consent modal.
    previewLaunch.mockResolvedValue({
      ok: true,
      preview: { ...PREVIEW, msgValueWei: "-1" },
    });
    const result = await call(CH.tokenLaunch.preview, { sessionId: SESSION_ID, form: FORM });
    expect(isError(result)).toBe(true);
  });
});

// ── myLaunches resolves its own scope ────────────────────────────────────

describe("myLaunches", () => {
  it("reads the user's own EVM inventory server-side, on the Trench chain", async () => {
    listWallets.mockReturnValue([{ address: OWNER }, { address: `0x${"2".repeat(40)}` }]);
    listMyLaunches.mockResolvedValue([]);
    await call(CH.tokenLaunch.myLaunches, { limit: 25 });
    expect(listWallets).toHaveBeenCalledWith("evm");
    expect(listMyLaunches).toHaveBeenCalledWith([OWNER, `0x${"2".repeat(40)}`], 4663, 25);
  });

  it("returns an honest empty list when the user owns no EVM wallet", async () => {
    listWallets.mockReturnValue([]);
    const result = await call(CH.tokenLaunch.myLaunches, { limit: 25 });
    expect(result).toEqual({ ok: true, data: { launches: [] } });
    expect(listMyLaunches).not.toHaveBeenCalled();
  });

  it("a FAILED read is an error, never an empty list, and leaks no database detail", async () => {
    listWallets.mockReturnValue([{ address: OWNER }]);
    listMyLaunches.mockRejectedValue(
      new Error("connect ECONNREFUSED postgres://vex:hunter2@127.0.0.1:5432/vex"),
    );
    const result = await call(CH.tokenLaunch.myLaunches, { limit: 25 });
    const error = expectError(result, "internal.unexpected");
    expect(error.error.retryable).toBe(true);
    expect(error.error.message).not.toContain("postgres");
    expect(error.error.message).not.toContain("hunter2");
  });
});

// ── the two operations that are deliberately not built ───────────────────

describe("submit", () => {
  const SUBMIT_PAYLOAD = {
    sessionId: SESSION_ID,
    intentId: null,
    previewId: PREVIEW.previewId,
    form: FORM,
  };

  it("returns the launch with its hash and token address", async () => {
    submitLaunch.mockResolvedValue({
      ok: true,
      result: {
        intentId: "int_1",
        status: "confirmed",
        txHash: `0x${"a".repeat(64)}`,
        tokenAddress: `0x${"b".repeat(40)}`,
        msgValueWei: "11000000000000000",
        message: "Your token is live.",
      },
    });

    const result = await call(CH.tokenLaunch.submit, SUBMIT_PAYLOAD);

    expect(result).toEqual({ ok: true, data: expect.objectContaining({ status: "confirmed" }) });
    expect(submitLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, previewId: PREVIEW.previewId }),
      expect.any(Function),
    );
  });

  it("refuses a stale preview by name and keeps it retryable", async () => {
    submitLaunch.mockResolvedValue({
      ok: false,
      refusal: { kind: "preview_stale", detail: "The launch cost changed. Nothing was signed." },
    });
    const result = await call(CH.tokenLaunch.submit, SUBMIT_PAYLOAD);
    const error = expectError(result, "tokenLaunch.preview_stale");
    expect(error.error.retryable).toBe(true);
    expect(error.error.message).toContain("Nothing was signed");
  });

  it("surfaces an executor refusal verbatim and NOT as retryable", async () => {
    const detail =
      "This launch was already deployed, or its form window lapsed. Nothing was signed a second time.";
    submitLaunch.mockResolvedValue({ ok: false, refusal: { kind: "launch_refused", detail } });

    const result = await call(CH.tokenLaunch.submit, SUBMIT_PAYLOAD);

    const error = expectError(result, "internal.unexpected");
    // Retrying a lost double-submit race is how a user double-spends.
    expect(error.error.retryable).toBe(false);
    expect(error.error.message).toBe(detail);
  });

  it("refuses a locked vault without signing", async () => {
    submitLaunch.mockResolvedValue({
      ok: false,
      refusal: {
        kind: "launch_refused",
        detail: "Your wallet vault is locked, so nothing was signed. Unlock it and try again.",
      },
    });
    const result = await call(CH.tokenLaunch.submit, SUBMIT_PAYLOAD);
    const error = expectError(result, "internal.unexpected");
    expect(error.error.message).toContain("locked");
  });

  it("rejects a submit with no previewId before reaching the launch path", async () => {
    const result = await call(CH.tokenLaunch.submit, {
      sessionId: SESSION_ID,
      intentId: null,
      form: FORM,
    });
    expectError(result, "validation.invalid_input");
    expect(submitLaunch).not.toHaveBeenCalled();
  });
});

// ── Immutable on-chain metadata: rejected RAW, before any trim ───────────

/**
 * The launchpad operator's report: a control character or a double quote in
 * name, symbol, description or a link writes BROKEN metadata on-chain, and
 * `create()` makes it immutable, so the damage is permanent.
 *
 * The trap this pins is ORDERING. `tokenLaunchFormSchema` trims name, symbol
 * and description, so a LEADING or TRAILING newline used to be erased on its
 * way in and the launch proceeded with text the policy never got to see. A
 * silent repair is exactly what the reject-never-transform contract forbids:
 * `submit` can sign, and the user never reviewed the repaired string.
 */
describe("forbidden metadata characters are refused at the IPC boundary", () => {
  const FORBIDDEN_SAMPLES = [
    ["leading newline", "\nMoon"],
    ["trailing newline", "Moon\n"],
    ["interior newline", "Mo\non"],
    ["leading tab", "\tMoon"],
    ["trailing tab", "Moon\t"],
    ["double quote", 'Mo"on'],
    ["DEL", "Moon\u007F"],
  ] as const;

  for (const [label, value] of FORBIDDEN_SAMPLES) {
    for (const field of ["name", "symbol", "description"] as const) {
      it(`preview refuses a ${label} in ${field} without pricing anything`, async () => {
        const result = await call(CH.tokenLaunch.preview, {
          sessionId: SESSION_ID,
          form: { ...FORM, [field]: value },
        });
        expectError(result, "validation.invalid_input");
        expect(previewLaunch).not.toHaveBeenCalled();
      });

      it(`submit refuses a ${label} in ${field} without signing anything`, async () => {
        const result = await call(CH.tokenLaunch.submit, {
          sessionId: SESSION_ID,
          intentId: null,
          previewId: PREVIEW.previewId,
          form: { ...FORM, [field]: value },
        });
        expectError(result, "validation.invalid_input");
        expect(submitLaunch).not.toHaveBeenCalled();
      });
    }

    it(`preview refuses a ${label} in ANY link row`, async () => {
      for (const links of [
        [`https://vex.example/${value}`],
        ["https://ok.example", `https://vex.example/${value}`],
      ]) {
        const result = await call(CH.tokenLaunch.preview, {
          sessionId: SESSION_ID,
          form: { ...FORM, links },
        });
        expectError(result, "validation.invalid_input");
        expect(previewLaunch).not.toHaveBeenCalled();
      }
    });
  }

  it("still accepts ordinary text, emoji and accented letters", async () => {
    previewLaunch.mockResolvedValue({ ok: true, preview: PREVIEW });
    const result = await call(CH.tokenLaunch.preview, {
      sessionId: SESSION_ID,
      form: { ...FORM, name: "Moon Caf\u00e9 \ud83d\ude80", description: "Vex's token - it's fine" },
    });
    expect(isError(result)).toBe(false);
    expect(previewLaunch).toHaveBeenCalledTimes(1);
  });

  it("still trims ordinary surrounding whitespace rather than refusing it", async () => {
    previewLaunch.mockResolvedValue({ ok: true, preview: PREVIEW });
    await call(CH.tokenLaunch.preview, {
      sessionId: SESSION_ID,
      form: { ...FORM, name: "  Moon  " },
    });
    const input = previewLaunch.mock.calls[0]?.[0] as { form: { name: string } };
    expect(input.form.name).toBe("Moon");
  });
});

describe("cancel", () => {
  it("reports the cancellation and whether an agent turn actually resumed", async () => {
    cancelLaunch.mockResolvedValue({
      ok: true,
      result: { cancelled: true, resumedAgentTurn: true },
    });
    const result = await call(CH.tokenLaunch.cancel, {
      sessionId: SESSION_ID,
      intentId: "int_1",
    });
    expect(result).toEqual({ ok: true, data: { cancelled: true, resumedAgentTurn: true } });
  });

  it("reports an honest `cancelled: false` when nothing was live", async () => {
    cancelLaunch.mockResolvedValue({
      ok: true,
      result: { cancelled: false, resumedAgentTurn: false },
    });
    const result = await call(CH.tokenLaunch.cancel, {
      sessionId: SESSION_ID,
      intentId: "int_gone",
    });
    expect(result).toEqual({ ok: true, data: { cancelled: false, resumedAgentTurn: false } });
  });

  it("cannot be asked to cancel across sessions — the session id is required", async () => {
    const result = await call(CH.tokenLaunch.cancel, { intentId: "int_1" });
    expectError(result, "validation.invalid_input");
    expect(cancelLaunch).not.toHaveBeenCalled();
  });
});
