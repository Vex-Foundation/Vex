/**
 * EVM calldata decode for the generic signing tools. FAIL CLOSED.
 *
 * The in-repo precedent is `tools/protocols/pendle/calldata/decode.ts`: it
 * decodes against a CLOSED ABI and refuses everything it does not recognise,
 * because a decoder that shrugs at an unknown layout is a decoder that lets the
 * user approve a sentence nobody derived from the bytes being signed.
 *
 * ## The closed v1 set
 *
 *  - ERC-20 `transfer`, `approve`, `transferFrom`, `increaseAllowance`,
 *    `permit` (EIP-2612);
 *  - Permit2 `approve`, `permit`, `transferFrom`, at the CANONICAL deployment
 *    address for the chain and nowhere else (`./permit2.ts`);
 *  - a plain native transfer, `data = 0x`, and ONLY when `eth_getCode(to)` is
 *    empty.
 *
 * Everything else refuses BEFORE an intent row is created: an unknown selector,
 * a malformed argument layout, a Permit2 selector aimed at a non-canonical
 * address, and `data = 0x` sent to an address that has code. Routers and
 * aggregators are the largest population inside "everything else" and are
 * called out explicitly in the refusal, because each router ABI carries its own
 * embedded receivers, min-outs and helper contracts and is its own safety
 * review, not a missing entry in a table.
 *
 * ## What decode does NOT do
 *
 * It does not decide whether the effect is acceptable, and it does not talk to
 * the chain except through the injected `getCode` seam. Simulation, fee bounds
 * and the forbidden-field gate are the prepare handler's, and every one of them
 * runs on the OUTPUT of this module rather than on raw calldata.
 *
 * ## Why the ERC-20 branch labels its target UNVERIFIED
 *
 * A Permit2 call is trusted because its TARGET is the canonical deployment
 * address for the chain (`./permit2.ts`); a native transfer is trusted because
 * `eth_getCode` proved the target has no code. The ERC-20 branch has neither
 * anchor: it matches the calldata against the ERC-20 layout and nothing more,
 * so the same bytes decode identically whether `to` is a real token, an
 * ordinary account with no code, or a contract whose function selector merely
 * collides with `transfer(address,uint256)`. Verifying token identity would
 * take a chain read this decoder deliberately does not have (an `eth_call`
 * `decimals()` probe would be a NEW seam the confirm path's chain adapter would
 * also have to implement). Rather than assert a token transfer it cannot prove,
 * this module labels every ERC-20-shaped result UNVERIFIED: `criticalArgs`
 * carries `tokenIdentityVerified: "false"`, a warning states the target was not
 * proven to be a token, and the preview headline says so. The raw decoded args
 * are still bound in the digest, and because the label is a pure function of the
 * calldata it reproduces byte-for-byte at prepare and at the confirm re-decode,
 * so the digest matches.
 */

import { decodeFunctionData, getAddress, type Hex } from "viem";

import type { DecodedEvmCall } from "@vex-agent/db/contracts/wallet-transaction-intent.js";

import { canonicalPermit2Address, PERMIT2_ABI, UINT160_MAX } from "./permit2.js";
import { accept, refuse, type TransactionOutcome } from "./refusal.js";

/** `type(uint256).max`: the "unlimited allowance" sentinel every ERC-20 UI warns about. */
const UINT256_MAX = (1n << 256n) - 1n;

/**
 * The ERC-20 v1 subset. `increaseAllowance` and `permit` are NOT in the ERC-20
 * standard itself; they are widely deployed extensions (OpenZeppelin and
 * EIP-2612) whose arguments are unambiguous, which is the bar for inclusion.
 */
const ERC20_ABI = [
  {
    type: "function", name: "transfer", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function", name: "transferFrom", stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function", name: "increaseAllowance", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "addedValue", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function", name: "permit", stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/**
 * The one chain read decode needs. Narrow on purpose: a seam this small is
 * trivially faked in tests, and no test in this arc reaches a network.
 */
export interface EvmCodeReader {
  /** `eth_getCode`. Returns `0x` for an externally owned account. */
  readonly getCode: (address: string) => Promise<string>;
}

export interface DecodeEvmInput {
  readonly to: string;
  readonly data: string;
  /** RAW wei, decimal string. */
  readonly valueWei: string;
  readonly chainId: number;
}

function selectorOf(data: string): string {
  return data.slice(0, 10).toLowerCase();
}

/** Checksummed for display; comparisons elsewhere are lowercase. */
function display(address: string): string {
  return getAddress(address);
}

// ── The four refusals, each stated once ───────────────────────────────

function refuseUnsupportedCall<T>(selector: string, to: string): TransactionOutcome<T> {
  return refuse(
    "unsupported_call",
    `Refusing to prepare: the calldata for ${display(to)} calls selector ${selector}, which is not in `
    + "the v1 decode set (ERC-20 transfer/approve/transferFrom/increaseAllowance/permit, Permit2 "
    + "approve/permit/transferFrom at the canonical address, and a plain native transfer with empty "
    + "data). Router and aggregator calldata is deliberately outside v1: each router ABI hides its own "
    + "receivers, minimum outputs and helper contracts, and admitting one is its own safety review. "
    + "Nothing was prepared and nothing was signed.",
    { selector, to: display(to) },
  );
}

// ── Public entry point ────────────────────────────────────────────────

export async function decodeEvmTransaction(
  input: DecodeEvmInput,
  chain: EvmCodeReader,
): Promise<TransactionOutcome<DecodedEvmCall>> {
  const data = input.data.toLowerCase();
  const to = input.to.toLowerCase();

  if (data === "0x") {
    return decodeNativeTransfer(input, to, chain);
  }
  if (data.length < 10) {
    return refuse(
      "unsupported_call",
      "Refusing to prepare: the calldata is shorter than a 4-byte function selector, so there is "
      + "nothing to decode and nothing honest to show the user.",
    );
  }

  // A non-zero `value` on a token or Permit2 call means native coin rides along
  // with the call. Every function in the v1 set is non-payable, so the call
  // would revert and burn the gas, and if the target were payable after all the
  // user would be authorizing a second, undecoded transfer on the same line.
  if (input.valueWei !== "0") {
    return refuse(
      "unsupported_call",
      `Refusing to prepare: the proposal sends ${input.valueWei} wei of native coin alongside a `
      + "contract call, but every function in the v1 decode set is non-payable. Send native coin as a "
      + "plain transfer with empty calldata, or use a tool that understands the payable contract.",
      { valueWei: input.valueWei },
    );
  }

  const permit2 = canonicalPermit2Address(input.chainId);
  const selector = selectorOf(data);

  if (permit2 !== undefined && to === permit2) {
    return decodeAgainstPermit2(data as Hex, to, selector);
  }

  // A Permit2 selector aimed anywhere else. Decoded here ONLY to recognise the
  // shape so the refusal can name it; the result is discarded.
  if (looksLikePermit2(data as Hex)) {
    return refuse(
      "non_canonical_permit2",
      `Refusing to prepare: this is Permit2 calldata addressed to ${display(input.to)}, which is not `
      + `the canonical Permit2 deployment on chain ${input.chainId}`
      + (permit2 === undefined
        ? " (this build has no canonical Permit2 address recorded for that chain at all)."
        : ` (${display(permit2)}).`)
      + " An arbitrary contract implementing the same selectors would be shown to the user as Permit2, "
      + "so the address is checked before the name is used.",
      { to: display(input.to), chainId: String(input.chainId) },
    );
  }

  return decodeAgainstErc20(data as Hex, to, selector);
}

// ── Native transfer ───────────────────────────────────────────────────

async function decodeNativeTransfer(
  input: DecodeEvmInput,
  to: string,
  chain: EvmCodeReader,
): Promise<TransactionOutcome<DecodedEvmCall>> {
  // `data = 0x` is a plain transfer ONLY to an account with no code. Sending it
  // to a contract invokes that contract's `receive`/`fallback`, which can do
  // anything at all and which no part of this module decoded.
  const code = (await chain.getCode(input.to)).toLowerCase();
  if (code !== "0x" && code !== "") {
    return refuse(
      "code_at_native_transfer_target",
      `Refusing to prepare: ${display(input.to)} has contract code, so empty calldata is not a plain `
      + "transfer - it invokes the contract's receive or fallback function, whose effects nothing here "
      + "decoded. Prepare the actual contract call instead.",
      { to: display(input.to) },
    );
  }
  if (input.valueWei === "0") {
    return refuse(
      "unsupported_call",
      "Refusing to prepare: empty calldata and a zero value would be a transaction with no effect "
      + "other than spending gas.",
    );
  }
  return accept<DecodedEvmCall>({
    family: "eip155",
    role: "native_transfer",
    standard: "native",
    functionName: "nativeTransfer",
    contract: null,
    criticalArgs: {
      recipient: display(input.to),
      valueWei: input.valueWei,
    },
    unlimitedApproval: false,
    warnings: [],
  });
}

// ── ERC-20 ────────────────────────────────────────────────────────────

/**
 * The one warning every ERC-20-shaped accept carries. The target was matched on
 * calldata layout ALONE, so it is named here as an unproven token and the user
 * is told the amount and recipient below are claims derived from the shape, not
 * a confirmed token transfer. Built from `functionName` and `contract` only, so
 * it is a pure function of the calldata and reproduces identically at confirm.
 */
function erc20UnverifiedWarning(functionName: string, contract: string): string {
  return (
    `TOKEN IDENTITY UNVERIFIED: this calldata matches the ERC-20 ${functionName} layout, but nothing `
    + `here verified that ${contract} is a real ERC-20 token contract - it may be an account with no `
    + "code, or a contract whose function selector merely collides with a token's. Treat the token, "
    + "amount and recipient shown as claims derived from the calldata shape alone, not as a confirmed "
    + "token transfer."
  );
}

/**
 * The marker every ERC-20-shaped accept adds to `criticalArgs`, so a downstream
 * reader (the preview headline, an approval card) can tell an unproven target
 * apart from a Permit2 or native call whose target IS anchored. A string, like
 * every other bound arg, and part of the digest preimage.
 */
const ERC20_UNVERIFIED_FLAG = { tokenIdentityVerified: "false" } as const;

function decodeAgainstErc20(
  data: Hex,
  to: string,
  selector: string,
): TransactionOutcome<DecodedEvmCall> {
  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    const result = decodeFunctionData({ abi: ERC20_ABI, data });
    decoded = { functionName: result.functionName, args: (result.args ?? []) as readonly unknown[] };
  } catch {
    // viem throws for BOTH an unrecognised selector and a malformed argument
    // layout. Both are the same verdict here: we cannot say what the bytes do.
    return refuseUnsupportedCall(selector, to);
  }

  const contract = display(to);
  // Named once per branch: the target was proven to be nothing beyond an
  // address whose calldata parses against the ERC-20 layout.
  const unverified = erc20UnverifiedWarning(decoded.functionName, contract);
  switch (decoded.functionName) {
    case "transfer": {
      const [recipient, value] = decoded.args as [string, bigint];
      return accept<DecodedEvmCall>({
        family: "eip155", role: "contract_call", standard: "erc20",
        functionName: "transfer", contract,
        criticalArgs: {
          ...ERC20_UNVERIFIED_FLAG,
          token: contract, recipient: display(recipient), amountRaw: value.toString(),
        },
        unlimitedApproval: false, warnings: [unverified],
      });
    }
    case "approve": {
      const [spender, value] = decoded.args as [string, bigint];
      const unlimited = value === UINT256_MAX;
      return accept<DecodedEvmCall>({
        family: "eip155", role: "approve", standard: "erc20",
        functionName: "approve", contract,
        criticalArgs: {
          ...ERC20_UNVERIFIED_FLAG,
          token: contract, spender: display(spender), amountRaw: value.toString(),
        },
        unlimitedApproval: unlimited,
        warnings: unlimited ? [unverified, UNLIMITED_APPROVAL_WARNING] : [unverified],
      });
    }
    case "transferFrom": {
      const [from, recipient, value] = decoded.args as [string, string, bigint];
      return accept<DecodedEvmCall>({
        family: "eip155", role: "contract_call", standard: "erc20",
        functionName: "transferFrom", contract,
        criticalArgs: {
          ...ERC20_UNVERIFIED_FLAG,
          token: contract, from: display(from), recipient: display(recipient),
          amountRaw: value.toString(),
        },
        unlimitedApproval: false, warnings: [unverified],
      });
    }
    case "increaseAllowance": {
      const [spender, added] = decoded.args as [string, bigint];
      const unlimited = added === UINT256_MAX;
      return accept<DecodedEvmCall>({
        family: "eip155", role: "approve", standard: "erc20",
        functionName: "increaseAllowance", contract,
        criticalArgs: {
          ...ERC20_UNVERIFIED_FLAG,
          token: contract, spender: display(spender), addedAmountRaw: added.toString(),
        },
        unlimitedApproval: unlimited,
        warnings: [
          unverified,
          "increaseAllowance ADDS to the existing allowance; the resulting total is the current "
          + "on-chain allowance plus this amount.",
          ...(unlimited ? [UNLIMITED_APPROVAL_WARNING] : []),
        ],
      });
    }
    case "permit": {
      const [owner, spender, value, deadline] = decoded.args as [string, string, bigint, bigint];
      const unlimited = value === UINT256_MAX;
      return accept<DecodedEvmCall>({
        family: "eip155", role: "approve", standard: "erc20",
        functionName: "permit", contract,
        criticalArgs: {
          ...ERC20_UNVERIFIED_FLAG,
          token: contract, owner: display(owner), spender: display(spender),
          amountRaw: value.toString(), deadlineUnixSeconds: deadline.toString(),
        },
        unlimitedApproval: unlimited,
        warnings: [
          unverified,
          "An EIP-2612 permit grants the allowance from a signature the calldata already carries; "
          + "the owner it names is the account whose tokens become spendable.",
          ...(unlimited ? [UNLIMITED_APPROVAL_WARNING] : []),
        ],
      });
    }
    default:
      return refuseUnsupportedCall(selector, to);
  }
}

const UNLIMITED_APPROVAL_WARNING =
  "UNLIMITED APPROVAL: the amount is the maximum integer the type can hold, so the spender may move "
  + "the entire balance of this token, now and in future, until the allowance is revoked.";

// ── Permit2 ───────────────────────────────────────────────────────────

function looksLikePermit2(data: Hex): boolean {
  try {
    decodeFunctionData({ abi: PERMIT2_ABI, data });
    return true;
  } catch {
    return false;
  }
}

function decodeAgainstPermit2(
  data: Hex,
  to: string,
  selector: string,
): TransactionOutcome<DecodedEvmCall> {
  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    const result = decodeFunctionData({ abi: PERMIT2_ABI, data });
    decoded = { functionName: result.functionName, args: (result.args ?? []) as readonly unknown[] };
  } catch {
    return refuseUnsupportedCall(selector, to);
  }

  const contract = display(to);
  switch (decoded.functionName) {
    case "approve": {
      const [token, spender, amount, expiration] = decoded.args as [string, string, bigint, number];
      const unlimited = amount === UINT160_MAX;
      return accept<DecodedEvmCall>({
        family: "eip155", role: "approve", standard: "permit2",
        functionName: "approve", contract,
        criticalArgs: {
          token: display(token), spender: display(spender), amountRaw: amount.toString(),
          expirationUnixSeconds: String(expiration),
        },
        unlimitedApproval: unlimited,
        warnings: [PERMIT2_WARNING, ...(unlimited ? [UNLIMITED_APPROVAL_WARNING] : [])],
      });
    }
    case "permit": {
      const [owner, permitSingle] = decoded.args as [
        string,
        {
          details: { token: string; amount: bigint; expiration: number; nonce: number };
          spender: string;
          sigDeadline: bigint;
        },
      ];
      const unlimited = permitSingle.details.amount === UINT160_MAX;
      return accept<DecodedEvmCall>({
        family: "eip155", role: "approve", standard: "permit2",
        functionName: "permit", contract,
        criticalArgs: {
          owner: display(owner),
          token: display(permitSingle.details.token),
          spender: display(permitSingle.spender),
          amountRaw: permitSingle.details.amount.toString(),
          expirationUnixSeconds: String(permitSingle.details.expiration),
          sigDeadlineUnixSeconds: permitSingle.sigDeadline.toString(),
        },
        unlimitedApproval: unlimited,
        warnings: [PERMIT2_WARNING, ...(unlimited ? [UNLIMITED_APPROVAL_WARNING] : [])],
      });
    }
    case "transferFrom": {
      const [from, recipient, amount, token] = decoded.args as [string, string, bigint, string];
      return accept<DecodedEvmCall>({
        family: "eip155", role: "contract_call", standard: "permit2",
        functionName: "transferFrom", contract,
        criticalArgs: {
          token: display(token), from: display(from), recipient: display(recipient),
          amountRaw: amount.toString(),
        },
        unlimitedApproval: false,
        warnings: [PERMIT2_WARNING],
      });
    }
    default:
      return refuseUnsupportedCall(selector, to);
  }
}

const PERMIT2_WARNING =
  "This call goes to Permit2, the shared approval contract. The spender it names can move the named "
  + "token from the owner up to the amount and expiry shown, without a further transaction.";
