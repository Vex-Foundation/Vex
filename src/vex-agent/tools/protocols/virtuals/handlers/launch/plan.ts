/**
 * The PLAN a Virtuals launch would carry - built once, from the chain, and
 * shown before anything is signed.
 *
 * The preview shows this. The execute rebuilds it and holds the fresh copy
 * against the one the preview sealed. Because both come from this one module,
 * "what was shown" and "what would run" cannot be two different computations
 * that happen to agree today.
 *
 * ## The authority table, row by row (money path, rule 90)
 *
 * | field                            | authority                                     | revalidated pre-sign |
 * |----------------------------------|-----------------------------------------------|----------------------|
 * | chain                            | caller, resolved to the pinned deployment     | fixed                |
 * | BondingV5, VIRTUAL               | `curve/deployments.ts`                        | pinned               |
 * | proxy implementations            | EIP-1967 slot, re-read every time             | YES                  |
 * | bondingConfig                    | `BondingV5.bondingConfig()`                   | YES                  |
 * | router                           | `BondingV5.router()`, held to the pin         | YES                  |
 * | protocol launch fee              | `BondingConfig.calculateLaunchFee(false,false)`| YES                 |
 * | scheduled threshold              | `getScheduledLaunchParams().startTimeDelay`   | YES                  |
 * | name, ticker, cores, description | caller                                        | fixed                |
 * | on-chain name                    | derived from name + suffix choice             | fixed                |
 * | image URL                        | the content-addressed host ONLY               | fixed                |
 * | committed VIRTUAL                | caller, raw + decimals, never a float         | fixed                |
 * | Vex fee                          | `launch/fee.ts` constants, never params       | after success        |
 * | allowance                        | ERC-20 `allowance(wallet, BondingV5)`         | YES                  |
 * | balance                          | ERC-20 `balanceOf(wallet)`                    | YES                  |
 * | anti-sniper type                 | caller, 0-5, held to `isValidAntiSniperType`  | fixed                |
 * | calldata fingerprint             | `keccak256(chainId | to | value | data)`      | BINDING              |
 *
 * ## Why `startTime` is `block.timestamp` and not `Date.now()`
 *
 * `preLaunch` compares `startTime_` against `block.timestamp + startTimeDelay`
 * to decide whether the launch is SCHEDULED (`BondingV5.sol:326-333`), and a
 * scheduled launch is charged a fee and settles at a time no handler is alive
 * for. A wall clock that ran fast against a chain running slow would silently
 * cross that threshold. So the plan reads the head block's timestamp and names
 * a `startTime` strictly below the threshold, and states the margin it kept.
 */

import { formatUnits, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";

import {
  buildLaunchApproveTx,
  buildPreLaunchTx,
  launchCalldataFingerprint,
  onChainTokenName,
  readLaunchState,
  resolveVirtualsLaunchFee,
  type BuiltLaunchTx,
  type LaunchState,
  type PreLaunchArgs,
  type VirtualsLaunchFee,
} from "@tools/virtuals/launch/index.js";
import type { VirtualsCurveDeployment } from "@tools/virtuals/curve/index.js";

import { describeAntiSniperChoice, type LaunchFields } from "./params.js";
import type { ResolvedLaunchImage } from "./image.js";

/**
 * How far below the scheduled threshold a launch's `startTime` must sit.
 *
 * The threshold is `block.timestamp + startTimeDelay` (86400 s, read live), and
 * the plan names `block.timestamp` itself, so the real margin is the whole
 * delay. This constant is the assertion Vex makes about that margin rather than
 * a value it chooses: if a chain ever set `startTimeDelay` below it, an
 * immediate launch would be indistinguishable from a scheduled one and the
 * plan refuses instead of guessing which the venue would call it.
 */
export const IMMEDIATE_LAUNCH_MIN_MARGIN_SECONDS = 60n;

export interface LaunchPlan {
  /** The pinned contract table this plan was built against. */
  readonly deployment: VirtualsCurveDeployment;
  readonly state: LaunchState;
  readonly fee: VirtualsLaunchFee;
  readonly args: PreLaunchArgs;
  readonly preLaunchTx: BuiltLaunchTx;
  readonly approveTx: BuiltLaunchTx;
  /**
   * `approve(BondingV5, 0)` - built here rather than at the simulation and the
   * broadcast separately, so the two cannot disagree about the spender.
   */
  readonly approveResetTx: BuiltLaunchTx;
  /** True when the wallet's allowance to BondingV5 is short of the committed total. */
  readonly allowanceLegNeeded: boolean;
  /** True when a non-zero short allowance must be zeroed first. */
  readonly allowanceResetNeeded: boolean;
  readonly fingerprint: Hex;
  readonly onChainName: string;
  readonly image: ResolvedLaunchImage;
  /** The head block's timestamp the `startTime` was derived from. */
  readonly blockTimestamp: bigint;
}

export type BuildLaunchPlanResult =
  | { readonly ok: true; readonly plan: LaunchPlan }
  | { readonly ok: false; readonly reason: string };

/**
 * Read the chain and build every transaction this launch would send.
 *
 * NOTHING here signs, writes a row or opens a key. It is called by the preview,
 * by the execute's pre-sign re-read and by the simulation, and each of those
 * differs only in what it does with the answer.
 */
export async function buildLaunchPlan(input: {
  readonly client: PublicClient<Transport, Chain>;
  readonly fields: LaunchFields;
  readonly image: ResolvedLaunchImage;
  readonly wallet: Address;
}): Promise<BuildLaunchPlanResult> {
  const { fields, image } = input;
  const state = await readLaunchState({
    client: input.client,
    deployment: fields.deployment,
    wallet: input.wallet,
  });
  if (!state.ok) return { ok: false, reason: state.reason };

  // THE PIN, ASSERTED. `parseUnits` in `./params.ts` used the deployment's
  // recorded decimals; this is the token's own answer at the pinned block. They
  // agree today on both chains, and if they ever stop the committed amount the
  // caller wrote would mean something different from what they typed.
  if (state.virtualDecimals !== fields.deployment.virtualDecimals) {
    return {
      ok: false,
      reason:
        `VIRTUAL on ${fields.deployment.name} reports ${state.virtualDecimals} decimals, but Vex parsed the amount `
        + `with ${fields.deployment.virtualDecimals}. The amount you typed would not mean what you meant. Nothing `
        + "was signed.",
    };
  }

  const block = await input.client.getBlock({ blockNumber: state.blockNumber });
  const blockTimestamp = block.timestamp;
  if (state.scheduledStartTimeDelaySeconds < IMMEDIATE_LAUNCH_MIN_MARGIN_SECONDS) {
    return {
      ok: false,
      reason:
        `BondingConfig on ${fields.deployment.name} now treats a launch as SCHEDULED only `
        + `${state.scheduledStartTimeDelaySeconds} s ahead of the block, which is below the margin Vex requires to `
        + "state confidently that this launch is immediate. A scheduled launch is charged a fee and settles when no "
        + "handler is alive for it. Nothing was signed.",
    };
  }

  const fee = resolveVirtualsLaunchFee({
    deployment: fields.deployment,
    committedRaw: fields.committedRaw,
  });

  // THE VENUE'S OWN FEE COMES OUT OF WHAT THE VENUE RECEIVES, not out of Vex's
  // share. `preLaunch` splits `purchaseAmount_` into `launchFee` and
  // `initialPurchase` itself, so the initial purchase is what is left after
  // BOTH fees, and the plan states all three numbers rather than one net.
  if (fee.launchAmountRaw < state.protocolLaunchFeeRaw) {
    return {
      ok: false,
      reason:
        `After Vex's fee, ${formatUnits(fee.launchAmountRaw, state.virtualDecimals)} VIRTUAL would reach the venue, `
        + `which is below its own launch fee of ${formatUnits(state.protocolLaunchFeeRaw, state.virtualDecimals)} `
        + "VIRTUAL. preLaunch reverts with InvalidInput below the fee. Commit more.",
    };
  }

  if (state.virtualBalanceRaw < fee.committedRaw) {
    return {
      ok: false,
      reason:
        `This wallet holds ${formatUnits(state.virtualBalanceRaw, state.virtualDecimals)} VIRTUAL on `
        + `${fields.deployment.name} and the launch commits `
        + `${formatUnits(fee.committedRaw, state.virtualDecimals)}. Nothing was signed.`,
    };
  }

  const args: PreLaunchArgs = {
    name: fields.name,
    ticker: fields.ticker,
    cores: fields.cores,
    description: fields.description,
    imageUrl: image.url,
    urls: fields.urls,
    // What the venue is given. Vex's fee is already out; the venue's own
    // `calculateLaunchFee` comes out of this number inside the contract.
    purchaseAmountRaw: fee.launchAmountRaw,
    startTime: blockTimestamp,
    antiSniperTaxType: fields.antiSniperTaxType,
    nameSuffix: fields.nameSuffix,
  };

  const preLaunchTx = buildPreLaunchTx({ deployment: fields.deployment, args });

  // The allowance is sized on the VENUE's amount, not the committed total.
  // `preLaunch` pulls `launchFee + initialPurchase` and nothing else; Vex's own
  // fee is a separate transfer this wallet makes directly, with no allowance.
  const allowanceLegNeeded = state.allowanceRaw < fee.launchAmountRaw;

  return {
    ok: true,
    plan: {
      deployment: fields.deployment,
      state,
      fee,
      args,
      preLaunchTx,
      approveTx: buildLaunchApproveTx({
        deployment: fields.deployment,
        amountRaw: fee.launchAmountRaw,
      }),
      approveResetTx: buildLaunchApproveTx({ deployment: fields.deployment, amountRaw: 0n }),
      allowanceLegNeeded,
      // The USDT-style rule every EVM venue here follows: a non-zero allowance
      // that is short must be zeroed before it can be raised.
      allowanceResetNeeded: allowanceLegNeeded && state.allowanceRaw > 0n,
      fingerprint: launchCalldataFingerprint({
        chainId: fields.deployment.chainId,
        tx: preLaunchTx,
      }),
      onChainName: onChainTokenName(fields.name, fields.nameSuffix),
      image,
      blockTimestamp,
    },
  };
}

/**
 * The agent- and human-facing shape of a plan.
 *
 * Every fact the authority table calls user-visible is in here, spelled out
 * rather than implied: the name that will actually be on chain (which is NOT
 * always the name the caller typed), the three-way split of the committed
 * amount, the anti-sniper choice in words, the two transactions, the
 * fingerprint, and the two-transaction lifecycle with the fee waiver attached
 * to it.
 */
export function describeLaunchPlan(input: {
  readonly plan: LaunchPlan;
  readonly fields: LaunchFields;
  readonly wallet: Address;
}): Record<string, unknown> {
  const { plan, fields } = input;
  const d = fields.deployment;
  const decimals = plan.state.virtualDecimals;
  const initialPurchaseRaw = plan.fee.launchAmountRaw - plan.state.protocolLaunchFeeRaw;

  return {
    chain: d.key,
    chainId: d.chainId,
    wallet: input.wallet,
    venue: "virtuals-bonding",
    contracts: {
      bondingV5: d.bondingV5,
      bondingConfig: plan.state.bondingConfig,
      frouterV3: d.frouterV3,
      virtual: d.virtual,
      // The implementations are part of the approval, not a diagnostic: an
      // upgrade changes what `preLaunch` MEANS at an unchanged address.
      implementations: plan.state.implementations,
    },
    agent: {
      name: fields.name,
      // THE NAME THAT WILL EXIST. `preLaunch` appends " by Virtuals" unless bit
      // 1 of extParams is set, so the ERC-20 is named differently from the
      // string the caller passed. Shown explicitly for that reason.
      onChainName: plan.onChainName,
      nameSuffix: fields.nameSuffix,
      ticker: fields.ticker,
      description: fields.description,
      cores: fields.cores,
      socials: {
        twitter: fields.urls[0],
        telegram: fields.urls[1],
        youtube: fields.urls[2],
        website: fields.urls[3],
      },
      imageUrl: plan.image.url,
      imageContentId: plan.image.cid,
      imageLabel: plan.image.label,
    },
    money: {
      committedRaw: plan.fee.committedRaw.toString(),
      committed: formatUnits(plan.fee.committedRaw, decimals),
      vexFeeRaw: (plan.fee.feeRaw ?? 0n).toString(),
      vexFee: formatUnits(plan.fee.feeRaw ?? 0n, decimals),
      venueReceivesRaw: plan.fee.launchAmountRaw.toString(),
      venueReceives: formatUnits(plan.fee.launchAmountRaw, decimals),
      protocolLaunchFeeRaw: plan.state.protocolLaunchFeeRaw.toString(),
      protocolLaunchFee: formatUnits(plan.state.protocolLaunchFeeRaw, decimals),
      protocolFeeRecipient: plan.state.feeTo,
      initialPurchaseRaw: initialPurchaseRaw.toString(),
      initialPurchase: formatUnits(initialPurchaseRaw, decimals),
      symbol: "VIRTUAL",
      decimals,
      note:
        "The committed amount splits three ways and every part is stated: Vex's fee, the venue's own launch fee "
        + "(BondingConfig.calculateLaunchFee, read live and 0 for a normal immediate launch), and the initial "
        + "purchase - which is the ONLY part a cancel would refund.",
    },
    antiSniper: {
      type: fields.antiSniperTaxType,
      description: describeAntiSniperChoice(fields.antiSniperTaxType),
    },
    allowance: {
      currentRaw: plan.state.allowanceRaw.toString(),
      current: formatUnits(plan.state.allowanceRaw, decimals),
      spender: d.bondingV5,
      approvalNeeded: plan.allowanceLegNeeded,
      resetNeeded: plan.allowanceResetNeeded,
      note:
        "The spender is BondingV5 itself, not FRouterV3: preLaunch pulls the purchase with "
        + "safeTransferFrom(msg.sender, address(this), ...). A curve trade approves the router instead. The amount is "
        + "exact, never unlimited.",
    },
    balance: {
      virtualRaw: plan.state.virtualBalanceRaw.toString(),
      virtual: formatUnits(plan.state.virtualBalanceRaw, decimals),
    },
    transaction: {
      to: plan.preLaunchTx.to,
      value: plan.preLaunchTx.value.toString(),
      calldataFingerprint: plan.fingerprint,
      startTime: plan.args.startTime.toString(),
      blockNumber: plan.state.blockNumber.toString(),
      scheduledThresholdSeconds: plan.state.scheduledStartTimeDelaySeconds.toString(),
      note:
        "startTime is the head block's own timestamp, which is why this is an IMMEDIATE launch: preLaunch calls a "
        + "launch scheduled once startTime reaches block.timestamp + startTimeDelay.",
    },
    lifecycle: {
      note:
        "A Virtuals launch takes TWO transactions and only the first is yours. preLaunch creates the agent and takes "
        + "your VIRTUAL; the agent is NOT tradable and NOT listed until the Virtuals KEEPER calls launch(token), "
        + "about a minute later. Vex never calls launch() itself - doing so on 2026-09-04 beat the keeper and that "
        + "agent was never indexed by the platform. Vex waits and watches for the keeper's Launched event.",
      ifKeeperIsSlow:
        "If the keeper has not launched within the bounded wait, the launch is recorded as awaiting_keeper. That is "
        + "NOT a failure: the agent exists, your VIRTUAL is held by BondingV5, and Vex reconciles the launch later "
        + "without a signer. Vex's fee is then WAIVED PERMANENTLY and is never collected afterwards.",
      cancellable:
        "Until the keeper launches, you can call virtuals__agent_launch_cancel. It refunds the initial purchase ONLY: "
        + "the venue's protocol fee, if any was charged at preLaunch, is NOT refunded (BondingV5.cancelLaunch:559).",
    },
    vexFee: plan.fee.disclosure,
  };
}

/**
 * `eth_call` each transaction the plan would send, from the wallet ADDRESS.
 *
 * A leg whose allowance leg has not run yet reverts here BY CONSTRUCTION, and
 * that is reported rather than hidden: the reply says which leg was simulated
 * against which allowance state, so an honest failure is not mistaken for a
 * broken plan.
 */
export async function simulateLaunchPlan(input: {
  readonly client: PublicClient<Transport, Chain>;
  readonly plan: LaunchPlan;
  readonly wallet: Address;
  readonly describeError: (err: unknown) => string;
}): Promise<readonly Record<string, unknown>[]> {
  const requests: { readonly role: string; readonly tx: BuiltLaunchTx }[] = [];
  if (input.plan.allowanceResetNeeded) {
    requests.push({ role: "allowance_reset", tx: input.plan.approveResetTx });
  }
  if (input.plan.allowanceLegNeeded) requests.push({ role: "allowance", tx: input.plan.approveTx });
  requests.push({ role: "pre_launch", tx: input.plan.preLaunchTx });

  const results: Record<string, unknown>[] = [];
  for (const request of requests) {
    let succeeded = true;
    let revertReason: string | undefined;
    try {
      await input.client.call({
        account: input.wallet,
        to: request.tx.to,
        data: request.tx.data,
        value: request.tx.value,
      });
    } catch (err) {
      succeeded = false;
      revertReason = input.describeError(err);
    }
    results.push({
      role: request.role,
      to: request.tx.to,
      data: request.tx.data,
      value: request.tx.value.toString(),
      ok: succeeded,
      ...(revertReason === undefined ? {} : { revertReason }),
    });
  }
  return results;
}
