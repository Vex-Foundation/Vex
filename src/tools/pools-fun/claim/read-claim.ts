/**
 * What a creator-fee claim would actually pay - read and SIMULATED, never
 * inferred from a mapping.
 *
 * THE TRAP THIS MODULE EXISTS FOR. `PartyLocker.claimableToken` and
 * `claimablePaired` look like the answer to "what can I claim" and are not: they
 * hold fees ALREADY COLLECTED into the locker and not yet paid out. Measured
 * live, both read 0 while an `eth_call` of `collectAndClaim` returned
 * 0 / 599999999999 - because nothing had been collected yet. So the mappings are
 * surfaced under an "already collected" label and NEVER as a claimable total,
 * and the simulation is the only figure allowed to answer the question.
 *
 * EVERY AMOUNT LEAVES HERE WITH ITS ASSET AND ITS DECIMALS. A claim pays two
 * different assets at two different scales - the launched token (18) and the
 * paired asset (USDG is 6) - so a bare pair of numbers is unreadable and a
 * mixed-up pair is a millionfold error. Decimals are READ from the contracts,
 * never assumed.
 *
 * THREE OUTCOMES, NOT TWO. `collectAndClaim` can revert `NothingToClaim` or
 * `NotClaimable`, and both are REAL ANSWERS about the pool rather than failures
 * of the call: the agent is told there is nothing to claim, not that something
 * broke. Anything else that fails to answer is `unavailable`, and a caller must
 * never read that as "nothing to claim".
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";

import { PARTY_LOCKER_ABI, PARTY_LOCKER_CLAIM_ABI, PARTY_TOKEN_ABI } from "../abi.js";
import type { PoolsContractSuite } from "../constants.js";
import { POOLS_UNREGISTERED_SENTENCE } from "../evm/token-registration.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** One leg of a claim: what asset, how much, and at what scale. */
export interface PoolsClaimLeg {
  readonly assetAddress: Address;
  readonly amountRaw: bigint;
  readonly decimals: number;
}

/** The on-chain facts a claim is judged against, all at ONE pinned block. */
export interface PoolsClaimContext {
  readonly blockNumber: bigint;
  /**
   * The suite whose locker holds this token's LP, and therefore the ONE locker
   * a claim may be sent to.
   *
   * Carried on the context rather than re-derived by the caller: the address the
   * simulation ran against and the address the transaction targets must be the
   * same one, and passing the suite forward is how that is guaranteed instead of
   * hoped for.
   */
  readonly suite: PoolsContractSuite;
  /**
   * The pool's paired asset, from `getPoolInfo` - the authority the mission
   * floor's asset must equal. Never taken from an API row.
   */
  readonly pairedAsset: Address;
  readonly poolAddress: Address;
  /** Who the locker currently pays creator fees to for this token. */
  readonly feeRecipient: Address;
  readonly tokenDecimals: number;
  readonly pairedDecimals: number;
  /** ALREADY COLLECTED and not yet paid out. Never a claimable total. */
  readonly alreadyCollected: {
    readonly token: PoolsClaimLeg;
    readonly paired: PoolsClaimLeg;
  };
}

export type ReadPoolsClaimContextResult =
  | { readonly ok: true; readonly context: PoolsClaimContext }
  | { readonly ok: false; readonly reason: string };

/**
 * Read everything a claim decision needs, at one anchored block.
 *
 * An UNREGISTERED token (the locker answers with its all-zero row) is a FACT and
 * is refused by name: a `platform=sushi` token belongs to the older launchpad
 * and this locker will never pay fees for it. A call that does not answer at all
 * is a different refusal, and the two are never collapsed.
 */
export async function readPoolsClaimContext(
  client: PublicClient<Transport, Chain>,
  token: Address,
  account: Address,
  suite: PoolsContractSuite,
): Promise<ReadPoolsClaimContextResult> {
  const lockerAddress = suite.locker as Address;
  let blockNumber: bigint;
  try {
    blockNumber = await client.getBlockNumber();
  } catch (err) {
    return { ok: false, reason: `the chain's current block could not be read (${errorName(err)})` };
  }

  let poolInfo: unknown;
  let tokenDecimals: unknown;
  let claimableToken: unknown;
  let claimablePaired: unknown;
  try {
    [poolInfo, tokenDecimals, claimableToken, claimablePaired] = await client.multicall({
      allowFailure: true,
      blockNumber,
      contracts: [
        { address: lockerAddress, abi: PARTY_LOCKER_ABI, functionName: "getPoolInfo", args: [token] },
        { address: token, abi: PARTY_TOKEN_ABI, functionName: "decimals" },
        { address: lockerAddress, abi: PARTY_LOCKER_CLAIM_ABI, functionName: "claimableToken", args: [token, account] },
        { address: lockerAddress, abi: PARTY_LOCKER_CLAIM_ABI, functionName: "claimablePaired", args: [token, account] },
      ],
    });
  } catch (err) {
    return {
      ok: false,
      reason: `this token's locker registration could not be read at block ${blockNumber} (${errorName(err)})`,
    };
  }

  const info = successOf<readonly [string, string, string, string, readonly bigint[]]>(poolInfo);
  if (info === null) {
    return {
      ok: false,
      reason:
        `the V${suite.version} locker did not answer for ${token}, so who its fees belong to is unknown`,
    };
  }
  const [pairedAsset, poolAddress, , feeRecipient] = info;
  // The caller selected this suite from a cross-checked detection, so an
  // all-zero row here means the chain changed under the detection rather than
  // "sushi". The refusal says exactly that instead of naming a launcher nothing
  // proved.
  if (poolAddress.toLowerCase() === ZERO_ADDRESS) {
    return {
      ok: false,
      reason:
        `${token} is ${POOLS_UNREGISTERED_SENTENCE}: the V${suite.version} locker selected for it now answers `
        + "with an empty row, so there is no creator fee stream to claim here",
    };
  }

  const decimals = successOf<number>(tokenDecimals);
  if (decimals === null) {
    return {
      ok: false,
      reason: `${token} did not answer its decimals, and an amount without its scale cannot be reported`,
    };
  }

  const pairedDecimals = await readErc20Decimals(client, pairedAsset as Address, blockNumber);
  if (pairedDecimals === null) {
    return {
      ok: false,
      reason:
        `the paired asset ${pairedAsset} did not answer its decimals, so the amount it would pay cannot be `
        + "read - and Vex does not guess a scale on a money path",
    };
  }

  // A mapping that did not answer reads as ABSENT, not as zero: "nothing was
  // collected before" and "we could not ask" are different statements, and the
  // second one must never be shown as the first.
  const collectedToken = successOf<bigint>(claimableToken);
  const collectedPaired = successOf<bigint>(claimablePaired);
  if (collectedToken === null || collectedPaired === null) {
    return {
      ok: false,
      reason: "the locker's already-collected balances did not answer, so this claim cannot be described fully",
    };
  }

  return {
    ok: true,
    context: {
      blockNumber,
      suite,
      pairedAsset: pairedAsset as Address,
      poolAddress: poolAddress as Address,
      feeRecipient: feeRecipient as Address,
      tokenDecimals: Number(decimals),
      pairedDecimals,
      alreadyCollected: {
        token: { assetAddress: token, amountRaw: collectedToken, decimals: Number(decimals) },
        paired: { assetAddress: pairedAsset as Address, amountRaw: collectedPaired, decimals: pairedDecimals },
      },
    },
  };
}

/** What simulating `collectAndClaim` established. */
export type PoolsClaimSimulation =
  | {
      readonly kind: "would_pay";
      readonly tokenAmountRaw: bigint;
      readonly pairedAmountRaw: bigint;
    }
  /** The contract itself says there is nothing to pay. A fact, not a failure. */
  | { readonly kind: "nothing_to_claim"; readonly revert: "NothingToClaim" | "NotClaimable" }
  /** The call did not answer. NEVER to be read as "nothing to claim". */
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Simulate the claim AS THE SESSION WALLET.
 *
 * `collectAndClaim` is `nonpayable`, so this is an `eth_call` against current
 * state rather than a read: it collects into the locker and pays out in ONE
 * transaction, and only simulating it from the claiming account answers "what
 * would I actually receive". Simulating from anyone else would answer a
 * different question.
 */
export async function simulatePoolsClaim(
  client: PublicClient<Transport, Chain>,
  input: {
    readonly account: Address;
    readonly token: Address;
    readonly blockNumber: bigint;
    /**
     * The suite whose locker holds this token. REQUIRED, not defaulted: a claim
     * simulated against one suite's locker and broadcast to another's would
     * answer a question about a contract that never sees the transaction, and a
     * default is exactly how the pinned-V1 defect reached production.
     */
    readonly suite: PoolsContractSuite;
  },
): Promise<PoolsClaimSimulation> {
  try {
    const { result } = await client.simulateContract({
      account: input.account,
      address: input.suite.locker as Address,
      abi: PARTY_LOCKER_CLAIM_ABI,
      functionName: "collectAndClaim",
      args: [input.token],
      blockNumber: input.blockNumber,
    });
    const [tokenAmountRaw, pairedAmountRaw] = result as readonly [bigint, bigint];
    return { kind: "would_pay", tokenAmountRaw, pairedAmountRaw };
  } catch (err) {
    const named = namedRevert(err);
    if (named !== null) return { kind: "nothing_to_claim", revert: named };
    return { kind: "unavailable", reason: shortReason(err) };
  }
}

/** The locker's own named reverts, or `null` for anything else. */
function namedRevert(err: unknown): "NothingToClaim" | "NotClaimable" | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return null;
  const name = revert.data?.errorName;
  return name === "NothingToClaim" || name === "NotClaimable" ? name : null;
}

async function readErc20Decimals(
  client: PublicClient<Transport, Chain>,
  asset: Address,
  blockNumber: bigint,
): Promise<number | null> {
  try {
    const decimals = await client.readContract({
      address: asset,
      abi: PARTY_TOKEN_ABI,
      functionName: "decimals",
      blockNumber,
    });
    return Number(decimals);
  } catch {
    return null;
  }
}

function successOf<T>(call: unknown): T | null {
  if (call === null || typeof call !== "object") return null;
  const result = call as { status?: unknown; result?: unknown };
  return result.status === "success" ? (result.result as T) : null;
}

/** The error's short cause, with nothing in it that leaks a node URL or a body. */
function shortReason(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const named = err as { shortMessage?: unknown; name?: unknown };
    if (typeof named.shortMessage === "string" && named.shortMessage.trim() !== "") {
      return named.shortMessage.trim();
    }
    if (typeof named.name === "string") return named.name;
  }
  return "the node did not say why";
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown error";
}
