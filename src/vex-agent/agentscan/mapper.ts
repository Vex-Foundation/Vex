/**
 * AgentScan mapper — one `agent_activity` row → one ingest-contract event.
 *
 * PRIVACY IS STRUCTURAL HERE. The event object is built exclusively from the
 * named contract fields below; there is no spread, no passthrough, no "copy
 * the rest". The banned columns (`wallet_address`, `from_address`,
 * `session_id`, `nonce`, `failure_reason` free text, `route_provenance`, and
 * everything else the row carries) simply have no line that reads them.
 * `src/__tests__/vex-agent/agentscan/mapper.test.ts` pins the exact key set
 * and validates the output against a mirror of the server's own zod schema.
 *
 * VALUES ARE GUARDED, NOT TRUSTED. The server rejects a whole event over one
 * malformed optional (`^\d+$` amounts, `^\d+(\.\d+)?$` USD strings), so a
 * value that would fail its regex is sent as null — a lost estimate must not
 * sink a real activity report.
 *
 * THE STATUS IS THE OUTBOX SNAPSHOT, not the live row. A `pending` snapshot of
 * a row that has since confirmed reports `pending` without executed amounts or
 * `confirmedAt`; the server orders statuses itself (monotonic precedence), so
 * a stale snapshot can never regress anything. `superseded_unproven` is a
 * terminal NON-failure: no amounts, no confirmation time, and no failure code
 * (the server rejects an event that pairs one with this status).
 *
 * THE CONFIRMATION TIME WE SEND IS THE BLOCK TIME OR NOTHING. AgentScan
 * compares a reported `confirmedAt` against the block time it reads itself and
 * strikes the install when they differ by more than its tolerance; three
 * strikes quarantine the whole install. Our local `confirmed_at` is the time we
 * OBSERVED the settlement, which trails the block by however long the app was
 * not running, so it is never sent. A row with no `settled_block_time`
 * (migration 078) reports NO confirmation time at all, which the server accepts
 * and which makes it anchor its pricing on the block time it verified itself.
 */

const RAW_AMOUNT = /^\d+$/;
const USD_STRING = /^\d+(\.\d+)?$/;

/**
 * The server's closed failure-code enum. Vex's own vocabulary is a superset:
 * `solana_signature_expired` (proven blockhash expiry — Solana's flavor of "did
 * not confirm inside its validity window") maps to `confirmation_timeout`;
 * anything else unknown maps to `unknown`.
 */
const SERVER_FAILURE_CODES = new Set([
  "route_not_found", "slippage", "deadline_expired", "insufficient_liquidity",
  "allowance_or_balance", "chain_unsupported", "simulation_reverted", "mined_revert",
  "broadcast_error", "confirmation_timeout", "unknown", "bridge_failed", "bridge_refunded",
  "venue_unavailable",
]);

/**
 * The EVM native-asset sentinel — the ONE address a native leg may leave here
 * carrying, whatever the venue stored.
 */
const EVM_NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/**
 * The addresses that MEAN "the chain's native asset" on an EIP-155 row, all
 * lowercase and matched case-insensitively.
 *
 * The zero address is here because Relay records native ETH legs with it rather
 * than with the sentinel. Both are native to us; only one of them is native to
 * the server (see the normalization below).
 */
const EVM_NATIVE_ALIASES: ReadonlySet<string> = new Set([
  EVM_NATIVE_SENTINEL,
  `0x${"0".repeat(40)}`,
]);

/**
 * The executed slots the server actually VERIFIES for a native leg.
 *
 * Its verifier reads `tokenIn`/`tokenOut` only, and it splits on them:
 * a native INPUT is cross-checked against the transaction's own `value`, a
 * native OUTPUT is skipped outright, and the second-leg slots are not part of
 * its verification input at all. Skipping is not verifying, so only the slot it
 * genuinely checks may carry a native amount; the rest stay null until the
 * server states what it does with them. A declared amount the verifier cannot
 * match is a strike, and three strikes quarantine the whole install.
 *
 * Scope is the LEG, not the row: an ERC-20 leg on the same row reports its
 * executed amount normally, and the local database keeps every amount in full.
 * This is a reporting rule, not a decoding one.
 */
const NATIVE_VERIFIED_EXECUTED_SLOTS: ReadonlySet<ExecutedSlot> = new Set(["primary_input"]);

/** Which executed field is being reported — the axis the native rule turns on. */
type ExecutedSlot = "primary_input" | "primary_output" | "second_input" | "second_output";

/**
 * The settlement provenance that means "our reading of this row's amounts is
 * DISPUTED" — two decoders disagreed, no amount was written, and the row was
 * quarantined locally. Its executed amounts, whatever else is stored on the
 * row, must not be declared to a verifier.
 */
const DISPUTED_SETTLEMENT_SOURCE = "conflict_quarantined";

/**
 * Mirrors the server's `SECOND_LEG_ROLES` (`packages/contract/src/role-binding.ts`),
 * which rejects the whole event over a second leg on any other role.
 *
 * The three claim roles pay TWO assets (the launched token and the asset it was
 * paired against), which is the same second-output-leg shape the Pendle split
 * roles use. `reward_distribution` is deliberately absent on both sides: the
 * caller of `distribute()` is paid nothing, so a second leg on it would be
 * evidence the writer decoded the wrong transaction.
 */
const SECOND_LEG_ROLES = new Set([
  "yield_py",
  "yield_lp",
  "pools_claim",
  "creator_fee_claim",
  "holder_reward_claim",
]);

/**
 * Mirrors the server's `INPUT_LEG_FORBIDDEN_ROLES`: a claim spends nothing, on
 * either side, and a distribute takes nothing from its caller but gas, which
 * this ledger does not model as a leg.
 *
 * This is the OUTGOING half of the same rule migration 107 enforces on write
 * (`agent_activity_claim_family_no_input_leg`). It covers `pools_claim` too,
 * which that CHECK deliberately does not: rows already exist under that role, so
 * the database cannot refuse them retroactively, but nothing obliges this mapper
 * to declare an input leg the server would reject the event over.
 */
const INPUT_LEG_FORBIDDEN_ROLES = new Set([
  "yield_claim",
  "pools_claim",
  "creator_fee_claim",
  "holder_reward_claim",
  "reward_distribution",
]);

export interface AgentscanTokenRef {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
}

/** Ingest-contract event (§4.2) — chain ids as decimal strings (the server coerces bigint). */
export interface AgentscanEvent {
  readonly sourceRowId: string;
  readonly sourceExecutionId: string;
  readonly eventIndex: number;
  readonly kind: string;
  readonly eventRole: string;
  readonly status: string;
  readonly protocol: string;
  readonly chainFamily: string;
  readonly chainId: string;
  readonly fromChainId: string | null;
  readonly toChainId: string | null;
  readonly tokenIn: AgentscanTokenRef | null;
  readonly tokenOut: AgentscanTokenRef | null;
  readonly amountInRaw: string | null;
  readonly amountOutRaw: string | null;
  readonly executedInRaw: string | null;
  readonly executedOutRaw: string | null;
  readonly tokenIn2: AgentscanTokenRef | null;
  readonly tokenOut2: AgentscanTokenRef | null;
  readonly amountIn2Raw: string | null;
  readonly amountOut2Raw: string | null;
  readonly executedIn2Raw: string | null;
  readonly executedOut2Raw: string | null;
  readonly usdInEst: string | null;
  readonly usdOutEst: string | null;
  readonly usdFeeEst: string | null;
  readonly usdSource: string | null;
  readonly txHash: string | null;
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly confirmedAt: string | null;
  readonly observedAt: string | null;
}

export function mapActivityToEvent(
  activity: Record<string, unknown>,
  snapshot: { readonly status: string },
): AgentscanEvent {
  const confirmed = snapshot.status === "confirmed";
  const failed = snapshot.status === "definitively_failed";
  const role = str(activity.event_role) ?? "";
  const inputLegAllowed = !INPUT_LEG_FORBIDDEN_ROLES.has(role);
  const secondLegAllowed = SECOND_LEG_ROLES.has(role);
  const evm = str(activity.chain_family) === "eip155";

  const tokenIn = inputLegAllowed
    ? tokenRef(activity.token_in_address, activity.token_in_symbol, activity.token_in_decimals, evm)
    : null;
  const tokenOut = tokenRef(activity.token_out_address, activity.token_out_symbol, activity.token_out_decimals, evm);
  // BOTH gates, not just the second-leg one: a role that spends nothing spends
  // nothing on either side, and the three claim roles are on both lists. The
  // database already forbids these columns on those roles (migrations 082/102),
  // so this is the structural guarantee rather than the only one.
  const tokenIn2 = secondLegAllowed && inputLegAllowed
    ? tokenRef(activity.token_in2_address, activity.token_in2_symbol, activity.token_in2_decimals, evm)
    : null;
  const tokenOut2 = secondLegAllowed
    ? tokenRef(activity.token_out2_address, activity.token_out2_symbol, activity.token_out2_decimals, evm)
    : null;

  const executed = executedAmountReporter(activity, confirmed);

  return {
    sourceRowId: String(activity.id),
    sourceExecutionId: String(activity.protocol_execution_id),
    eventIndex: Number(activity.event_index),
    kind: str(activity.kind) ?? "",
    eventRole: role,
    status: snapshot.status,
    protocol: (str(activity.protocol) ?? "").slice(0, 32),
    chainFamily: str(activity.chain_family) ?? "",
    chainId: String(activity.chain_id),
    fromChainId: idString(activity.from_chain_id),
    toChainId: idString(activity.to_chain_id),
    tokenIn,
    tokenOut,
    amountInRaw: inputLegAllowed ? guarded(activity.amount_in_raw, RAW_AMOUNT) : null,
    amountOutRaw: guarded(activity.amount_out_raw, RAW_AMOUNT),
    executedInRaw: inputLegAllowed
      ? executed(activity.executed_amount_in_raw, activity.token_in_address, "primary_input")
      : null,
    executedOutRaw: executed(activity.executed_amount_out_raw, activity.token_out_address, "primary_output"),
    tokenIn2,
    tokenOut2,
    // A second-leg amount may never travel without the token carrying its
    // decimals: the server rejects the event, and a raw amount whose decimals
    // are unknown is unreadable anyway.
    amountIn2Raw: tokenIn2 === null ? null : guarded(activity.amount_in2_raw, RAW_AMOUNT),
    amountOut2Raw: tokenOut2 === null ? null : guarded(activity.amount_out2_raw, RAW_AMOUNT),
    executedIn2Raw: tokenIn2 === null
      ? null
      : executed(activity.executed_amount_in2_raw, activity.token_in2_address, "second_input"),
    executedOut2Raw: tokenOut2 === null
      ? null
      : executed(activity.executed_amount_out2_raw, activity.token_out2_address, "second_output"),
    usdInEst: guarded(activity.usd_in_est, USD_STRING),
    usdOutEst: guarded(activity.usd_out_est, USD_STRING),
    usdFeeEst: guarded(activity.usd_fee_est, USD_STRING),
    usdSource: clamp(str(activity.usd_source), 32),
    txHash: str(activity.tx_hash),
    failureCode: failed ? mapFailureCode(activity.failure_code) : null,
    createdAt: iso(activity.created_at) ?? new Date(0).toISOString(),
    // The BLOCK time or nothing — never the local observation time. See the
    // module header for what sending the observation time costs.
    confirmedAt: confirmed ? iso(activity.settled_block_time) : null,
    observedAt: iso(activity.observed_at),
  };
}

/**
 * The one place an executed amount is allowed out, with the two suppressions
 * that keep an unverifiable claim from becoming a strike, bound together so
 * neither can be forgotten on a new leg.
 */
function executedAmountReporter(
  activity: Record<string, unknown>,
  confirmed: boolean,
): (value: unknown, legTokenAddress: unknown, slot: ExecutedSlot) => string | null {
  const disputed = str(activity.settlement_source) === DISPUTED_SETTLEMENT_SOURCE;
  return (value, legTokenAddress, slot) => {
    if (!confirmed || disputed) return null;
    if (isEvmNativeAlias(legTokenAddress) && !NATIVE_VERIFIED_EXECUTED_SLOTS.has(slot)) return null;
    return guarded(value, RAW_AMOUNT);
  };
}

/** The leg's stored address, whatever its casing, against every native alias. */
function isEvmNativeAlias(address: unknown): boolean {
  return typeof address === "string" && EVM_NATIVE_ALIASES.has(address.toLowerCase());
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function clamp(value: string | null, max: number): string | null {
  return value === null ? null : value.slice(0, max);
}

/** A nullable bigint-ish column → decimal string (pg returns int8 as string). */
function idString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/** A string column that must match the server's regex — anything else is sent as null. */
function guarded(value: unknown, shape: RegExp): string | null {
  const s = str(value);
  return s !== null && shape.test(s) ? s : null;
}

/**
 * All three parts or nothing — the server requires the full object when present.
 *
 * A native EIP-155 leg is emitted with the SENTINEL whatever alias the row
 * stored, because the server has exactly one native address: its verifier calls
 * a leg native only when the address equals the sentinel, and it prices the
 * sentinel correctly by mapping it to the zero address itself. A native leg
 * declared with the zero address would therefore be cross-checked as an ERC-20
 * token, find no `Transfer` log for it, and take a strike. The normalization is
 * OUTGOING only: the local row keeps the address its venue wrote.
 */
function tokenRef(
  address: unknown,
  symbol: unknown,
  decimals: unknown,
  evm: boolean,
): AgentscanTokenRef | null {
  const addr = str(address);
  const sym = str(symbol);
  if (addr === null || sym === null || decimals === null || decimals === undefined) return null;
  const dec = Number(decimals);
  if (!Number.isInteger(dec)) return null;
  const reported = evm && isEvmNativeAlias(addr) ? EVM_NATIVE_SENTINEL : addr;
  return { address: reported, symbol: sym.slice(0, 16), decimals: dec };
}

function mapFailureCode(value: unknown): string | null {
  const code = str(value);
  if (code === null) return null;
  if (code === "solana_signature_expired") return "confirmation_timeout";
  return SERVER_FAILURE_CODES.has(code) ? code : "unknown";
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}
