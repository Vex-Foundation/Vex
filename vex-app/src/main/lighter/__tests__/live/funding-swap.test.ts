/**
 * LIVE STEP 1 (funding) - swap native ETH for USDG on Robinhood Chain through
 * Vex's own Uniswap tools, so the Lighter deposit step has something to deposit.
 *
 * Gated by `VEX_LIGHTER_LIVE_FUNDING_SWAP=1`. Run BEFORE the deposit step; the
 * deposit amount is the USDG this step CONFIRMS RECEIVED, never the USDG the
 * quote predicted.
 *
 * THIS DRIVES THE OTHER APPROVAL ROUTE. Every Lighter write in this directory is
 * a prepared-action tool: the turn loop resolves a follow-up and dispatches it
 * through a trusted hop. `uniswap__swap_execute` is not one. It is an ordinary
 * mutating tool, so in a restricted session it simply comes back with
 * `pendingApproval` and the orchestrator enqueues the card itself
 * (`turn-loop-tool-batch.ts:322` -> `enqueueApprovalIntent`). This step drives
 * exactly that pair of production functions through
 * `dispatchAndEnqueueExecuteApproval`, and decides the card with the same
 * `prepareApprove` the IPC approve handler calls.
 *
 * THE GATES ALL FIRE BEFORE ANYTHING IS PREPARED, because a mistyped amount
 * must be a no-op rather than an unresolved intent:
 *   1. the amount parses with the production decimal parser;
 *   2. the wallet's LIVE native balance covers it plus a reserve, so the swap
 *      cannot leave the wallet unable to pay for the transactions that follow
 *      it (the deposit's own gas among them);
 *   3. the chain is 4663 and it has a verified Vex Uniswap deployment;
 *   4. the wallet is the owner's.
 *
 * Then, after the card exists and BEFORE the decision, the card is read back
 * from `approval_intents.preview_json` and compared against what this run asked
 * for. A mismatch stops the run with nothing signed.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getAddress } from "viem";

vi.mock("electron", async () => (await import("./harness.js")).electronMainStub());

import {
  approveAndResume,
  cardCriticalArgs,
  createLiveSession,
  dispatchAndEnqueueExecuteApproval,
  flagEnabled,
  installLighterProductionSeams,
  isDryRun,
  LIVE_FLAGS,
  LiveHarnessRefusal,
  openEvidence,
  pollUntil,
  printInspectionSql,
  readApprovalRecord,
  requireLiveTarget,
  runReadTool,
  type EvidenceWriter,
  type LiveSession,
  type LiveTarget,
} from "./harness.js";

const describeLive = flagEnabled(LIVE_FLAGS.fundingSwap) ? describe : describe.skip;

const SWAP_AMOUNT_ENV = "VEX_LIGHTER_LIVE_SWAP_ETH_AMOUNT";

/** Robinhood Chain. The swap, the deposit and the Lighter account all live here. */
const CHAIN_ID = 4663;
const CHAIN_KEY = "robinhood";

/** USDG on Robinhood Chain: Lighter's settlement asset, and this swap's output. */
const USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const USDG_DECIMALS = 6;

/**
 * Native ETH the swap may NOT spend, in wei (0.005 ETH).
 *
 * The swap is not the last transaction this wallet has to pay for: the Vex fee
 * leg follows it, and the Lighter deposit's approve and transfer follow that. A
 * swap that consumed the whole balance would leave the deposit unable to
 * broadcast, which is a worse outcome than a smaller swap.
 */
const NATIVE_RESERVE_WEI = 5_000_000_000_000_000n;

const NATIVE_DECIMALS = 18;

let disposeSeams: (() => void) | null = null;
let session: LiveSession | null = null;
let evidence: EvidenceWriter | null = null;
let target: LiveTarget | null = null;
const approvalIds: string[] = [];

interface ChainBalances {
  readonly nativeWei: bigint;
  readonly usdgUnits: bigint;
}

/**
 * The wallet's live balances on Robinhood Chain, through the production reader
 * the wallet surfaces use (`readLocalChainBalances`). No RPC URL and no ABI is
 * written here.
 */
async function readChainBalances(walletAddress: string): Promise<ChainBalances> {
  const [{ getLocalChain }, { readLocalChainBalances }] = await Promise.all([
    import("@tools/evm-chains/registry.js"),
    import("@tools/evm-chains/balances.js"),
  ]);
  const config = getLocalChain(CHAIN_ID);
  if (config === undefined) {
    throw new LiveHarnessRefusal(
      `Chain ${CHAIN_ID} is not a configured local chain in this install, so its balances cannot be read. `
      + "Nothing was prepared, signed or submitted.",
    );
  }
  const read = await readLocalChainBalances(config, walletAddress, [getAddress(USDG_ADDRESS)]);
  const usdg = read.tokens.find((token) => getAddress(token.address) === getAddress(USDG_ADDRESS));
  const failure = read.tokenFailures.find((row) => getAddress(row.address) === getAddress(USDG_ADDRESS));
  if (usdg === undefined && failure !== undefined) {
    // A read that FAILED is not a zero balance, and treating it as one would
    // report a swap as uncredited or as credited by the wrong amount.
    throw new LiveHarnessRefusal(
      `The USDG balance of ${walletAddress} could not be READ on chain ${CHAIN_ID} (${failure.reason}). `
      + "Nothing is known about it, so this run fails closed rather than guessing.",
    );
  }
  return { nativeWei: read.nativeWei, usdgUnits: usdg?.balanceWei ?? 0n };
}

/**
 * THE AMOUNT GATES, all of them before anything is prepared. The parser is the
 * production one the Lighter deposit path uses, so "1e-3", "abc" and an amount
 * with too many decimals are refused here for the same reason and with the same
 * arithmetic they would be refused later.
 */
async function requireSwapAmount(balances: ChainBalances): Promise<{ readonly amountIn: string; readonly amountWei: bigint }> {
  const { decimalToBaseUnits } = await import("@tools/lighter/wallet-funding/onboarding-plan.js");
  const raw = process.env[SWAP_AMOUNT_ENV]?.trim();
  if (raw === undefined || raw.length === 0) {
    throw new LiveHarnessRefusal(
      `${SWAP_AMOUNT_ENV} is not set. It must be the amount of native ETH to swap, in human decimals, for `
      + "example \"0.01\". Nothing was prepared, signed or submitted.",
    );
  }
  let amountWei: bigint;
  try {
    amountWei = decimalToBaseUnits(raw, NATIVE_DECIMALS);
  } catch (cause) {
    throw new LiveHarnessRefusal(
      `${SWAP_AMOUNT_ENV} is "${raw}", which is not a valid ETH amount `
      + `(${cause instanceof Error ? cause.message : String(cause)}). Nothing was prepared, signed or submitted.`,
    );
  }
  if (amountWei <= 0n) {
    throw new LiveHarnessRefusal(
      `${SWAP_AMOUNT_ENV} is "${raw}", which is not a positive amount. Nothing was prepared, signed or `
      + "submitted.",
    );
  }
  const spendable = balances.nativeWei > NATIVE_RESERVE_WEI ? balances.nativeWei - NATIVE_RESERVE_WEI : 0n;
  if (amountWei > spendable) {
    throw new LiveHarnessRefusal(
      `${SWAP_AMOUNT_ENV} is "${raw}" (${amountWei} wei), but the wallet holds ${balances.nativeWei} wei on `
      + `chain ${CHAIN_ID} and this run keeps ${NATIVE_RESERVE_WEI} wei back for the fee leg and the deposit `
      + `that follow, leaving ${spendable} wei spendable. Nothing was prepared, signed or submitted.`,
    );
  }
  return { amountIn: raw, amountWei };
}

/**
 * THE CARD, checked against what this run asked for, BEFORE the decision.
 *
 * The card is the sentence a human approves. Every field below is on it because
 * the outcome depends on it, and each is compared rather than merely recorded.
 *
 * ONE HONEST GAP: `criticalArgs` carries no wallet address. The preview's
 * allow-list (`approval-intent-preview.ts` `PREVIEW_KEY_ALLOWLIST`) has no
 * `walletAddress` key, so the SPENDING WALLET is not a field on the card; what
 * the card does carry is the chain, inside the spendability line. The wallet is
 * bound instead by the session the approval belongs to - the executor resolves
 * the signing wallet from that same session selection - so this check asserts
 * the session's selected wallet and NAMES the gap rather than pretending the
 * card showed it.
 */
function assertSwapCardBinding(input: {
  readonly criticalArgs: Record<string, unknown>;
  readonly amountIn: string;
  readonly slippageBps: number;
}): { readonly quoteBinding: string; readonly spendability: string } {
  const say = (message: string): never => {
    throw new LiveHarnessRefusal(`${message} Refusing before the approval decision; nothing was signed.`);
  };

  if (String(input.criticalArgs["chain"]) !== CHAIN_KEY) {
    say(`The swap approval card is for chain "${String(input.criticalArgs["chain"])}", not "${CHAIN_KEY}".`);
  }
  if (String(input.criticalArgs["amountIn"]) !== input.amountIn) {
    say(
      `The swap approval card carries amountIn ${String(input.criticalArgs["amountIn"])}, not the requested `
      + `${input.amountIn} ETH.`,
    );
  }
  if (Number(input.criticalArgs["slippageBps"]) !== input.slippageBps) {
    say(
      `The swap approval card carries slippageBps ${String(input.criticalArgs["slippageBps"])}, not the `
      + `${input.slippageBps} this run quoted with; the execute would not match the quote.`,
    );
  }
  const tokenOut = String(input.criticalArgs["tokenOut"] ?? "");
  if (tokenOut.toLowerCase() !== USDG_ADDRESS.toLowerCase()) {
    say(`The swap approval card sends the output to ${tokenOut}, not USDG ${USDG_ADDRESS}.`);
  }

  const quoteBinding = String(input.criticalArgs["quoteBinding"] ?? "");
  if (!quoteBinding.includes("will not fill below")) {
    say(
      "The swap approval card states no minimum output, so the only price protection on the trade is not on "
      + `the card. It reads: ${quoteBinding || "(absent)"}.`,
    );
  }
  const spendability = String(input.criticalArgs["spendability"] ?? "");
  if (!spendability.includes(`chain ${CHAIN_ID}`)) {
    say(
      `The swap approval card's spendability line does not name chain ${CHAIN_ID}. It reads: `
      + `${spendability || "(absent)"}.`,
    );
  }
  if (!spendability.includes("wei/gas")) {
    say(
      "The swap approval card states no per-gas ceiling, so the fee bound the wallet is held to is not on "
      + `the card. It reads: ${spendability}.`,
    );
  }
  return { quoteBinding, spendability };
}

beforeAll(async () => {
  evidence = openEvidence("funding-swap");
  target = await requireLiveTarget();
  if (isDryRun()) {
    const { runMigrations } = await import("@vex-agent/db/migrate.js");
    await runMigrations();
  }
  disposeSeams = await installLighterProductionSeams();
  session = await createLiveSession(target, "funding-swap");
});

afterAll(async () => {
  if (session !== null) printInspectionSql(session.sessionId, approvalIds);
  disposeSeams?.();
  const { closePool } = await import("@vex-agent/db/client.js");
  await closePool();
});

function requireEvidence(): EvidenceWriter {
  if (evidence === null) throw new Error("The evidence writer was not opened.");
  return evidence;
}

function requireSession(): LiveSession {
  if (session === null) throw new Error("The live session was not created.");
  return session;
}

function requireTarget(): LiveTarget {
  if (target === null) throw new Error("The live target was not resolved.");
  return target;
}

describeLive("one live ETH to USDG swap on Robinhood Chain, through Vex's Uniswap tools", () => {
  it("quotes, parks the approval card, decides it and confirms the USDG received", { timeout: 900_000 }, async () => {
    const record = requireEvidence();
    const live = requireSession();
    const wallet = requireTarget();

    const { getUniswapDeployment } = await import("@tools/uniswap/deployments.js");
    const deployment = getUniswapDeployment(CHAIN_ID);
    if (deployment === undefined || deployment.key !== CHAIN_KEY) {
      throw new LiveHarnessRefusal(
        `Chain ${CHAIN_ID} has no verified Vex Uniswap deployment, so this swap has no route to take. `
        + "Nothing was prepared, signed or submitted.",
      );
    }

    const before = await readChainBalances(wallet.walletAddress);
    const amount = await requireSwapAmount(before);
    // The default: the same tolerance the quote and the execute must BOTH
    // carry, stated once here so the two calls cannot drift apart.
    const { VEX_DEFAULT_SLIPPAGE_BPS } = await import("@vex-agent/tools/protocols/slippage-policy.js");
    const slippageBps = VEX_DEFAULT_SLIPPAGE_BPS;

    record.record("target", {
      chainId: CHAIN_ID,
      chainKey: CHAIN_KEY,
      walletAddress: wallet.walletAddress,
      sessionId: live.sessionId,
      dryRun: isDryRun(),
      amountIn: amount.amountIn,
      amountWei: amount.amountWei.toString(),
      slippageBps,
      balancesBefore: {
        nativeWei: before.nativeWei.toString(),
        usdgUnits: before.usdgUnits.toString(),
      },
      nativeReserveWei: NATIVE_RESERVE_WEI.toString(),
      usdgAddress: USDG_ADDRESS,
    });

    const swapParams = {
      chain: CHAIN_KEY,
      tokenIn: "ETH",
      tokenOut: USDG_ADDRESS,
      amountIn: amount.amountIn,
      slippageBps,
    };

    // ── The quote: it prices nothing on chain and seeds the prequote the
    // execute is matched against. Identical params, or the execute refuses.
    const quote = await runReadTool({
      sessionId: live.sessionId,
      publicName: "uniswap__swap_quote",
      params: swapParams,
    });
    expect(quote.success, quote.output).toBe(true);
    const quoteJson = quote.json as Record<string, unknown> | null;
    record.record("quote", { params: swapParams, quote: quote.output });

    const eligibility = (quoteJson?.["eligibility"] as Record<string, unknown> | undefined)?.["status"]
      ?? quoteJson?.["eligibility"];
    if (String(eligibility) !== "executable") {
      throw new LiveHarnessRefusal(
        `The quote's eligibility is "${String(eligibility)}", and only "executable" authorizes an execute. `
        + `Nothing was prepared, signed or submitted. Quote: ${quote.output}`,
      );
    }

    // ── The execute: an ORDINARY mutating tool, so the card is enqueued by the
    // orchestrator's own route rather than by a prepared-action follow-up.
    const parked = await dispatchAndEnqueueExecuteApproval({
      sessionId: live.sessionId,
      publicName: "uniswap__swap_execute",
      params: swapParams,
    });
    approvalIds.push(parked.approvalId);

    const card = await readApprovalRecord(parked.approvalId);
    expect(card.queueStatus).toBe("pending");
    expect(card.decision).toBeNull();
    expect(card.executionStatus).toBe("not_started");
    expect(card.actionKind).toBe("user_wallet_broadcast");
    const criticalArgs = cardCriticalArgs(card);
    const bound = assertSwapCardBinding({ criticalArgs, amountIn: amount.amountIn, slippageBps });

    record.record("card", {
      approvalId: parked.approvalId,
      approvalCard: card,
      criticalArgs,
      quoteBinding: bound.quoteBinding,
      spendability: bound.spendability,
      walletBinding:
        "The approval preview's allow-list carries no walletAddress key, so the SPENDING WALLET is not a "
        + "field on this card; it is bound by the session the approval belongs to, whose selected wallet is "
        + `${wallet.walletAddress}. Named as a gap rather than asserted against a field that does not exist.`,
      sessionSelectedWallet: wallet.walletAddress,
    });

    if (isDryRun()) return;

    const executed = await approveAndResume(parked.approvalId);
    record.record("executed", {
      approvalId: parked.approvalId,
      executionStatus: executed.executionStatus,
      resumeToolOutput: executed.toolResult.output,
    });
    expect(executed.toolResult.success, executed.toolResult.output).toBe(true);

    // ── The world's answer, not the tool's. The deposit step's amount is the
    // USDG this read CONFIRMS, never the USDG the quote predicted.
    const credited = await pollUntil(
      { attempts: 20, intervalMs: 6_000, what: "the USDG balance rose" },
      () => readChainBalances(wallet.walletAddress),
      (attempt) => attempt.usdgUnits > before.usdgUnits,
    );
    const after = credited.attempts.at(-1) ?? before;
    const receivedUnits = after.usdgUnits > before.usdgUnits ? after.usdgUnits - before.usdgUnits : 0n;
    // The whole-number USDG the deposit step should be given. Rounded DOWN,
    // because a deposit larger than the wallet holds is refused at its own gate.
    const depositWholeUsdg = receivedUnits / (10n ** BigInt(USDG_DECIMALS));

    record.record("balance", {
      settled: credited.settled,
      usdgBefore: before.usdgUnits.toString(),
      usdgAfter: after.usdgUnits.toString(),
      receivedUnits: receivedUnits.toString(),
      usdgDecimals: USDG_DECIMALS,
      nativeBefore: before.nativeWei.toString(),
      nativeAfter: after.nativeWei.toString(),
      depositWholeUsdg: depositWholeUsdg.toString(),
      nextStep:
        `Run the deposit step with VEX_LIGHTER_LIVE_DEPOSIT_AMOUNT=${depositWholeUsdg.toString()} - the USDG `
        + "this read CONFIRMED, not the amount the quote predicted.",
    });
    process.stdout.write(`${JSON.stringify({
      event: "lighter.live.funding_swap_received",
      receivedUnits: receivedUnits.toString(),
      depositWholeUsdg: depositWholeUsdg.toString(),
    })}\n`);

    expect(credited.settled, `USDG did not arrive: before ${before.usdgUnits}, after ${after.usdgUnits}`).toBe(true);
    expect(receivedUnits > 0n).toBe(true);
  });
});
