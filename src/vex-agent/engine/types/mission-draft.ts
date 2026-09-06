/**
 * Mission draft — the camelCase domain model and the untrusted model patch.
 *
 * Implementation detail of `engine/types.ts`; import from there.
 */

// ── Mission draft — domain model (camelCase, typed) ─────────────

/**
 * The capital this mission actually puts to work, typed.
 *
 * Rule 90: "Raw amounts must travel with the decimals needed to read them."
 * `startingCapital` stays as the free-text sentence the user reads; this is the
 * machine-readable declaration the runtime measures against, so nothing has to
 * re-derive it from prose.
 *
 * ALL SIX PARTS OR NONE for new declarations. A raw amount without decimals is unreadable, an
 * amount without an asset is uncountable, and an asset without a chain is
 * ambiguous. `mapper`, `contract-hash` and `patch-parser` all route through the
 * ONE shared normalizer in `engine/mission/deployed-capital.ts`, which turns a
 * partial or malformed object into `null` (absent), never into a
 * partially-usable value.
 *
 * NOT A SPEND CAP. Nothing refuses a trade for exceeding it. It is the
 * denominator for measurement. The enforceable ceilings are `maxLaunchValue*`
 * / `maxLaunchCount` in `engine/mission/launch-ceiling.ts`.
 */
export interface DeployedCapital {
  /** Integer base-unit amount, digits only, at least one non-zero digit. Never a float, never signed, never in exponent form. */
  readonly amountRaw: string;
  /** Decimals needed to read `amountRaw`. Integer 0..36. */
  readonly decimals: number;
  /** Chain the asset lives on, as the repo's numeric chain id (Solana is 20011000000). */
  readonly chainId: number;
  /**
   * Token identity on `chainId`. EVM: a 20-byte 0x address or the native
   * sentinel, canonicalized to lowercase. Solana: a base58 mint, case
   * PRESERVED. See `engine/mission/deployed-capital.ts` for the family rules.
   */
  readonly assetAddress: string;
  /**
   * Structural spendability domain. `native` means the chain account coin;
   * `token` means a contract/SPL mint, including wSOL. Null is accepted only
   * for legacy five-field declarations and is treated as ambiguous where the
   * address alone cannot distinguish the two.
   */
  readonly assetKind: "native" | "token" | null;
  /** Display symbol as the user agreed it. Never used for matching; matching is by (chainId, assetAddress). */
  readonly assetSymbol: string;
}

/**
 * Shared bounds for {@link DeployedCapital}, reused by the patch parser, the
 * mapper, the contract hash and the `MissionDraftUpdate` tool schema so all
 * four accept exactly the same values. `AMOUNT_RAW_MAX_CHARS` and
 * `DECIMALS_MAX` match the host's existing `maxLaunchValueRaw` bounds.
 */
export const DEPLOYED_CAPITAL_BOUNDS = {
  AMOUNT_RAW_MAX_CHARS: 80,
  DECIMALS_MIN: 0,
  DECIMALS_MAX: 36,
  CHAIN_ID_MIN: 1,
  ASSET_ADDRESS_MAX: 128,
  ASSET_SYMBOL_MAX: 32,
} as const;

/** Required fields for a mission to transition from draft → ready. */
export interface MissionDraft {
  title: string | null;
  goal: string | null;
  capitalSource: string | null;
  startingCapital: string | null;
  /**
   * @see DeployedCapital. Optional; `null` means "not declared", never "zero".
   * Deliberately absent from {@link MISSION_DRAFT_REQUIRED_FIELDS}: requiring it
   * would strand every existing draft at `not_ready`. `engine/mission/measurability.ts`
   * applies the pressure instead, by warning when a success criterion needs it.
   */
  deployedCapital: DeployedCapital | null;
  allowedWallets: string[] | null;
  allowedChains: string[] | null;
  allowedProtocols: string[] | null;
  riskProfile: string | null;
  successCriteria: string[] | null;
  stopConditions: string[] | null;
  /** Optional — mission may have no deadline. */
  deadline: string | null;
  /**
   * Optional hard time-box in whole minutes. The turn-loop deadline
   * enforcer stops the run at `started_at + this` (see
   * `engine/mission/mission-deadline.ts`). Absent -> env override -> 60min
   * default. Distinct from `deadline` (free-text, informational only).
   */
  durationMinutes: number | null;
  /**
   * Enforceable spend ceiling for an autonomous token launch (C6), as a RAW
   * integer amount string paired with {@link maxLaunchValueDecimals}. `null`
   * means NO CEILING SET, which FAILS CLOSED — it is not "unlimited".
   * HOST-AUTHORED ONLY (deliberately absent from `patch-parser.ts`).
   * Units, the decimals===18 requirement and the comparison itself live in
   * `engine/mission/launch-ceiling.ts` — read it before using either field.
   */
  maxLaunchValueRaw: string | null;
  /** Decimals for {@link maxLaunchValueRaw}. Must be 18 to be enforceable. */
  maxLaunchValueDecimals: number | null;
  /**
   * How many tokens the agent may create in this mission (C6b). A
   * non-negative whole number; `null` means NO CEILING SET and FAILS CLOSED,
   * exactly like {@link maxLaunchValueRaw} — a mission that was never set up
   * to create tokens can never create one unattended.
   *
   * The value ceiling alone is not enough: a loop that stays under the
   * per-launch cap could still mint dozens of tokens. HOST-AUTHORED ONLY
   * (deliberately absent from `patch-parser.ts`); enforcement lives in
   * `engine/mission/launch-ceiling.ts`.
   */
  maxLaunchCount: number | null;
}

/**
 * Required fields that must be non-null for draft → ready transition.
 * `deadline` is intentionally excluded — it's optional.
 */
export const MISSION_DRAFT_REQUIRED_FIELDS: readonly (keyof MissionDraft)[] = [
  "title",
  "goal",
  "capitalSource",
  "startingCapital",
  "allowedWallets",
  "allowedChains",
  "allowedProtocols",
  "riskProfile",
  "successCriteria",
  "stopConditions",
] as const;

// ── Mission patch — untrusted model output ──────────────────────

/** Raw patch from model — must be validated/sanitized before DB write. */
export interface MissionPatch {
  [key: string]: unknown;
}
