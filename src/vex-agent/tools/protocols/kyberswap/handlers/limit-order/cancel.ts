/**
 * KyberSwap limit order cancel handlers — gasless / hard / cancel-all.
 *
 * `kyberswap.limitOrder.cancel`, `.hardCancel`, `.cancelAll`.
 */

import { getKyberLimitOrderClient } from "@tools/kyberswap/limit-order/client.js";
import { signEip712Message } from "@tools/kyberswap/limit-order/signing.js";
import { verifyCancelOrderSignMessage } from "@tools/kyberswap/limit-order/sign-message-verification.js";
import {
  getKyberEvmClients,
  sendKyberTransaction,
} from "@tools/kyberswap/evm-utils.js";
import { DSLO_PROTOCOL } from "@tools/kyberswap/constants.js";
import { resolveChainWithId } from "@tools/kyberswap/helpers.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";

import { type Hex } from "viem";
import type { ProtocolHandler } from "../../../types.js";
import { str, num, fail } from "../../../handler-helpers.js";

export const limitOrderCancel: ProtocolHandler = async (p, ctx) => {
  const chain = str(p, "chain"), orderId = num(p, "orderId");
  if (!chain || orderId == null) return fail("Missing required: chain, orderId");
  const { slug, chainId } = resolveChainWithId(chain);
  // Gasless cancel signs an EIP-712 message — resolve the signing wallet.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(ctx.walletResolution, ctx.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");

  const eip712 = await getKyberLimitOrderClient().getCancelSignMessage({
    chainId: String(chainId),
    maker: signer.address,
    orderIds: [orderId],
  });
  // Cross-check the cancel sign-message before signing — only the allowlisted
  // DSLOProtocol on the requested chain may be signed for. Fail closed.
  verifyCancelOrderSignMessage(eip712, { chainId });
  const signature = await signEip712Message(signer.privateKey, eip712);
  await getKyberLimitOrderClient().cancelOrders({ ...eip712, signature });

  return { success: true, output: JSON.stringify({ chain: slug, orderId, method: "gasless", status: "cancelled" }, null, 2), data: { orderId: String(orderId), _tradeCapture: { type: "order", chain: slug, status: "cancelled", walletAddress: signer.address, positionKey: String(orderId), meta: { orderType: "limitOrder", method: "gasless" } } } };
};

export const limitOrderHardCancel: ProtocolHandler = async (p, ctx) => {
  const chain = str(p, "chain"), orderId = num(p, "orderId");
  if (!chain || orderId == null) return fail("Missing required: chain, orderId");
  const { slug } = resolveChainWithId(chain);
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(ctx.walletResolution, ctx.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");

  const encoded = await getKyberLimitOrderClient().encodeCancelBatch([orderId]);
  const { publicClient, walletClient } = getKyberEvmClients(slug, signer.privateKey);
  const txHash = await sendKyberTransaction(publicClient, walletClient, {
    to: DSLO_PROTOCOL,
    data: encoded.encodedData as Hex,
  });

  return { success: true, output: JSON.stringify({ chain: slug, orderId, txHash, method: "hard-cancel" }, null, 2), data: { txHash, orderId: String(orderId), _tradeCapture: { type: "order", chain: slug, status: "cancelled", walletAddress: signer.address, positionKey: String(orderId), signature: txHash, meta: { orderType: "limitOrder", method: "hard-cancel" } } } };
};

export const limitOrderCancelAll: ProtocolHandler = async (p, ctx) => {
  const chain = str(p, "chain");
  if (!chain) return fail("Missing required: chain");
  const { slug, chainId } = resolveChainWithId(chain);
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(ctx.walletResolution, ctx.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");
  const makerAddress = signer.address;

  // Prefetch active orders BEFORE nonce increase for per-order itemization.
  // Race condition: orders may fill between list and cancel — acceptable,
  // fill would have its own capture. Prefetch is best-effort.
  const loClient = getKyberLimitOrderClient();
  const activeOrders = await loClient.getOrders({
    chainId: String(chainId), maker: makerAddress, status: "active",
  });

  const encoded = await loClient.encodeIncreaseNonce(String(chainId));
  const { publicClient, walletClient } = getKyberEvmClients(slug, signer.privateKey);
  const txHash = await sendKyberTransaction(publicClient, walletClient, {
    to: DSLO_PROTOCOL,
    data: encoded.encodedData as Hex,
  });

  const captureItems = activeOrders.map(order => ({
    type: "order" as const, chain: slug, status: "cancelled" as const,
    walletAddress: makerAddress, positionKey: String(order.id),
    signature: txHash,
    meta: { orderType: "limitOrder", action: "cancelAll" },
  }));

  return { success: true, output: JSON.stringify({ chain: slug, txHash, method: "increase-nonce", cancelledCount: captureItems.length }, null, 2), data: { txHash, _tradeCapture: captureItems[0] ?? { type: "order", chain: slug, status: "cancelled", walletAddress: makerAddress, signature: txHash, meta: { orderType: "limitOrder", action: "cancelAll" } }, _tradeCaptureItems: captureItems.length > 0 ? captureItems : undefined } };
};
