/**
 * THE AUTHORITY FENCE BARRIERS, on real PostgreSQL, for BOTH families.
 *
 * The fence answers one question at three points: is the authority this
 * dispatch was approved under still the authority Vex holds? The two ways it
 * can stop being so are the two barriers injected here, and both are applied
 * exactly as production applies them:
 *
 *   LOCK       - `advanceStudioDispatchGeneration()`, the same durable advance
 *                `lockSecretSession` performs after its synchronous scrub;
 *   SCOPE      - the `sessions` wallet mirror that `updateProjectScope` writes
 *                for a project's backing session;
 *   PERMISSION - the `full` -> `restricted` flip on the same mirror. It moves
 *                neither the address nor the generation, so it is invisible to
 *                every other barrier, and it decides whether this dispatch
 *                needed an approval at all;
 *   WALLET ENTRY - the selection re-pointed at a DIFFERENT inventory id with the
 *                SAME address, which an address comparison cannot see.
 *
 * The last two say "two barriers" is now four; the file is the barrier matrix
 * and every fact the anchor binds gets a row in it.
 *
 * Each barrier is injected at each of the three points:
 *
 *   (a) between the preflight and the claim,
 *   (b) between the claim and the signature,
 *   (c) between the staged evidence and the submission,
 *
 * and each case proves BOTH halves: nothing signed or broadcast, AND the intent
 * is left in a state that recovery can drive to a correct terminal one.
 *
 * ## SEAM A, which these tests are the evidence for
 *
 *   - A lock that wins before the pre-sign fence prevents key loading and
 *     signing.
 *   - Once key loading and signing have begun, a lock cannot retroactively
 *     cancel the local signature.
 *   - The post-stage fence immediately before submission prevents broadcast when
 *     lock or scope revocation wins before submission.
 *   - A submission already invoked won the ordering: the outcome is ambiguous or
 *     chain-observed, never guessed.
 *   - `clearKeystorePasswordProvider` is defense in depth for FUTURE loads, not
 *     revocation of a materialized key.
 *
 * Only the WALLET RESOLUTION is faked (there is no keystore in an integration
 * run) and the chain is a seam by design. The intent rows, the claim
 * transaction, the fence reads, the session control lock, the staged-broadcast
 * primitive and the terminal settlement are all real.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPublicClient, createWalletClient, http, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base as baseChain } from "viem/chains";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedMessage,
} from "@solana/web3.js";

import { execute, queryOne } from "@vex-agent/db/client.js";
import * as intentsRepo from "@vex-agent/db/repos/wallet-transaction-intents.js";
import { PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { advanceStudioDispatchGeneration } from "@vex-agent/engine/core/approval-runtime/studio/dispatch-gate.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";

import { makeSession, resetDb } from "../setup/fixtures.js";

const EVM_ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`);
const WALLET = EVM_ACCOUNT.address;
const OTHER_WALLET = "0x9999999999999999999999999999999999999999";
const TO = "0x2222222222222222222222222222222222222222";
// REAL base58 keys, deterministic across runs: the canonical message below is
// deserialized and decoded by the production code, which rejects anything else.
const SOL_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(7));
const SOL_WALLET = SOL_KEYPAIR.publicKey.toBase58();
const SOL_OTHER = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58();
/** A syntactically valid blockhash: 32 zero bytes, base58. */
const BLOCKHASH = PublicKey.default.toBase58();

/** The canonical message the Solana intent carries, as prepare would store it. */
const SOL_MESSAGE_BASE64 = Buffer.from(
  new TransactionMessage({
    payerKey: SOL_KEYPAIR.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: SOL_KEYPAIR.publicKey,
        toPubkey: new PublicKey(SOL_OTHER),
        lamports: 1000,
      }),
    ],
  })
    .compileToV0Message()
    .serialize(),
).toString("base64");

/** No address lookup tables in this message, so the reader is never consulted. */
const NO_LOOKUPS = { getLookupTableAddresses: async () => null };

// The ONE fake: there is no keystore in an integration run. Both entry points
// answer for the same wallet, so a fence refusal is never a resolution failure
// wearing a fence's name.
const resolveSelectedAddress = vi.fn();
const resolveSigningWallet = vi.fn();
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress,
  resolveSigningWallet,
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : "wallet scope error",
  }),
}));

const { handleWalletEvmTransactionConfirm } = await import(
  "@vex-agent/tools/internal/wallet/transaction/confirm-evm.js"
);
const { handleWalletSolanaTransactionConfirm } = await import(
  "@vex-agent/tools/internal/wallet/transaction/confirm-solana.js"
);
const { digestOfIntent } = await import(
  "@vex-agent/tools/internal/wallet/transaction/revalidate.js"
);
const { canonicalTransactionPreview } = await import(
  "@vex-agent/tools/internal/wallet/transaction/preview.js"
);
const { decodeSolanaTransaction } = await import(
  "@vex-agent/tools/internal/wallet/transaction/decode-solana.js"
);

/**
 * The decoded effects the REAL decoder produces for the message above. Derived
 * rather than hand-written: `revalidateDecodedEffects` compares the stored
 * decode against a fresh one at commit time, so a hand-written approximation
 * would be refused before the fence was ever reached.
 */
const SOL_DECODED = await (async () => {
  const decoded = await decodeSolanaTransaction(
    VersionedMessage.deserialize(new Uint8Array(Buffer.from(SOL_MESSAGE_BASE64, "base64"))),
    NO_LOOKUPS,
  );
  if (!decoded.ok) throw new Error(`the fixture message does not decode: ${decoded.refusal.code}`);
  return decoded.value;
})();

// ── The two barriers, applied exactly as production applies them ───────

type Barrier = (sessionId: string) => Promise<void>;

/** The durable advance `lockSecretSession` performs after its synchronous scrub. */
const lockVex: Barrier = async () => {
  const advanced = await advanceStudioDispatchGeneration();
  if (!advanced.ok) throw new Error("the test barrier could not advance the generation");
};

/**
 * The backing-session PERMISSION mirror `updateProjectScope` writes when the
 * project's permission changes.
 *
 * `full` -> `restricted` is the dangerous direction and the one seeded here: it
 * moves neither the wallet address nor the dispatch generation, so before the
 * anchor carried the permission NOTHING in the fence could see it, and a
 * dispatch that was authorized without an approval kept signing under a
 * permission that now requires one.
 */
const flipPermission: Barrier = async (sessionId) => {
  await execute("UPDATE sessions SET permission = 'restricted' WHERE id = $1", [sessionId]);
};

/**
 * The SAME ADDRESS, a DIFFERENT wallet entry. Two inventory rows can carry one
 * public key, so an address comparison passes while the selection now points at
 * a reference the user did not authorize this dispatch under.
 */
function swapWalletEntry(family: "eip155" | "solana"): Barrier {
  return async (sessionId) => {
    await execute(
      family === "solana"
        ? "UPDATE sessions SET selected_solana_wallet_id = 'sol-duplicate' WHERE id = $1"
        : "UPDATE sessions SET selected_evm_wallet_id = 'evm-duplicate' WHERE id = $1",
      [sessionId],
    );
  };
}

/** The backing-session wallet mirror `updateProjectScope` writes on a scope edit. */
function editScope(family: "eip155" | "solana"): Barrier {
  return async (sessionId) => {
    await execute(
      family === "solana"
        ? `UPDATE sessions SET selected_solana_wallet_id = 'sol-2',
                               selected_solana_wallet_address = $2 WHERE id = $1`
        : `UPDATE sessions SET selected_evm_wallet_id = 'evm-2',
                               selected_evm_wallet_address = $2 WHERE id = $1`,
      [sessionId, family === "solana" ? SOL_OTHER : OTHER_WALLET],
    );
  };
}

const BARRIERS = ["lock", "scope", "permission", "wallet_entry"] as const;
type BarrierName = (typeof BARRIERS)[number];

function barrierFor(name: BarrierName, family: "eip155" | "solana"): Barrier {
  if (name === "lock") return lockVex;
  if (name === "scope") return editScope(family);
  if (name === "permission") return flipPermission;
  return swapWalletEntry(family);
}

// ── Fixtures ───────────────────────────────────────────────────────────

/**
 * Re-seed the single `studio_runtime_gate` row that migration 086 inserts.
 *
 * `resetDb` TRUNCATEs every table, which removes it, and a missing gate row
 * makes the fence refuse EVERYTHING - correctly, because a fence that cannot
 * read what it fences against has proven nothing. Production never reaches that
 * state (the migration seeds the row), so the fixture restores it rather than
 * the fence being softened to tolerate it.
 */
async function seedStudioGate(): Promise<void> {
  await execute(
    `INSERT INTO studio_runtime_gate (id, dispatch_generation)
     VALUES (1, 1) ON CONFLICT (id) DO NOTHING`,
  );
}

/** A session whose selected wallet mirror is the one the intent was prepared for. */
async function sessionWithWallet(): Promise<string> {
  const sessionId = await makeSession();
  // The id and the address move together: `chk_sessions_evm_wallet_atomic`
  // forbids half a selection, and the fence reads the address half.
  await execute(
    `UPDATE sessions
        SET selected_evm_wallet_id = 'evm-1', selected_evm_wallet_address = $2,
            selected_solana_wallet_id = 'sol-1', selected_solana_wallet_address = $3,
            permission = 'full'
      WHERE id = $1`,
    [sessionId, WALLET, SOL_WALLET],
  );
  return sessionId;
}

function evmRow(sessionId: string, intentId: string): intentsRepo.CreateWalletTransactionIntentInput {
  const base = {
    intentId,
    sessionId,
    walletAddress: WALLET,
    family: "eip155" as const,
    chainAlias: "base",
    chainId: 8453,
    payload: { family: "eip155" as const, evm: { to: TO, data: "0x", valueWei: "1000" } },
    decoded: {
      family: "eip155" as const,
      role: "native_transfer" as const,
      standard: "native" as const,
      functionName: "nativeTransfer",
      contract: null,
      criticalArgs: { recipient: TO, valueWei: "1000" },
      unlimitedApproval: false,
      warnings: [],
    },
    // V2: the card is bound into the digest and the binding refuses a row whose
    // stored card is not the one its own fields render, so it is DERIVED here.
    preview: canonicalTransactionPreview({
      family: "eip155",
      chainAlias: "base",
      decoded: {
        family: "eip155",
        role: "native_transfer",
        standard: "native",
        functionName: "nativeTransfer",
        contract: null,
        criticalArgs: { recipient: TO, valueWei: "1000" },
        unlimitedApproval: false,
        warnings: [],
      },
      feeBounds: {
        mode: "eip1559",
        gasLimit: "60000",
        maxFeePerGasWei: "1000000000",
        maxPriorityFeePerGasWei: "1000000",
        maxTotalFeeWei: "60000000000000",
      },
      evmValueWei: "1000",
    }),
    feeBounds: {
      mode: "eip1559" as const,
      gasLimit: "60000",
      maxFeePerGasWei: "1000000000",
      maxPriorityFeePerGasWei: "1000000",
      maxTotalFeeWei: "60000000000000",
    },
    proposalDigestVersion: PROPOSAL_DIGEST_VERSION,
    recentBlockhash: null,
    lastValidBlockHeight: null,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  return { ...base, proposalDigest: digestOfIntentInput(base) };
}

function solanaRow(
  sessionId: string,
  intentId: string,
): intentsRepo.CreateWalletTransactionIntentInput {
  const base = {
    intentId,
    sessionId,
    walletAddress: SOL_WALLET,
    family: "solana" as const,
    chainAlias: null,
    chainId: null,
    payload: {
      family: "solana" as const,
      solana: { messageBase64: SOL_MESSAGE_BASE64, feePayer: SOL_WALLET },
    },
    decoded: SOL_DECODED,
    preview: canonicalTransactionPreview({
      family: "solana",
      chainAlias: null,
      decoded: SOL_DECODED,
      feeBounds: {
        mode: "solana",
        computeUnitLimit: "200000",
        computeUnitPriceMicroLamports: "1000",
        baseFeeLamports: "5000",
        maxPriorityFeeLamports: "200",
        maxTotalFeeLamports: "10000",
      },
      // Solana charges no Vex fee on this lane (migration 088).
      evmValueWei: null,
    }),
    feeBounds: {
      mode: "solana" as const,
      computeUnitLimit: "200000",
      computeUnitPriceMicroLamports: "1000",
      baseFeeLamports: "5000",
      maxPriorityFeeLamports: "200",
      maxTotalFeeLamports: "10000",
    },
    proposalDigestVersion: PROPOSAL_DIGEST_VERSION,
    recentBlockhash: BLOCKHASH,
    lastValidBlockHeight: 1000,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  return { ...base, proposalDigest: digestOfIntentInput(base) };
}

/** The digest this build computes for the row these inputs become. */
function digestOfIntentInput(
  input: Omit<intentsRepo.CreateWalletTransactionIntentInput, "proposalDigest">,
): string {
  return digestOfIntent({
    ...input,
    proposalDigest: "",
    status: "pending",
    failureStage: null,
    activityId: null,
    consumedAt: null,
    cancelledAt: null,
    txHash: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
  } as intentsRepo.WalletTransactionIntent);
}

async function insert(
  input: intentsRepo.CreateWalletTransactionIntentInput,
): Promise<intentsRepo.WalletTransactionIntent> {
  await withSessionControlLock(input.sessionId, (client) => intentsRepo.createWith(client, input));
  const row = await intentsRepo.getById(input.intentId, input.sessionId);
  if (row === null) throw new Error("the intent was not persisted");
  return row;
}

function context(sessionId: string): InternalToolContext {
  return {
    sessionId,
    sessionPermission: "full",
    approved: false,
    walletResolution: {},
    walletPolicy: { kind: "none" },
  } as InternalToolContext;
}

interface Rows {
  status: string;
  failure_stage: string | null;
  tx_hash: string | null;
  activity_id: string | null;
}

function readIntent(intentId: string): Promise<Rows | null> {
  return queryOne<Rows>(
    `SELECT status, failure_stage, tx_hash, activity_id::text AS activity_id
       FROM wallet_transaction_intents WHERE intent_id = $1`,
    [intentId],
  );
}

// ── EVM ────────────────────────────────────────────────────────────────

const CHAIN: Chain = baseChain;

/**
 * A whole EVM confirm, with the chain and the signing client as seams and
 * everything else real. `at` names the moment the barrier fires.
 */
function evmDeps(
  sessionId: string,
  barrier: Barrier,
  at: "preflight" | "post_claim" | "post_sign" | "never",
) {
  const calls = { signed: 0, sent: 0, clientsBuilt: 0, walletsCreated: 0 };

  const chainFactory = vi.fn(async () => ({
    chainId: 8453,
    chainAlias: "base",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    simulate: async () => {
      // The LAST call before the claim, so a barrier here wins before it.
      if (at === "preflight") await barrier(sessionId);
      return { ok: true as const, value: undefined };
    },
    getCode: async () => "0x",
    estimateFees: async () => ({
      suggestedGasLimit: "21000",
      suggestedMaxFeePerGasWei: "1000000000",
      suggestedMaxPriorityFeePerGasWei: "1000000",
      suggestedGasPriceWei: "1000000000",
      supportsEip1559: true,
    }),
  }));

  const signingAccount = {
      ...EVM_ACCOUNT,
      // THE SIGNATURE, on the account rather than the client: the deferred arm
      // signs OFFLINE through the local account's own signer, because viem's
      // wallet action would ask the node for `eth_chainId` first and that round
      // trip is exactly what may not sit between the fence and the signature.
      signTransaction: vi.fn(async () => {
        calls.signed += 1;
        // The barrier lands AFTER the local signature and BEFORE the staged
        // evidence and the submission - the (c) window.
        if (at === "post_sign") await barrier(sessionId);
        return "0xdeadbeef" as Hex;
      }),
  };
  const walletClient = Object.assign(createWalletClient({
    account: signingAccount,
    chain: CHAIN,
    transport: http("http://127.0.0.1:1"),
  }), {
    account: signingAccount,
    chain: CHAIN,
    prepareTransactionRequest: vi.fn(),
    // Never reached on this arm; present so the fixture is the shape production
    // hands over, not a shape shaved to fit the assertion.
    signTransaction: vi.fn(async () => {
      throw new Error("the deferred arm must not reach viem's wallet action");
    }),
  });

  const publicClient = Object.assign(createPublicClient({
    chain: CHAIN,
    transport: http("http://127.0.0.1:1"),
  }), {
    chain: CHAIN,
    estimateGas: async () => 21_000n,
    prepareTransactionRequest: async () => ({
      to: TO,
      data: "0x" as Hex,
      value: 0n,
      gas: 42_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      nonce: 7,
      chain: CHAIN,
    }),
    sendRawTransaction: async () => {
      calls.sent += 1;
      return "0xhash" as Hex;
    },
    waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 1n }),
  });

  const signerClientsFactory = vi.fn(async () => {
    calls.clientsBuilt += 1;
    // Runs AFTER the claim committed and BEFORE the pre-sign fence - the (b)
    // window.
    if (at === "post_claim") await barrier(sessionId);
    return {
      publicClient,
      chain: CHAIN,
      createWalletClient: () => {
        calls.walletsCreated += 1;
        return walletClient;
      },
      chainName: "Base",
    };
  });

  return {
    calls,
    deps: {
      chainFactory,
      signerClientsFactory,
    },
  };
}

// ── Solana ─────────────────────────────────────────────────────────────

function solanaDeps(
  sessionId: string,
  barrier: Barrier,
  at: "preflight" | "post_claim" | "post_stage" | "never",
) {
  const calls = { signed: 0, submitted: 0 };
  let heightCalls = 0;

  const chainFactory = vi.fn(async () => ({
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000 }),
    getBlockHeight: async () => {
      heightCalls += 1;
      // Call 1 is the pre-claim revalidation; call 2 is the recheck immediately
      // before the fence, so a barrier there lands in the (b) window - after the
      // claim committed and before the fence reads.
      if (at === "post_claim" && heightCalls === 2) await barrier(sessionId);
      return 500;
    },
    getMessageFee: async () => 5200,
    estimateFees: async () => ({
      suggestedComputeUnitLimit: "200000",
      suggestedComputeUnitPriceMicroLamports: "1000",
    }),
    getLookupTableAddresses: async () => null,
    simulateMessage: async () => {
      if (at === "preflight") await barrier(sessionId);
      return { ok: true as const, value: undefined };
    },
  }));

  const signing = {
    sign: vi.fn(async () => {
      calls.signed += 1;
      // The barrier lands after the SIGNATURE and before the submission. The
      // staging write happens in between; the (c) fence is what must stop the
      // send.
      if (at === "post_stage") await barrier(sessionId);
      return {
        signature: "5".repeat(64),
        serialized: new Uint8Array([1, 2, 3]),
        // The MESSAGE BYTES ARE UNCHANGED: only the signature slot may differ,
        // which is what `revalidateMessageBytes` proves at this point.
        messageBase64: SOL_MESSAGE_BASE64,
        recentBlockhash: BLOCKHASH,
        lastValidBlockHeight: 1000,
      };
    }),
    submit: vi.fn(async () => {
      calls.submitted += 1;
      return { kind: "accepted" as const };
    }),
    confirm: vi.fn(async () => ({ phase: "confirmed" as const })),
  };

  return {
    calls,
    signing,
    deps: { chainFactory, signing },
  };
}

// ── The matrix ─────────────────────────────────────────────────────────

describe("the authority fence: EVM barriers at all three points", () => {
  beforeEach(async () => {
    await resetDb();
    await seedStudioGate();
    resolveSelectedAddress.mockReset().mockReturnValue(WALLET);
    resolveSigningWallet
      .mockReset()
      .mockReturnValue({ family: "eip155", address: WALLET, privateKey: `0x${"1".repeat(64)}` });
  });

  it("with NO barrier the same setup signs and broadcasts, so the refusals below are the fence", async () => {
    const sessionId = await sessionWithWallet();
    const intent = await insert(evmRow(sessionId, `wtx-${randomUUID()}`));
    const { calls, deps } = evmDeps(sessionId, lockVex, "never");

    const result = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      context(sessionId),
      deps,
    );

    expect(result.success).toBe(true);
    expect(calls.signed).toBe(1);
    expect(calls.sent).toBe(1);
    const row = await readIntent(intent.intentId);
    expect(row?.status).toBe("executed");
  });

  for (const name of BARRIERS) {
    it(`(a) a ${name} barrier between preflight and claim leaves the intent PENDING and unclaimed`, async () => {
      const sessionId = await sessionWithWallet();
      const intent = await insert(evmRow(sessionId, `wtx-${randomUUID()}`));
      const { calls, deps } = evmDeps(sessionId, barrierFor(name, "eip155"), "preflight");

      const result = await handleWalletEvmTransactionConfirm(
        { intentId: intent.intentId },
        context(sessionId),
        deps,
      );

      expect(result.success).toBe(false);
      expect(calls.signed).toBe(0);
      expect(calls.sent).toBe(0);
      expect(calls.clientsBuilt).toBe(0);
      // Nothing was claimed: the intent is exactly the shape from which
      // preparing again, or cancelling, or expiring, is safe.
      const row = await readIntent(intent.intentId);
      expect(row?.status).toBe("pending");
      expect(row?.activity_id).toBeNull();
      expect(row?.tx_hash).toBeNull();
    });

    it(`(b) a ${name} barrier between claim and sign signs NOTHING and terminalizes without a hash`, async () => {
      const sessionId = await sessionWithWallet();
      const intent = await insert(evmRow(sessionId, `wtx-${randomUUID()}`));
      const { calls, deps } = evmDeps(sessionId, barrierFor(name, "eip155"), "post_claim");

      const result = await handleWalletEvmTransactionConfirm(
        { intentId: intent.intentId },
        context(sessionId),
        deps,
      );

      expect(result.success).toBe(false);
      // SEAM A: a lock that wins BEFORE the pre-sign fence prevents key loading
      // and signing.
      expect(calls.walletsCreated).toBe(0);
      expect(calls.signed).toBe(0);
      expect(calls.sent).toBe(0);
      const row = await readIntent(intent.intentId);
      // Terminal, recoverable, and NEVER `audit_failed`: our audit write was
      // never even reached, and no hash may exist for a broadcast that did not
      // happen.
      expect(row?.status).toBe("failed");
      expect(row?.failure_stage).toBe("pre_broadcast");
      expect(row?.tx_hash).toBeNull();
    });

    it(`(c) a ${name} barrier between stage and send BROADCASTS NOTHING and is not audit_failed`, async () => {
      const sessionId = await sessionWithWallet();
      const intent = await insert(evmRow(sessionId, `wtx-${randomUUID()}`));
      const { calls, deps } = evmDeps(sessionId, barrierFor(name, "eip155"), "post_sign");

      const result = await handleWalletEvmTransactionConfirm(
        { intentId: intent.intentId },
        context(sessionId),
        deps,
      );

      expect(result.success).toBe(false);
      // SEAM A: the local signature already happened and is NOT retroactively
      // cancelled - but the post-stage fence prevents the broadcast.
      expect(calls.signed).toBe(1);
      expect(calls.sent).toBe(0);
      const row = await readIntent(intent.intentId);
      // NOT `audit_failed`. The durable evidence write succeeded; what stopped
      // this was the authority being revoked, and conflating the two would send
      // an investigator after a write that never broke.
      expect(row?.status).toBe("failed");
      expect(row?.failure_stage).toBe("pre_broadcast");
      expect(row?.tx_hash).toBeNull();
    });
  }
});

describe("the authority fence: Solana barriers at all three points", () => {
  beforeEach(async () => {
    await resetDb();
    await seedStudioGate();
    resolveSelectedAddress.mockReset().mockReturnValue(SOL_WALLET);
    resolveSigningWallet
      .mockReset()
      .mockReturnValue({ family: "solana", address: SOL_WALLET, secretKey: new Uint8Array(64) });
  });

  it("with NO barrier the same setup signs and submits", async () => {
    const sessionId = await sessionWithWallet();
    const intent = await insert(solanaRow(sessionId, `wtx-${randomUUID()}`));
    const { calls, deps } = solanaDeps(sessionId, lockVex, "never");

    const result = await handleWalletSolanaTransactionConfirm(
      { intentId: intent.intentId },
      context(sessionId),
      deps,
    );

    expect(result.success).toBe(true);
    expect(calls.signed).toBe(1);
    expect(calls.submitted).toBe(1);
  });

  for (const name of BARRIERS) {
    it(`(a) a ${name} barrier between preflight and claim leaves the intent PENDING`, async () => {
      const sessionId = await sessionWithWallet();
      const intent = await insert(solanaRow(sessionId, `wtx-${randomUUID()}`));
      const { calls, deps } = solanaDeps(sessionId, barrierFor(name, "solana"), "preflight");

      const result = await handleWalletSolanaTransactionConfirm(
        { intentId: intent.intentId },
        context(sessionId),
        deps,
      );

      expect(result.success).toBe(false);
      expect(calls.signed).toBe(0);
      expect(calls.submitted).toBe(0);
      const row = await readIntent(intent.intentId);
      expect(row?.status).toBe("pending");
      expect(row?.activity_id).toBeNull();
    });

    it(`(b) a ${name} barrier between claim and sign signs NOTHING`, async () => {
      const sessionId = await sessionWithWallet();
      const intent = await insert(solanaRow(sessionId, `wtx-${randomUUID()}`));
      const { calls, deps } = solanaDeps(sessionId, barrierFor(name, "solana"), "post_claim");

      const result = await handleWalletSolanaTransactionConfirm(
        { intentId: intent.intentId },
        context(sessionId),
        deps,
      );

      expect(result.success).toBe(false);
      expect(calls.signed).toBe(0);
      expect(calls.submitted).toBe(0);
      const row = await readIntent(intent.intentId);
      expect(row?.status).toBe("failed");
      expect(row?.failure_stage).toBe("pre_broadcast");
      expect(row?.tx_hash).toBeNull();
    });

    it(`(c) a ${name} barrier between stage and send SUBMITS NOTHING`, async () => {
      const sessionId = await sessionWithWallet();
      const intent = await insert(solanaRow(sessionId, `wtx-${randomUUID()}`));
      const { calls, deps } = solanaDeps(sessionId, barrierFor(name, "solana"), "post_stage");

      const result = await handleWalletSolanaTransactionConfirm(
        { intentId: intent.intentId },
        context(sessionId),
        deps,
      );

      expect(result.success).toBe(false);
      // The signature exists locally and is not cancelled retroactively; the
      // fence stops the SUBMISSION, which is the thing that would have been
      // irreversible.
      expect(calls.signed).toBe(1);
      expect(calls.submitted).toBe(0);
      const row = await readIntent(intent.intentId);
      expect(row?.status).toBe("failed");
      expect(row?.failure_stage).toBe("pre_broadcast");
      expect(row?.tx_hash).toBeNull();
    });
  }
});

// The digest helper above must agree with the real one, or every case here
// would be refused by row revalidation and prove nothing about the fence. The
// "no barrier" cases at the top of each block are that proof: they reach a
// signature and a submission through the identical setup.

/**
 * THE ANCHOR'S OWN CROSS-CHECK (pass 6 / N3).
 *
 * The three barriers above all compare the anchor against the session row LATER.
 * This one is about the anchor's own construction: the approval gate decides
 * from `InternalToolContext.sessionPermission`, and the fence defends
 * `sessions.permission`. If those two disagree at capture time, the dispatch was
 * admitted under one answer and would be fenced under the other, and there is no
 * safe way to pick a winner - so it does not proceed at all.
 */
describe("the authority anchor refuses when the gate's permission is not the session's", () => {
  beforeEach(async () => {
    await resetDb();
    await seedStudioGate();
    resolveSelectedAddress.mockReset().mockReturnValue(WALLET);
    resolveSigningWallet
      .mockReset()
      .mockReturnValue({ family: "eip155", address: WALLET, privateKey: `0x${"1".repeat(64)}` });
  });

  it("signs NOTHING and leaves the intent pending when the context is stale", async () => {
    const sessionId = await sessionWithWallet();
    // The durable authority moved to `restricted`; the tool context still
    // carries the `full` it was built with, which is what let this call past
    // the approval gate.
    await execute("UPDATE sessions SET permission = 'restricted' WHERE id = $1", [sessionId]);
    const intent = await insert(evmRow(sessionId, `wtx-${randomUUID()}`));
    const { calls, deps } = evmDeps(sessionId, lockVex, "never");

    const result = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      context(sessionId),
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Nothing was signed");
    expect(calls.signed).toBe(0);
    expect(calls.sent).toBe(0);
    // Nothing was claimed either: the intent is still preparable-again.
    const row = await readIntent(intent.intentId);
    expect(row?.status).toBe("pending");
    expect(row?.tx_hash).toBeNull();
  });

  it("CONTROL: the same call proceeds when the two agree", async () => {
    const sessionId = await sessionWithWallet();
    const intent = await insert(evmRow(sessionId, `wtx-${randomUUID()}`));
    const { calls, deps } = evmDeps(sessionId, lockVex, "never");

    const result = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      context(sessionId),
      deps,
    );

    expect(result.success).toBe(true);
    expect(calls.signed).toBe(1);
  });
});
