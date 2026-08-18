/**
 * The NATIVE-SOL leg of a Jupiter swap, proven from the INSTRUCTIONS of the
 * landed transaction rather than from balances.
 *
 * WHY THIS EXISTS. Jupiter routes native SOL through a wrapped-SOL account that
 * the same transaction creates and closes, so that account appears in NEITHER
 * `meta.preTokenBalances` NOR `meta.postTokenBalances` and the balance-delta
 * decoder correctly reports no evidence. The movement is still fully recorded -
 * in the instruction stream - and this module reads it there.
 *
 * WHAT IT WILL NOT USE. Not the fee payer's lamport delta (it carries the
 * network fee, the landing tip and every ATA rent deposit), not the
 * `CloseAccount` payout (it carries the account's 2039280-lamport rent on top of
 * the swap proceeds - visible in the `swap-sol-to-usdc-3SC5Mi5L` capture), and
 * never the quote.
 *
 * THE PROOF IS ONE TRANSIENT FLOW, NOT ONE TRANSFER. A real route splits the
 * wrapped principal across several pool transfers and takes the Vex fee as
 * another; what must be unique is the transient ACCOUNT and the flow through it:
 *
 *   input  - exactly one principal `System Transfer` from OUR wallet into the
 *            candidate, immediately followed by `SyncNative` on it, and the
 *            token debits out of the candidate must sum EXACTLY to that
 *            principal (so nothing else funded it and nothing was left behind);
 *   output - no funding transfer and no `SyncNative` at all, and the NET SPL
 *            credits into the candidate are the amount; `CloseAccount`
 *            (candidate -> wallet) is a STRUCTURAL check only.
 *
 * EVERYTHING ELSE DECLINES, by name: several candidate accounts or flows, an
 * account index no lookup table resolved, the wrong owner/mint/authority, a
 * missing or misordered sync/close, an account that already existed or already
 * held a balance, a Token-2022 shape, residual or foreign flow through the
 * candidate, and any ambiguity between the swap and the tip or rent.
 */

import bs58 from "bs58";
import { z } from "zod";

/** Native SOL travels as this mint whenever it is wrapped. */
export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

/** Lamports per SOL, as decimals. Wrapped SOL uses the same scale. */
export const WRAPPED_SOL_DECIMALS = 9;

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
/** The ORIGINAL SPL Token program. A Token-2022 account is a different shape and is declined, not guessed at. */
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const SYSTEM_CREATE_ACCOUNT = 0;
const SYSTEM_TRANSFER = 2;
const TOKEN_TRANSFER = 3;
const TOKEN_CLOSE_ACCOUNT = 9;
const TOKEN_TRANSFER_CHECKED = 12;
const TOKEN_SYNC_NATIVE = 17;
const TOKEN_INITIALIZE_ACCOUNT_3 = 18;

export type WsolFlowDirection = "input" | "output";

export type WsolFlowDeclineReason =
  | "unreadable_body"
  | "on_chain_error"
  | "unresolved_account_index"
  | "no_transient_candidate"
  | "multiple_transient_candidates"
  | "preexisting_balance"
  | "foreign_funding"
  | "no_principal_transfer"
  | "multiple_principal_transfers"
  | "sync_native_missing_or_misordered"
  | "debits_do_not_match_principal"
  | "unexpected_funding_for_output"
  | "no_net_credit";

export type WsolFlowDecode =
  | { readonly outcome: "proven"; readonly lamports: bigint }
  | { readonly outcome: "declined"; readonly reason: WsolFlowDeclineReason };

/**
 * The lamports of the native leg this wallet actually spent (`input`) or
 * received (`output`) through a transient wrapped-SOL account.
 */
export function decodeTransientWsolFlow(
  body: unknown,
  params: { readonly owner: string; readonly direction: WsolFlowDirection },
): WsolFlowDecode {
  const parsed = transactionBodySchema.safeParse(body);
  if (!parsed.success) return declined("unreadable_body");
  const { transaction, meta } = parsed.data;
  if (meta.err !== null) return declined("on_chain_error");

  const keys = [
    ...transaction.message.accountKeys,
    ...(meta.loadedAddresses?.writable ?? []),
    ...(meta.loadedAddresses?.readonly ?? []),
  ];
  const flat = flattenInstructions(parsed.data);
  if (flat === null) return declined("unresolved_account_index");

  const candidate = findTransientCandidate(flat, keys, params.owner);
  if (candidate.outcome !== "found") return declined(candidate.reason);

  const account = candidate.accountIndex;
  if (meta.preTokenBalances.some((balance) => balance.accountIndex === account)) {
    return declined("preexisting_balance");
  }

  return params.direction === "input"
    ? proveInputFlow(flat, keys, params.owner, account)
    : proveOutputFlow(flat, keys, account);
}

// ── Candidate discovery ──────────────────────────────────────────────────

type CandidateSearch =
  | { readonly outcome: "found"; readonly accountIndex: number }
  | { readonly outcome: "declined"; readonly reason: WsolFlowDeclineReason };

/**
 * The one token account that this transaction CREATED, initialised as wrapped
 * SOL owned by OUR wallet, and CLOSED back to that same wallet.
 *
 * Ownership comes from `InitializeAccount3`'s own owner bytes, not from the
 * Associated Token Account program's argument order, so a route that opens the
 * account another way is read the same way - and a Token-2022 account is not
 * read at all, because only the original Token program's instructions are
 * decoded.
 */
function findTransientCandidate(
  flat: readonly FlatInstruction[],
  keys: readonly string[],
  owner: string,
): CandidateSearch {
  const created = new Set<number>();
  for (const ix of flat) {
    if (keys[ix.programIdIndex] !== SYSTEM_PROGRAM_ID) continue;
    if (readSystemInstructionType(ix.data) !== SYSTEM_CREATE_ACCOUNT) continue;
    const account = ix.accounts[1];
    if (account !== undefined) created.add(account);
  }

  const initialized = new Set<number>();
  for (const ix of flat) {
    if (keys[ix.programIdIndex] !== TOKEN_PROGRAM_ID) continue;
    const data = decodeBase58(ix.data);
    if (data === null || data[0] !== TOKEN_INITIALIZE_ACCOUNT_3) continue;
    const account = ix.accounts[0];
    const mint = ix.accounts[1];
    if (account === undefined || mint === undefined) continue;
    if (keys[mint] !== WRAPPED_SOL_MINT) continue;
    // `InitializeAccount3` carries the owner as 32 raw bytes after its tag.
    if (data.length < 33) continue;
    if (bs58.encode(data.subarray(1, 33)) !== owner) continue;
    if (!created.has(account)) continue;
    initialized.add(account);
  }

  const closed = new Set<number>();
  for (const ix of flat) {
    if (keys[ix.programIdIndex] !== TOKEN_PROGRAM_ID) continue;
    const data = decodeBase58(ix.data);
    if (data === null || data[0] !== TOKEN_CLOSE_ACCOUNT) continue;
    const [account, destination, authority] = ix.accounts;
    if (account === undefined || destination === undefined || authority === undefined) continue;
    if (keys[destination] !== owner || keys[authority] !== owner) continue;
    closed.add(account);
  }

  const candidates = [...initialized].filter((account) => closed.has(account));
  if (candidates.length === 0) return { outcome: "declined", reason: "no_transient_candidate" };
  if (candidates.length > 1) return { outcome: "declined", reason: "multiple_transient_candidates" };
  return { outcome: "found", accountIndex: candidates[0]! };
}

// ── The two directions ───────────────────────────────────────────────────

function proveInputFlow(
  flat: readonly FlatInstruction[],
  keys: readonly string[],
  owner: string,
  candidate: number,
): WsolFlowDecode {
  const fundings: { readonly position: number; readonly lamports: bigint; readonly fromOwner: boolean }[] = [];
  flat.forEach((ix, position) => {
    if (keys[ix.programIdIndex] !== SYSTEM_PROGRAM_ID) return;
    if (readSystemInstructionType(ix.data) !== SYSTEM_TRANSFER) return;
    const [source, destination] = ix.accounts;
    if (destination !== candidate) return; // the landing tip and every unrelated payment leave here
    const lamports = readSystemTransferLamports(ix.data);
    if (lamports === null) return;
    fundings.push({ position, lamports, fromOwner: source !== undefined && keys[source] === owner });
  });
  if (fundings.length === 0) return declined("no_principal_transfer");
  if (fundings.length > 1) return declined("multiple_principal_transfers");
  const principal = fundings[0]!;
  if (!principal.fromOwner) return declined("foreign_funding");

  const nextTouch = flat.findIndex(
    (ix, position) => position > principal.position && touchesCandidate(ix, keys, candidate),
  );
  if (nextTouch === -1) return declined("sync_native_missing_or_misordered");
  const sync = flat[nextTouch]!;
  if (keys[sync.programIdIndex] !== TOKEN_PROGRAM_ID) return declined("sync_native_missing_or_misordered");
  const syncData = decodeBase58(sync.data);
  if (syncData === null || syncData[0] !== TOKEN_SYNC_NATIVE) {
    return declined("sync_native_missing_or_misordered");
  }

  const movement = sumTokenMovement(flat, keys, candidate);
  if (movement.credited !== 0n) return declined("debits_do_not_match_principal");
  if (movement.debited !== principal.lamports) return declined("debits_do_not_match_principal");
  return { outcome: "proven", lamports: principal.lamports };
}

function proveOutputFlow(
  flat: readonly FlatInstruction[],
  keys: readonly string[],
  candidate: number,
): WsolFlowDecode {
  // An output candidate that was ALSO funded is not a pure receive: the two
  // flows would be indistinguishable in the close payout.
  //
  // BOTH funding shapes are refused, not just the transfer. A transient account
  // can be given lamports by the `CreateAccount` that opens it - which is not a
  // System Transfer at all - and a following `SyncNative` would turn those
  // lamports into a wrapped-SOL balance that nets out as a credit here. Output
  // value may only ever come from SPL token credits, so ANY `SyncNative` on the
  // candidate disqualifies the flow.
  const funded = flat.some(
    (ix) =>
      (keys[ix.programIdIndex] === SYSTEM_PROGRAM_ID
        && readSystemInstructionType(ix.data) === SYSTEM_TRANSFER
        && ix.accounts[1] === candidate)
      || (keys[ix.programIdIndex] === TOKEN_PROGRAM_ID
        && ix.accounts[0] === candidate
        && decodeBase58(ix.data)?.[0] === TOKEN_SYNC_NATIVE),
  );
  if (funded) return declined("unexpected_funding_for_output");

  const movement = sumTokenMovement(flat, keys, candidate);
  const net = movement.credited - movement.debited;
  if (net <= 0n) return declined("no_net_credit");
  return { outcome: "proven", lamports: net };
}

/** Token movement in and out of one account, over the original SPL Token program only. */
function sumTokenMovement(
  flat: readonly FlatInstruction[],
  keys: readonly string[],
  account: number,
): { credited: bigint; debited: bigint } {
  let credited = 0n;
  let debited = 0n;
  for (const ix of flat) {
    if (keys[ix.programIdIndex] !== TOKEN_PROGRAM_ID) continue;
    const data = decodeBase58(ix.data);
    if (data === null) continue;
    const tag = data[0];
    if (tag !== TOKEN_TRANSFER && tag !== TOKEN_TRANSFER_CHECKED) continue;
    if (data.length < 9) continue;
    const amount = data.readBigUInt64LE(1);
    // `Transfer` is (source, destination, authority); `TransferChecked` inserts
    // the mint as the second account.
    const source = ix.accounts[0];
    const destination = tag === TOKEN_TRANSFER ? ix.accounts[1] : ix.accounts[2];
    if (source === account) debited += amount;
    if (destination === account) credited += amount;
  }
  return { credited, debited };
}

function touchesCandidate(ix: FlatInstruction, keys: readonly string[], candidate: number): boolean {
  if (keys[ix.programIdIndex] === SYSTEM_PROGRAM_ID || keys[ix.programIdIndex] === TOKEN_PROGRAM_ID) {
    return ix.accounts.includes(candidate);
  }
  return false;
}

// ── Body shape ───────────────────────────────────────────────────────────

const compiledInstructionSchema = z
  .object({
    programIdIndex: z.number().int().min(0),
    accounts: z.array(z.number().int().min(0)),
    data: z.string(),
  })
  .passthrough();

const transactionBodySchema = z
  .object({
    transaction: z
      .object({
        message: z
          .object({
            accountKeys: z.array(z.string()),
            instructions: z.array(compiledInstructionSchema),
            addressTableLookups: z.array(z.unknown()).optional(),
          })
          .passthrough(),
      })
      .passthrough(),
    meta: z
      .object({
        err: z.unknown().optional(),
        preTokenBalances: z.array(z.object({ accountIndex: z.number().int().min(0) }).passthrough()),
        innerInstructions: z
          .array(
            z
              .object({ index: z.number().int().min(0), instructions: z.array(compiledInstructionSchema) })
              .passthrough(),
          )
          .optional(),
        loadedAddresses: z
          .object({ writable: z.array(z.string()), readonly: z.array(z.string()) })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

type ParsedBody = z.infer<typeof transactionBodySchema>;
type FlatInstruction = z.infer<typeof compiledInstructionSchema>;

/**
 * Every instruction of the transaction in execution order - top-level and inner
 * alike - or `null` when any of them references an account index no key table
 * resolves.
 *
 * That `null` is the address-lookup-table guard: a versioned transaction whose
 * `meta.loadedAddresses` is missing or short leaves indexes pointing at nothing,
 * and an unresolved index could silently read as "not our wallet" and turn a
 * refusal into a wrong amount.
 */
function flattenInstructions(parsed: ParsedBody): FlatInstruction[] | null {
  const keyCount =
    parsed.transaction.message.accountKeys.length
    + (parsed.meta.loadedAddresses?.writable.length ?? 0)
    + (parsed.meta.loadedAddresses?.readonly.length ?? 0);
  const hasLookups = (parsed.transaction.message.addressTableLookups?.length ?? 0) > 0;
  if (hasLookups && parsed.meta.loadedAddresses === undefined) return null;

  const inner = new Map<number, FlatInstruction[]>();
  for (const group of parsed.meta.innerInstructions ?? []) {
    inner.set(group.index, group.instructions);
  }

  const flat: FlatInstruction[] = [];
  parsed.transaction.message.instructions.forEach((ix, index) => {
    flat.push(ix);
    for (const innerIx of inner.get(index) ?? []) flat.push(innerIx);
  });
  for (const ix of flat) {
    if (ix.programIdIndex >= keyCount) return null;
    if (ix.accounts.some((account) => account >= keyCount)) return null;
  }
  return flat;
}

// ── Instruction data ─────────────────────────────────────────────────────

function decodeBase58(data: string): Buffer | null {
  try {
    const bytes = bs58.decode(data);
    return bytes.length === 0 ? null : Buffer.from(bytes);
  } catch {
    return null;
  }
}

/** The System program's instruction discriminator: a little-endian u32 prefix. */
function readSystemInstructionType(data: string): number | null {
  const bytes = decodeBase58(data);
  if (bytes === null || bytes.length < 4) return null;
  return bytes.readUInt32LE(0);
}

function readSystemTransferLamports(data: string): bigint | null {
  const bytes = decodeBase58(data);
  if (bytes === null || bytes.length < 12) return null;
  return bytes.readBigUInt64LE(4);
}

function declined(reason: WsolFlowDeclineReason): WsolFlowDecode {
  return { outcome: "declined", reason };
}
