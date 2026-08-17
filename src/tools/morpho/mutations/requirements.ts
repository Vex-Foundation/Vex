/**
 * Classification of the SDK's action REQUIREMENTS under the owner's FINAL
 * approval policy (decision 2026-08-17, which replaced the earlier Permit2 one).
 *
 * THE POLICY, stated once so the code below reads as its enforcement:
 *
 *   Vex uses NO SIGNATURE PATH OF ANY KIND for Morpho. Not Permit2, not
 *   EIP-2612. Every operation is authorised by one plain ERC-20 `approve()` for
 *   EXACTLY that operation's amount, to the chain's pinned GeneralAdapter1, and
 *   then the operation itself. Two transactions, sequentially, behind one user
 *   consent. An approval naming any other spender is REFUSED BY NAME, and so is
 *   an approval naming any amount other than the operation's own, unbounded
 *   above all.
 *
 * WHY AN EXACT AMOUNT AND NOT A STANDING GRANT. GeneralAdapter1 is the contract
 * that actually pulls the user's tokens in a bundled Morpho action. An allowance
 * to it that outlives the operation is a standing licence to take that much
 * again; sized to the operation, the worst residual a failed second leg can
 * leave is exactly one operation's worth, and a retry consumes it.
 *
 * WHY A SIGNATURE REQUIREMENT IS A REFUSAL AND NOT A FALLBACK. The client this
 * layer builds against is constructed with `supportSignature: false`
 * (`./client.ts`), under which the SDK's own requirement resolver returns a
 * classic approval and nothing else - verified in
 * `getGeneralAdapterRequirements`. A signature requirement arriving here would
 * therefore mean the SDK is not behaving as the layer was built against, and the
 * safe reading of that is "stop", not "handle it".
 *
 * WHY THE SPENDER IS CHECKED AGAINST OUR OWN TABLE AND NOT THE SDK'S. The SDK
 * carries an internal spender allowlist and it is a good one. It is also the
 * thing being checked. `../constants.ts` holds GeneralAdapter1 per chain with
 * dated provenance, and a chain absent from that table is a refusal rather than
 * a guess.
 */

import type { Address } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import { MORPHO_CONTRACTS, MORPHO_SPENDER_LABELS } from "../constants.js";

/** An ERC-20 approval the wallet must send before the operation can run. */
export interface MorphoApprovalRequirement {
  readonly kind: "approval";
  /** The token being approved, which is always the vault's own asset. */
  readonly token: string;
  readonly spender: string;
  readonly spenderRole: string;
  /** Always exactly the operation's own amount; anything else was refused. */
  readonly amountRaw: string;
  readonly explanation: string;
}

/**
 * The ERC-20 `approve(spender, 0)` that must precede a new approval on a token
 * which refuses a non-zero to non-zero change (the USDT shape).
 *
 * It exists in Vex's plan and NEVER in the SDK's requirement list, and that
 * asymmetry is deliberate rather than an oversight: the SDK states WHAT
 * allowance the operation needs, while the reset is a property of the TOKEN's
 * own `approve` implementation. `./allowance-plan.ts` owns it for that reason,
 * and the cross-check below therefore compares the approval, never the reset.
 */
export interface MorphoApprovalResetRequirement {
  readonly kind: "approval_reset";
  readonly token: string;
  readonly spender: string;
  readonly spenderRole: string;
  /** Always "0". A reset that named any other amount would be an approval. */
  readonly amountRaw: "0";
  readonly explanation: string;
}

/**
 * Every requirement shape this policy produces. Kept as an explicit union, and
 * every member added deliberately: a shape that appeared by widening would pass
 * through every `switch` in the lane without anybody deciding it should.
 */
export type MorphoRequirement = MorphoApprovalRequirement | MorphoApprovalResetRequirement;

/** The raw requirement shape the SDK returns, read structurally and untrusted. */
interface RawRequirement {
  to?: unknown;
  action?: { type?: unknown; args?: Record<string, unknown> };
  sign?: unknown;
}

function policyViolation(message: string, hint: string): never {
  throw new VexError(ErrorCodes.MORPHO_APPROVAL_POLICY_VIOLATION, message, hint);
}

const NOTHING_HAPPENED_HINT =
  "Nothing was approved and nothing was sent. This is a policy refusal rather than a transient failure, so retrying "
  + "the same operation produces the same answer.";

function readAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    policyViolation(
      `Refusing a Morpho operation: its ${field} did not read as an address, so Vex cannot say what the wallet `
      + "would be authorising.",
      NOTHING_HAPPENED_HINT,
    );
  }
  return value.toLowerCase();
}

function readAmount(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  policyViolation(
    `Refusing a Morpho operation: its ${field} did not read as a whole number of raw units, so the size of what `
    + "the wallet would be authorising is unknown.",
    NOTHING_HAPPENED_HINT,
  );
}

/** The chain's pinned GeneralAdapter1, or a named refusal where the registry has none. */
export function requireGeneralAdapter1(chainId: number): string {
  const adapter = MORPHO_CONTRACTS[chainId]?.generalAdapter1;
  if (adapter === null || adapter === undefined) {
    policyViolation(
      `Vex's approval policy for Morpho approves the chain's pinned GeneralAdapter1, and the registry has no pinned `
      + `GeneralAdapter1 on chain ${chainId}. The operation is refused rather than routed through an address Vex `
      + "cannot vouch for.",
      NOTHING_HAPPENED_HINT,
    );
  }
  return adapter.toLowerCase();
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

function classifyApproval(
  raw: RawRequirement,
  chainId: number,
  assetAddress: Address,
  operationAmountRaw: bigint,
): MorphoApprovalRequirement {
  const args = raw.action?.args ?? {};
  const spender = readAddress(args["spender"], "approval spender");
  const amount = readAmount(args["amount"], "approval amount");
  const token = readAddress(raw.to, "approval token");
  const adapter = requireGeneralAdapter1(chainId);

  if (spender !== adapter) {
    policyViolation(
      `Refusing a Morpho operation: it asks the wallet to approve ${describeSpender(chainId, spender)} `
      + `(${spender}) to spend its tokens. Vex approves exactly one spender for a Morpho vault operation, the `
      + `chain's pinned GeneralAdapter1 ${adapter}, and only for that operation's own amount. Vex signs no permit `
      + "and no permit2 message, so an approval to Permit2 would authorise a step that does not exist here.",
      NOTHING_HAPPENED_HINT,
    );
  }
  if (token !== assetAddress.toLowerCase()) {
    policyViolation(
      `Refusing a Morpho operation: it asks the wallet to approve the token ${token}, which is not the vault's own `
      + `asset ${assetAddress.toLowerCase()}.`,
      "Nothing was approved. An approval on a token the operation does not move is not part of this operation.",
    );
  }
  if (amount !== operationAmountRaw) {
    policyViolation(
      `Refusing a Morpho operation: it asks the wallet to approve ${amount} raw units while the operation moves `
      + `${operationAmountRaw}. Vex approves EXACTLY the operation's amount, never more and never less: more leaves `
      + "the adapter a standing licence over the difference, and less cannot pay for the operation it precedes.",
      NOTHING_HAPPENED_HINT,
    );
  }

  return {
    kind: "approval",
    token,
    spender,
    spenderRole: MORPHO_SPENDER_LABELS.generalAdapter1,
    amountRaw: amount.toString(),
    explanation:
      `An ERC-20 approval of EXACTLY ${amount.toString()} raw units to GeneralAdapter1, the contract that moves the `
      + "tokens in a bundled Morpho action. It is sent as its own transaction immediately before the operation and "
      + "it is sized to that operation, so nothing is left standing once the operation consumes it. If the operation "
      + "that follows fails, this approval remains until it is used or reset.",
  };
}

/**
 * Classify every requirement the SDK returned, enforcing the approval policy.
 *
 * SINCE THE OWNER'S OPTION-B RULING (2026-08-17) THIS IS A CROSS-CHECK, NOT THE
 * SOURCE. `./allowance-plan.ts` is the single owner of the allowance fact, read
 * from the chain for the wallet that will actually send the transaction; the
 * list this function returns is what the SDK independently believes, and the two
 * must AGREE or the operation is refused. Two independent readers of the same
 * money fact that are allowed to disagree silently is the shape rules/04 forbids.
 *
 * `operationAmountRaw` is the amount Vex's own intent moves. It is the yardstick
 * the approval is measured against, so the SDK cannot be both the builder of the
 * requirement and the authority on whether its size is right.
 *
 * @throws {VexError} `MORPHO_APPROVAL_POLICY_VIOLATION` when an approval names
 * any spender other than the chain's pinned GeneralAdapter1, any token the
 * operation does not move, or any amount other than the operation's own; when a
 * SIGNATURE requirement appears at all; or when a requirement cannot be read.
 */
export function classifyMorphoRequirements(
  requirements: readonly unknown[],
  chainId: number,
  assetAddress: Address,
  operationAmountRaw: bigint,
): readonly MorphoApprovalRequirement[] {
  return requirements.map((entry) => {
    const raw = entry as RawRequirement;
    if (typeof raw.sign === "function") {
      policyViolation(
        `Refusing a Morpho operation: the SDK returned a SIGNATURE requirement of type `
        + `"${String(raw.action?.type)}" even though Vex asked for none (\`supportSignature: false\`). Vex signs no `
        + "permit and no permit2 message for Morpho at all, so there is no step here that could satisfy it, and a "
        + "requirement Vex did not ask for means the builder is not behaving as this layer was built against.",
        "Nothing was signed, approved or sent. Report this as a Morpho SDK behaviour change rather than retrying.",
      );
    }
    if (raw.action?.type === "erc20Approval") {
      return classifyApproval(raw, chainId, assetAddress, operationAmountRaw);
    }
    policyViolation(
      `Refusing a Morpho operation: it carries a requirement of type "${String(raw.action?.type)}" that Vex does `
      + "not recognise as an exact-amount ERC-20 approval, so it cannot be shown to a user or checked against the "
      + "approval policy.",
      "Nothing was signed or approved. An unrecognised requirement is refused rather than passed through.",
    );
  });
}
