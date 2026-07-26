/**
 * Solana `getTransaction` (jsonParsed, `maxSupportedTransactionVersion:0`)
 * RESPONSE PARSING — the raw RPC payload validated and narrowed into the one
 * `ParsedSolanaTransaction` shape every settlement decoder reads.
 *
 * MOVE-ONLY extraction out of `solana-settlement-decoders.ts`, which owns the
 * money-reading rules. Two different reasons to change: this file changes when
 * the RPC's response shape does, that one when what counts as a proven
 * settlement does. Its whole surface is RE-EXPORTED from
 * `solana-settlement-decoders.js`, so every existing import site is unaffected.
 *
 * NEVER GUESS, AT THE PARSE BOUNDARY TOO: any missing or malformed field this
 * shape depends on yields `null` for the WHOLE result rather than a defaulted
 * field. A caller must treat that identically to "cannot decode".
 *
 * SPL + TOKEN-2022, UNIFORMLY: `preTokenBalances`/`postTokenBalances` entries
 * report `accountIndex`/`owner`/`mint`/`uiTokenAmount.amount` identically
 * regardless of which token program manages the mint — no program-id branching
 * is needed anywhere below.
 *
 * ACCOUNT-INDEX RESOLUTION (versioned tx + address lookup tables): the
 * combined account-key list that `pre/postBalances` and every token balance's
 * `accountIndex` are indexed against is the transaction's STATIC keys followed
 * by the loaded writable then loaded readonly addresses. In the jsonParsed
 * encoding the RPC ALREADY returns that combined list in
 * `message.accountKeys` (each entry carrying `source`), so `resolveAccountKeys`
 * takes it as-is and appends `meta.loadedAddresses` ONLY for the legacy
 * plain-`string[]` encoding — see that function for the duplication this rule
 * exists to prevent.
 */

// ── Parsed transaction (narrow, validated view of the raw RPC response) ─────

export interface ParsedSolanaTokenBalance {
  /**
   * Index into {@link ParsedSolanaTransaction.accountKeys} — WHICH token
   * account this balance belongs to, not merely whose it is. Required to bind
   * a movement to a DERIVED address (an escrow ATA, say) rather than to any
   * account its owner happens to hold; `owner`+`mint` alone cannot, because a
   * program-derived owner can hold more than one account for a mint and anyone
   * may create another. `null` only when the payload omitted the field
   * entirely (never a real RPC response) — a consumer that needs the binding
   * must then DECLINE, never fall back to owner-matching.
   */
  readonly accountIndex: number | null;
  readonly owner: string;
  readonly mint: string;
  readonly amountRaw: string;
}

/** One `system` `transfer`/`transferWithSeed` effect. The DESTINATION is retained because a protocol-aware decoder classifies a transfer by who received it (design D3) — a landing tip and a SOL-wrap funding transfer are structurally identical otherwise. */
export interface SolanaNativeTransfer {
  readonly source: string;
  readonly destination: string;
  readonly lamports: number;
}

/** One `system` `createAccount`/`createAccountWithSeed` effect. The created ACCOUNT ADDRESS is retained so rent can be attributed only to accounts that survived the transaction (design D3/D5). */
export interface SolanaCreatedAccount {
  readonly source: string;
  readonly address: string;
  readonly lamports: number;
}

/**
 * System-program lamport-moving instruction effects collected from a tx
 * (top-level + inner instructions): the facts a native-SOL decode needs to
 * separate swap economics from fees, tips and rent. `null` (at the
 * `ParsedSolanaTransaction` field, not here) means "could not be reliably
 * read" — see the module doc.
 */
export interface SolanaNativeInstructionEvidence {
  readonly transfers: readonly SolanaNativeTransfer[];
  readonly accountCreations: readonly SolanaCreatedAccount[];
}

export interface ParsedSolanaTransaction {
  readonly err: unknown;
  readonly feeLamports: number;
  readonly accountKeys: readonly string[];
  readonly preBalancesLamports: readonly number[];
  readonly postBalancesLamports: readonly number[];
  readonly preTokenBalances: readonly ParsedSolanaTokenBalance[];
  readonly postTokenBalances: readonly ParsedSolanaTokenBalance[];
  /** `null` when top-level/inner instructions could not be reliably read — `decodeNativeSolDelta` must decline rather than assume no ambiguous transfer occurred. */
  readonly nativeInstructionEvidence: SolanaNativeInstructionEvidence | null;
}

/**
 * Validate + narrow a raw `getTransaction` (jsonParsed) RPC result. `null`
 * on ANY missing/malformed field this module depends on — the caller must
 * treat that identically to "cannot decode" (never guess a default).
 */
export function parseSolanaTransactionResult(raw: unknown): ParsedSolanaTransaction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const root = raw as Record<string, unknown>;
  const meta = root.meta;
  if (typeof meta !== "object" || meta === null) return null;
  const metaRec = meta as Record<string, unknown>;

  const fee = metaRec.fee;
  if (typeof fee !== "number" || !Number.isFinite(fee)) return null;

  const preBalances = readNumberArray(metaRec.preBalances);
  const postBalances = readNumberArray(metaRec.postBalances);
  if (!preBalances || !postBalances) return null;

  const preTokenBalances = readTokenBalances(metaRec.preTokenBalances);
  const postTokenBalances = readTokenBalances(metaRec.postTokenBalances);
  if (!preTokenBalances || !postTokenBalances) return null;

  const accountKeys = resolveAccountKeys(root.transaction, metaRec.loadedAddresses);
  if (!accountKeys) return null;

  const nativeInstructionEvidence = collectNativeInstructionEvidence(root.transaction, metaRec.innerInstructions);

  return {
    err: metaRec.err ?? null,
    feeLamports: fee,
    accountKeys,
    preBalancesLamports: preBalances,
    postBalancesLamports: postBalances,
    preTokenBalances,
    postTokenBalances,
    nativeInstructionEvidence,
  };
}

function readNumberArray(value: unknown): readonly number[] | null {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) return null;
    out.push(entry);
  }
  return out;
}

function readTokenBalances(value: unknown): readonly ParsedSolanaTokenBalance[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: ParsedSolanaTokenBalance[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const rec = entry as Record<string, unknown>;
    const owner = rec.owner;
    const mint = rec.mint;
    const uiTokenAmount = rec.uiTokenAmount;
    if (typeof owner !== "string" || typeof mint !== "string") return null;
    if (typeof uiTokenAmount !== "object" || uiTokenAmount === null) return null;
    const amountRaw = (uiTokenAmount as Record<string, unknown>).amount;
    if (typeof amountRaw !== "string" || !/^\d+$/.test(amountRaw)) return null;
    // Present-but-malformed is a malformed payload and declines the WHOLE
    // parse, like every other reader here; absent is recorded as `null` so a
    // consumer that does not need the account binding is unaffected.
    const accountIndex = readAccountIndex(rec.accountIndex);
    if (accountIndex === "invalid") return null;
    out.push({ accountIndex, owner, mint, amountRaw });
  }
  return out;
}

/** `null` when the field is absent; `"invalid"` when present but not a usable index. */
function readAccountIndex(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "invalid";
  return value;
}

/**
 * The combined account-key list `pre/postBalances` are indexed against.
 * `null` on an unrecognized shape.
 *
 * jsonParsed `message.accountKeys` ALREADY CONTAINS the ALT-loaded keys (each
 * entry carries `source`), so `meta.loadedAddresses` must NOT be appended on
 * top of it. Appending anyway listed every ALT key at TWO indices and made
 * `accountKeys.length` exceed `preBalances.length` — index→key reads survived
 * (duplicates land after every real index) but key→index and entry-identity
 * reads could bind to the duplicate. Chain-verified: the captured prediction
 * create transactions carry 14 `accountKeys`, 2 `lookupTable`-sourced, against
 * exactly 14 `preBalances`. The legacy plain-`string[]` encoding carries
 * STATIC keys only, so there the documented static → loaded-writable →
 * loaded-readonly order still has to be reconstructed.
 */
function resolveAccountKeys(transaction: unknown, loadedAddresses: unknown): readonly string[] | null {
  if (typeof transaction !== "object" || transaction === null) return null;
  const message = (transaction as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return null;
  const accountKeys = readPubkeyList((message as Record<string, unknown>).accountKeys);
  if (!accountKeys) return null;
  if (accountKeys.isCombinedList) return accountKeys.keys;

  let writable: readonly string[] = [];
  let readonly_: readonly string[] = [];
  if (typeof loadedAddresses === "object" && loadedAddresses !== null) {
    const rec = loadedAddresses as Record<string, unknown>;
    const w = readStringArray(rec.writable);
    const r = readStringArray(rec.readonly);
    if (w) writable = w;
    if (r) readonly_ = r;
  }
  return [...accountKeys.keys, ...writable, ...readonly_];
}

interface ParsedAccountKeyList {
  readonly keys: readonly string[];
  /** `true` for the jsonParsed object encoding, whose list is already complete — see `resolveAccountKeys`. */
  readonly isCombinedList: boolean;
}

/** `message.accountKeys` in jsonParsed encoding is `{pubkey, signer, writable, source?}[]`; plain string[] is accepted too (legacy encoding fallback). */
function readPubkeyList(value: unknown): ParsedAccountKeyList | null {
  if (!Array.isArray(value)) return null;
  const keys: string[] = [];
  let objectEntries = 0;
  for (const entry of value) {
    if (typeof entry === "string") {
      keys.push(entry);
      continue;
    }
    if (typeof entry === "object" && entry !== null) {
      const pubkey = (entry as Record<string, unknown>).pubkey;
      if (typeof pubkey === "string") {
        keys.push(pubkey);
        objectEntries++;
        continue;
      }
    }
    return null;
  }
  return { keys, isCombinedList: keys.length > 0 && objectEntries === keys.length };
}

function readStringArray(value: unknown): readonly string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    out.push(entry);
  }
  return out;
}

type SystemInstructionEffect =
  | { readonly kind: "transfer"; readonly transfer: SolanaNativeTransfer }
  | { readonly kind: "createAccount"; readonly creation: SolanaCreatedAccount }
  | { readonly kind: "irrelevant" };

/** Lamports are integers by definition; a non-integer/unsafe value is a malformed RPC payload, and `BigInt()` would THROW on it further down. Declining is the only honest answer. */
function readLamports(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Reads ONE parsed instruction entry (top-level or inner, jsonParsed
 * encoding). A non-`system`-program entry is irrelevant to native-SOL
 * netting and always safe to skip. A `system`-program entry present but NOT
 * in the expected `parsed.{type,info}` shape returns `null` — the caller
 * must treat that as "cannot prove no lamports moved," never as "skip it."
 */
function readSystemInstructionEffect(entry: unknown): SystemInstructionEffect | null {
  if (typeof entry !== "object" || entry === null) return null;
  const rec = entry as Record<string, unknown>;
  if (rec.program !== "system") return { kind: "irrelevant" };

  const parsed = rec.parsed;
  if (typeof parsed !== "object" || parsed === null) return null;
  const parsedRec = parsed as Record<string, unknown>;
  const info = parsedRec.info;
  if (typeof info !== "object" || info === null) return null;
  const infoRec = info as Record<string, unknown>;
  const source = infoRec.source;
  const lamports = readLamports(infoRec.lamports);

  if (parsedRec.type === "transfer" || parsedRec.type === "transferWithSeed") {
    const destination = infoRec.destination;
    if (typeof source !== "string" || typeof destination !== "string" || lamports === null) return null;
    return { kind: "transfer", transfer: { source, destination, lamports } };
  }
  if (parsedRec.type === "createAccount" || parsedRec.type === "createAccountWithSeed") {
    const address = infoRec.newAccount;
    if (typeof source !== "string" || typeof address !== "string" || lamports === null) return null;
    return { kind: "createAccount", creation: { source, address, lamports } };
  }
  // allocate/assign/withdrawNonceAccount/advanceNonceAccount/... never move
  // lamports out of an arbitrary funder in a way relevant to this netting.
  return { kind: "irrelevant" };
}

/**
 * Collects system-program transfer/createAccount effects from the tx's
 * top-level instructions AND every `meta.innerInstructions` group. `null`
 * when the instruction shape cannot be reliably read (present but not an
 * array, or an unparseable `system` entry) — see the module doc.
 */
function collectNativeInstructionEvidence(
  transaction: unknown,
  innerInstructions: unknown,
): SolanaNativeInstructionEvidence | null {
  if (typeof transaction !== "object" || transaction === null) return null;
  const message = (transaction as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return null;

  const entries: unknown[] = [];
  const topLevel = (message as Record<string, unknown>).instructions;
  if (topLevel !== undefined && topLevel !== null) {
    if (!Array.isArray(topLevel)) return null;
    entries.push(...topLevel);
  }
  if (innerInstructions !== undefined && innerInstructions !== null) {
    if (!Array.isArray(innerInstructions)) return null;
    for (const group of innerInstructions) {
      if (typeof group !== "object" || group === null) return null;
      const inner = (group as Record<string, unknown>).instructions;
      if (!Array.isArray(inner)) return null;
      entries.push(...inner);
    }
  }

  const transfers: SolanaNativeTransfer[] = [];
  const accountCreations: SolanaCreatedAccount[] = [];
  for (const entry of entries) {
    const effect = readSystemInstructionEffect(entry);
    if (effect === null) return null;
    if (effect.kind === "transfer") transfers.push(effect.transfer);
    else if (effect.kind === "createAccount") accountCreations.push(effect.creation);
  }
  return { transfers, accountCreations };
}
