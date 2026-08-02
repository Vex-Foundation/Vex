/**
 * `trench.launch_request_form` — the AGENT-requested form continuation, wired.
 *
 * Until the host threaded the originating tool-call id, this handler could only
 * refuse: §C3b's result must answer a specific pending call, and parking a turn
 * whose result can never be addressed hangs it forever. `toolCallId` now rides
 * on `ProtocolExecutionContext` (host-side, never model input), so the real path
 * exists and these pins hold it to three things:
 *
 *   1. the intent is DRAFTED first (`agent_requested_form` / `awaiting_user_form`,
 *      carrying the tool-call id the DB CHECK requires on this path);
 *   2. the run is PARKED only after that row exists — a run parked with no
 *      intent to resume against is a hang;
 *   3. the tool output tells the model the form is open, that nothing was
 *      created, and that the outcome arrives as this call's result — a model
 *      that thinks the launch happened is the failure this wording prevents.
 *
 * The refusal is KEPT for a dispatch that genuinely carries no tool-call id.
 * That is fail-closed, not dead code: internal/legacy dispatch paths exist.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";

const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const TOOL_CALL_ID = "call_abc123";

let created: Record<string, unknown>[] = [];
let parked: Record<string, unknown>[] = [];
/** Statement order across the whole handler, to pin draft-before-park. */
let order: string[] = [];

vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  acquireSessionControlLock: async () => undefined,
}));
vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  createWith: async (_c: unknown, input: Record<string, unknown>) => {
    order.push("create");
    created.push(input);
    return { intentId: input.intentId };
  },
}));
// Address-only resolve: this path never signs, so `loadWalletFromEntry` must
// never be reached — it throws here so a regression that decrypts on the form
// path fails loudly instead of quietly gaining signing authority.
vi.mock("@tools/wallet/multi-auth.js", () => ({
  resolveSelectedEntry: () => ({ family: "evm", entry: { id: "w1", address: WALLET } }),
  loadWalletFromEntry: () => {
    throw new Error("request_form must never load a signing wallet");
  },
}));
vi.mock("@vex-agent/engine/core/user-form-runtime.js", () => ({
  parkRunForUserForm: async (ref: Record<string, unknown>) => {
    order.push("park");
    parked.push(ref);
  },
}));

const { trenchLaunchRequestFormHandler } = await import(
  "@vex-agent/tools/protocols/trench/handlers/launch/request-form.js"
);

const PARAMS = {
  name: "Vex Coin",
  symbol: "VEX",
  description: "A test launch",
  links: ["https://vex.example"],
  imageId: "img_01",
  prebuyEth: "0.01",
};

function context(over: Record<string, unknown> = {}) {
  return {
    sessionPermission: "full",
    approved: true,
    sessionId: "sess-1",
    missionRunId: "run-1",
    toolCallId: TOOL_CALL_ID,
    walletResolution: { source: "session", evm: { id: "w1", address: WALLET }, solana: null },
    walletPolicy: { kind: "none" },
    ...over,
  } as never;
}

beforeEach(() => {
  created = [];
  parked = [];
  order = [];
});

describe("with a host tool-call id, the form path DRAFTS and goes PENDING", () => {
  it("drafts the intent at awaiting_user_form carrying the tool-call id", async () => {
    const result = await trenchLaunchRequestFormHandler(PARAMS, context());
    expect(result.success).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      origin: "agent_requested_form",
      status: "awaiting_user_form",
      sessionId: "sess-1",
      missionRunId: "run-1",
      toolCallId: TOOL_CALL_ID,
      imageId: "img_01",
      prebuyDecimals: 18,
    });
  });

  it("returns pendingUserForm naming the drafted row — the batch stop's signal", async () => {
    const result = await trenchLaunchRequestFormHandler(PARAMS, context());
    // The turn loop reads THIS to stop the batch without recording a result.
    // A different id here would park the turn on a row the resume never answers.
    expect(result.pendingUserForm).toEqual({ intentId: created[0]?.intentId });
  });

  /**
   * The handler makes the wait DURABLE and stops there.
   *
   * Parking here would park a run the turn loop is still driving, and emitting
   * here would push a dialog before the operator-stop gate has decided whether
   * this form may be shown at all. Both now belong to the batch's single
   * transaction (`turn-loop-tool-batch/user-form-stop.ts`), pinned by
   * `engine/core/turn-loop/user-form-stop.test.ts`.
   */
  it("does NOT park the run and does NOT push the dialog itself", async () => {
    const { launchFormBus } = await import(
      "@vex-agent/engine/runtime/launch-form-bus.js"
    );
    launchFormBus.clear();
    const events: unknown[] = [];
    const off = launchFormBus.subscribe((event) => events.push(event));

    await trenchLaunchRequestFormHandler(PARAMS, context());
    off();

    expect(order).toEqual(["create"]);
    expect(parked).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("a chat session drafts the same way — the loop decides what parking means", async () => {
    const result = await trenchLaunchRequestFormHandler(
      PARAMS,
      context({ missionRunId: null }),
    );
    expect(result.pendingUserForm).toBeDefined();
    expect(created[0]).toMatchObject({ missionRunId: null });
  });
});

describe("without a host tool-call id it still REFUSES", () => {
  it("refuses rather than parking a turn nothing can answer", async () => {
    const result = await trenchLaunchRequestFormHandler(
      PARAMS,
      context({ toolCallId: undefined }),
    );
    expect(result.success).toBe(false);
    expect(result.pendingUserForm).toBeUndefined();
    expect(String(result.output)).toContain("could not identify the tool call");
    expect(created).toHaveLength(0);
  });

  it("treats a blank id as absent — a whitespace call id answers nothing", async () => {
    const result = await trenchLaunchRequestFormHandler(PARAMS, context({ toolCallId: "  " }));
    expect(result.success).toBe(false);
    expect(created).toHaveLength(0);
  });
});
