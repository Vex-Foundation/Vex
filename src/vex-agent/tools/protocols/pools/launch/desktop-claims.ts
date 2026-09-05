/**
 * The desktop lane's remaining four contract methods: claim preview, claim,
 * launch list, and "is a form waiting for me".
 *
 * These are thin on purpose. Every one of them is the SAME work the agent-facing
 * tools already do, reached through the same modules - the desktop lane must not
 * become a second implementation of a money path, because the first symptom of
 * that divergence would be the app showing a number the agent would never sign.
 *
 * `previewClaim` and `claim` therefore run the same simulation and the same
 * settlement decode as `pools.claim_fees`; `myLaunches` reads the same launchpad
 * index as `pools.my_launches`; `getAwaiting` reads the intent table the form
 * tool writes.
 */

import { getAddress, type Address, type Hex } from "viem";

import { getLocalChain } from "@tools/evm-chains/registry.js";
import {
  POOLS_UNREGISTERED_SENTENCE,
  readPoolsOnChainSnapshot,
} from "@tools/pools-fun/evm/token-registration.js";
import { getLocalPublicClient } from "@tools/evm-chains/evm-client.js";
import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import { POOLS_CHAIN_ID } from "@tools/pools-fun/constants.js";
import { readPoolsClaimContext, simulatePoolsClaim } from "@tools/pools-fun/claim/read-claim.js";
import { getAwaitingForSession } from "@vex-agent/db/repos/token-launch-intents.js";
import { openLaunchSigningClients } from "../../shared/launch-signing-clients.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { estimatePoolsClaimGas, poolsClaimFeesHandler } from "../handlers/claim.js";
import type {
  ClaimPoolsFees,
  GetAwaitingPoolsLaunchForm,
  ListPoolsMyLaunches,
  PoolsAmount,
  PoolsLaunchOutcome,
  PoolsLaunchRefusalKind,
  PoolsMyLaunchRow,
  PreviewPoolsClaim,
} from "./runtime-contract.js";

const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

function refusal<T>(kind: PoolsLaunchRefusalKind, message: string): PoolsLaunchOutcome<T> {
  return { ok: false, refusal: { kind, message } };
}

function amount(assetAddress: Address, rawWei: bigint, decimals: number, assetSymbol: string): PoolsAmount {
  return { rawWei: rawWei.toString(), decimals, assetAddress, assetSymbol };
}

/**
 * A desktop call has a session id and an address, not a wallet resolution, so
 * the signer comes from the trusted default path (main is the only caller) and
 * is CROSS-CHECKED against the address the call is about. Same construction as
 * the deploy path, and the same reason: a wallet switch must refuse rather than
 * answer about somebody else's fees.
 */
function desktopContext(): ProtocolExecutionContext {
  return {
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
  } as ProtocolExecutionContext;
}

export const previewPoolsClaim: PreviewPoolsClaim = async (session, inputs) => {
  const chainConfig = getLocalChain(POOLS_CHAIN_ID);
  if (!chainConfig) {
    return refusal("provider_unavailable", `Robinhood Chain (${POOLS_CHAIN_ID}) is not in the local chain registry.`);
  }

  let account: Address;
  let token: Address;
  try {
    account = getAddress(session.walletAddress);
    token = getAddress(inputs.tokenAddress);
  } catch {
    return refusal("invalid_inputs", "That is not a readable token address.");
  }

  const client = getLocalPublicClient(chainConfig);

  // WHICH SUITE HOLDS THE TOKEN, before any locker is addressed. The desktop
  // lane shares the agent lane's detection so the two cannot disagree about
  // where a token's fees live; each non-registered outcome keeps its own words,
  // because "we could not ask" is not "there is nothing here".
  let registration;
  try {
    registration = (await readPoolsOnChainSnapshot(token)).locker;
  } catch {
    return refusal(
      "provider_unavailable",
      "The chain could not be reached to find which pools.fun suite holds this token, so nothing about its "
        + "fees was established.",
    );
  }
  if (registration.status === "unavailable" || registration.status === "ambiguous") {
    return refusal("provider_unavailable", registration.detail);
  }
  if (registration.status === "unregistered") {
    return refusal(
      "invalid_inputs",
      `This token is ${POOLS_UNREGISTERED_SENTENCE}, so it has no creator fee stream to claim here.`,
    );
  }
  const suite = registration.suite;

  const context = await readPoolsClaimContext(client, token, account, suite);
  if (!context.ok) return refusal("provider_unavailable", context.reason);

  const simulation = await simulatePoolsClaim(client, {
    account,
    token,
    blockNumber: context.context.blockNumber,
    suite,
  });
  if (simulation.kind === "unavailable") {
    // NEVER rendered as zero: "we could not ask" and "there is nothing" are
    // different answers, and only one of them is about the pool.
    return refusal(
      "provider_unavailable",
      `This claim could not be simulated (${simulation.reason}), so what it would pay is unknown. This is not `
        + "a statement that there is nothing to claim.",
    );
  }

  const tokenRaw = simulation.kind === "would_pay" ? simulation.tokenAmountRaw : 0n;
  const pairedRaw = simulation.kind === "would_pay" ? simulation.pairedAmountRaw : 0n;
  const gasLimit = await estimatePoolsClaimGas(client, { account, token, locker: suite.locker as Address });
  const gasPrice = await readGasPrice(client);

  return {
    ok: true,
    value: {
      tokenAddress: token,
      tokenLeg: amount(token, tokenRaw, context.context.tokenDecimals, ""),
      pairedLeg: amount(context.context.pairedAsset, pairedRaw, context.context.pairedDecimals, ""),
      alreadyCollected: {
        tokenLeg: amount(
          token,
          context.context.alreadyCollected.token.amountRaw,
          context.context.alreadyCollected.token.decimals,
          "",
        ),
        pairedLeg: amount(
          context.context.pairedAsset,
          context.context.alreadyCollected.paired.amountRaw,
          context.context.alreadyCollected.paired.decimals,
          "",
        ),
      },
      // A CEILING on network cost, and zero when it could not be priced rather
      // than a guessed figure - the renderer shows "unknown" from the raw zero
      // paired with the absence of a gas limit, never an invented number.
      gasBound: amount(
        NATIVE_ADDRESS,
        gasLimit === null || gasPrice === null ? 0n : gasLimit * gasPrice,
        18,
        "ETH",
      ),
    },
  };
};

export const claimPoolsFees: ClaimPoolsFees = async (session, inputs) => {
  const chainConfig = getLocalChain(POOLS_CHAIN_ID);
  if (!chainConfig) {
    return refusal("provider_unavailable", `Robinhood Chain (${POOLS_CHAIN_ID}) is not in the local chain registry.`);
  }
  const signing = openLaunchSigningClients(desktopContext(), chainConfig);
  if (!signing.ok) return refusal("wallet_unavailable", signing.result.output);

  let expected: Address;
  try {
    expected = getAddress(session.walletAddress);
  } catch {
    return refusal("wallet_unavailable", "No usable wallet address was resolved for this session.");
  }
  const signer = getAddress(signing.clients.walletClient.account.address);
  if (signer !== expected) {
    return refusal(
      "wallet_unavailable",
      `This claim is for ${expected}, but the active signing wallet is ${signer}. Only the wallet a token's fee `
        + "stream points at can claim it, so nothing was signed.",
    );
  }

  // THE SAME HANDLER the agent calls. A second implementation of a signing path
  // is how the app and the agent start disagreeing about what a claim does.
  const result = await poolsClaimFeesHandler(
    { token: inputs.tokenAddress },
    { ...desktopContext(), sessionId: session.sessionId, sessionPermission: "full", approved: true },
  );

  const data = (result.data ?? {}) as Record<string, unknown>;
  const status = typeof data.status === "string" ? data.status : "unknown";
  const claimed = (data.claimed ?? {}) as Record<string, Record<string, unknown>>;
  if (status === "confirmed" && typeof data.txHash === "string") {
    return {
      ok: true,
      value: {
        tokenAddress: getAddress(String(data.tokenAddress)),
        txHash: data.txHash as Hex,
        activityId: Number(data._executionId),
        tokenLeg: amount(
          getAddress(String(claimed.tokenLeg?.assetAddress)),
          BigInt(String(claimed.tokenLeg?.amountRaw ?? "0")),
          Number(claimed.tokenLeg?.decimals ?? 18),
          "",
        ),
        pairedLeg: amount(
          getAddress(String(claimed.pairedLeg?.assetAddress)),
          BigInt(String(claimed.pairedLeg?.amountRaw ?? "0")),
          Number(claimed.pairedLeg?.decimals ?? 18),
          "",
        ),
      },
    };
  }
  // Pending, reverted, nothing-to-claim and refused all arrive here with the
  // handler's own sentence, which already says what happened and whether to
  // retry. Flattening them into "failed" would lose exactly that.
  return refusal("provider_unavailable", result.output);
};

export const listPoolsMyLaunches: ListPoolsMyLaunches = async (session, inputs) => {
  let wallet: Address;
  try {
    wallet = getAddress(session.walletAddress);
  } catch {
    return refusal("wallet_unavailable", "No usable wallet address was resolved for this session.");
  }

  try {
    const page = await getPoolsFunClient().discover({
      platform: "poolsfun",
      deployerAddress: wallet,
      sortBy: "deployedAt",
      order: "desc",
      limit: inputs.limit ?? 25,
    });
    const launches: PoolsMyLaunchRow[] = page.results.map((row) => ({
      tokenAddress: getAddress(row.tokenAddress),
      poolAddress: row.poolId === null ? null : (row.poolId as Address),
      name: row.name,
      symbol: row.symbol,
      pairedAsset: row.pairedAsset,
      launchedAt: row.deployedAt,
      txHash: null,
      feeRecipient: row.feeRecipientAddress === null || row.feeRecipientAddress === undefined
        ? null
        : (row.feeRecipientAddress as Address),
      // `claimable` is deliberately ABSENT rather than zero: it means NOT
      // MEASURED here. The app asks for a figure per token through
      // `previewClaim`, which simulates - and a list that quietly showed zeros
      // would tell a user their fees are gone.
    }));
    return { ok: true, value: { wallet, launches } };
  } catch (err) {
    return refusal(
      "provider_unavailable",
      `Your pools.fun launches could not be listed right now (${err instanceof Error ? err.name : "unknown"}).`,
    );
  }
};

export const getAwaitingPoolsLaunchForm: GetAwaitingPoolsLaunchForm = async (session) => {
  try {
    const awaiting = await getAwaitingForSession(session.sessionId);
    // The pools.fun rows only: the same table carries every launchpad's forms,
    // and the desktop's pools lane must not open another venue's launch in a
    // pools form.
    const row = awaiting.find((intent) => intent.protocol === "pools_fun");
    // `null` is the ORDINARY answer and is deliberately not an error: "nothing
    // is waiting" is what this question usually returns.
    if (row === undefined) return { ok: true, value: null };

    return {
      ok: true,
      value: {
        intentId: row.intentId,
        sessionId: row.sessionId,
        expiresAt: row.expiresAt,
        proposed: {
          name: row.name,
          symbol: row.symbol,
          ...(row.pools?.pairedAsset === undefined ? {} : { pairedAsset: row.pools.pairedAsset }),
          ...(row.imageId === null ? {} : { image: { kind: "locker" as const, imageId: row.imageId } }),
          ...(row.prebuyRaw === null || row.prebuyRaw === "0"
            ? {}
            : { prebuy: { amountHuman: formatPrebuy(row.prebuyRaw, row.prebuyDecimals) } }),
        },
      },
    };
  } catch (err) {
    return refusal(
      "provider_unavailable",
      `Whether a launch form is waiting could not be read (${err instanceof Error ? err.name : "unknown"}).`,
    );
  }
};

/** The stored prebuy as the form shows it. Decimals travel with the raw amount. */
function formatPrebuy(raw: string, decimals: number | null): string {
  const scale = decimals ?? 18;
  const value = BigInt(raw);
  const divisor = 10n ** BigInt(scale);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(scale, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

async function readGasPrice(client: ReturnType<typeof getLocalPublicClient>): Promise<bigint | null> {
  try {
    return await client.getGasPrice();
  } catch {
    return null;
  }
}
