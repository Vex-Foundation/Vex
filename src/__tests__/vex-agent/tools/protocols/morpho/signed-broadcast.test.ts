/**
 * The Morpho write path: what gets RECORDED, in what ORDER, and what is refused
 * to be recorded at all.
 *
 * ── WHY `chain_family` AND `chain_id` HAVE THEIR OWN CASES ──────────────────
 *
 * Migration 079 widened `agent_activity_kind_family_binding` to admit
 * `kind = 'lend' AND chain_family = 'eip155'`. Before it, a lend writer that
 * forgot the family was rejected by the database on its first insert; after it,
 * both families satisfy the CHECK and only the writer knows which is true. 079's
 * own header records that risk in those words. So the value that lands in the
 * column is asserted here rather than trusted to a default that no longer means
 * anything, and the chain id is asserted to come from the caller's registry-
 * resolved value rather than from anything a model supplied.
 *
 * ── WHY THE ORDERING CASES ARE THE MONEY CASES ──────────────────────────────
 *
 * Two failures would be expensive and both are invisible without a test:
 *
 *   1. Broadcasting the deposit after its simulation PROVED a revert. The whole
 *      point of simulating after the approval lands is that a doomed deposit
 *      costs nothing; a lane that simulated and then sent anyway would have
 *      spent the gas for no reason at all.
 *   2. Terminalizing a row whose broadcast ended ambiguously. An ambiguous send
 *      may already have moved funds. Writing `definitively_failed` on it, or
 *      re-broadcasting it, are the two ways one transaction becomes two.
 *
 * The clients are stubs and the staged-broadcast primitive is mocked: this suite
 * is about the protocol around a broadcast, not about signing, which has its own
 * owner and its own fork proof.
 *
 * This file owns the mock surface and the describe blocks; each group's cases
 * live in `./signed-broadcast/`, one responsibility per file.
 */

import { describe, vi, beforeEach } from "vitest";

import { definedValue } from "../../../../_test-value-guards.js";
import {
  BUNDLER3,
  MINTED_SHARES,
  allowancePlanNeedingApproval,
  rowsFor,
  vaultState,
  type SignedBroadcastContext,
} from "./signed-broadcast/harness.js";
import { registerRecordedRowCases } from "./signed-broadcast/recorded-rows-cases.js";
import { registerLegOrderingCases } from "./signed-broadcast/leg-ordering-cases.js";
import { registerAmbiguityCases } from "./signed-broadcast/ambiguity-cases.js";
import { registerSettlementCases } from "./signed-broadcast/settlement-cases.js";

const mockCreateIntent = vi.fn();
const mockConfirm = vi.fn();
const mockFail = vi.fn();
const mockAbort = vi.fn();
const mockMarkBroadcast = vi.fn();
const mockMarkAccepted = vi.fn();
const mockNoteBlockTime = vi.fn();
const mockSignStageBroadcast = vi.fn();
const mockNotePendingReason = vi.fn();
const mockPrepareExecution = vi.fn();
const mockPrepareLeg = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createAgentActivityIntent: (...a: unknown[]) => mockCreateIntent(...a),
    confirmActivityEvent: (...a: unknown[]) => mockConfirm(...a),
    failActivityEvent: (...a: unknown[]) => mockFail(...a),
    abortPlannedEvents: (...a: unknown[]) => mockAbort(...a),
    markActivityBroadcast: (...a: unknown[]) => mockMarkBroadcast(...a),
    markBroadcastAccepted: (...a: unknown[]) => mockMarkAccepted(...a),
    noteSettledBlockTime: (...a: unknown[]) => mockNoteBlockTime(...a),
  };
});

vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({
  signStageBroadcast: (...a: unknown[]) => mockSignStageBroadcast(...a),
}));

vi.mock("@vex-agent/tools/protocols/runtime/pending-provenance.js", () => ({
  noteHandlerPendingReason: (...a: unknown[]) => mockNotePendingReason(...a),
}));

vi.mock("@tools/morpho/mutations.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    prepareMorphoVaultExecution: (...a: unknown[]) => mockPrepareExecution(...a),
    prepareMorphoOperationLeg: (...a: unknown[]) => mockPrepareLeg(...a),
    // The deposit lane re-asks the curation gate immediately before signing. Its
    // own predicate and the DEPOSIT-ONLY asymmetry are proved in
    // `./vault-operation-leg-regate.test.ts`; here it is stubbed to the curated
    // answer so these cases stay about settlement rather than about the gate.
    assertMorphoCuratesVault: async () => undefined,
  };
});

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const signedBroadcast = await import(
  "@vex-agent/tools/protocols/morpho/handlers/signed-broadcast.js"
);

const ctx: SignedBroadcastContext = {
  module: signedBroadcast,
  createIntent: mockCreateIntent,
  confirm: mockConfirm,
  fail: mockFail,
  abort: mockAbort,
  notePendingReason: mockNotePendingReason,
  noteBlockTime: mockNoteBlockTime,
  signStageBroadcast: mockSignStageBroadcast,
  prepareExecution: mockPrepareExecution,
  prepareLeg: mockPrepareLeg,
  capturedEvents: () => {
    const firstCall = definedValue(mockCreateIntent.mock.calls[0], "the createAgentActivityIntent call");
    return firstCall[0].events as Record<string, unknown>[];
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockMarkBroadcast.mockResolvedValue({ applied: true });
  mockMarkAccepted.mockResolvedValue({ applied: true });
  mockConfirm.mockResolvedValue({ applied: true });
  mockFail.mockResolvedValue({ applied: true });
  mockAbort.mockResolvedValue([]);
  mockNoteBlockTime.mockResolvedValue(true);
  mockCreateIntent.mockImplementation(async (input: { events: Record<string, unknown>[] }) => ({
    executionId: 7,
    events: rowsFor(input.events),
  }));
  mockPrepareExecution.mockResolvedValue({
    state: vaultState(),
    allowancePlan: allowancePlanNeedingApproval(),
    expectedSharesRaw: MINTED_SHARES,
    bundle: { to: BUNDLER3, shape: "bundler3-multicall" },
  });
  mockPrepareLeg.mockResolvedValue({
    to: BUNDLER3,
    data: "0xdeposit",
    value: 0n,
    bundle: { to: BUNDLER3 },
    gas: { nodeEstimate: "100000", vexGasLimit: "150000" },
    preflight: { verdict: "ok", revertReason: null, explanation: "" },
  });
});

describe("the durable rows a Morpho deposit writes", () => {
  registerRecordedRowCases(ctx);
});

describe("leg ordering and the refusals that protect it", () => {
  registerLegOrderingCases(ctx);
});

describe("ambiguity never terminalizes and never re-broadcasts", () => {
  registerAmbiguityCases(ctx);
});

describe("a settled deposit", () => {
  registerSettlementCases(ctx);
});
