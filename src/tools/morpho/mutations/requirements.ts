/**
 * Classification of the SDK's action REQUIREMENTS under the owner's approval
 * policy (decision 2026-08-17).
 *
 * THE POLICY, stated once so the code below reads as its enforcement:
 *
 *   A wallet may hold ONE standing ERC-20 approval, and it must be to the
 *   CANONICAL Permit2 contract. Every individual Morpho operation is then
 *   authorised by its OWN Permit2 signature carrying that operation's amount and
 *   its own deadline. An approval to anything else - GeneralAdapter1 above all,
 *   because that is the contract that actually pulls the user's tokens - is
 *   REFUSED BY NAME, whatever amount it names.
 *
 * WHY THE SPENDER IS CHECKED AGAINST OUR OWN TABLE AND NOT THE SDK'S. The SDK
 * carries an internal spender allowlist and it is a good one. It is also the
 * thing being checked. `../constants.ts` holds Permit2's address per chain with
 * dated provenance and an explicit `null` on the two chains where Permit2 is
 * genuinely absent, and a `null` there means REFUSE rather than fall back to
 * "Permit2 is the same everywhere".
 *
 * NOTHING HERE SIGNS. A signature requirement is turned into a description - the
 * spender, the amount, the deadline, and what signing it would authorise - and
 * the `sign` callable is deliberately NOT carried onto the returned object. The
 * spike established that `buildTx` does not verify who signed what; the account
 * binding happens inside `requirement.sign()`. That makes `sign()` the
 * authorisation gate, and an authorisation gate does not belong in a preview.
 */

import type { Address } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import { MORPHO_CONTRACTS, MORPHO_SPENDER_LABELS, UINT256_MAX } from "../constants.js";

/** The unbounded value a Permit2 approval is customarily set to: `type(uint160).max`. */
const UINT160_MAX = (2n ** 160n - 1n).toString();

/** An ERC-20 approval the wallet must send before the operation can run. */
export interface MorphoApprovalRequirement {
  readonly kind: "approval";
  /** The token being approved, which is always the vault's own asset. */
  readonly token: string;
  readonly spender: string;
  readonly spenderRole: string;
  readonly amountRaw: string;
  /**
   * Whether the approval is the unbounded one. Reported rather than hidden: the
   * policy ACCEPTS an unbounded approval to Permit2 (that is what makes it a
   * one-time step) and the user is entitled to know that is what it is.
   */
  readonly unbounded: boolean;
  readonly explanation: string;
}

/** A signature the wallet must produce. Described here, never produced here. */
export interface MorphoSignatureRequirement {
  readonly kind: "signature";
  /** `permit2` or `permit`, as the SDK named it. */
  readonly scheme: string;
  readonly spender: string;
  readonly spenderRole: string;
  readonly amountRaw: string;
  /** Unix seconds after which the signature is worthless. Always present. */
  readonly deadlineSeconds: string;
  /** Permit2 only: when the allowance the signature installs itself expires. */
  readonly expirationSeconds: string | null;
  readonly explanation: string;
}

export type MorphoRequirement = MorphoApprovalRequirement | MorphoSignatureRequirement;

/** The raw requirement shape the SDK returns, read structurally and untrusted. */
interface RawRequirement {
  to?: unknown;
  action?: { type?: unknown; args?: Record<string, unknown> };
  sign?: unknown;
}

function policyViolation(message: string, hint: string): never {
  throw new VexError(ErrorCodes.MORPHO_APPROVAL_POLICY_VIOLATION, message, hint);
}

function readAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    policyViolation(
      `Refusing a Morpho operation: its ${field} did not read as an address, so Vex cannot say what the wallet `
      + "would be authorising.",
      "Nothing was signed or approved. Re-read the vault and rebuild the operation.",
    );
  }
  return value.toLowerCase();
}

function readAmount(value: unknown, field: string): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  policyViolation(
    `Refusing a Morpho operation: its ${field} did not read as a whole number of raw units, so the size of what `
    + "the wallet would be authorising is unknown.",
    "Nothing was signed or approved. Re-read the vault and rebuild the operation.",
  );
}

/** The chain's canonical Permit2, or a named refusal where the registry has none. */
function requirePermit2(chainId: number): string {
  const permit2 = MORPHO_CONTRACTS[chainId]?.permit2;
  if (permit2 === null || permit2 === undefined) {
    policyViolation(
      `Vex's approval policy for Morpho requires the canonical Permit2 contract, and the pinned registry has no `
      + `Permit2 on chain ${chainId}. The operation is refused rather than routed through a different approval.`,
      "Permit2 is genuinely absent on Monad and HyperEVM in the pinned registry. Vex does not assume Permit2 is "
      + "deployed at the same address everywhere, because approving a contract that is not there is not safety.",
    );
  }
  return permit2.toLowerCase();
}

function describeSpender(chainId: number, spender: string): string {
  const contracts = MORPHO_CONTRACTS[chainId];
  if (contracts === undefined) return "an unrecognised contract";
  for (const [role, address] of Object.entries(contracts)) {
    if (address !== null && address.toLowerCase() === spender) {
      return MORPHO_SPENDER_LABELS[role as keyof typeof MORPHO_SPENDER_LABELS] ?? role;
    }
  }
  return "a contract with no pinned Morpho role";
}

function classifyApproval(raw: RawRequirement, chainId: number, assetAddress: Address): MorphoApprovalRequirement {
  const args = raw.action?.args ?? {};
  const spender = readAddress(args["spender"], "approval spender");
  const amountRaw = readAmount(args["amount"], "approval amount");
  const token = readAddress(raw.to, "approval token");
  const permit2 = requirePermit2(chainId);

  if (spender !== permit2) {
    policyViolation(
      `Refusing a Morpho operation: it asks the wallet to approve ${describeSpender(chainId, spender)} `
      + `(${spender}) to spend its tokens. Vex's approval policy permits exactly one standing approval, to the `
      + `canonical Permit2 ${permit2}, with every operation then authorised by its own signed permit. An approval `
      + "to any other contract, GeneralAdapter1 included, is refused.",
      "Nothing was approved. This is a policy refusal rather than a transient failure, so retrying the same "
      + "operation produces the same answer.",
    );
  }
  if (token.toLowerCase() !== assetAddress.toLowerCase()) {
    policyViolation(
      `Refusing a Morpho operation: it asks the wallet to approve the token ${token}, which is not the vault's own `
      + `asset ${assetAddress.toLowerCase()}.`,
      "Nothing was approved. An approval on a token the operation does not move is not part of this operation.",
    );
  }

  const unbounded = amountRaw === UINT160_MAX || amountRaw === UINT256_MAX;
  return {
    kind: "approval",
    token,
    spender,
    spenderRole: MORPHO_SPENDER_LABELS.permit2,
    amountRaw,
    unbounded,
    explanation: unbounded
      ? "A one-time unbounded approval to the canonical Permit2. Permit2 cannot move anything on its own: each "
        + "operation still needs its own signature naming an amount and a deadline, which is why this approval is "
        + "sent once rather than before every deposit. It is nonetheless a standing grant and can be revoked."
      : `A one-time approval of ${amountRaw} raw units to the canonical Permit2. Each operation still needs its own `
        + "signature naming an amount and a deadline.",
  };
}

function classifySignature(raw: RawRequirement, chainId: number): MorphoSignatureRequirement {
  const scheme = typeof raw.action?.type === "string" ? raw.action.type : "unknown";
  const args = raw.action?.args ?? {};
  const spender = readAddress(args["spender"], "signature spender");
  const amountRaw = readAmount(args["amount"], "signature amount");
  const deadlineSeconds = readAmount(args["deadline"], "signature deadline");
  const expiration = args["expiration"];
  const expirationSeconds = expiration === undefined ? null : readAmount(expiration, "permit2 expiration");

  return {
    kind: "signature",
    scheme,
    spender,
    spenderRole: describeSpender(chainId, spender),
    amountRaw,
    deadlineSeconds,
    expirationSeconds,
    explanation:
      `Signing this would authorise ${describeSpender(chainId, spender)} (${spender}) to draw ${amountRaw} raw units `
      + `for this one operation, and the signature stops being usable after unix second ${deadlineSeconds}. It is a `
      + "per-operation authorisation, not a standing approval, and NOTHING has been signed here.",
  };
}

/**
 * Classify every requirement the SDK returned, enforcing the approval policy.
 *
 * @throws {VexError} `MORPHO_APPROVAL_POLICY_VIOLATION` when an approval names
 * any spender other than the chain's canonical Permit2, when it names a token
 * the operation does not move, or when a requirement cannot be read at all.
 */
export function classifyMorphoRequirements(
  requirements: readonly unknown[],
  chainId: number,
  assetAddress: Address,
): readonly MorphoRequirement[] {
  return requirements.map((entry) => {
    const raw = entry as RawRequirement;
    if (typeof raw.sign === "function") return classifySignature(raw, chainId);
    if (raw.action?.type === "erc20Approval") return classifyApproval(raw, chainId, assetAddress);
    policyViolation(
      `Refusing a Morpho operation: it carries a requirement of type "${String(raw.action?.type)}" that Vex does `
      + "not recognise as either an approval or a signature, so it cannot be shown to a user or checked against "
      + "the approval policy.",
      "Nothing was signed or approved. An unrecognised requirement is refused rather than passed through.",
    );
  });
}
