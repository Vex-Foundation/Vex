/**
 * KyberSwap ZaaS zap-migrate handler — `kyberswap.zap.migrate`.
 */

import { getKyberZaasClient } from "@tools/kyberswap/zaas/client.js";
import {
  getKyberEvmClients,
  ensureKyberAllowance,
  sendKyberTransactionWithReceipt,
  extractMintedNftId,
  extractErc1155Position,
  ensureErc721Approval,
  ensureErc1155ApprovalForAll,
  verifyRouterAddress,
} from "@tools/kyberswap/evm-utils.js";
import { KS_ZAP_ROUTER_POSITION } from "@tools/kyberswap/constants.js";
import { resolveChainSlug } from "@tools/kyberswap/chains.js";
import { requireFeature } from "@tools/kyberswap/helpers.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";

import { getAddress, maxUint256, type Hex } from "viem";
import type { ProtocolHandler } from "../../../types.js";
import { str, num, ok, fail } from "../../../handler-helpers.js";
import { resolveZapApprovalTarget, buildPositionKey, formatZapPreview } from "./helpers.js";

export const zapMigrate: ProtocolHandler = async (p, ctx) => {
  const chain = str(p, "chain"), dexFrom = str(p, "dexFrom"), dexTo = str(p, "dexTo");
  const poolFrom = str(p, "poolFrom"), poolTo = str(p, "poolTo"), sourcePositionRef = str(p, "sourcePositionRef");
  if (!chain || !dexFrom || !dexTo || !poolFrom || !poolTo || !sourcePositionRef)
    return fail("Missing required: chain, dexFrom, dexTo, poolFrom, poolTo, sourcePositionRef");

  const slug = resolveChainSlug(chain);
  requireFeature(slug, "zaas");

  // Validate source and destination DEXes
  const { getZapDexConfig } = await import("@tools/kyberswap/zaas/zap-dexes/index.js");
  const dexConfig = getZapDexConfig(slug);
  const srcEntry = dexConfig?.dexes.find(d => d.id === dexFrom);
  const dstEntry = dexConfig?.dexes.find(d => d.id === dexTo);
  if (!srcEntry) return fail(`Unknown source DEX "${dexFrom}" on ${slug}. Query kyberswap.zap.list for supported DEXes.`);
  if (!dstEntry) return fail(`Unknown destination DEX "${dexTo}" on ${slug}. Query kyberswap.zap.list for supported DEXes.`);
  if (srcEntry.verification === "tbd") return fail(`DEX ${dexFrom} classified as TBD — not yet safe for automated execution.`);
  if (dstEntry.verification === "tbd") return fail(`DEX ${dexTo} classified as TBD — not yet safe for automated execution.`);
  if (!srcEntry.supports.includes("zap-migrate-source")) return fail(`DEX ${dexFrom} does not support zap-migrate-source.`);
  if (!dstEntry.supports.includes("zap-migrate-destination")) return fail(`DEX ${dexTo} does not support zap-migrate-destination.`);

  const collectFee = p.collectFee !== false; // default true
  const routeResp = await getKyberZaasClient().getZapMigrateRoute(slug, {
    dexFrom,
    dexTo,
    "poolFrom.id": poolFrom,
    "poolTo.id": poolTo,
    "positionFrom.id": sourcePositionRef,
    "positionTo.tickLower": num(p, "tickLower"),
    "positionTo.tickUpper": num(p, "tickUpper"),
    liquidityOut: str(p, "liquidity") || undefined,
    collectFee,
    slippage: num(p, "slippageBps"),
  });

  if (p.dryRun === true) {
    return ok({ dryRun: true, chain: slug, zapDetails: routeResp.data.zapDetails });
  }

  if (!routeResp.data.route || !routeResp.data.routerAddress) return fail("No zap route returned");
  const routerAddress = routeResp.data.routerAddress;
  verifyRouterAddress(routerAddress, KS_ZAP_ROUTER_POSITION);

  // Per-session signing wallet (5D-protocols) — after dryRun gate, real exec only.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(ctx.walletResolution, ctx.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");
  const { publicClient, walletClient } = getKyberEvmClients(slug, signer.privateKey);

  // Family-aware approval for source position — resolve target from approvalTargetKind (R1)
  const srcApprovalTarget = resolveZapApprovalTarget(srcEntry, poolFrom, routeResp);
  switch (srcEntry.approvalStandard) {
    case "erc721":
      await ensureErc721Approval(publicClient, walletClient, srcApprovalTarget, BigInt(sourcePositionRef), routerAddress);
      break;
    case "erc20":
      // Unlimited standing allowance is intentional here (not the exact-amount
      // doctrine used by swaps / zap-in). The erc20 approval standard covers
      // V2-like LP tokens and vault shares (positionRefKind "ownerAddress"),
      // whose source position is the wallet's on-chain LP/share BALANCE. The
      // exact amount the router pulls is not determinable pre-build: `liquidity`
      // is optional ("omit for full"), and `liquidityOut`/positionDetails.
      // liquidity are concentrated-liquidity units, not the raw ERC-20 amount
      // the router transfers. Approving an exact amount that undershoots would
      // revert a money-moving migration, so maxUint256 is passed AS the required
      // amount.
      await ensureKyberAllowance(publicClient, walletClient, srcApprovalTarget, routerAddress, maxUint256);
      break;
    case "erc1155":
      await ensureErc1155ApprovalForAll(publicClient, walletClient, srcApprovalTarget, routerAddress);
      break;
    case "none":
      break;
  }

  const buildResp = await getKyberZaasClient().buildZapMigrate(slug, { sender: signer.address, recipient: signer.address, route: routeResp.data.route });
  // Verify the BUILD-response router before broadcasting (fail closed): the tx
  // target and approvals both flow to this address, so an attacker-controlled
  // build router is a direct theft vector.
  verifyRouterAddress(buildResp.data.routerAddress, KS_ZAP_ROUTER_POSITION);
  const { hash: txHash, receipt } = await sendKyberTransactionWithReceipt(publicClient, walletClient, { to: getAddress(buildResp.data.routerAddress), data: buildResp.data.callData as Hex, value: BigInt(buildResp.data.value) });

  // Capture new position ref from receipt for destination DEX
  let newPositionRef: string | undefined;
  if (dstEntry.captureKind === "receiptNftMint") {
    newPositionRef = extractMintedNftId(receipt.logs, signer.address) ?? undefined;
  } else if (dstEntry.captureKind === "receiptErc1155") {
    newPositionRef = extractErc1155Position(receipt.logs, signer.address) ?? undefined;
  }

  const zapDetails = routeResp.data.zapDetails;
  const sourcePositionKey = buildPositionKey(srcEntry, slug, poolFrom, signer.address, sourcePositionRef);
  const dstVaultAddr = routeResp.data.poolDetails?.address;
  const newPositionKey = buildPositionKey(dstEntry, slug, poolTo, signer.address, newPositionRef, dstVaultAddr);

  // R6: Emit two capture items — close source + open destination
  const closeCapture = {
    type: "lp" as const, chain: slug, status: "executed" as const, walletAddress: signer.address,
    positionKey: sourcePositionKey, instrumentKey: `${slug}:lp:${poolFrom}`,
    valuationSource: "none" as const,
    meta: { dex: dexFrom, pool: poolFrom, action: "zap-out", positionRef: sourcePositionRef, collectFee, zapDetails },
  };
  const openCapture = {
    type: "lp" as const, chain: slug, status: "executed" as const, walletAddress: signer.address,
    positionKey: newPositionKey, instrumentKey: `${slug}:lp:${poolTo}`,
    inputValueUsd: zapDetails?.finalAmountUsd,
    valuationSource: (zapDetails?.finalAmountUsd ? "zaas_estimate" : "none") as string,
    meta: { dex: dexTo, pool: poolTo, action: "zap-in", positionRef: newPositionRef, zapDetails },
  };

  return { success: true, output: JSON.stringify({ txHash, chain: slug, sourcePositionRef, newPositionRef, from: poolFrom, to: poolTo, collectFee, ...formatZapPreview(zapDetails) }, null, 2), data: { txHash, _tradeCapture: closeCapture, _tradeCaptureItems: [closeCapture, openCapture] } };
};
