/**
 * Uniswap staged execution primitives — ERC-20 allowance reads/allowlist
 * (`erc20.ts`) and the sign/broadcast pair the execute handler stages around
 * `agent_activity.markActivityBroadcast` (`execute.ts`).
 *
 * Renamed from `uniswap-receipt-status.test.ts` — the old monolithic
 * `sendUniswapTransaction`/`ensureUniswapAllowanceExact` this file used to
 * test are gone (superseded by the staged flow the execute handler now owns
 * per-broadcast); the mined-revert-detection case they used to cover is a
 * generic `waitForSuccessfulReceipt` behavior already pinned by
 * `evm-chains/receipt-guard.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { keccak256, type Address, type Hex } from "viem";

import { ErrorCodes } from "../../../errors.js";
import { readUniswapAllowance } from "@tools/uniswap/erc20.js";
import { signUniswapTransaction, broadcastUniswapTransaction, buildApproveTx } from "@tools/uniswap/execute.js";

const TOKEN = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b" as Address;
const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2" as Address; // Robinhood SwapRouter02 (allowlisted)
const SIGNED_TX = "0x02f8b0018203118080825208808080c080a0" as Hex;

describe("readUniswapAllowance", () => {
  it("reads allowance(owner, spender) via the public client", async () => {
    const readContract = vi.fn().mockResolvedValue(123n);
    const client = { readContract };
    const allowance = await readUniswapAllowance(client as never, TOKEN, OWNER, ROUTER);
    expect(allowance).toBe(123n);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: TOKEN, functionName: "allowance", args: [OWNER, ROUTER] }),
    );
  });
});

describe("buildApproveTx", () => {
  it("encodes approve(spender, amount) targeting the token contract with zero value", () => {
    const tx = buildApproveTx(TOKEN, ROUTER, 500n);
    expect(tx.to.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(tx.value).toBe(0n);
    expect(tx.data.startsWith("0x095ea7b3")).toBe(true); // approve(address,uint256) selector
  });

  it("encodes a zero-amount reset identically shaped (USDT-style non-zero-to-non-zero guard)", () => {
    const tx = buildApproveTx(TOKEN, ROUTER, 0n);
    expect(tx.value).toBe(0n);
    expect(tx.data.startsWith("0x095ea7b3")).toBe(true);
  });
});

// ── Staged sign/broadcast (plan §11.1 durability contract) ──────────────────
//
// `signUniswapTransaction`/`broadcastUniswapTransaction` are the two halves the
// execute handler stages around `agent_activity.markActivityBroadcast` — the
// hash persisted BEFORE broadcast must be the SAME hash the node later
// confirms, so `signUniswapTransaction` derives it locally from the signed
// bytes rather than trusting a value returned only after broadcast.

// `null` = "prepared request carries no nonce" (an explicit `undefined` arg would
// trigger the JS default and silently re-inject 7).
function stagedClients(nonce: number | null = 7) {
  const prepareTransactionRequest = vi.fn().mockResolvedValue({
    account: { address: OWNER },
    chain: { id: 4663 },
    to: ROUTER,
    data: "0x",
    value: 0n,
    ...(nonce === null ? {} : { nonce }),
  });
  const signTransaction = vi.fn().mockResolvedValue(SIGNED_TX);
  const sendRawTransaction = vi.fn().mockResolvedValue(keccak256(SIGNED_TX));
  const walletClient = {
    account: { address: OWNER },
    chain: { id: 4663 },
    prepareTransactionRequest,
    signTransaction,
  };
  const publicClient = { sendRawTransaction };
  return { walletClient, publicClient, prepareTransactionRequest, signTransaction, sendRawTransaction };
}

describe("signUniswapTransaction", () => {
  it("prepares, signs, and derives the tx hash locally from the signed bytes", async () => {
    const { walletClient } = stagedClients();
    const signed = await signUniswapTransaction(walletClient as never, { to: ROUTER, data: "0x", value: 0n });
    expect(signed.serializedTransaction).toBe(SIGNED_TX);
    expect(signed.txHash).toBe(keccak256(SIGNED_TX));
    expect(signed.fromAddress).toBe(OWNER);
    expect(signed.nonce).toBe(7);
  });

  it("throws when the prepared request has no resolved nonce", async () => {
    const { walletClient } = stagedClients(null);
    await expect(
      signUniswapTransaction(walletClient as never, { to: ROUTER, data: "0x", value: 0n }),
    ).rejects.toMatchObject({ code: ErrorCodes.SWAP_FAILED });
  });
});

describe("broadcastUniswapTransaction", () => {
  it("submits the signed bytes via sendRawTransaction and returns the node's hash", async () => {
    const { publicClient, sendRawTransaction } = stagedClients();
    const hash = await broadcastUniswapTransaction(publicClient as never, SIGNED_TX);
    expect(sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: SIGNED_TX });
    expect(hash).toBe(keccak256(SIGNED_TX));
  });
});
