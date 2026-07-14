/**
 * KyberSwap ZaaS zap-in handler — `kyberswap.zap.in`.
 */

import { getKyberZaasClient } from "@tools/kyberswap/zaas/client.js";
import {
  getKyberEvmClients,
  ensureKyberAllowance,
  sendKyberTransactionWithReceipt,
  extractMintedNftId,
  extractErc1155Position,
  verifyRouterAddress,
} from "@tools/kyberswap/evm-utils.js";
import { KS_ZAP_ROUTER_POSITION, NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import { resolveChainSlug } from "@tools/kyberswap/chains.js";
import { requireFeature } from "@tools/kyberswap/helpers.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";

import { isAddress, getAddress, type Hex } from "viem";
import type { ProtocolHandler } from "../../../types.js";
import { str, num, ok, fail } from "../../../handler-helpers.js";
import { buildPositionKey, formatZapPreview } from "./helpers.js";

export const zapIn: ProtocolHandler = async (p, ctx) => {
  const chain = str(p, "chain"), dex = str(p, "dex"), pool = str(p, "pool");
  const tokenIn = str(p, "tokenIn"), amountIn = str(p, "amountIn");
  if (!chain || !dex || !pool || !tokenIn || !amountIn) return fail("Missing required: chain, dex, pool, tokenIn, amountIn");

  // Validate tokenIn is a properly formatted address
  if (tokenIn.toLowerCase() !== NATIVE_TOKEN_ADDRESS.toLowerCase() && !isAddress(tokenIn)) {
    return fail(`Invalid tokenIn address: "${tokenIn}". Resolve via khalani.tokens.search first.`);
  }

  const slug = resolveChainSlug(chain);
  requireFeature(slug, "zaas");

  // Validate DEX is known and supports zap-in
  const { getZapDexConfig } = await import("@tools/kyberswap/zaas/zap-dexes/index.js");
  const zapDexConfig = getZapDexConfig(slug);
  const zapDexEntry = zapDexConfig?.dexes.find(d => d.id === dex);
  if (!zapDexEntry) return fail(`Unknown DEX "${dex}" on ${slug}. Query kyberswap.zap.list for supported DEXes.`);
  if (zapDexEntry.verification === "tbd") return fail(`DEX ${dex} classified as TBD — not yet safe for automated execution. Report to maintainers.`);
  if (!zapDexEntry.supports.includes("zap-in")) return fail(`DEX ${dex} on ${slug} is source-only — cannot be used as zap-in destination.`);

  const routeResp = await getKyberZaasClient().getZapInRoute(slug, {
    dex,
    "pool.id": pool,
    tokensIn: tokenIn,
    amountsIn: amountIn,
    slippage: num(p, "slippageBps"),
    "position.id": str(p, "positionRef") || undefined,
    "position.tickLower": num(p, "tickLower"),
    "position.tickUpper": num(p, "tickUpper"),
  });

  if (p.dryRun === true) {
    return ok({ dryRun: true, chain: slug, routerAddress: routeResp.data.routerAddress, ...formatZapPreview(routeResp.data.zapDetails) });
  }

  if (!routeResp.data.route || !routeResp.data.routerAddress) return fail("No zap route returned");
  verifyRouterAddress(routeResp.data.routerAddress, KS_ZAP_ROUTER_POSITION);

  // Per-session signing wallet (5D-protocols) — after dryRun gate, real exec only.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(ctx.walletResolution, ctx.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");

  const { publicClient, walletClient } = getKyberEvmClients(slug, signer.privateKey);
  if (tokenIn.toLowerCase() !== NATIVE_TOKEN_ADDRESS.toLowerCase()) {
    await ensureKyberAllowance(publicClient, walletClient, getAddress(tokenIn), routeResp.data.routerAddress, BigInt(amountIn));
  }

  const buildResp = await getKyberZaasClient().buildZapIn(slug, { sender: signer.address, recipient: signer.address, route: routeResp.data.route });
  // Verify the BUILD-response router before broadcasting (fail closed): the tx
  // target and approvals both flow to this address, so an attacker-controlled
  // build router is a direct theft vector.
  verifyRouterAddress(buildResp.data.routerAddress, KS_ZAP_ROUTER_POSITION);
  const { hash: txHash, receipt } = await sendKyberTransactionWithReceipt(publicClient, walletClient, { to: getAddress(buildResp.data.routerAddress), data: buildResp.data.callData as Hex, value: BigInt(buildResp.data.value) });

  // Capture position ref from receipt based on DEX family (R11: reuse zapDexEntry from above)
  let positionRef = str(p, "positionRef") || undefined;
  if (!positionRef) {
    switch (zapDexEntry.captureKind) {
      case "receiptNftMint":
        positionRef = extractMintedNftId(receipt.logs, signer.address) ?? undefined;
        break;
      case "receiptErc1155":
        positionRef = extractErc1155Position(receipt.logs, signer.address) ?? undefined;
        break;
      case "shareBalance":
      case "none":
        break;
    }
  }

  const zapDetails = routeResp.data.zapDetails;
  const vaultAddr = routeResp.data.poolDetails?.address;
  const positionKey = buildPositionKey(zapDexEntry, slug, pool, signer.address, positionRef, vaultAddr);

  return { success: true, output: JSON.stringify({ txHash, chain: slug, dex, pool, positionRef, ...formatZapPreview(zapDetails) }, null, 2), data: { txHash, _tradeCapture: {
    type: "lp", chain: slug, status: "executed", walletAddress: signer.address,
    positionKey, instrumentKey: `${slug}:lp:${pool}`,
    inputValueUsd: zapDetails?.initialAmountUsd,
    valuationSource: zapDetails?.initialAmountUsd ? "zaas_estimate" : "none",
    meta: { dex, pool, action: "zap-in", positionRef, zapDetails },
  } } };
};
