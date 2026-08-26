/**
 * Solana instruction decode for the generic signing tools. FAIL CLOSED.
 *
 * ## Variants, never program names
 *
 * The allowlist is a set of exact (program, instruction variant) pairs, not a
 * set of trusted programs. "The SPL Token program" is not a safety statement:
 * the same program id serves `Transfer`, `SetAuthority`, `Burn`,
 * `CloseAccount`, `FreezeAccount` and `MintTo`, and a user who approved a line
 * saying "SPL Token" would have approved all of them.
 *
 * The v1 set:
 *
 *  - System `transfer`;
 *  - CLASSIC SPL Token `transfer`, `transferChecked`, `approve`, `revoke`;
 *  - ComputeBudget `setComputeUnitLimit`, `setComputeUnitPrice`;
 *  - Memo.
 *
 * ## Token-2022 is excluded IN v1 AND REFUSED BY NAME
 *
 * Token-2022 shares the classic instruction encoding but its mints and accounts
 * carry EXTENSIONS: a transfer-fee extension takes a cut, and a transfer-hook
 * extension invokes an arbitrary external program by CPI on every transfer.
 * Decoding a bare Token-2022 transfer without loading and enumerating those
 * extensions would show the user a clean "send N tokens" line for a transaction
 * whose real economics live somewhere the decoder never looked. Supporting it is
 * its own review, exactly like an EVM router. It is refused by name so the
 * refusal says what to do rather than "unknown program".
 *
 * ## Address lookup tables are resolved BEFORE verification
 *
 * A versioned message names most of its accounts by (table, index). Verifying
 * programs and accounts against the static keys alone would verify a fraction of
 * the transaction and silently ignore everything an ALT contributed, including
 * the program ids themselves. So every lookup is resolved first, through an
 * injected reader, and an unresolvable table refuses: an account set we cannot
 * enumerate is a transaction we cannot describe.
 */

import type { VersionedMessage } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import type {
  DecodedSolanaTransaction,
  WalletTransactionRole,
} from "@vex-agent/db/contracts/wallet-transaction-intent.js";

import { accept, refuse, type TransactionOutcome } from "./refusal.js";

// ── Program identities ────────────────────────────────────────────────

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const CLASSIC_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
/** Memo v2 is the current program; v1 is still accepted by the runtime and still appears. */
const MEMO_V2_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const MEMO_V1_PROGRAM_ID = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";

/** System instruction discriminants are a 4-byte little-endian enum. */
const SYSTEM_TRANSFER = 2;
/** SPL Token instruction discriminants are a single leading byte. */
const TOKEN_TRANSFER = 3;
const TOKEN_APPROVE = 4;
const TOKEN_REVOKE = 5;
const TOKEN_TRANSFER_CHECKED = 12;
/** ComputeBudget discriminants are a single leading byte. */
const CB_SET_UNIT_LIMIT = 2;
const CB_SET_UNIT_PRICE = 3;

// ── Seams ─────────────────────────────────────────────────────────────

/**
 * Resolves one address lookup table to its ordered address list.
 *
 * Narrow by design: this is the only chain read decode performs, and a
 * one-method seam is faked in a line, so no test in this arc touches a network.
 * `null` means the table does not exist or could not be read - both refuse.
 */
export interface AddressLookupTableReader {
  readonly getLookupTableAddresses: (tableKey: string) => Promise<readonly string[] | null>;
}

type DecodedInstruction = DecodedSolanaTransaction["instructions"][number];

// ── Public entry point ────────────────────────────────────────────────

export async function decodeSolanaTransaction(
  message: VersionedMessage,
  lookups: AddressLookupTableReader,
): Promise<TransactionOutcome<DecodedSolanaTransaction>> {
  const keys = await resolveAccountKeys(message, lookups);
  if (!keys.ok) return keys;
  const accountKeys = keys.value;

  const instructions: DecodedInstruction[] = [];
  for (const compiled of message.compiledInstructions) {
    const programId = accountKeys[compiled.programIdIndex];
    if (programId === undefined) {
      return refuse(
        "unsupported_instruction",
        "Refusing to prepare: an instruction names a program index that is outside the resolved "
        + "account list, so the transaction does not describe a program we can identify.",
      );
    }
    const accounts = compiled.accountKeyIndexes.map((index) => accountKeys[index]);
    if (accounts.some((account) => account === undefined)) {
      return refuse(
        "unsupported_instruction",
        `Refusing to prepare: an instruction for program ${programId} names an account index outside `
        + "the resolved account list.",
        { programId },
      );
    }
    const decoded = decodeOne(
      programId,
      accounts as readonly string[],
      Uint8Array.from(compiled.data),
    );
    if (!decoded.ok) return decoded;
    instructions.push(decoded.value);
  }

  if (instructions.length === 0) {
    return refuse(
      "unsupported_instruction",
      "Refusing to prepare: the message carries no instructions, so signing it would authorize "
      + "nothing while still consuming a fee and a nonce.",
    );
  }

  return accept<DecodedSolanaTransaction>({
    family: "solana",
    role: roleOf(instructions),
    instructions,
    accountKeys,
    addressTableLookupsResolved: message.addressTableLookups.length > 0,
    warnings: [],
  });
}

/**
 * The activity role the instruction set implies. A set containing a delegation
 * is reported as `approve` because that is the effect a user most needs named;
 * anything else with a real effect is the honest generic `spl_instruction_set`.
 * ComputeBudget and Memo carry no effect of their own and never decide the role.
 */
function roleOf(instructions: readonly DecodedInstruction[]): WalletTransactionRole {
  if (instructions.some((one) => one.variant === "approve")) return "approve";
  const effectful = instructions.filter(
    (one) => one.program !== "compute_budget" && one.program !== "memo",
  );
  if (effectful.length === 1 && effectful[0]?.variant === "transfer"
      && effectful[0].program === "system") {
    return "native_transfer";
  }
  return "spl_instruction_set";
}

// ── Address lookup table resolution ───────────────────────────────────

/**
 * Static keys first, then every WRITABLE index from each table in lookup order,
 * then every READONLY index from each table in lookup order. That is the order
 * the runtime itself builds the account list in, and an index resolved against
 * any other order would name the wrong account while still decoding cleanly.
 */
async function resolveAccountKeys(
  message: VersionedMessage,
  lookups: AddressLookupTableReader,
): Promise<TransactionOutcome<readonly string[]>> {
  const staticKeys = message.staticAccountKeys.map((key) => key.toBase58());
  if (message.addressTableLookups.length === 0) {
    return accept<readonly string[]>(staticKeys);
  }

  const writable: string[] = [];
  const readonly: string[] = [];
  for (const lookup of message.addressTableLookups) {
    const tableKey = lookup.accountKey.toBase58();
    const addresses = await lookups.getLookupTableAddresses(tableKey);
    if (addresses === null) {
      return refuse(
        "unresolvable_address_lookup_table",
        `Refusing to prepare: address lookup table ${tableKey} could not be read, so the accounts and `
        + "programs it contributes to this transaction cannot be enumerated. A transaction whose "
        + "account set we cannot list is a transaction we cannot describe honestly.",
        { tableKey },
      );
    }
    for (const index of lookup.writableIndexes) {
      const address = addresses[index];
      if (address === undefined) return refuseIndexOutOfRange(tableKey, index);
      writable.push(address);
    }
    for (const index of lookup.readonlyIndexes) {
      const address = addresses[index];
      if (address === undefined) return refuseIndexOutOfRange(tableKey, index);
      readonly.push(address);
    }
  }
  return accept<readonly string[]>([...staticKeys, ...writable, ...readonly]);
}

function refuseIndexOutOfRange(
  tableKey: string,
  index: number,
): TransactionOutcome<readonly string[]> {
  return refuse(
    "unresolvable_address_lookup_table",
    `Refusing to prepare: address lookup table ${tableKey} does not have an entry at index ${index}, `
    + "so the transaction refers to an address the table cannot supply.",
    { tableKey, index: String(index) },
  );
}

// ── Per-instruction decode ────────────────────────────────────────────

function decodeOne(
  programId: string,
  accounts: readonly string[],
  data: Uint8Array,
): TransactionOutcome<DecodedInstruction> {
  if (programId === TOKEN_2022_PROGRAM_ID) {
    return refuse(
      "token_2022_unsupported",
      "Refusing to prepare: this instruction targets the Token-2022 program, which is excluded from "
      + "the v1 decode set BY NAME. Token-2022 mints and accounts can carry a transfer-fee extension "
      + "that takes a cut, and a transfer-hook extension that invokes an arbitrary external program on "
      + "every transfer. Showing you a plain transfer line without loading and listing those "
      + "extensions would hide the real economics, so the whole program waits on its own review. "
      + "Classic SPL Token instructions are supported.",
      { programId },
    );
  }
  if (programId === SYSTEM_PROGRAM_ID) return decodeSystem(accounts, data);
  if (programId === CLASSIC_TOKEN_PROGRAM_ID) return decodeSplToken(programId, accounts, data);
  if (programId === COMPUTE_BUDGET_PROGRAM_ID) return decodeComputeBudget(programId, data);
  if (programId === MEMO_V2_PROGRAM_ID || programId === MEMO_V1_PROGRAM_ID) {
    return decodeMemo(programId, data);
  }
  return refuse(
    "unsupported_instruction",
    `Refusing to prepare: program ${programId} is not in the v1 decode set (System transfer, classic `
    + "SPL Token transfer/transferChecked/approve/revoke, ComputeBudget compute-unit limit and price, "
    + "and Memo). Nothing was prepared and nothing was signed.",
    { programId },
  );
}

function readU32LE(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

function decodeSystem(
  accounts: readonly string[],
  data: Uint8Array,
): TransactionOutcome<DecodedInstruction> {
  if (data.length !== 12 || readU32LE(data, 0) !== SYSTEM_TRANSFER) {
    return refuse(
      "unsupported_instruction",
      "Refusing to prepare: the only System Program instruction in the v1 decode set is `transfer`. "
      + "Account creation, assignment, nonce operations and `transferWithSeed` each move authority in "
      + "ways this build does not describe.",
      { programId: SYSTEM_PROGRAM_ID },
    );
  }
  const [from, to] = accounts;
  if (from === undefined || to === undefined) {
    return refuse(
      "unsupported_instruction",
      "Refusing to prepare: a System `transfer` must name exactly a funding account and a recipient.",
      { programId: SYSTEM_PROGRAM_ID },
    );
  }
  return accept<DecodedInstruction>({
    program: "system",
    variant: "transfer",
    programId: SYSTEM_PROGRAM_ID,
    criticalArgs: { from, recipient: to, lamports: readU64LE(data, 4).toString() },
  });
}

function decodeSplToken(
  programId: string,
  accounts: readonly string[],
  data: Uint8Array,
): TransactionOutcome<DecodedInstruction> {
  const discriminant = data[0];
  const unsupported = (): TransactionOutcome<DecodedInstruction> =>
    refuse(
      "unsupported_instruction",
      "Refusing to prepare: the classic SPL Token instructions in the v1 decode set are `transfer`, "
      + "`transferChecked`, `approve` and `revoke`. The same program also serves `setAuthority`, "
      + "`burn`, `closeAccount`, `freezeAccount` and `mintTo`, which is exactly why the allowlist is "
      + "written as instruction variants rather than as a trusted program id.",
      { programId, discriminant: discriminant === undefined ? "none" : String(discriminant) },
    );

  switch (discriminant) {
    case TOKEN_TRANSFER: {
      if (data.length !== 9) return unsupported();
      const [source, destination, authority] = accounts;
      if (source === undefined || destination === undefined || authority === undefined) {
        return unsupported();
      }
      return accept<DecodedInstruction>({
        program: "spl_token", variant: "transfer", programId,
        criticalArgs: {
          source, recipient: destination, authority,
          amountRaw: readU64LE(data, 1).toString(),
          // An unchecked transfer carries no mint and no decimals, so the raw
          // amount cannot be rendered as a human figure from the bytes alone.
          decimals: "unknown (transfer carries no mint; use transferChecked)",
        },
      });
    }
    case TOKEN_TRANSFER_CHECKED: {
      if (data.length !== 10) return unsupported();
      const [source, mint, destination, authority] = accounts;
      if (source === undefined || mint === undefined || destination === undefined
          || authority === undefined) {
        return unsupported();
      }
      return accept<DecodedInstruction>({
        program: "spl_token", variant: "transferChecked", programId,
        criticalArgs: {
          source, mint, recipient: destination, authority,
          amountRaw: readU64LE(data, 1).toString(),
          decimals: String(data[9]),
        },
      });
    }
    case TOKEN_APPROVE: {
      if (data.length !== 9) return unsupported();
      const [source, delegate, authority] = accounts;
      if (source === undefined || delegate === undefined || authority === undefined) {
        return unsupported();
      }
      return accept<DecodedInstruction>({
        program: "spl_token", variant: "approve", programId,
        criticalArgs: {
          source, delegate, authority,
          amountRaw: readU64LE(data, 1).toString(),
        },
      });
    }
    case TOKEN_REVOKE: {
      if (data.length !== 1) return unsupported();
      const [source, authority] = accounts;
      if (source === undefined || authority === undefined) return unsupported();
      return accept<DecodedInstruction>({
        program: "spl_token", variant: "revoke", programId,
        criticalArgs: { source, authority },
      });
    }
    default:
      return unsupported();
  }
}

function decodeComputeBudget(
  programId: string,
  data: Uint8Array,
): TransactionOutcome<DecodedInstruction> {
  if (data[0] === CB_SET_UNIT_LIMIT && data.length === 5) {
    return accept<DecodedInstruction>({
      program: "compute_budget", variant: "setComputeUnitLimit", programId,
      criticalArgs: { computeUnitLimit: String(readU32LE(data, 1)) },
    });
  }
  if (data[0] === CB_SET_UNIT_PRICE && data.length === 9) {
    return accept<DecodedInstruction>({
      program: "compute_budget", variant: "setComputeUnitPrice", programId,
      criticalArgs: { computeUnitPriceMicroLamports: readU64LE(data, 1).toString() },
    });
  }
  return refuse(
    "unsupported_instruction",
    "Refusing to prepare: the ComputeBudget instructions in the v1 decode set are the compute-unit "
    + "LIMIT and the compute-unit PRICE. `requestHeapFrame` and the deprecated combined request are "
    + "not decoded.",
    { programId },
  );
}

function decodeMemo(programId: string, data: Uint8Array): TransactionOutcome<DecodedInstruction> {
  // The memo is signed content the user is entitled to read in full, so it is
  // carried whole. It is DATA: nothing downstream treats it as an instruction.
  //
  // FATAL decoding, not lossy: a non-fatal decoder silently rewrites every
  // invalid byte to U+FFFD, so an attacker-shaped memo would render as an
  // innocuous-looking string the user reads while different bytes are signed.
  // Invalid UTF-8 is instead surfaced as tagged hex - the exact bytes, nothing
  // hidden - and `memoEncoding` tells the reader (and the card) which it is, so
  // a legitimate memo that literally begins "hex:" is not mistaken for one.
  let memo: string;
  let memoEncoding: "utf-8" | "hex";
  try {
    memo = new TextDecoder("utf-8", { fatal: true }).decode(data);
    memoEncoding = "utf-8";
  } catch {
    memo = `hex:${Buffer.from(data).toString("hex")}`;
    memoEncoding = "hex";
  }
  return accept<DecodedInstruction>({
    program: "memo", variant: "memo", programId,
    criticalArgs: { memo, memoEncoding, memoBytes: String(data.length) },
  });
}

/** Exported for the goldens: proves the constants are real base58 program ids. */
export const V1_SOLANA_PROGRAM_IDS = {
  system: SYSTEM_PROGRAM_ID,
  classicToken: CLASSIC_TOKEN_PROGRAM_ID,
  token2022: TOKEN_2022_PROGRAM_ID,
  computeBudget: COMPUTE_BUDGET_PROGRAM_ID,
  memoV2: MEMO_V2_PROGRAM_ID,
  memoV1: MEMO_V1_PROGRAM_ID,
} as const;

/** Guards the literals above against a typo that would silently never match. */
export function assertProgramIdsAreValid(): void {
  for (const id of Object.values(V1_SOLANA_PROGRAM_IDS)) {
    // Throws on a non-base58 or wrong-length literal.
    void new PublicKey(id);
  }
}
