/**
 * The pools.fun TWO-STAGE authorization machine.
 *
 * This is the rule that decides when a click may spend real money, so it is
 * pinned as a pure reducer rather than through a rendered dialog. The property
 * that matters most is negative: there must be NO path that carries a prepared
 * fingerprint across a change. If one existed, a user could edit the symbol
 * after stage 1 and press Deploy on figures computed for the old one.
 */

import { describe, expect, it } from "vitest";
import type { PoolsPreparedLaunch } from "@shared/schemas/pools-launch.js";
import {
  armedFingerprint,
  canDismissPoolsLaunch,
  isPoolsLaunchBusy,
  poolsLaunchReducer,
  POOLS_LAUNCH_INITIAL_STATE,
  type PoolsLaunchEvent,
  type PoolsLaunchState,
} from "../../TokenLaunchDialog/pools/machine.js";

const AMOUNT = {
  rawWei: "1000",
  decimals: 18,
  assetAddress: "0x0000000000000000000000000000000000000000",
  assetSymbol: "ETH",
} as const;

function fingerprint(over: Partial<PoolsPreparedLaunch> = {}): PoolsPreparedLaunch {
  return {
    fingerprintId: "fp-1",
    predictedTokenAddress: "0x1111111111111111111111111111111111111111",
    predictedPoolAddress: "0x2222222222222222222222222222222222222222",
    resolvedFeeRecipient: "0x3333333333333333333333333333333333333333",
    pairedAsset: "weth",
    pairedAssetAddress: "0x4444444444444444444444444444444444444444",
    costs: {
      deploymentFee: AMOUNT,
      prebuy: null,
      vexFee: AMOUNT,
      gasBound: AMOUNT,
      transactionValue: AMOUNT,
    },
    metadataUri: "https://example.test/meta.json",
    imageLanded: true,
    expiresAt: "2026-08-18T12:00:00.000Z",
    ...over,
  };
}

/** Drive the machine through a list of events from the initial state. */
function run(...events: readonly PoolsLaunchEvent[]): PoolsLaunchState {
  return events.reduce(poolsLaunchReducer, POOLS_LAUNCH_INITIAL_STATE);
}

/** The happy path up to an ARMED fingerprint. */
function armed(fp: PoolsPreparedLaunch = fingerprint()): PoolsLaunchState {
  return run({ type: "prepare_started" }, { type: "prepare_succeeded", fingerprint: fp });
}

describe("pools launch machine - the two stages", () => {
  it("starts in stage 1 with nothing armed", () => {
    expect(POOLS_LAUNCH_INITIAL_STATE).toEqual({ kind: "editing" });
    expect(armedFingerprint(POOLS_LAUNCH_INITIAL_STATE)).toBeNull();
  });

  it("arms stage 2 only through a completed preparation", () => {
    const fp = fingerprint();
    const state = armed(fp);
    expect(state.kind).toBe("authorizing");
    expect(armedFingerprint(state)).toBe(fp);
  });

  it("deploys the ARMED fingerprint and nothing else", () => {
    const fp = fingerprint({ fingerprintId: "fp-armed" });
    const deploying = poolsLaunchReducer(armed(fp), { type: "deploy_started" });
    expect(deploying).toEqual({ kind: "deploying", fingerprint: fp });
  });
});

describe("pools launch machine - the voiding rule", () => {
  it("VOIDS an armed fingerprint on any form edit", () => {
    const state = poolsLaunchReducer(armed(), { type: "form_changed" });
    expect(state).toEqual({ kind: "editing" });
    expect(armedFingerprint(state)).toBeNull();
  });

  it("cannot deploy after an edit - the click has nothing to authorize", () => {
    const afterEdit = poolsLaunchReducer(armed(), { type: "form_changed" });
    // The event that would start a spend is inert from stage 1.
    expect(poolsLaunchReducer(afterEdit, { type: "deploy_started" })).toBe(afterEdit);
  });

  it("VOIDS on expiry, so the user never presses a button that can only fail", () => {
    const state = poolsLaunchReducer(armed(), { type: "fingerprint_expired" });
    expect(state.kind).toBe("re_review");
    expect(armedFingerprint(state)).toBeNull();
  });

  it("VOIDS on a refused deploy - a refusal never proves the plan still holds", () => {
    const deploying = poolsLaunchReducer(armed(), { type: "deploy_started" });
    const state = poolsLaunchReducer(deploying, {
      type: "deploy_refused",
      message: "The deployment fee moved.",
    });
    expect(state).toEqual({ kind: "re_review", message: "The deployment fee moved." });
    expect(armedFingerprint(state)).toBeNull();
  });

  it("carries NO fingerprint into any stage-1 state, whatever the route", () => {
    const routes: readonly PoolsLaunchState[] = [
      poolsLaunchReducer(armed(), { type: "form_changed" }),
      poolsLaunchReducer(armed(), { type: "fingerprint_expired" }),
      poolsLaunchReducer(poolsLaunchReducer(armed(), { type: "deploy_started" }), {
        type: "deploy_refused",
        message: "no",
      }),
      run({ type: "prepare_started" }, { type: "prepare_failed", message: "no" }),
    ];
    for (const state of routes) expect(armedFingerprint(state)).toBeNull();
  });
});

describe("pools launch machine - in-flight stages are not interruptible", () => {
  it("ignores an edit while verifying or deploying", () => {
    const verifying = run({ type: "prepare_started" });
    expect(poolsLaunchReducer(verifying, { type: "form_changed" })).toBe(verifying);

    const deploying = poolsLaunchReducer(armed(), { type: "deploy_started" });
    expect(poolsLaunchReducer(deploying, { type: "form_changed" })).toBe(deploying);
  });

  it("ignores a LATE preparation answer that arrives after the user moved on", () => {
    // The user edited while a prepare was in flight: the machine is back in
    // stage 1, and the late success must not silently arm Deploy behind them.
    const afterEdit = run(
      { type: "prepare_started" },
      { type: "form_changed" },
    );
    expect(afterEdit.kind).toBe("verifying"); // an edit cannot recall the call
    const late = poolsLaunchReducer(
      { kind: "editing" },
      { type: "prepare_succeeded", fingerprint: fingerprint() },
    );
    expect(late).toEqual({ kind: "editing" });
  });

  it("refuses to start a second preparation while a deploy is in flight", () => {
    const deploying = poolsLaunchReducer(armed(), { type: "deploy_started" });
    expect(poolsLaunchReducer(deploying, { type: "prepare_started" })).toBe(deploying);
  });

  it("expiry cannot disturb a deploy already in flight", () => {
    const deploying = poolsLaunchReducer(armed(), { type: "deploy_started" });
    expect(poolsLaunchReducer(deploying, { type: "fingerprint_expired" })).toBe(deploying);
  });
});

describe("pools launch machine - dismissal and busy", () => {
  it("is NOT dismissible mid-signature, and dismissible everywhere else", () => {
    const deploying = poolsLaunchReducer(armed(), { type: "deploy_started" });
    expect(canDismissPoolsLaunch(deploying)).toBe(false);
    // Verifying signs nothing, so closing it costs nothing.
    expect(canDismissPoolsLaunch(run({ type: "prepare_started" }))).toBe(true);
    expect(canDismissPoolsLaunch(POOLS_LAUNCH_INITIAL_STATE)).toBe(true);
    expect(canDismissPoolsLaunch(armed())).toBe(true);
  });

  it("reports both in-flight stages as busy", () => {
    expect(isPoolsLaunchBusy(run({ type: "prepare_started" }))).toBe(true);
    expect(
      isPoolsLaunchBusy(poolsLaunchReducer(armed(), { type: "deploy_started" })),
    ).toBe(true);
    expect(isPoolsLaunchBusy(armed())).toBe(false);
  });
});

describe("pools launch machine - terminal states", () => {
  it("keeps main's own sentence and tone verbatim", () => {
    const deploying = poolsLaunchReducer(armed(), { type: "deploy_started" });
    const done = poolsLaunchReducer(deploying, {
      type: "deploy_succeeded",
      message: "Launched 0xabc. Trading fees go to 0xdef.",
      tone: "success",
      autoDismiss: true,
    });
    expect(done).toEqual({
      kind: "done",
      message: "Launched 0xabc. Trading fees go to 0xdef.",
      tone: "success",
      autoDismiss: true,
    });
  });

  it("seals a completed launch against edits and re-preparation", () => {
    const done = poolsLaunchReducer(
      poolsLaunchReducer(armed(), { type: "deploy_started" }),
      { type: "deploy_succeeded", message: "ok", tone: "success", autoDismiss: true },
    );
    expect(poolsLaunchReducer(done, { type: "form_changed" })).toBe(done);
    expect(poolsLaunchReducer(done, { type: "prepare_started" })).toBe(done);
  });

  it("a fresh open is a fresh consent from every state", () => {
    const done = poolsLaunchReducer(
      poolsLaunchReducer(armed(), { type: "deploy_started" }),
      { type: "deploy_succeeded", message: "ok", tone: "success", autoDismiss: true },
    );
    expect(poolsLaunchReducer(done, { type: "reopened" })).toEqual({ kind: "editing" });
    expect(poolsLaunchReducer(armed(), { type: "reopened" })).toEqual({ kind: "editing" });
  });
});
