/**
 * Binding a PROVIDER-SUPPLIED bridge DEPOSIT call to the principal Vex decided
 * to bridge, BEFORE anything is signed.
 *
 * WHY IT EXISTS. The approve guard (`./erc20-approve-step-guard.ts`) closed the
 * allowance hole: a bridge may only grant exactly the principal, and only to
 * the deposit this same plan calls. It does NOT prove that the deposit then
 * MOVES that principal. A depository that is handed `approve(target, 5_000_000)`
 * can still be called with `depositErc20(user, token, 1, id)`: one unit bridged,
 * the full fixed Vex fee charged, and the card that said the whole amount would
 * travel is wrong. This module reads the deposit calldata and refuses that.
 *
 * WHAT MAY BE BOUND, AND WHAT MAY NOT. A selector is only a bound when its
 * SIGNATURE is confirmed from an authoritative source - the provider's own
 * public documentation, or a VERIFIED contract on a chain explorer for the very
 * address the live capture calls. A four-byte value alone proves nothing: the
 * 4byte and openchain directories are user-submitted, collide by construction,
 * and a wrong argument layout read as a money bound is worse than no bound.
 * So an UNCONFIRMED selector is NOT refused - refusing it would break honest
 * traffic the moment a venue upgrades its router, on nothing more than our own
 * ignorance. It is recorded as {@link DEPOSIT_SELECTOR_UNVERIFIED} and logged
 * once, and the RECEIPT FLOOR
 * (`@vex-agent/tools/protocols/bridge-deposit-evidence.ts`) stays the money
 * guard for it: the deposit's own logs must prove the principal moved before
 * any fee leg becomes eligible.
 *
 * THE SIGNATURE TABLE AND ITS PROVENANCE (researched 2026-09-04):
 *
 *  - `0xe8017952` = `depositErc20(address depositor, address token, uint256
 *    amount, bytes32 id)`. Relay. CONFIRMED: the verified `RelayDepository`
 *    source and ABI published by the Base explorer for
 *    `0x4cD00e387622c35bDDB9B4C962C136462338BC31`, the very address all five
 *    live Relay ERC-20 captures call
 *    (`base.blockscout.com/api/v2/smart-contracts/0x4cD00e387622c35bDDB9B4C962C136462338BC31`,
 *    `file_path: src/RelayDepository.sol`, `is_verified: true`). The selector
 *    is the keccak prefix of that signature, and the decoded arguments of every
 *    capture match the quote exactly: `token` is the requested
 *    `originCurrency`, `amount` is the requested `amount`.
 *  - `0x49290c1c` = `depositNative(address depositor, bytes32 id)`. Relay, same
 *    verified contract and same source file. The principal is the transaction
 *    VALUE, which `native-value-authorization` already attributes wei by wei,
 *    so this entry binds the DEPOSITOR and leaves the amount to that gate.
 *  - `0x5a1ee3ac` = `depositErc20(address depositor, address token, bytes32
 *    id)`, the three-argument overload in the same verified source. It encodes
 *    no amount: the depository pulls the whole ALLOWANCE, which the approve
 *    guard has already bound to exactly the principal. Listed so the overload is
 *    a KNOWN shape rather than an unverified one.
 *  - `0xf3125a1f` = Khalani `CONTRACT_CALL` deposit, target
 *    `0x1A7c327d0f402AEf2eD3D20D1141bD71BA1C317B` on Base. NOT CONFIRMED. That
 *    address is unverified on the Base explorer (no ABI, no source) and on
 *    Sourcify, and the Khalani/Hyperstream public documentation publishes no
 *    deposit ABI. The head words of the live capture are consistent with
 *    `(address token, uint256 amount, ...)` - the first word is the origin USDC
 *    address and the second is the quoted input - but "consistent with" is a
 *    guess, not a signature, and a guess must not become a money bound. It is
 *    therefore recorded unverified and left to the receipt floor.
 */

import { decodeAbiParameters, getAddress, type Hex } from "viem";

import logger from "../../utils/logger.js";

/** The recorded outcome for a deposit whose selector no authority confirms. */
export const DEPOSIT_SELECTOR_UNVERIFIED = "deposit_selector_unverified";

/** What a confirmed signature lets this module compare, per argument. */
interface VerifiedDepositSignature {
  /** The human signature, for the log line and the refusal text. */
  readonly signature: string;
  /** ABI parameter types of the argument body, in order. */
  readonly types: readonly { readonly type: string }[];
  /** Index of the ERC-20 token argument, when the signature encodes one. */
  readonly tokenArg: number | null;
  /** Index of the principal argument, when the signature encodes one. */
  readonly amountArg: number | null;
  /** Index of the depositor argument, when the signature encodes one. */
  readonly depositorArg: number | null;
  /** True when the principal travels as the transaction value instead. */
  readonly principalIsTxValue: boolean;
}

const ADDRESS = { type: "address" } as const;
const UINT256 = { type: "uint256" } as const;
const BYTES32 = { type: "bytes32" } as const;

const VERIFIED_DEPOSIT_SIGNATURES: Readonly<Record<string, VerifiedDepositSignature>> = {
  "0xe8017952": {
    signature: "depositErc20(address,address,uint256,bytes32)",
    types: [ADDRESS, ADDRESS, UINT256, BYTES32],
    depositorArg: 0,
    tokenArg: 1,
    amountArg: 2,
    principalIsTxValue: false,
  },
  "0x5a1ee3ac": {
    signature: "depositErc20(address,address,bytes32)",
    types: [ADDRESS, ADDRESS, BYTES32],
    depositorArg: 0,
    tokenArg: 1,
    amountArg: null,
    principalIsTxValue: false,
  },
  "0x49290c1c": {
    signature: "depositNative(address,bytes32)",
    types: [ADDRESS, BYTES32],
    depositorArg: 0,
    tokenArg: null,
    amountArg: null,
    principalIsTxValue: true,
  },
};

/** Closed refusal vocabulary of the deposit binding. */
export type BridgeDepositCalldataRefusalReason =
  /** A confirmed selector whose argument body would not decode. */
  | "deposit_calldata_undecodable"
  /** A confirmed selector that moves a token other than the origin currency. */
  | "deposit_token_not_origin"
  /** A confirmed selector that moves an amount other than the quoted principal. */
  | "deposit_principal_mismatch"
  /** A confirmed selector crediting an account that is not the selected wallet. */
  | "deposit_depositor_not_wallet";

export type BridgeDepositCalldataVerdict =
  | { readonly ok: true; readonly bound: true; readonly signature: string }
  | { readonly ok: true; readonly bound: false; readonly selector: string }
  | {
      readonly ok: false;
      readonly reason: BridgeDepositCalldataRefusalReason;
      readonly detail: string;
    };

/** The deposit transaction as the plan carries it. */
export interface BridgeDepositCall {
  readonly to: string;
  readonly data: string | undefined;
  readonly value: bigint;
}

/** What VEX derived about this bridge, never a provider echo. */
export interface BridgeDepositBinding {
  /**
   * The origin token contract, or `null` when the origin asset is the chain's
   * native currency.
   */
  readonly originToken: string | null;
  /** The selected wallet the deposit must credit. */
  readonly wallet: string;
  /**
   * The exact principal Vex asked the venue to bridge (`bridgedRaw`), or `null`
   * when Vex derived none. A `null` principal binds no amount: the receipt
   * floor is then the only amount rule, exactly as for an unverified selector.
   */
  readonly principalRaw: bigint | null;
}

function selectorOf(data: string | undefined): string | null {
  if (typeof data !== "string") return null;
  if (!/^0x[0-9a-fA-F]{8}/.test(data)) return null;
  return data.slice(0, 10).toLowerCase();
}

function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/**
 * Every (venue, chain, selector) already reported, so the unverified-selector
 * line is emitted ONCE per shape rather than once per bridge. The set is
 * bounded by the number of deposit shapes a build can meet, which is the
 * number of entries a venue's router publishes: a handful, not a per-call
 * growth.
 */
const reportedUnverified = new Set<string>();

/** Report an unconfirmed deposit selector once per venue, chain and selector. */
export function logUnverifiedDepositSelector(args: {
  readonly venue: string;
  readonly chainId: number;
  readonly selector: string;
  readonly target: string;
}): void {
  const key = `${args.venue}:${args.chainId}:${args.selector}`;
  if (reportedUnverified.has(key)) return;
  reportedUnverified.add(key);
  logger.info(`${args.venue}.${DEPOSIT_SELECTOR_UNVERIFIED}`, {
    chainId: args.chainId,
    selector: args.selector,
    target: args.target,
  });
}

/**
 * Bind a deposit call to the plan, or record that its selector is unconfirmed.
 *
 * Returns `{ ok: true, bound: false }` for a selector no authority confirms:
 * that is a RECORD, not an acceptance of the amount. The caller logs it and the
 * receipt floor still has to prove the principal moved before a fee is charged.
 */
export function verifyBridgeDepositCalldata(
  call: BridgeDepositCall,
  plan: BridgeDepositBinding,
): BridgeDepositCalldataVerdict {
  const selector = selectorOf(call.data);
  if (selector === null) {
    return { ok: true, bound: false, selector: "0x" };
  }
  const known = VERIFIED_DEPOSIT_SIGNATURES[selector];
  if (known === undefined) {
    return { ok: true, bound: false, selector };
  }

  let args: readonly unknown[];
  try {
    // `call.data` was proved to carry at least a selector above, and the ABI
    // decoder owns the rest: a body that does not match the confirmed layout
    // throws, and a throw is a refusal rather than a guess.
    args = decodeAbiParameters(known.types, `0x${(call.data as string).slice(10)}` as Hex);
  } catch {
    return {
      ok: false,
      reason: "deposit_calldata_undecodable",
      detail: `the deposit calls ${known.signature} with an argument body Vex could not decode`,
    };
  }

  if (known.depositorArg !== null) {
    const depositor = args[known.depositorArg];
    if (typeof depositor !== "string" || !sameAddress(depositor, plan.wallet)) {
      return {
        ok: false,
        reason: "deposit_depositor_not_wallet",
        detail: "the deposit would be credited to an account that is not the selected wallet",
      };
    }
  }

  if (known.tokenArg !== null) {
    const token = args[known.tokenArg];
    if (plan.originToken === null || typeof token !== "string" || !sameAddress(token, plan.originToken)) {
      return {
        ok: false,
        reason: "deposit_token_not_origin",
        detail: "the deposit would move a token that is not the origin currency of this bridge",
      };
    }
  }

  if (plan.principalRaw !== null) {
    if (known.amountArg !== null) {
      const amount = args[known.amountArg];
      if (typeof amount !== "bigint" || amount !== plan.principalRaw) {
        return {
          ok: false,
          reason: "deposit_principal_mismatch",
          detail: `the deposit would move ${typeof amount === "bigint" ? amount : "an unreadable amount"} where the plan bridges exactly ${plan.principalRaw}`,
        };
      }
    } else if (known.principalIsTxValue && call.value !== plan.principalRaw) {
      return {
        ok: false,
        reason: "deposit_principal_mismatch",
        detail: `the deposit sends ${call.value} native wei where the plan bridges exactly ${plan.principalRaw}`,
      };
    }
  }

  return { ok: true, bound: true, signature: known.signature };
}
