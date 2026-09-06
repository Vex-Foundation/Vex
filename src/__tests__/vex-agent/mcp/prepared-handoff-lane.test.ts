/**
 * WHO BROADCASTS a prepared transfer, per lane (live-test pass 2, finding I-1).
 *
 * `WalletSendPrepare` answered every caller with "Transfer prepared; Vex will
 * confirm it automatically." That is true of the IN-APP lane only, where the
 * turn loop reads the result's `preparedActionFollowUp` and dispatches
 * `WalletSendConfirm` itself
 * (`engine/core/turn-loop-tool-batch/prepared-follow-up.ts`). The MCP lane has
 * no turn loop and no other consumer of that field, so an external agent that
 * believed the sentence waited for a dispatch that was never coming.
 *
 * The two assertions that matter are here together, because the defect was the
 * GAP between them: the message the MCP caller reads, and the absence of any
 * handoff object behind it. The in-app case is asserted in the same file so a
 * change that "fixes" one lane by breaking the other fails here.
 *
 * The database is faked: this is a contract test over the result a lane
 * produces, not over the intent row, and the row's own repository has its own
 * suite.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const WALLET = { id: "wallet-1", address: "0x1111111111111111111111111111111111111111" };

const createWith = vi.fn();
const getById = vi.fn();

vi.mock("@vex-agent/db/repos/wallet-intents.js", () => ({
  createWith: (...args: readonly unknown[]) => createWith(...args),
  getById: (...args: readonly unknown[]) => getById(...args),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: async <T>(_sessionId: string, fn: (client: unknown) => Promise<T>) =>
    fn({}),
}));

// The wallet INVENTORY is real config on disk; the selected entry is faked so
// the resolution succeeds without one. Same seam `project-context.test.ts`
// uses, and the resolver itself stays real.
vi.mock("@tools/wallet/inventory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tools/wallet/inventory.js")>();
  return {
    ...actual,
    getWalletById: (family: string, id: string) =>
      family === "evm" && id === WALLET.id
        ? { id: WALLET.id, address: WALLET.address, label: "test" }
        : null,
  };
});

const { handleWalletSendPrepare } = await import(
  "@vex-agent/tools/internal/wallet/send/prepare.js"
);
const { buildProjectToolContext } = await import("@vex-agent/mcp/project-context.js");
const { executeStudioTool } = await import("@vex-agent/mcp/executor.js");
const { projectScopeSchema } = await import("@vex-agent/mcp/project-scope.js");

type InternalToolContext = import("@vex-agent/tools/internal/types.js").InternalToolContext;

const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const SEND_PARAMS = {
  walletFamily: "eip155",
  chain: "base",
  to: "0x2222222222222222222222222222222222222222",
  amountIn: "0.01",
} as const;

function mcpScope(permission: "restricted" | "full" = "restricted") {
  return projectScopeSchema.parse({
    projectId: "66666666-6666-4666-8666-666666666666",
    scopeVersion: 3,
    permission,
    backingSessionId: SESSION_ID,
    wallets: { evm: WALLET, solana: null },
  });
}

/** The MCP lane's own context, built by the ONE builder that surface uses. */
function mcpContext(permission: "restricted" | "full" = "restricted"): InternalToolContext {
  return buildProjectToolContext(mcpScope(permission));
}

/**
 * The in-app lane's context, which is the MCP one with the lane field taken
 * off. Deriving it that way keeps the two cases identical in everything except
 * the field under test.
 */
function inAppContext(): InternalToolContext {
  const { toolLane: _lane, ...rest } = mcpContext();
  return rest;
}

beforeEach(() => {
  vi.clearAllMocks();
  createWith.mockResolvedValue(undefined);
  getById.mockResolvedValue(null);
});

describe("a prepared transfer names its own broadcaster", () => {
  it("over MCP names the confirm call, its intentId and the card, and hands off to nobody", async () => {
    const context = mcpContext();
    expect(context.toolLane).toBe("mcp");

    const result = await handleWalletSendPrepare({ ...SEND_PARAMS }, context);

    expect(result.success).toBe(true);
    const data = result.data as { intentId: string; message: string; status: string };
    expect(data.status).toBe("prepared");
    expect(data.message).toBe(
      `Transfer prepared: call WalletSendConfirm with intentId ${data.intentId} within 10 minutes `
      + "to broadcast; the approval card is raised there.",
    );
    // The defect in one line: nothing on this lane dispatches a follow-up, so
    // the result carries none. A regression that re-attaches it would put a
    // handoff on a surface with no dispatcher behind it.
    expect(result.preparedActionFollowUp).toBeUndefined();
    // And the sentence must not be the in-app promise.
    expect(data.message).not.toContain("Vex will confirm it automatically");
  });

  /**
   * The Codex-final-review defect: the MCP sentence promised "the approval card
   * is raised there" to EVERY caller, but the confirm gate is restricted-only
   * (`internal/wallet/send/confirm.ts`: the pendingApproval branch is entered
   * only when `!context.approved && context.sessionPermission === "restricted"`).
   * In a full-permission project the very next call signs and broadcasts real
   * funds with no human in the loop, and the sentence said a human would see a
   * card first. Rule 90: never overstate the safety of a money path.
   *
   * Both permissions are asserted in one place because the defect was the GAP
   * between them, and the confirm-side gate is asserted here too so a change
   * that moves the gate without moving the sentence fails.
   */
  it("under full permission says confirm broadcasts immediately, with no card", async () => {
    const context = mcpContext("full");
    expect(context.sessionPermission).toBe("full");
    expect(context.approved).not.toBe(true);

    const result = await handleWalletSendPrepare({ ...SEND_PARAMS }, context);

    expect(result.success).toBe(true);
    const data = result.data as { intentId: string; message: string };
    expect(data.message).toBe(
      `Transfer prepared: call WalletSendConfirm with intentId ${data.intentId} within 10 minutes `
      + "to broadcast; this project has full permission, so confirm broadcasts immediately and "
      + "no approval card is raised.",
    );
    // The claim the old sentence made and this project cannot keep.
    expect(data.message).not.toContain("approval card is raised there");
    expect(result.preparedActionFollowUp).toBeUndefined();
  });

  it("the confirm gate the sentence describes really is restricted-only", async () => {
    // The evidence behind the two sentences above, driven through the REAL
    // confirm handler over the row prepare actually wrote: an unapproved
    // restricted context is held for approval; an unapproved FULL context is
    // not - it walks straight past the gate. If that ever flips, one of the two
    // messages above becomes a lie, and this test names which.
    //
    // The full-permission context is given NO evm wallet so the run stops at
    // `resolveSigningWallet`, immediately after the gate: enough to prove the
    // gate was passed, without a key decrypt or a broadcast in a unit test.
    const { handleWalletSendConfirm } = await import(
      "@vex-agent/tools/internal/wallet/send/confirm.js"
    );

    const prepared = await handleWalletSendPrepare({ ...SEND_PARAMS }, mcpContext());
    const { intentId } = prepared.data as { intentId: string };
    const [, row] = createWith.mock.calls[0] as [unknown, Record<string, unknown>];
    getById.mockResolvedValue({ ...row, status: "pending" });

    const restricted = await handleWalletSendConfirm(
      { walletFamily: "eip155", intentId },
      mcpContext(),
    );
    expect(restricted.pendingApproval).toBe(true);
    expect(restricted.success).toBe(false);

    const full = await handleWalletSendConfirm(
      { walletFamily: "eip155", intentId },
      buildProjectToolContext(
        projectScopeSchema.parse({
          projectId: "66666666-6666-4666-8666-666666666666",
          scopeVersion: 3,
          permission: "full",
          backingSessionId: SESSION_ID,
          wallets: { evm: null, solana: null },
        }),
      ),
    );
    expect(full.pendingApproval).not.toBe(true);
  });

  it("in the app keeps the automatic follow-up and the sentence that describes it", async () => {
    const result = await handleWalletSendPrepare({ ...SEND_PARAMS }, inAppContext());

    expect(result.success).toBe(true);
    const data = result.data as { intentId: string; message: string };
    expect(data.message).toBe("Transfer prepared; Vex will confirm it automatically.");
    expect(result.preparedActionFollowUp).toMatchObject({
      toolName: "WalletSendConfirm",
      args: { walletFamily: "eip155", intentId: data.intentId },
    });
  });

  it("says the same thing through the real MCP entry point", async () => {
    // The handler cases above build the lane's context directly. This one goes
    // through `executeStudioTool`, so the lane field is proven to survive the
    // path an external client actually takes: scope -> context -> admission ->
    // dispatch.
    const { result } = await executeStudioTool(mcpScope(), {
      name: "WalletSendPrepare",
      args: { ...SEND_PARAMS },
      toolCallId: "call-WalletSendPrepare",
    });

    expect(result.success).toBe(true);
    const data = result.data as { intentId: string; message: string };
    expect(data.message).toContain(`call WalletSendConfirm with intentId ${data.intentId}`);
    expect(result.preparedActionFollowUp).toBeUndefined();
  });

  it("records the same intent either way, so the lane changes only what is said", async () => {
    await handleWalletSendPrepare({ ...SEND_PARAMS }, mcpContext());
    await handleWalletSendPrepare({ ...SEND_PARAMS }, inAppContext());

    expect(createWith).toHaveBeenCalledTimes(2);
    const [, mcpRow] = createWith.mock.calls[0] as [unknown, Record<string, unknown>];
    const [, inAppRow] = createWith.mock.calls[1] as [unknown, Record<string, unknown>];
    for (const key of ["sessionId", "walletAddress", "network", "chainAlias", "toAddress", "amount"]) {
      expect(mcpRow[key]).toEqual(inAppRow[key]);
    }
    expect(mcpRow["walletAddress"]).toBe(WALLET.address);
  });
});
