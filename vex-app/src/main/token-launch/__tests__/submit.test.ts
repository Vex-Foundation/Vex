/**
 * The Deploy click, main-side — the refusals that must hold before anything can
 * sign, plus the one happy path.
 *
 * Pinned here, because each of these is a way real funds move wrongly:
 *
 *  - a submit against figures the user is no longer looking at is REFUSED by
 *    name and writes NO intent row (a stale authorization is still an
 *    authorization once it exists);
 *  - the authorized row is written BEFORE the executor is called — that row is
 *    what the exactly-once CAS claims, so the order is the guard;
 *  - the row carries `origin: "user"`, `authorization_kind: "user_submit"`, its
 *    prebuy WITH decimals, and the consent snapshot;
 *  - a lost double-submit race and a locked vault are the EXECUTOR's refusals
 *    and are surfaced verbatim — paraphrasing a money refusal teaches the user
 *    the wrong thing;
 *  - an image deleted between preview and Deploy is a named, actionable refusal,
 *    not a generic outage;
 *  - a failed intent write refuses and never reaches the executor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const planLaunchContext = vi.fn();
const buildLaunchPlan = vi.fn();

vi.mock("../plan-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plan-context.js")>();
  return {
    ...actual,
    planLaunchContext: (sessionId: string, form: unknown) => planLaunchContext(sessionId, form),
    buildLaunchPlan: (input: unknown) => buildLaunchPlan(input),
  };
});

const wakeParkedAgent = vi.fn(
  async (_intentId: string, _sessionId: string, _outcome: unknown) => true,
);
vi.mock("../execute-seam.js", () => ({
  wakeParkedAgent: (intentId: string, sessionId: string, outcome: unknown) =>
    wakeParkedAgent(intentId, sessionId, outcome),
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const createWith = vi.fn();
const authorizeWith = vi.fn();
vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  createWith: (client: unknown, input: unknown) => createWith(client, input),
  authorizeWith: (
    client: unknown,
    intentId: string,
    sessionId: string,
    input: unknown,
  ) => authorizeWith(client, intentId, sessionId, input),
}));

const withSessionControlLock = vi.fn(
  async (_sessionId: string, fn: (client: unknown) => Promise<unknown>) => fn({}),
);
vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: (sessionId: string, fn: (client: unknown) => Promise<unknown>) =>
    withSessionControlLock(sessionId, fn),
}));

const { submitLaunch } = await import("../submit.js");

const SESSION_ID = "3f0d2f7a-1c2b-4b3c-8d4e-5f6a7b8c9d0e";
const OWNER = "0x1111111111111111111111111111111111111111";
// The value component MUST match the mocked plan's `preview.msgValueWei` —
// the CAS is value-anchored (block-anchored equality refused every honest
// Deploy on a ~1s-block chain; proven live 2026-08-02).
const PREVIEW_ID = "lp_100_11000000000000000";

const FORM = {
  name: "Moon",
  symbol: "MOON",
  description: "to the moon",
  links: ["https://moon.example"],
  imageId: "img_0123456789abcdef0123456789abcdef",
  prebuy: "0.01",
};

const REQUEST = {
  name: "Moon",
  symbol: "MOON",
  description: "to the moon",
  links: ["https://moon.example"],
  imageId: FORM.imageId,
  prebuyWei: 10_000_000_000_000_000n,
};

/**
 * A COMPLETE `LaunchAuthorizationBinding`, because the snapshot built from it is
 * validated field-by-field on the signing side. A partial fixture here would
 * pass these tests and refuse every real launch.
 */
const BINDING = {
  name: "Moon",
  symbol: "MOON",
  description: "to the moon",
  links: ["https://moon.example"],
  imageId: FORM.imageId,
  imageDigest: "d".repeat(64),
  chainId: 4663,
  contract: `0x${"e".repeat(40)}`,
  creationFeeWei: "1000000000000000",
  prebuyWei: "10000000000000000",
  msgValueWei: "11000000000000000",
  vexFeeWei: "27500000000000",
  anchorBlockNumber: "100",
  calldata: "0xdeadbeef",
  callFingerprint: `0x${"f".repeat(64)}`,
  sessionId: SESSION_ID,
  walletAddress: OWNER,
  permission: "full",
};

function plan(previewId = PREVIEW_ID) {
  return {
    binding: BINDING,
    preview: {
      previewId,
      chainId: 4663,
      creationFeeWei: "1000000000000000",
      prebuyWei: "10000000000000000",
      msgValueWei: "11000000000000000",
      vexFeeWei: "27500000000000",
      vexFeeCharged: true,
      estimatedNetworkFeeWei: "2025200000000000",
      anchorBlockNumber: "100",
    },
  };
}

const CONFIRMED = {
  kind: "broadcast" as const,
  status: "confirmed" as const,
  txHash: `0x${"a".repeat(64)}`,
  tokenAddress: `0x${"b".repeat(40)}`,
  message: "Your token is live.",
};

function submitInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    intentId: null,
    previewId: PREVIEW_ID,
    form: FORM,
    ...overrides,
  } as Parameters<typeof submitLaunch>[0];
}

beforeEach(() => {
  planLaunchContext.mockResolvedValue({
    ok: true,
    request: REQUEST,
    walletAddress: OWNER,
    permission: "full",
    publicClient: {},
    planFeeLeg: () => null,
    nativeAddress: "0x0000000000000000000000000000000000000000",
  });
  buildLaunchPlan.mockResolvedValue({ ok: true, plan: plan() });
  createWith.mockResolvedValue({ intentId: "written" });
  authorizeWith.mockResolvedValue({ intentId: "drafted", origin: "agent_requested_form" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the preview CAS", () => {
  it("refuses a submit whose consented FIGURE no longer re-derives, and writes NO row", async () => {
    const moved = plan("lp_205_1500000000000000");
    (moved.preview as { msgValueWei: string }).msgValueWei = "1500000000000000";
    buildLaunchPlan.mockResolvedValue({ ok: true, plan: moved });
    const executor = vi.fn();

    const outcome = await submitLaunch(submitInput(), executor);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.kind).toBe("preview_stale");
    expect(outcome.refusal.detail).toContain("Nothing was signed");
    expect(outcome.refusal.detail.toLowerCase()).toContain("preview the launch again");
    // The critical half: no authorization exists to be consumed later.
    expect(createWith).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });

  it("proceeds when the previewId still re-derives", async () => {
    const executor = vi.fn().mockResolvedValue(CONFIRMED);
    const outcome = await submitLaunch(submitInput(), executor);
    expect(outcome.ok).toBe(true);
    expect(createWith).toHaveBeenCalledOnce();
  });

  it("proceeds when only the ANCHOR BLOCK moved and the figure is identical — the live regression", async () => {
    // Two derivations five blocks apart with the same fee refused every honest
    // Deploy under literal id equality (funded UI-path probe, 2026-08-02).
    const executor = vi.fn().mockResolvedValue(CONFIRMED);
    buildLaunchPlan.mockResolvedValue({ ok: true, plan: plan("lp_205_11000000000000000") });
    const outcome = await submitLaunch(submitInput(), executor);
    expect(outcome.ok).toBe(true);
  });
});

describe("the authorized intent row", () => {
  it("is written before the executor runs", async () => {
    const order: string[] = [];
    createWith.mockImplementation(async () => {
      order.push("write");
      return {};
    });
    const executor = vi.fn().mockImplementation(async () => {
      order.push("execute");
      return CONFIRMED;
    });

    await submitLaunch(submitInput(), executor);

    expect(order).toEqual(["write", "execute"]);
  });

  it("records a user-origin, user_submit authorization with the prebuy AND its decimals", async () => {
    await submitLaunch(submitInput(), vi.fn().mockResolvedValue(CONFIRMED));

    const written = createWith.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(written.origin).toBe("user");
    expect(written.status).toBe("authorized");
    expect(written.authorizationKind).toBe("user_submit");
    expect(written.authorizationId).toEqual(expect.any(String));
    expect(written.chainId).toBe(4663);
    expect(written.walletAddress).toBe(OWNER);
    expect(written.imageId).toBe(FORM.imageId);
    // A raw amount without its decimals is unreadable (rule 90).
    expect(written.prebuyRaw).toBe("10000000000000000");
    expect(written.prebuyDecimals).toBe(18);
  });

  it("carries the consent snapshot, including what the user was SHOWN", async () => {
    await submitLaunch(submitInput(), vi.fn().mockResolvedValue(CONFIRMED));

    const written = createWith.mock.calls[0]?.[1] as Record<string, unknown>;
    const snapshot = written.authorizationJson as Record<string, unknown>;
    expect(snapshot.kind).toBe("user_submit");
    // The binding lives at the TOP LEVEL — the validator on the signing side
    // reads it there, and a nested copy would refuse every launch.
    expect(snapshot.msgValueWei).toBe("11000000000000000");
    expect(snapshot.previewId).toBe(PREVIEW_ID);
    const shown = snapshot.shown as Record<string, unknown>;
    // The Vex fee is part of what was consented to — a snapshot that omitted it
    // could not answer "was the user told about the fee?" months later.
    expect(shown.msgValueWei).toBe("11000000000000000");
    expect(shown.vexFeeWei).toBe("27500000000000");
    expect(shown.imageDigest).toBe("d".repeat(64));
  });

  it("is written under the session control lock", async () => {
    await submitLaunch(submitInput(), vi.fn().mockResolvedValue(CONFIRMED));
    expect(withSessionControlLock).toHaveBeenCalledWith(SESSION_ID, expect.any(Function));
  });

  /**
   * SUPERSEDED BEHAVIOUR, pinned as its inverse.
   *
   * This case previously asserted that an agent-supplied `intentId` was passed
   * to `createWith` — i.e. that a SECOND, `user`-origin row was inserted under
   * the agent's intent id. That is the §C3b defect: the drafted
   * `awaiting_user_form` row carries the parked `tool_call_id`, and inserting
   * alongside it leaves the agent's turn waiting on an intent nothing ever
   * authorizes. The create path is now reached ONLY when there is no drafted
   * row; the authorize-existing path is covered in its own block below.
   */
  it("only ever CREATES for a user-origin launch — an agent draft is authorized in place", async () => {
    await submitLaunch(
      submitInput({ intentId: "int_from_agent_form" }),
      vi.fn().mockResolvedValue(CONFIRMED),
    );
    expect(createWith).not.toHaveBeenCalled();
  });
});

describe("failures on the way to the executor", () => {
  it("names a vanished image instead of reporting a generic outage", async () => {
    const missing = new Error("image gone");
    missing.name = "LaunchImageMissingError";
    createWith.mockRejectedValue(missing);
    const executor = vi.fn();

    const outcome = await submitLaunch(submitInput(), executor);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.kind).toBe("image_not_found");
    expect(outcome.refusal.detail).toContain("Nothing was signed");
    expect(executor).not.toHaveBeenCalled();
  });

  it("refuses without reaching the executor when the intent cannot be recorded", async () => {
    createWith.mockRejectedValue(new Error("connect ECONNREFUSED postgres://vex:hunter2@db"));
    const executor = vi.fn();

    const outcome = await submitLaunch(submitInput(), executor);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.detail).not.toContain("hunter2");
    expect(outcome.refusal.detail).toContain("did not sign");
    expect(executor).not.toHaveBeenCalled();
  });

  it("refuses when the plan itself refuses, and writes no row", async () => {
    buildLaunchPlan.mockResolvedValue({
      ok: false,
      code: "insufficient_native_balance",
      reason: "This wallet cannot cover the launch.",
    });
    const outcome = await submitLaunch(submitInput(), vi.fn());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.kind).toBe("insufficient_funds");
    expect(createWith).not.toHaveBeenCalled();
  });

  it("refuses when the session has no wallet, and writes no row", async () => {
    planLaunchContext.mockResolvedValue({
      ok: false,
      refusal: { kind: "no_wallet", detail: "No EVM wallet is selected." },
    });
    const outcome = await submitLaunch(submitInput(), vi.fn());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.kind).toBe("no_wallet");
    expect(createWith).not.toHaveBeenCalled();
  });
});

describe("the executor's outcome is reported, never reinterpreted", () => {
  it("returns the confirmed launch with its hash and token", async () => {
    const outcome = await submitLaunch(submitInput(), vi.fn().mockResolvedValue(CONFIRMED));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.result.status).toBe("confirmed");
    expect(outcome.result.txHash).toBe(CONFIRMED.txHash);
    expect(outcome.result.tokenAddress).toBe(CONFIRMED.tokenAddress);
    expect(outcome.result.msgValueWei).toBe("11000000000000000");
    expect(outcome.result.intentId).toEqual(expect.any(String));
  });

  it.each([
    [
      "a lost double-submit race",
      "This launch was already deployed, or its form window lapsed. Nothing was signed a second time.",
    ],
    ["a locked vault", "Your wallet vault is locked, so nothing was signed. Unlock it."],
    ["authorization drift", "The creation fee moved since you confirmed. Nothing was signed."],
  ])("surfaces %s verbatim as a refusal, NOT as a reverted launch", async (_name, message) => {
    const outcome = await submitLaunch(
      submitInput(),
      vi.fn().mockResolvedValue({ kind: "refused", message }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.kind).toBe("launch_refused");
    // Verbatim: the executor knows what it refused; this layer does not.
    expect(outcome.refusal.detail).toBe(message);
  });

  it("wakes a parked agent with `failed` when the executor refused", async () => {
    await submitLaunch(
      submitInput(),
      vi.fn().mockResolvedValue({ kind: "refused", message: "Nothing was signed." }),
    );
    expect(wakeParkedAgent).toHaveBeenCalledWith(expect.any(String), SESSION_ID, {
      kind: "failed",
      reason: "Nothing was signed.",
    });
  });

  it("wakes a parked agent with `launched` and the real hash on success", async () => {
    await submitLaunch(submitInput(), vi.fn().mockResolvedValue(CONFIRMED));
    expect(wakeParkedAgent).toHaveBeenCalledWith(expect.any(String), SESSION_ID, {
      kind: "launched",
      txHash: CONFIRMED.txHash,
      tokenAddress: CONFIRMED.tokenAddress,
    });
  });

  it("reports an AMBIGUOUS broadcast as pending, never as a failure to retry", async () => {
    const outcome = await submitLaunch(
      submitInput(),
      vi.fn().mockResolvedValue({
        kind: "broadcast",
        status: "pending",
        txHash: `0x${"c".repeat(64)}`,
        tokenAddress: null,
        message: "The launch was broadcast but has not settled. Do not resubmit.",
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.result.status).toBe("pending");
    expect(outcome.result.txHash).not.toBeNull();
  });
});

// ── the integration check the signing side asked for ─────────────────────

describe("the consent snapshot round-trips through the signing side's validator", () => {
  it("is accepted by parseStoredBinding exactly as written", async () => {
    // THE CONTRACT BETWEEN TWO PROCESSES. This writer produces the blob; the
    // executor validates it before it will sign anything. If they disagree about
    // shape, every launch refuses with "the authorization recorded when you
    // submitted this launch is incomplete" — and no test of either side alone
    // would show it. This is that test.
    const { parseStoredBinding } = await import(
      "@vex-agent/tools/protocols/trench/handlers/launch/execute-user-submit.js"
    );

    await submitLaunch(submitInput(), vi.fn().mockResolvedValue(CONFIRMED));
    const written = createWith.mock.calls[0]?.[1] as Record<string, unknown>;

    // Through JSON, as JSONB storage would carry it — not the in-memory object.
    const roundTripped: unknown = JSON.parse(JSON.stringify(written.authorizationJson));
    const parsed = parseStoredBinding(roundTripped);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.binding.msgValueWei).toBe(BINDING.msgValueWei);
    expect(parsed.binding.imageDigest).toBe(BINDING.imageDigest);
    expect(parsed.binding.callFingerprint).toBe(BINDING.callFingerprint);
    expect([...parsed.binding.links]).toEqual(BINDING.links);
  });

  it("agrees with the intent row's own columns, which the executor cross-checks", async () => {
    await submitLaunch(submitInput(), vi.fn().mockResolvedValue(CONFIRMED));
    const written = createWith.mock.calls[0]?.[1] as Record<string, unknown>;
    const snapshot = written.authorizationJson as Record<string, unknown>;

    // `checkRecordAgreesWithRow` refuses on any of these disagreeing.
    expect(snapshot.name).toBe(written.name);
    expect(snapshot.symbol).toBe(written.symbol);
    expect(snapshot.imageId).toBe(written.imageId);
    expect(snapshot.prebuyWei).toBe(written.prebuyRaw);
    expect(snapshot.sessionId).toBe(written.sessionId);
    expect(snapshot.walletAddress).toBe(written.walletAddress);
    expect(snapshot.chainId).toBe(written.chainId);
  });
});

/**
 * §C3b — the agent asked, the user deployed.
 *
 * The row ALREADY EXISTS at `awaiting_user_form`, drafted by
 * `trench.launch_request_form`, carrying the parked `tool_call_id` and
 * `origin: 'agent_requested_form'`. Creating a second row here is the defect
 * these tests exist to prevent: the agent's turn would stay parked against an
 * intent nobody ever authorizes, the wake would answer nothing, and the DB
 * would hold two live intents for one launch.
 */
describe("an agent-requested intent authorizes the EXISTING row", () => {
  const DRAFTED_INTENT = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

  it("calls authorizeWith on the drafted row and NEVER createWith", async () => {
    const executor = vi.fn().mockResolvedValue(CONFIRMED);

    const outcome = await submitLaunch(
      submitInput({ intentId: DRAFTED_INTENT }),
      executor,
    );

    expect(outcome.ok).toBe(true);
    // THE PIN. A create here would orphan the agent's parked call.
    expect(createWith).not.toHaveBeenCalled();
    expect(authorizeWith).toHaveBeenCalledOnce();

    const [, intentId, sessionId] = authorizeWith.mock.calls[0] ?? [];
    expect(intentId).toBe(DRAFTED_INTENT);
    expect(sessionId).toBe(SESSION_ID);
  });

  it("preserves origin by never passing one — authorizeWith cannot rewrite it", async () => {
    const executor = vi.fn().mockResolvedValue(CONFIRMED);

    await submitLaunch(submitInput({ intentId: DRAFTED_INTENT }), executor);

    const input = authorizeWith.mock.calls[0]?.[3] as Record<string, unknown>;
    // The writer's input has no `origin` and no `toolCallId` field at all, so
    // `agent_requested_form` and the parked call survive by construction. A
    // regression that reintroduced them would land here.
    expect(input).not.toHaveProperty("origin");
    expect(input).not.toHaveProperty("toolCallId");
  });

  /**
   * THE EDITED-FORM ROUND TRIP.
   *
   * The dialog opens the agent's draft with every field editable. The consent
   * snapshot is built from the SUBMITTED values, and `execute-user-submit.ts`
   * cross-checks that snapshot against the intent row's own columns before
   * signing — so if authorize left the row on the agent's original name, an
   * edited launch would REFUSE at the gate rather than deploy.
   */
  it("writes the USER'S final values to the row, not the agent's draft", async () => {
    const executor = vi.fn().mockResolvedValue(CONFIRMED);

    await submitLaunch(submitInput({ intentId: DRAFTED_INTENT }), executor);

    const input = authorizeWith.mock.calls[0]?.[3] as Record<string, unknown>;
    // `REQUEST` is what `planLaunchContext` resolved from the submitted form.
    expect(input.name).toBe(REQUEST.name);
    expect(input.symbol).toBe(REQUEST.symbol);
    expect(input.description).toBe(REQUEST.description);
    expect(input.links).toEqual({ urls: REQUEST.links });
    expect(input.imageId).toBe(REQUEST.imageId);
  });

  it("keeps the row and the consent record describing the SAME token", async () => {
    const executor = vi.fn().mockResolvedValue(CONFIRMED);

    await submitLaunch(submitInput({ intentId: DRAFTED_INTENT }), executor);

    const input = authorizeWith.mock.calls[0]?.[3] as Record<string, unknown>;
    const snapshot = input.authorizationJson as Record<string, unknown>;
    // This equality IS the pre-sign cross-check, asserted at the write instead
    // of discovered at the gate.
    expect(input.name).toBe(snapshot.name);
    expect(input.symbol).toBe(snapshot.symbol);
    expect(input.imageId).toBe(snapshot.imageId);
    expect(input.prebuyRaw).toBe(snapshot.prebuyWei);
  });

  it("persists the SAME user_submit consent snapshot the create path writes", async () => {
    const executor = vi.fn().mockResolvedValue(CONFIRMED);

    await submitLaunch(submitInput({ intentId: DRAFTED_INTENT }), executor);

    const input = authorizeWith.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(input.authorizationKind).toBe("user_submit");
    // Raw amount + its decimals, together and always (rule 90).
    expect(input.prebuyRaw).toBe("10000000000000000");
    expect(input.prebuyDecimals).toBe(18);

    const snapshot = input.authorizationJson as Record<string, unknown>;
    // The binding must be spread at the TOP level — nested, `parseStoredBinding`
    // reads it as "no authorization was stored" and every launch refuses.
    expect(snapshot.callFingerprint).toBe(BINDING.callFingerprint);
    expect(snapshot.imageDigest).toBe(BINDING.imageDigest);
    expect(snapshot.kind).toBe("user_submit");
    expect(snapshot.previewId).toBe(PREVIEW_ID);
  });

  it("executes against the DRAFTED intent id, not a freshly minted one", async () => {
    const executor = vi.fn().mockResolvedValue(CONFIRMED);

    const outcome = await submitLaunch(
      submitInput({ intentId: DRAFTED_INTENT }),
      executor,
    );

    expect(executor).toHaveBeenCalledWith({
      intentId: DRAFTED_INTENT,
      sessionId: SESSION_ID,
    });
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.result.intentId).toBe(DRAFTED_INTENT);
    // And the parked turn is woken against that same row.
    expect(wakeParkedAgent).toHaveBeenCalledWith(
      DRAFTED_INTENT,
      SESSION_ID,
      expect.objectContaining({ kind: "launched" }),
    );
  });

  it("refuses without signing when the CAS misses — a lapsed or already-answered form", async () => {
    // `null` is the repo's "race lost" signal: the predicate requires
    // `awaiting_user_form` AND an unexpired window.
    authorizeWith.mockResolvedValue(null);
    const executor = vi.fn();

    const outcome = await submitLaunch(
      submitInput({ intentId: DRAFTED_INTENT }),
      executor,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.kind).toBe("launch_refused");
    expect(outcome.refusal.detail).toContain("no longer open");
    expect(outcome.refusal.detail).toContain("Nothing was signed");
    // The half that matters: nothing was signed and no turn was woken with a
    // fabricated outcome.
    expect(executor).not.toHaveBeenCalled();
    expect(wakeParkedAgent).not.toHaveBeenCalled();
  });

  it("reports a vanished image as the named, actionable refusal", async () => {
    const missing = new Error("image gone");
    missing.name = "LaunchImageMissingError";
    authorizeWith.mockRejectedValue(missing);
    const executor = vi.fn();

    const outcome = await submitLaunch(
      submitInput({ intentId: DRAFTED_INTENT }),
      executor,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.kind).toBe("image_not_found");
    expect(executor).not.toHaveBeenCalled();
  });
});
