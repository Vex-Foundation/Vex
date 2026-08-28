/**
 * `WalletWrapPrepare`. Signs nothing, spends nothing, writes ONE durable
 * `wallet_wrap_intents` row.
 *
 * The order of operations is the contract, and each step exists because the
 * next one would otherwise be dishonest:
 *
 *  1. validate shape, and refuse a caller-supplied redirect field BY NAME;
 *  2. resolve the chain and the session's selected wallet ADDRESS (no decrypt);
 *  3. look the chain up in the VERIFIED wrapped-native registry - an
 *     unregistered chain is refused by name here, before anything is derived,
 *     because there is no address to derive a transaction against;
 *  4. DERIVE the `{ to, data, value }` triple locally from the bound fields;
 *     the caller never supplies bytes, so there is nothing to decode;
 *  5. check the balance on the side this direction actually spends;
 *  6. simulate with `eth_call` from the selected wallet, surfacing the decoded
 *     revert reason;
 *  7. require the MANDATORY gas caps; a missing cap refuses BY NAME and carries
 *     the current network estimate as a labelled hint;
 *  8. render the card and compute the VERSIONED digest over every sign-relevant
 *     field, the card included;
 *  9. INSERT the intent under the session control lock.
 *
 * Steps 3 to 8 all run BEFORE step 9, so every refusal above leaves no row
 * behind and nothing to cancel.
 *
 * WHAT IS STRUCTURALLY ABSENT: there is no fee planning, no quote, no slippage,
 * no route and no recipient. The conversion is 1:1 by the contract's
 * construction and the contract credits `msg.sender`, so none of those inputs
 * exists to be supplied, bounded or displayed.
 */

import { randomUUID } from "node:crypto";

import * as wrapIntentsRepo from "@vex-agent/db/repos/wallet-wrap-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { WRAP_PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-wrap-intent.js";
import {
  getWrappedNativeContract,
  listWrappedNativeChainSlugs,
} from "@tools/evm-chains/wrapped-native.js";

import type { ToolResult } from "../../../types.js";
import type { InternalToolContext } from "../../types.js";
import { resolveSelectedAddress, walletScopeErrorToResult } from "../resolve.js";
import { WALLET_INTENT_TTL_MS } from "../send-types.js";
import { forbiddenRedirectFieldRefusal, parseEvmFeeBounds } from "../transaction/fee-bounds.js";

import { deriveWrapTransaction, isWrapDirection, type WrapDirection } from "./calldata.js";
import { defaultWrapChainFactory, type WrapChainFactory, type WrapSimulationCall } from "./chain.js";
import { formatWrapAmountHuman, isWrapEvmFeeBounds, renderWrapPreview } from "./preview.js";
import { computeWrapProposalDigest } from "./proposal-digest.js";
import { refuse, type WrapOutcome } from "./refusal.js";
import {
  fromTransactionRefusal,
  requireWrapAmountRaw,
  requireWrapString,
  wrapRefusalToResult,
} from "./tool-io.js";

function requireDirection(params: Record<string, unknown>): WrapOutcome<WrapDirection> {
  const raw = requireWrapString(params, "direction");
  if (!raw.ok) return raw;
  if (!isWrapDirection(raw.value)) {
    return refuse(
      "invalid_input",
      "`direction` must be either `wrap` (native into wrapped-native) or `unwrap` (wrapped-native "
      + `back into native). Received \`${raw.value}\`.`,
      { field: "direction" },
    );
  }
  return { ok: true, value: raw.value };
}

export async function handleWalletWrapPrepare(
  params: Record<string, unknown>,
  context: InternalToolContext,
  chainFactory: WrapChainFactory = defaultWrapChainFactory,
): Promise<ToolResult> {
  // 1. A caller-supplied field that could redirect funds or restate a bound
  // value is refused BY NAME rather than silently dropped, so the model learns
  // the field does not exist instead of believing it was honoured.
  const forbidden = forbiddenRedirectFieldRefusal(params);
  if (forbidden !== null) {
    return wrapRefusalToResult({
      code: "forbidden_field",
      message: forbidden.message,
      details: forbidden.details,
    });
  }

  const chainInput = requireWrapString(params, "chain");
  if (!chainInput.ok) return wrapRefusalToResult(chainInput.refusal);

  const direction = requireDirection(params);
  if (!direction.ok) return wrapRefusalToResult(direction.refusal);

  const amountRaw = requireWrapAmountRaw(params, "amountRaw");
  if (!amountRaw.ok) return wrapRefusalToResult(amountRaw.refusal);

  // 2. The chain, and the session's SELECTED ADDRESS. Nothing is decrypted:
  // prepare proves what would be signed, it does not sign.
  let chain;
  try {
    chain = await chainFactory(chainInput.value);
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  let walletAddress: string;
  try {
    walletAddress = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  // 3. THE CAPABILITY GATE. A chain Vex has not verified a wrapped-native
  // contract on is refused by name, with the verified set named, and never
  // resolved from another table: the pricing and recording tables answer
  // different questions and a wrong address here is the user's funds sent to a
  // contract that will not give them back.
  const contract = getWrappedNativeContract(chain.chainId);
  if (contract === undefined) {
    return wrapRefusalToResult({
      code: "unverified_chain",
      message:
        `Refusing to prepare: Vex has not verified a wrapped-native contract on ${chain.chainAlias} `
        + `(chain id ${chain.chainId}), so there is no contract identity it can bind this conversion `
        + "to. Nothing was prepared. Wrapping is available on: "
        + `${listWrappedNativeChainSlugs().join(", ")}.`,
      details: {
        chain: chain.chainAlias,
        chainId: String(chain.chainId),
        verifiedChains: listWrappedNativeChainSlugs().join(","),
      },
    });
  }

  // 4. The triple, derived LOCALLY from bound fields. Confirm re-derives it
  // from the same fields and compares all three before signing.
  const amount = BigInt(amountRaw.value);
  const transaction = deriveWrapTransaction({
    direction: direction.value,
    contract,
    amountRaw: amount,
  });

  const call: WrapSimulationCall = {
    from: walletAddress,
    to: transaction.to,
    data: transaction.data,
    valueWei: transaction.valueWei,
  };

  // 5. The balance on the side this direction SPENDS. A wrap spends native and
  // must also leave room for the gas ceiling the caller authorizes, but the
  // ceiling is not known until step 7, so the amount alone is checked here and
  // the combined check follows the fee bounds.
  const balanceCheck = await checkSpendableBalance(chain, contract.address, walletAddress, direction.value, amount, contract.symbol);
  if (!balanceCheck.ok) return wrapRefusalToResult(balanceCheck.refusal);

  // 6. Simulation, from the selected wallet, against current state.
  const simulated = await chain.simulate(call);
  if (!simulated.ok) return wrapRefusalToResult(simulated.refusal);

  // 7. The MANDATORY gas caps, through the existing fee-bounds parser. Vex
  // never derives a spending limit from a network estimate: the estimate only
  // travels inside the refusal as a labelled hint.
  const estimates = await chain.estimateFees(call);
  const parsedBounds = fromTransactionRefusal(parseEvmFeeBounds(params, estimates));
  if (!parsedBounds.ok) return wrapRefusalToResult(parsedBounds.refusal);
  const feeBounds = parsedBounds.value;
  if (!isWrapEvmFeeBounds(feeBounds)) {
    return wrapRefusalToResult({
      code: "missing_fee_bounds",
      message:
        "Refusing to prepare: this conversion is an EVM transaction and needs EVM gas caps. Nothing "
        + "was prepared.",
    });
  }

  // A wrap spends native AND pays gas in native out of the same balance, so the
  // authorized ceiling is checked against the sum. An unwrap spends the token
  // and pays gas in native, which are different balances.
  if (direction.value === "wrap") {
    const nativeBalance = BigInt(await chain.getNativeBalance(walletAddress));
    const ceiling = BigInt(feeBounds.maxTotalFeeWei);
    if (nativeBalance < amount + ceiling) {
      return wrapRefusalToResult({
        code: "insufficient_balance",
        message:
          `Refusing to prepare: wrapping ${formatWrapAmountHuman(amountRaw.value, contract.decimals)} `
          + `${chain.nativeSymbol} also needs up to `
          + `${formatWrapAmountHuman(feeBounds.maxTotalFeeWei, chain.nativeDecimals)} `
          + `${chain.nativeSymbol} for the network fee you authorized, and the wallet holds `
          + `${formatWrapAmountHuman(nativeBalance.toString(10), chain.nativeDecimals)} `
          + `${chain.nativeSymbol}. Nothing was prepared. Wrap a smaller amount, or lower the gas cap.`,
        details: {
          balanceRaw: nativeBalance.toString(10),
          amountRaw: amountRaw.value,
          maxTotalFeeWei: feeBounds.maxTotalFeeWei,
        },
      });
    }
  }

  // 8. The card and the digest, rendered from the SAME bound fields by the same
  // functions, so the stored card and the digested card cannot start out
  // disagreeing.
  const intentId = randomUUID();
  const expiresAt = new Date(Date.now() + WALLET_INTENT_TTL_MS).toISOString();
  const contractIdentity = {
    address: contract.address,
    symbol: contract.symbol,
    decimals: contract.decimals,
  };
  const digestInput = {
    intentId,
    walletAddress,
    chainAlias: chain.chainAlias,
    chainId: chain.chainId,
    direction: direction.value,
    contract: contractIdentity,
    amountRaw: amountRaw.value,
    payload: transaction,
    feeBounds,
    expiresAt,
  };
  const preview = renderWrapPreview(digestInput);
  const digest = computeWrapProposalDigest(digestInput);

  // 9. Under the session control lock, DB-only, committed before anything else:
  // creating the row is the moment the session gains live money state.
  await withSessionControlLock(context.sessionId, (client) =>
    wrapIntentsRepo.createWith(client, {
      intentId,
      sessionId: context.sessionId,
      walletAddress,
      chainAlias: chain.chainAlias,
      chainId: chain.chainId,
      direction: direction.value,
      contract: contractIdentity,
      amountRaw: amountRaw.value,
      payload: transaction,
      preview,
      feeBounds,
      proposalDigest: digest.digest,
      proposalDigestVersion: WRAP_PROPOSAL_DIGEST_VERSION,
      expiresAt,
    }),
  );

  return {
    success: true,
    output:
      `Prepared. Nothing was signed and nothing was spent. Confirm with WalletWrapConfirm and intent `
      + `id ${intentId} to broadcast it.`,
    data: {
      intentId,
      chain: chain.chainAlias,
      chainId: chain.chainId,
      walletAddress,
      status: "prepared",
      direction: direction.value,
      wrappedNativeContract: contractIdentity,
      amountRaw: amountRaw.value,
      amountHuman: formatWrapAmountHuman(amountRaw.value, contract.decimals),
      rate: "1:1",
      expiresAt,
      preview,
      approvedFeeBounds: feeBounds,
      nativeCurrency: { symbol: chain.nativeSymbol, decimals: chain.nativeDecimals },
    },
  };
}

/** The balance on the side the direction spends, before gas is known. */
async function checkSpendableBalance(
  chain: { getNativeBalance: (a: string) => Promise<string>; getWrappedBalance: (c: string, a: string) => Promise<string>; nativeSymbol: string; nativeDecimals: number },
  contractAddress: string,
  walletAddress: string,
  direction: WrapDirection,
  amount: bigint,
  wrappedSymbol: string,
): Promise<WrapOutcome<void>> {
  if (direction === "wrap") {
    const balance = BigInt(await chain.getNativeBalance(walletAddress));
    if (balance < amount) {
      return refuse(
        "insufficient_balance",
        `Refusing to prepare: the wallet holds `
        + `${formatWrapAmountHuman(balance.toString(10), chain.nativeDecimals)} ${chain.nativeSymbol} `
        + `and this would wrap ${formatWrapAmountHuman(amount.toString(10), chain.nativeDecimals)} `
        + `${chain.nativeSymbol}. Nothing was prepared.`,
        { balanceRaw: balance.toString(10), amountRaw: amount.toString(10) },
      );
    }
    return { ok: true, value: undefined };
  }

  const balance = BigInt(await chain.getWrappedBalance(contractAddress, walletAddress));
  if (balance < amount) {
    return refuse(
      "insufficient_balance",
      `Refusing to prepare: the wallet holds `
      + `${formatWrapAmountHuman(balance.toString(10), chain.nativeDecimals)} ${wrappedSymbol} and `
      + `this would unwrap ${formatWrapAmountHuman(amount.toString(10), chain.nativeDecimals)} `
      + `${wrappedSymbol}. Nothing was prepared.`,
      { balanceRaw: balance.toString(10), amountRaw: amount.toString(10) },
    );
  }
  return { ok: true, value: undefined };
}
