/**
 * KyberSwap limit order create handler — `kyberswap.limitOrder.create`.
 */

import { getKyberLimitOrderClient } from "@tools/kyberswap/limit-order/client.js";
import { signEip712Message } from "@tools/kyberswap/limit-order/signing.js";
import { verifyCreateOrderSignMessage } from "@tools/kyberswap/limit-order/sign-message-verification.js";
import { resolveTokenMetadataStrict, requireFeature, resolveChainWithId } from "@tools/kyberswap/helpers.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";

import { parseUnits, getAddress, type Address } from "viem";
import type { ProtocolHandler } from "../../../types.js";
import { str, ok, fail } from "../../../handler-helpers.js";
import { parseDuration } from "./helpers.js";

export const limitOrderCreate: ProtocolHandler = async (p, ctx) => {
  const chain = str(p, "chain"), makerAssetRaw = str(p, "makerAsset"), takerAssetRaw = str(p, "takerAsset");
  const makingAmountRaw = str(p, "makingAmount"), takingAmountRaw = str(p, "takingAmount"), expires = str(p, "expires");
  if (!chain || !makerAssetRaw || !takerAssetRaw || !makingAmountRaw || !takingAmountRaw || !expires)
    return fail("Missing required: chain, makerAsset, takerAsset, makingAmount, takingAmount, expires");

  const { slug, chainId } = resolveChainWithId(chain);
  requireFeature(slug, "limitOrder");
  // Session maker (5D-protocols) — address-only, no decrypt (pre-dryRun safe).
  let maker: Address;
  try {
    maker = getAddress(resolveSelectedAddress(ctx.walletResolution, ctx.walletPolicy, "eip155"));
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  // Strict: address-only for mutating limit orders
  const makerToken = await resolveTokenMetadataStrict(makerAssetRaw, chainId);
  const takerToken = await resolveTokenMetadataStrict(takerAssetRaw, chainId);
  const makingAmount = parseUnits(makingAmountRaw, makerToken.decimals).toString();
  const takingAmount = parseUnits(takingAmountRaw, takerToken.decimals).toString();

  const expiresSeconds = parseDuration(expires);
  const expiredAt = Math.floor(Date.now() / 1000) + expiresSeconds;

  // Get unsigned EIP-712
  const eip712 = await getKyberLimitOrderClient().getSignMessage({
    chainId: String(chainId),
    makerAsset: makerToken.address,
    takerAsset: takerToken.address,
    maker,
    makingAmount,
    takingAmount,
    expiredAt,
  });

  if (p.dryRun === true) {
    return ok({ dryRun: true, chain: slug, makerAsset: makerToken.symbol, takerAsset: takerToken.symbol, makingAmount, takingAmount, expiredAt, expiresAtIso: new Date(expiredAt * 1000).toISOString() });
  }

  // Signing wallet — decrypt AFTER the dryRun gate, real exec only.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(ctx.walletResolution, ctx.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");

  // Cross-check the returned EIP-712 message against the locally computed order
  // BEFORE signing — the API response is untrusted, and blind-signing a tampered
  // verifyingContract / amount / asset is a direct theft vector. Fail closed.
  verifyCreateOrderSignMessage(eip712, {
    chainId,
    maker,
    makerAsset: makerToken.address,
    takerAsset: takerToken.address,
    makingAmount,
    takingAmount,
    expiredAt,
  });

  // Sign
  const signature = await signEip712Message(signer.privateKey, eip712);

  // Create
  const result = await getKyberLimitOrderClient().createOrder({
    chainId: String(chainId),
    makerAsset: makerToken.address,
    takerAsset: takerToken.address,
    maker,
    makingAmount,
    takingAmount,
    expiredAt,
    salt: eip712.message.salt,
    signature,
  });

  return {
    success: true,
    output: JSON.stringify({ chain: slug, orderId: result.orderId, makerAsset: makerToken.symbol, takerAsset: takerToken.symbol, makingAmount, takingAmount, makingAmountHuman: makingAmountRaw, takingAmountHuman: takingAmountRaw, expiredAt, expiresAtIso: new Date(expiredAt * 1000).toISOString() }, null, 2),
    data: {
      orderId: result.orderId,
      _tradeCapture: {
        type: "order", chain: slug, status: "open",
        walletAddress: maker,
        positionKey: String(result.orderId),
        instrumentKey: `${slug}:lo:${makerToken.address}:${takerToken.address}`,
        inputTokenAddress: makerToken.address, inputToken: makerToken.symbol,
        outputTokenAddress: takerToken.address, outputToken: takerToken.symbol,
        inputAmount: makingAmount, outputAmount: takingAmount,
        meta: { orderType: "limitOrder", expiredAt },
      },
    },
  };
};
