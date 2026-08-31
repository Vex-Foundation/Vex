/**
 * Can this wallet pay for the Jupiter swap it just asked to be built.
 *
 * CHAIN READS AND ARITHMETIC ONLY. The verdict itself is not decided here:
 * `vex-agent/tools/protocols/quote-authority/spendability.ts` owns that, and
 * `src/tools` may not import `src/vex-agent` (trust-boundary direction). So
 * this module produces the OBSERVATIONS - spendable atoms, lamports, the exact
 * message fee, every wallet-paid lamport debit the message carries, and the
 * measured follow-up reserve - and the Jupiter handlers hand them to the shared
 * evaluator.
 *
 * WHY THE DEBIT IS READ OFF THE MESSAGE, NOT ASSEMBLED FROM THE QUOTE FIELDS.
 * Live `/build` probe, 2026-08-31 (SOL -> USDC, 0.01 SOL, tip 1,000,000,
 * `wrapAndUnwrapSol: true`): the assembled v0 message carried
 *
 *   - a System `Transfer` of exactly `inAmount` lamports from the taker (the
 *     wrap - this IS the native principal),
 *   - a System `Transfer` of exactly the approved tip from the taker,
 *   - TWO Associated-Token-Account `CreateIdempotent` instructions with the
 *     taker as payer (the wSOL account and the output account), on top of the
 *     treasury fee ATA `fee-swap.ts` splices in itself.
 *
 * Summing `fee-swap.ts`'s own `ataRentLamports` would therefore have missed two
 * wallet-funded accounts, and adding `tipLamports` and the principal on top of
 * the decoded transfers would have counted both twice. Reading the message is
 * the only derivation that cannot drift from what the wallet will actually be
 * charged.
 *
 * NO DOUBLE COUNTING, the two rules this module exists to keep:
 *
 *   1. Vex's 25 bps is taken out of `inAmount` by the swap itself, so the
 *      principal is `inAmount` and the fee is never added to it.
 *   2. `getFeeForMessage` returns the network fee AND the priority fee of THIS
 *      message (live: 7,321 lamports for a 1-signature swap message whose base
 *      fee is 5,000), so `priorityFeeLamportsEstimate` - a disclosure figure
 *      decoded from the response's own ComputeBudget instructions - is never
 *      added again.
 *
 * WHAT THIS CANNOT SEE. Only instructions present IN THE MESSAGE are
 * attributable. A program invoked by the message can move lamports out of the
 * signer through a System CPI that never appears as a message-level
 * instruction. Attribution is therefore a lower bound on the debit, and its
 * job is to make every VISIBLE debit explicit and to REFUSE when a lamport
 * -moving instruction cannot be decoded, not to promise omniscience. The
 * measured follow-up reserve is the margin that keeps the wallet able to act
 * after an under-observed swap.
 */

import {
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  type AddressLookupTableAccount,
  type Commitment,
  type MessageCompiledInstruction,
  type VersionedMessage,
} from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccountLenForMint,
  unpackMint,
} from "@solana/spl-token";
import { z } from "zod";

import { VexError, ErrorCodes } from "../../../../errors.js";

/**
 * The commitment every spendability read is taken at.
 *
 * `processed` is Solana's analogue of an EVM `pending` tag: it is the only
 * commitment that reflects the wallet's most recent, not-yet-confirmed
 * activity, which is exactly what contract C2.4 requires a spend to be judged
 * from. A `confirmed` read can still show lamports an unconfirmed transfer has
 * already committed to spending.
 */
export const SOLANA_SPENDABILITY_COMMITMENT = "processed" as const;

/** The ATA program's `Create` and `CreateIdempotent` discriminants (1-byte instruction data). */
const ATA_CREATE = 0;
const ATA_CREATE_IDEMPOTENT = 1;

// ── SPL source balance ──────────────────────────────────────────────────

const parsedTokenAccountSchema = z.object({
  parsed: z.object({
    type: z.literal("account"),
    info: z.object({
      mint: z.string().min(1),
      owner: z.string().min(1),
      /** `initialized`, `frozen`, or `uninitialized` on a healthy node. */
      state: z.string().min(1),
      tokenAmount: z.object({
        /** u64 atoms as a decimal string. Never parsed into a float. */
        amount: z.string().regex(/^\d+$/, "expected a u64 decimal string"),
        /** The mint's `u8` decimals, so 0..255 is the whole on-chain range. */
        decimals: z.number().int().min(0).max(255),
      }),
    }),
  }),
});

/**
 * One mint's holding, split by whether the atoms can actually be spent.
 *
 * The split is the point. `balances/read-wallet-balances.ts` answers a
 * different question - what does this wallet HOLD - and deliberately counts a
 * frozen account as held, because it is. A swap cannot move those atoms, so the
 * inventory projection is not reusable here and this module keeps its own,
 * stricter reading of the same wire shape.
 */
export interface SolanaSplSpendability {
  /** Atoms in `initialized`, non-frozen accounts. Decimal string. */
  readonly spendableAmountRaw: string;
  /** Atoms held in frozen accounts. Present, unspendable, never summed into the above. */
  readonly frozenAmountRaw: string;
  /**
   * Accounts whose state this build could not read as a spendability fact: a
   * shape the schema refused, a state name outside the known set, a mint or
   * owner that is not the one asked about, or two accounts disagreeing about
   * the mint's decimals. NEVER treated as zero - a non-zero count is
   * `balance_unavailable`, not a small balance.
   */
  readonly malformedOrUnknownAccounts: number;
  /** How many token accounts the owner holds for this mint. */
  readonly accountCount: number;
  /** The mint's decimals as every readable account agreed, or `null` when none was readable. */
  readonly decimals: number | null;
}

/**
 * The narrow slice of `Connection` this module uses.
 *
 * Declared structurally, like `balances/read-wallet-balances.ts`'s own RPC
 * seam: a real `Connection` satisfies it, and a test drives the reader with a
 * scripted object instead of a cast that would silence the very type errors a
 * fake is supposed to surface.
 */
export interface SolanaSpendabilityRpc {
  getParsedTokenAccountsByOwner(
    owner: PublicKey,
    filter: { mint: PublicKey },
    commitment?: Commitment,
  ): Promise<{ value: ReadonlyArray<{ pubkey: PublicKey; account: { data: unknown } }> }>;
  getBalance(publicKey: PublicKey, commitment?: Commitment): Promise<number>;
  getFeeForMessage(
    message: VersionedMessage,
    commitment?: Commitment,
  ): Promise<{ value: number | null }>;
  getAccountInfo(
    publicKey: PublicKey,
    commitment?: Commitment,
  ): Promise<{ data: Uint8Array; owner: PublicKey } | null>;
  getMinimumBalanceForRentExemption(dataLength: number, commitment?: Commitment): Promise<number>;
  getAddressLookupTable(
    accountKey: PublicKey,
  ): Promise<{ value: AddressLookupTableAccount | null }>;
}

/** The two calls a balance read alone needs. */
export type SolanaSourceBalanceRpc = Pick<
  SolanaSpendabilityRpc,
  "getParsedTokenAccountsByOwner" | "getBalance"
>;

/** The four calls pricing one message needs. */
export type SolanaNativeDebitRpc = Pick<
  SolanaSpendabilityRpc,
  "getFeeForMessage" | "getAccountInfo" | "getMinimumBalanceForRentExemption" | "getAddressLookupTable"
>;

/**
 * Read one mint's spendable and frozen atoms for one owner.
 *
 * Every account for the mint is read, not just the associated one: a wallet can
 * hold several accounts for a mint and a swap can be funded from the sum of the
 * spendable ones. A single unreadable account poisons the whole answer, because
 * the atoms it holds are unknown, not zero.
 */
export async function readSplSpendability(
  rpc: SolanaSourceBalanceRpc,
  owner: string,
  mint: string,
): Promise<SolanaSplSpendability> {
  const accounts = await rpc.getParsedTokenAccountsByOwner(
    new PublicKey(owner),
    { mint: new PublicKey(mint) },
    SOLANA_SPENDABILITY_COMMITMENT,
  );

  let spendable = 0n;
  let frozen = 0n;
  let malformed = 0;
  let decimals: number | null = null;

  for (const entry of accounts.value) {
    const parsed = parsedTokenAccountSchema.safeParse(entry.account.data);
    if (!parsed.success) {
      malformed += 1;
      continue;
    }
    const info = parsed.data.parsed.info;
    if (info.mint !== mint || info.owner !== owner) {
      // The node answered about an account we did not ask about. Fail closed
      // rather than reason about a balance whose identity does not match.
      malformed += 1;
      continue;
    }
    if (decimals === null) decimals = info.tokenAmount.decimals;
    if (decimals !== info.tokenAmount.decimals) {
      // Impossible on-chain: one mint has one scale. A response that says
      // otherwise cannot be trusted for any of its accounts.
      malformed += 1;
      continue;
    }
    const atoms = BigInt(info.tokenAmount.amount);
    if (info.state === "initialized") {
      spendable += atoms;
      continue;
    }
    if (info.state === "frozen") {
      frozen += atoms;
      continue;
    }
    // `uninitialized` or any name this build does not know. Not spendable, and
    // not silently ignorable either.
    malformed += 1;
  }

  return {
    spendableAmountRaw: spendable.toString(10),
    frozenAmountRaw: frozen.toString(10),
    malformedOrUnknownAccounts: malformed,
    accountCount: accounts.value.length,
    decimals,
  };
}

/** Read the owner's own lamports at the spendability commitment. */
export async function readNativeLamports(rpc: SolanaSourceBalanceRpc, owner: string): Promise<string> {
  const lamports = await rpc.getBalance(new PublicKey(owner), SOLANA_SPENDABILITY_COMMITMENT);
  if (!Number.isInteger(lamports) || lamports < 0) {
    throw new VexError(
      ErrorCodes.SOLANA_RPC_ERROR,
      "The node returned a lamport balance that is not a whole number of lamports.",
    );
  }
  return BigInt(lamports).toString(10);
}

// ── Native debit, read off the exact message ────────────────────────────

/** One lamport debit the message charges the signer, with what it pays for. */
export interface AttributedNativeDebit {
  /** `wrap_or_transfer`, `account_creation`, or `token_account_rent`. */
  readonly kind: "wrap_or_transfer" | "account_creation" | "token_account_rent";
  readonly lamports: string;
  /** The instruction index in the compiled message, for a reader tracing the sum. */
  readonly instructionIndex: number;
}

export interface JupiterNativeDebit {
  /** Every wallet-paid lamport debit the message itself carries. */
  readonly attributedLamports: string;
  /** `getFeeForMessage` on the EXACT message: network fee plus priority fee. */
  readonly messageFeeLamports: string;
  /** A freshly priced one-signature, zero-lamport self-transfer (owner decision 2026-08-31). */
  readonly followUpReserveLamports: string;
  /** The sum the wallet must hold in lamports for this swap to be signable. */
  readonly totalLamports: string;
  readonly items: readonly AttributedNativeDebit[];
}

/**
 * Measure the whole native debit of one assembled swap message.
 *
 * FAILS CLOSED. Any instruction from a program that can move the signer's
 * lamports which this build cannot decode into a known amount throws, and so
 * does a fee the node will not price. A swap whose cost cannot be stated is not
 * a swap that may be signed.
 */
export async function measureJupiterNativeDebit(params: {
  readonly connection: SolanaNativeDebitRpc;
  readonly message: VersionedMessage;
  readonly signer: PublicKey;
}): Promise<JupiterNativeDebit> {
  const { connection, message, signer } = params;

  const payer = message.staticAccountKeys[0];
  if (!payer || !payer.equals(signer)) {
    throw new VexError(
      ErrorCodes.SOLANA_TX_FAILED,
      "Refusing to price this swap: the message's fee payer is not the selected wallet.",
    );
  }

  const items = await attributeSignerNativeDebits({ connection, message });
  const attributed = items.reduce((sum, item) => sum + BigInt(item.lamports), 0n);
  const messageFee = await priceMessage(connection, message);
  const reserve = await measureFollowUpReserve(connection, message, signer);

  return {
    attributedLamports: attributed.toString(10),
    messageFeeLamports: messageFee.toString(10),
    followUpReserveLamports: reserve.toString(10),
    totalLamports: (attributed + messageFee + reserve).toString(10),
    items,
  };
}

/** `getFeeForMessage`, refusing the `null` the node returns for a blockhash it cannot find. */
async function priceMessage(connection: SolanaNativeDebitRpc, message: VersionedMessage): Promise<bigint> {
  const fee = await connection.getFeeForMessage(message, "confirmed");
  if (fee.value === null || fee.value === undefined) {
    throw new VexError(
      ErrorCodes.SOLANA_RPC_ERROR,
      "The node could not price this transaction - its blockhash is no longer known. Re-quote and retry.",
    );
  }
  return BigInt(fee.value);
}

/**
 * The absolute follow-up reserve: what it costs to send ONE more transaction.
 *
 * Measured, never a percentage (owner decision 2026-08-31): a one-signature,
 * zero-lamport self-transfer priced by the node against the SAME blockhash the
 * swap carries, so the reserve is quoted under the same fee schedule the swap
 * is. Live 2026-08-31: 5,000 lamports.
 */
async function measureFollowUpReserve(
  connection: SolanaNativeDebitRpc,
  message: VersionedMessage,
  signer: PublicKey,
): Promise<bigint> {
  const reserveMessage = new TransactionMessage({
    payerKey: signer,
    recentBlockhash: message.recentBlockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: signer, toPubkey: signer, lamports: 0 })],
  }).compileToV0Message();
  return priceMessage(connection, reserveMessage);
}

/**
 * Decode every message-level instruction that debits the fee payer's lamports.
 *
 * The fee payer is account index 0 by construction, and both lamport-moving
 * programs here take the funder as their FIRST account, so "does this
 * instruction charge us" is `accountKeyIndexes[0] === 0`. Program ids are
 * always static keys in a v0 message, so a lookup table can never hide which
 * program an instruction belongs to.
 */
async function attributeSignerNativeDebits(params: {
  readonly connection: SolanaNativeDebitRpc;
  readonly message: VersionedMessage;
}): Promise<readonly AttributedNativeDebit[]> {
  const { connection, message } = params;
  const systemProgram = SystemProgram.programId.toBase58();
  const ataProgram = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();

  const compiled = message.compiledInstructions;
  const relevant = compiled
    .map((instruction, index) => ({ instruction, index }))
    .filter(({ instruction }) => {
      const programId = message.staticAccountKeys[instruction.programIdIndex]?.toBase58();
      return programId === systemProgram || programId === ataProgram;
    });
  if (relevant.length === 0) return [];

  // Resolved keys are needed only to identify the ACCOUNTS an ATA creation
  // touches; the lookup tables are fetched once, and only when the message
  // actually uses them.
  const keys = message.getAccountKeys({
    addressLookupTableAccounts: await fetchLookupTables(connection, message),
  });

  const debits: AttributedNativeDebit[] = [];
  for (const { instruction, index } of relevant) {
    const programId = message.staticAccountKeys[instruction.programIdIndex]!.toBase58();
    const paysFromSigner = instruction.accountKeyIndexes[0] === 0;

    if (programId === systemProgram) {
      const lamports = decodeSystemDebit(instruction, index, paysFromSigner);
      if (lamports > 0n) {
        debits.push({ kind: "wrap_or_transfer", lamports: lamports.toString(10), instructionIndex: index });
      }
      continue;
    }

    if (!paysFromSigner) continue;
    const rent = await attributeAtaRent(connection, keys, instruction, index);
    if (rent > 0n) {
      debits.push({ kind: "token_account_rent", lamports: rent.toString(10), instructionIndex: index });
    }
  }
  return debits;
}

/** The lookup tables a v0 message references, or none when it references none. */
async function fetchLookupTables(
  connection: SolanaNativeDebitRpc,
  message: VersionedMessage,
): Promise<AddressLookupTableAccount[]> {
  const lookups = message.addressTableLookups;
  if (lookups.length === 0) return [];
  const tables: AddressLookupTableAccount[] = [];
  for (const lookup of lookups) {
    const fetched = await connection.getAddressLookupTable(lookup.accountKey);
    if (!fetched.value) {
      throw new VexError(
        ErrorCodes.SOLANA_RPC_ERROR,
        "Refusing to price this swap: one of its address lookup tables could not be read, so the accounts it funds cannot be identified.",
      );
    }
    tables.push(fetched.value);
  }
  return tables;
}

/**
 * How many lamports one System-program instruction takes from the fee payer.
 *
 * Every member of the instruction set is named: the ones that move lamports out
 * of their first account, the ones that provably move none, and - by falling
 * through to the throw - the ones a future runtime might add.
 */
function decodeSystemDebit(
  instruction: MessageCompiledInstruction,
  index: number,
  paysFromSigner: boolean,
): bigint {
  const decodable = new TransactionInstruction({
    programId: SystemProgram.programId,
    // The decoders read the DATA and the account COUNT, never the identities,
    // so placeholder keys are enough and no lookup resolution is needed.
    keys: instruction.accountKeyIndexes.map(() => ({
      pubkey: PublicKey.default,
      isSigner: false,
      isWritable: true,
    })),
    data: Buffer.from(instruction.data),
  });

  let type: string;
  try {
    type = SystemInstruction.decodeInstructionType(decodable);
  } catch {
    throw unattributable(index, "an undecodable System-program instruction");
  }

  switch (type) {
    case "Transfer":
      return paysFromSigner ? BigInt(SystemInstruction.decodeTransfer(decodable).lamports) : 0n;
    case "TransferWithSeed":
      return paysFromSigner ? BigInt(SystemInstruction.decodeTransferWithSeed(decodable).lamports) : 0n;
    case "Create":
      return paysFromSigner ? BigInt(SystemInstruction.decodeCreateAccount(decodable).lamports) : 0n;
    case "CreateWithSeed":
      return paysFromSigner ? BigInt(SystemInstruction.decodeCreateWithSeed(decodable).lamports) : 0n;
    // These move no lamports at all: they assign, size, or drive a nonce.
    case "Assign":
    case "AssignWithSeed":
    case "Allocate":
    case "AllocateWithSeed":
    case "AdvanceNonceAccount":
    case "InitializeNonceAccount":
    case "AuthorizeNonceAccount":
    case "UpgradeNonceAccount":
      return 0n;
    // A withdrawal CREDITS the fee payer; a swap that pays us is still priced
    // by what it costs, never by what it might return.
    case "WithdrawNonceAccount":
      return 0n;
    default:
      throw unattributable(index, `System instruction "${type}"`);
  }
}

/**
 * What an Associated-Token-Account creation costs the payer.
 *
 * `CreateIdempotent` on an account that already exists costs nothing, and
 * Jupiter emits it unconditionally (live 2026-08-31: two of them, for accounts
 * the taker already held), so the account is READ rather than assumed missing -
 * charging rent for an account that exists would refuse solvent wallets on
 * every swap. A Token-2022 account is sized from its own mint, because its
 * extensions make it larger than the classic 165 bytes.
 */
async function attributeAtaRent(
  connection: SolanaNativeDebitRpc,
  keys: ReturnType<VersionedMessage["getAccountKeys"]>,
  instruction: MessageCompiledInstruction,
  index: number,
): Promise<bigint> {
  const discriminant = instruction.data.length === 0 ? ATA_CREATE : instruction.data[0]!;
  if (instruction.data.length > 1 || (discriminant !== ATA_CREATE && discriminant !== ATA_CREATE_IDEMPOTENT)) {
    // `RecoverNested` and anything newer moves lamports in ways this build
    // cannot price.
    throw unattributable(index, "an Associated-Token-Account instruction that is not a plain account creation");
  }

  const account = keys.get(instruction.accountKeyIndexes[1] ?? -1);
  const mint = keys.get(instruction.accountKeyIndexes[3] ?? -1);
  const tokenProgram = keys.get(instruction.accountKeyIndexes[5] ?? -1);
  if (!account || !mint || !tokenProgram) {
    throw unattributable(index, "an Associated-Token-Account creation whose accounts could not be resolved");
  }

  const existing = await connection.getAccountInfo(account, SOLANA_SPENDABILITY_COMMITMENT);
  if (existing !== null) return 0n;

  const size = tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
    ? await token2022AccountSize(connection, mint, index)
    : ACCOUNT_SIZE;
  return BigInt(await connection.getMinimumBalanceForRentExemption(size));
}

/**
 * A Token-2022 associated account is sized by ITS OWN MINT: the mint's
 * extensions decide which the account must carry, so the classic 165 bytes is
 * the wrong rent for it. The mint account is read and decoded here rather than
 * assumed, and a mint that cannot be decoded is unattributable, never guessed.
 */
async function token2022AccountSize(
  connection: SolanaNativeDebitRpc,
  mint: PublicKey,
  index: number,
): Promise<number> {
  const info = await connection.getAccountInfo(mint, SOLANA_SPENDABILITY_COMMITMENT);
  if (!info) throw unattributable(index, "a Token-2022 account creation whose mint could not be read");
  try {
    return getAccountLenForMint(
      unpackMint(mint, { ...info, data: Buffer.from(info.data), executable: false, lamports: 0, rentEpoch: 0 }, TOKEN_2022_PROGRAM_ID),
    );
  } catch {
    throw unattributable(index, "a Token-2022 account creation whose mint could not be decoded");
  }
}

function unattributable(index: number, what: string): VexError {
  return new VexError(
    ErrorCodes.SOLANA_TX_FAILED,
    `Refusing to price this swap: instruction ${index} is ${what}, so the lamports it takes from the wallet cannot be accounted for.`,
    "This is a fail-closed refusal. Re-quote; if it persists the provider changed the transaction shape and Vex must be updated before it can price it.",
  );
}
