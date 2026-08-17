import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import { LighterClient } from "@tools/lighter/client.js";
import {
  projectLighterDepositReceipt,
  proveLighterDepositCredit,
  proveLighterDepositL1,
} from "@tools/lighter/wallet-funding/deposit-evidence.js";
import {
  LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS,
  LIGHTER_DEPOSIT_CHAIN_ID,
} from "@tools/lighter/wallet-funding/constants.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";

const RUN_LIVE = process.env.VEX_LIGHTER_DEPOSIT_EVIDENCE_LIVE === "1";
const d = RUN_LIVE ? describe : describe.skip;

// Public historical Core deposit observed on 2026-08-17. This fixture contains
// no Vex wallet, credential, signature, or private material.
const L1_TX_HASH = "0xeb4cac8779af7de8737909220e4edc89973bb8c915f0a2db847214da9756a237";
const L1_WALLET = getAddress("0x16f037a3ddf53da1b047a926e1833219f0a8e1fc");
const ACCOUNT_INDEX = 677_540;
const ASSET_INDEX = 1;
const ROUTE_TYPE = 1;
const AMOUNT_UNITS = 201_934_092n;

d("Lighter live exact deposit evidence", () => {
  it("proves one real Ethereum deposit through Lighter execution and ownership", async () => {
    const deployment = getUniswapDeployment(LIGHTER_DEPOSIT_CHAIN_ID);
    if (deployment === undefined) {
      throw new Error("Ethereum mainnet is not configured for the live deposit proof");
    }
    const publicClient = getUniswapPublicClient(deployment);
    const receipt = await publicClient.getTransactionReceipt({ hash: L1_TX_HASH });
    const l1 = proveLighterDepositL1(projectLighterDepositReceipt(receipt), {
      txHash: L1_TX_HASH,
      gatewayAddress: LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS,
      walletAddress: L1_WALLET,
      recipientAddress: L1_WALLET,
      assetIndex: ASSET_INDEX,
      routeType: ROUTE_TYPE,
      amountUnits: AMOUNT_UNITS,
    });

    const lighter = new LighterClient();
    const [tx, accounts] = await Promise.all([
      lighter.getTxFromL1("core", { hash: L1_TX_HASH }),
      lighter.getAccountsByL1Address("core", { l1Address: L1_WALLET }),
    ]);
    const proof = proveLighterDepositCredit({ l1, tx, accounts });

    expect(proof).toMatchObject({
      txHash: L1_TX_HASH,
      accountIndex: ACCOUNT_INDEX,
      walletAddress: L1_WALLET,
      assetIndex: ASSET_INDEX,
      routeType: ROUTE_TYPE,
      amountUnits: AMOUNT_UNITS.toString(),
      lighterStatus: 3,
    });
  }, 60_000);
});
