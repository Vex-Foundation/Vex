/**
 * THE SEAM THE previewId CROSSES — priced by the real builder, checked by the
 * real submit, with NO hand-written id string anywhere in this file.
 *
 * WHY IT EXISTS. `launchPreviewId` mints `lp_<anchorBlock>_<creationFeeWei>` and
 * `submitLaunch` reads that payload back to decide whether the launch may be
 * authorized. Those are two modules in two packages, and until this suite they
 * were only ever tested apart: `launch-plan.test.ts` asserted a FEE-shaped mint
 * while `submit.test.ts` hand-wrote a TOTAL-shaped fixture, and both suites were
 * green while the shipping build hard-blocked every launch with a nonzero prebuy
 * (2026-08-06). A fixture cannot disagree with a producer it never meets.
 *
 * So the id here is always the one the REAL `buildLaunchPlan` minted, reached
 * through the REAL `previewLaunch`, and fed to the REAL `submitLaunch`. The
 * mocked seams are the ones that would otherwise need a database, a session, a
 * chain or a signature: `planLaunchContext`, the intent repository, the session
 * control lock, the agent wake and the executor. The money derivation itself,
 * from the anchored fee read to the value gate, runs for real on both sides.
 *
 * THE PREBUY IS ASSERTED NONZERO in the regression cases. Without that assertion
 * a form that silently priced at zero prebuy would make this suite pass while
 * reproducing nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEther, toHex } from "viem";

import {
  registerLaunchImageByteResolver,
  registerLaunchImageOnchainByteResolver,
  resetLaunchImageByteResolver,
  resetLaunchImageOnchainByteResolver,
} from "@vex-agent/tools/protocols/shared/launch-image-byte-resolver.js";
import {
  TRENCH_CREATION_FEE_FIXTURE,
  TRENCH_CREATION_FEE_SLOT,
} from "@tools/trench-express/evm/creation-fee.js";
import type { TokenLaunchForm } from "@shared/schemas/token-launch.js";

const SESSION_ID = "3f0d2f7a-1c2b-4b3c-8d4e-5f6a7b8c9d0e";
const OWNER = "0x33eF000000000000000000000000000000000001";
const IMAGE_ID = "img_0123456789abcdef0123456789abcdef";
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

/**
 * The chain, mutable between the preview and the submit.
 *
 * `feeWord` is the raw storage word the fee reader decodes, so moving it moves
 * the creation fee exactly the way the launchpad would: through the anchored
 * read, not by editing a plan object.
 */
let feeWord: `0x${string}` = TRENCH_CREATION_FEE_FIXTURE.rawWord;
let anchorBlockNumber = 29_489_845n;

const publicClient = {
  async getBlockNumber() {
    return anchorBlockNumber;
  },
  async getStorageAt(args: { slot: string }) {
    return args.slot.toLowerCase() === TRENCH_CREATION_FEE_SLOT.toLowerCase()
      ? feeWord
      : undefined;
  },
  async estimateGas() {
    return 2_000_000n;
  },
  async getGasPrice() {
    return 20_000_000n;
  },
  async getBalance() {
    return 10n ** 20n;
  },
};

/**
 * The one mocked seam on the plan side: session lookup and wallet scope.
 *
 * `buildLaunchPlan` is deliberately NOT mocked here — it is the module under
 * test on the other end of the seam.
 */
const planLaunchContext = vi.fn();
vi.mock("../plan-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plan-context.js")>();
  return {
    ...actual,
    planLaunchContext: (sessionId: string, form: unknown) => planLaunchContext(sessionId, form),
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
  authorizeWith: (client: unknown, intentId: string, sessionId: string, input: unknown) =>
    authorizeWith(client, intentId, sessionId, input),
  getAwaitingForSession: vi.fn(async () => []),
  listUnsettledForWallets: vi.fn(async () => []),
}));

vi.mock("@vex-agent/db/repos/launched-tokens.js", () => ({
  listForWallets: vi.fn(async () => []),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: (_sessionId: string, fn: (client: unknown) => Promise<unknown>) => fn({}),
}));

const { previewLaunch, submitLaunch } = await import("../index.js");

const CONFIRMED = {
  kind: "broadcast" as const,
  status: "confirmed" as const,
  txHash: `0x${"a".repeat(64)}`,
  tokenAddress: `0x${"b".repeat(40)}`,
  message: "Your token is live.",
};

function formWithPrebuy(prebuy: string): TokenLaunchForm {
  return {
    name: "Moon",
    symbol: "MOON",
    description: "to the moon",
    links: ["https://moon.example"],
    imageId: IMAGE_ID,
    prebuy,
  } as TokenLaunchForm;
}

/**
 * Price a launch through the production preview path and hand back its id.
 *
 * The id is READ OFF the preview result, never constructed here. That is the
 * whole point of the suite: if the mint's shape changes, these tests follow it
 * automatically and the guard is what has to keep up.
 */
async function previewedLaunch(form: TokenLaunchForm) {
  const outcome = await previewLaunch({ sessionId: SESSION_ID, form });
  if (!outcome.ok) throw new Error(`preview refused: ${outcome.refusal.detail}`);
  return outcome.preview;
}

beforeEach(() => {
  feeWord = TRENCH_CREATION_FEE_FIXTURE.rawWord;
  anchorBlockNumber = 29_489_845n;
  registerLaunchImageByteResolver(async () => ({
    bytes: IMAGE_BYTES,
    digest: "d".repeat(64),
  }));
  // The Trench path consumes the ON-CHAIN copy since the per-lane image split.
  // For a locker image already inside the budget the two seams hand back the
  // same bytes and the same digest, which is what this fixture states.
  registerLaunchImageOnchainByteResolver(async () => ({
    kind: "resolved",
    bytes: IMAGE_BYTES,
    digest: "d".repeat(64),
  }));
  planLaunchContext.mockImplementation(async (_sessionId: string, form: TokenLaunchForm) => ({
    ok: true,
    request: {
      name: form.name,
      symbol: form.symbol,
      description: form.description ?? null,
      links: form.links ?? [],
      imageId: form.imageId,
      prebuyWei: parseEther(form.prebuy),
    },
    walletAddress: OWNER,
    permission: "full",
    publicClient,
    planFeeLeg: () => null,
    nativeAddress: "0x0000000000000000000000000000000000000000",
  }));
  createWith.mockResolvedValue({ intentId: "written" });
  authorizeWith.mockResolvedValue({ intentId: "drafted", origin: "agent_requested_form" });
});

afterEach(() => {
  resetLaunchImageByteResolver();
  resetLaunchImageOnchainByteResolver();
  vi.clearAllMocks();
});

describe("a previewId minted by the real plan builder is accepted by the real submit", () => {
  it("accepts a launch with a NONZERO PREBUY — the 2026-08-06 hard block", async () => {
    const form = formWithPrebuy("0.0005");
    const preview = await previewedLaunch(form);

    // The reproduction's own precondition: the prebuy is really in the total,
    // and the id therefore really does differ from it.
    expect(BigInt(preview.prebuyWei)).toBeGreaterThan(0n);
    expect(preview.msgValueWei).not.toBe(preview.creationFeeWei);
    expect(preview.previewId).toBe(`lp_${anchorBlockNumber}_${preview.creationFeeWei}`);

    const executor = vi.fn().mockResolvedValue(CONFIRMED);
    const outcome = await submitLaunch(
      { sessionId: SESSION_ID, intentId: null, previewId: preview.previewId, form },
      executor,
    );

    expect(outcome.ok).toBe(true);
    expect(createWith).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledOnce();
  });

  it("accepts a launch with NO prebuy", async () => {
    const form = formWithPrebuy("0");
    const preview = await previewedLaunch(form);
    expect(preview.msgValueWei).toBe(preview.creationFeeWei);

    const executor = vi.fn().mockResolvedValue(CONFIRMED);
    const outcome = await submitLaunch(
      { sessionId: SESSION_ID, intentId: null, previewId: preview.previewId, form },
      executor,
    );

    expect(outcome.ok).toBe(true);
    expect(createWith).toHaveBeenCalledOnce();
  });

  it("accepts the agent-requested form route, which authorizes the drafted row", async () => {
    const form = formWithPrebuy("0.0005");
    const preview = await previewedLaunch(form);
    const executor = vi.fn().mockResolvedValue(CONFIRMED);

    const outcome = await submitLaunch(
      {
        sessionId: SESSION_ID,
        intentId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        previewId: preview.previewId,
        form,
      },
      executor,
    );

    expect(outcome.ok).toBe(true);
    expect(authorizeWith).toHaveBeenCalledOnce();
    expect(createWith).not.toHaveBeenCalled();
  });

  it("still accepts when only the ANCHOR BLOCK advanced — the block is provenance", async () => {
    const form = formWithPrebuy("0.0005");
    const preview = await previewedLaunch(form);
    anchorBlockNumber += 5n;

    const outcome = await submitLaunch(
      { sessionId: SESSION_ID, intentId: null, previewId: preview.previewId, form },
      vi.fn().mockResolvedValue(CONFIRMED),
    );

    expect(outcome.ok).toBe(true);
  });
});

describe("a creation fee that moved between preview and Deploy still refuses", () => {
  it("refuses BEFORE any intent row is written, naming both figures", async () => {
    const form = formWithPrebuy("0.0005");
    const preview = await previewedLaunch(form);

    // The launchpad repriced: 0.001 ETH -> 0.002 ETH, through the anchored
    // storage read, exactly as a real reprice would reach us.
    const movedFeeWei = 2_000_000_000_000_000n;
    feeWord = toHex(movedFeeWei, { size: 32 });

    const executor = vi.fn();
    const outcome = await submitLaunch(
      { sessionId: SESSION_ID, intentId: null, previewId: preview.previewId, form },
      executor,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.kind).toBe("preview_stale");
    expect(outcome.refusal.detail).toContain(movedFeeWei.toString());
    expect(outcome.refusal.detail).toContain(preview.creationFeeWei);
    expect(outcome.refusal.detail).toContain("Nothing was signed");
    // The half that matters: no authorization exists for anything to consume.
    expect(createWith).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });

  it("refuses an unreadable preview id without writing a row", async () => {
    const executor = vi.fn();
    const outcome = await submitLaunch(
      {
        sessionId: SESSION_ID,
        intentId: null,
        previewId: "not-a-preview-id",
        form: formWithPrebuy("0.0005"),
      },
      executor,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.kind).toBe("preview_stale");
    expect(createWith).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });
});
