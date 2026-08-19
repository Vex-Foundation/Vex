/**
 * The Merkl Distributor: the one contract a reward claim may ever be sent to,
 * and the decode-and-assert that proves the calldata about to be signed says
 * what this lane believes it says.
 *
 * ── WHY THE ADDRESS IS PINNED IN THE REPOSITORY, NOT FETCHED ────────────────
 *
 * The claim target is the single most dangerous field in this lane. A target
 * taken from an API response - even Merkl's own - lets whoever can answer that
 * request choose which contract Vex signs a transaction to. Merkl's `/v4/chains`
 * route does not publish it anyway (probed 2026-08-17: the response carries the
 * chain's name, icon, explorers and campaign count, and no contract address at
 * all), so there is no live source to prefer even if one were wanted.
 *
 * It is therefore a constant, and its provenance is a measurement rather than a
 * citation. LIVE PROBE 2026-08-17, through Vex's own pinned RPC table, one
 * `eth_getCode` and one `getMerkleRoot()` per chain:
 *
 *   ethereum   1      code present   root 0x786efd68...fa124f
 *   optimism   10     code present   root 0x52d46d8e...9420f1
 *   unichain   130    code present   root 0xd12b1d80...0b2ce4
 *   polygon    137    code present   root 0x5b0bf79e...015a1b
 *   monad      143    code present   root 0x857b2365...b58760
 *   hyperevm   999    code present   root 0x4d2b33ff...42cd0a
 *   robinhood  4663   code present   root 0xe802af81...4c21dd
 *   base       8453   code present   root 0x9ba8e44a...dc68f8
 *   arbitrum   42161  code present   root 0xede18db0...92bfee
 *
 * All nine of Vex's Morpho chains carry the SAME address, each answering with
 * its own live root - which is the shape a per-chain deployment of one canonical
 * contract has, and is why one constant is honest here rather than lazy. Two
 * further facts from the same probe pin the semantics the claim depends on: on
 * Base the row's `root` equalled `getMerkleRoot()` exactly (so a row's `amount`
 * is the CURRENTLY CLAIMABLE leaf), and `claimed(wallet, token)` equalled the
 * row's `claimed` exactly (so `amount - claimed` is what a claim delivers).
 *
 * A chain absent from this table is REFUSED BY NAME. Vex does not fall back to
 * the canonical address for a chain it has not looked at: "probably the same
 * everywhere" is exactly the reasoning that signs a transaction to nothing.
 *
 * ── NO APPROVAL IS INVOLVED, AND THAT IS VERIFIED, NOT ASSUMED ──────────────
 *
 * `claim` pays out of the distributor's OWN token balance against a Merkle
 * proof; the caller spends nothing but gas and grants no allowance. This lane
 * therefore has exactly one leg and never builds an ERC20 approval. The probe
 * above is the evidence: `claimed(user, token)` is the contract's own ledger of
 * what it has already paid that user, which is only coherent for a payer.
 */

import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex } from "viem";

/**
 * The canonical Merkl Distributor, deployed at the same address on every chain
 * Vex reaches Morpho on. See the header for the per-chain measurement.
 */
const MERKL_DISTRIBUTOR_ADDRESS = "0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae" as const;

/** The chain ids the address above was actually verified on, and nothing more. */
const VERIFIED_DISTRIBUTOR_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, 10, 130, 137, 143, 999, 4663, 8453, 42161,
]);

/**
 * `claimWithRecipient(address[],address[],uint256[],bytes32[][],address[],bytes[])`.
 *
 * WHY NOT THE PLAIN `claim`. `users[i]` names who the leaf belongs to, not who
 * pays gas, and it does NOT name who gets paid. The distributor resolves the
 * destination from its OWN state. Verified 2026-08-17 against the deployed
 * implementation behind the Base proxy (impl
 * `0x64455a45d85d872bfd7f833e367686108d13d6e6`, matching
 * `AngleProtocol/merkl-contracts` `Distributor.sol`), whose `_claim` reads:
 *
 *   if (msg.sender != user || recipient == address(0)) {
 *       address userSetRecipient = claimRecipient[user][token];
 *       if (userSetRecipient == address(0)) userSetRecipient = claimRecipient[user][address(0)];
 *       if (userSetRecipient == address(0)) recipient = user;
 *       else recipient = userSetRecipient;
 *   }
 *
 * `claim(...)` allocates an all-zero `recipients` array, so it ALWAYS takes that
 * branch. A `setClaimRecipient` executed at any earlier point permanently
 * redirects every later plain claim, per token or, with `address(0)` as the
 * token, for all of them. The old assertion could not see this: it proved
 * `users[i]` was the session wallet, which is not the same claim as "the tokens
 * arrive at the session wallet".
 *
 * `claimWithRecipient` closes it IN THE SIGNED BYTES rather than in a read that
 * can go stale between check and inclusion. The caller's `recipients[i]` is
 * honoured whenever `msg.sender == user` and the value is non-zero, and Vex
 * signs from the session wallet with `users[i]` set to it, so the override
 * always applies and overrides any stored recipient. Two conditions carry that
 * guarantee and are both asserted below:
 *
 *   - `recipients[i]` must be the session wallet and must never be the zero
 *     address, because zero silently falls back to the stored-state lookup.
 *   - `datas[i]` must be empty. A non-empty value makes the distributor call
 *     `IClaimRecipient(recipient).onClaim` and demand a magic return value.
 *
 * Every array is parallel and the contract requires equal lengths.
 */
const MERKL_DISTRIBUTOR_ABI = [
  {
    name: "claimWithRecipient",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "users", type: "address[]" },
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "proofs", type: "bytes32[][]" },
      { name: "recipients", type: "address[]" },
      { name: "datas", type: "bytes[]" },
    ],
    outputs: [],
  },
] as const;

/**
 * `claimRecipient(user, token)`, the stored redirect the override defeats.
 *
 * Read only to REPORT that a wallet was configured to pay somebody else, which
 * is worth surfacing to the owner. It is deliberately not the defence: a read
 * can be invalidated by a `setClaimRecipient` landing between the read and the
 * claim's inclusion, and `claimWithRecipient` cannot.
 */
export const MERKL_CLAIM_RECIPIENT_ABI = [
  {
    name: "claimRecipient",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/** One leaf of a claim: one token, its cumulative amount, and its proof. */
export interface MerklClaimLeaf {
  readonly tokenAddress: string;
  readonly tokenSymbol: string | null;
  readonly tokenDecimals: number;
  /** The CUMULATIVE leaf amount the proof authorizes. Not the delivered amount. */
  readonly cumulativeAmountRaw: string;
  /** `cumulativeAmountRaw - claimed`: what this leaf actually delivers now. */
  readonly deliveredAmountRaw: string;
  readonly root: string;
  readonly proof: readonly string[];
}

/** The transaction a claim would send. */
export interface MerklClaimCalldata {
  readonly to: Address;
  readonly data: Hex;
  /**
   * Always zero for a claim. Typed as a plain `bigint` rather than the literal
   * `0n` ON PURPOSE: pinning the literal would make the assertion's value check
   * unreachable dead code, and the assertion's job is to catch a call some
   * future path built differently, not to restate what this file's own builder
   * already guarantees.
   */
  readonly value: bigint;
}

/**
 * The distributor for a chain Vex has verified, or `undefined`. The caller
 * refuses by name rather than substituting the canonical address.
 */
export function merklDistributorAddress(chainId: number): Address | undefined {
  return VERIFIED_DISTRIBUTOR_CHAIN_IDS.has(chainId) ? getAddress(MERKL_DISTRIBUTOR_ADDRESS) : undefined;
}

/** True when the address is the pinned distributor, compared case-insensitively. */
export function isMerklDistributor(address: string): boolean {
  return address.toLowerCase() === MERKL_DISTRIBUTOR_ADDRESS.toLowerCase();
}

/**
 * Build `claimWithRecipient(...)` for one wallet's leaves, with every recipient
 * hard-bound to that wallet. Encoding only; no assertions.
 */
export function buildMerklClaimCalldata(
  distributor: Address,
  walletAddress: Address,
  leaves: readonly MerklClaimLeaf[],
): MerklClaimCalldata {
  return {
    to: distributor,
    data: encodeFunctionData({
      abi: MERKL_DISTRIBUTOR_ABI,
      functionName: "claimWithRecipient",
      args: [
        leaves.map(() => walletAddress),
        leaves.map((leaf) => getAddress(leaf.tokenAddress)),
        leaves.map((leaf) => BigInt(leaf.cumulativeAmountRaw)),
        leaves.map((leaf) => leaf.proof.map((node) => node as Hex)),
        leaves.map(() => walletAddress),
        leaves.map(() => "0x" as Hex),
      ],
    }),
    value: 0n,
  };
}

/** What the assertion refused, named so the agent-facing wording can be exact. */
export type MerklClaimAssertionFailure =
  | "target_not_distributor"
  | "value_not_zero"
  | "not_a_claim_call"
  | "leaf_count_mismatch"
  | "user_not_wallet"
  | "recipient_not_wallet"
  | "recipient_hook_data_present"
  | "token_mismatch"
  | "amount_mismatch"
  | "proof_mismatch";

export interface MerklClaimAssertion {
  readonly ok: boolean;
  readonly failure: MerklClaimAssertionFailure | null;
  readonly detail: string | null;
}

const OK: MerklClaimAssertion = { ok: true, failure: null, detail: null };

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

function refuse(failure: MerklClaimAssertionFailure, detail: string): MerklClaimAssertion {
  return { ok: false, failure, detail };
}

/**
 * DECODE THE CALLDATA BACK AND PROVE IT SAYS WHAT WE MEANT, before a signature
 * exists.
 *
 * This is not a test of the encoder. It is the money-path discipline rules/90
 * states for opaque calldata, applied to calldata this lane happens to have
 * built itself: the bytes are what gets signed, so the bytes are what gets
 * checked, and the check reads them back through the ABI rather than trusting
 * the values that went in. It closes the gap where a future refactor builds the
 * arrays from a different source than the one the assertions read.
 *
 * Four things must hold, and each has a real failure behind it:
 *
 *   - the TARGET is the pinned distributor and the value is zero. A claim that
 *     sends ether sends it to a contract with no reason to return it.
 *   - every `users[i]` is THIS wallet. The distributor happily accepts a proof
 *     naming someone else and pays THEM while we pay the gas.
 *   - every `recipients[i]` is THIS wallet, and no `datas[i]` is present. This
 *     is the leg that makes the destination provable rather than assumed: see
 *     the ABI's own note on `claimRecipient`. A zero recipient is refused here
 *     for the same reason a wrong one is, because zero is not "unset, so pay
 *     the user" - it is "fall back to whatever the contract was told earlier".
 *   - the tokens, amounts and proofs match the leaves the rewards read produced,
 *     element for element and in order. A reordered `amounts` array against an
 *     unreordered `tokens` array is a valid transaction that claims the wrong
 *     number for the wrong asset.
 *   - the arrays are all the same length as the leaves. The contract requires
 *     it, and finding out on-chain costs gas.
 */
export function assertMerklClaimCalldata(
  call: MerklClaimCalldata,
  walletAddress: Address,
  leaves: readonly MerklClaimLeaf[],
): MerklClaimAssertion {
  if (!isMerklDistributor(call.to)) {
    return refuse("target_not_distributor", `the call targets ${call.to.toLowerCase()}, not Merkl's distributor`);
  }
  if (call.value !== 0n) {
    return refuse("value_not_zero", `the call carries ${call.value.toString()} wei of value; a claim spends none`);
  }

  let decoded;
  try {
    decoded = decodeFunctionData({ abi: MERKL_DISTRIBUTOR_ABI, data: call.data });
  } catch {
    return refuse("not_a_claim_call", "the calldata does not decode as Merkl's claim function");
  }
  if (decoded.functionName !== "claimWithRecipient") {
    return refuse("not_a_claim_call", `the calldata calls ${decoded.functionName}, not claimWithRecipient`);
  }

  const [users, tokens, amounts, proofs, recipients, datas] = decoded.args;
  const expected = leaves.length;
  if (
    users.length !== expected || tokens.length !== expected || amounts.length !== expected
    || proofs.length !== expected || recipients.length !== expected || datas.length !== expected
  ) {
    return refuse(
      "leaf_count_mismatch",
      `the call carries ${users.length}/${tokens.length}/${amounts.length}/${proofs.length}/${recipients.length}/`
      + `${datas.length} users/tokens/amounts/proofs/recipients/datas `
      + `for ${expected} reward${expected === 1 ? "" : "s"}`,
    );
  }

  const wallet = walletAddress.toLowerCase();
  for (const [index, leaf] of leaves.entries()) {
    const user = users[index];
    const token = tokens[index];
    const amount = amounts[index];
    const proof = proofs[index];
    const recipient = recipients[index];
    const data = datas[index];
    if (
      user === undefined || token === undefined || amount === undefined || proof === undefined
      || recipient === undefined || data === undefined
    ) {
      return refuse("leaf_count_mismatch", `entry ${index} is missing from the decoded call`);
    }
    if (user.toLowerCase() !== wallet) {
      return refuse("user_not_wallet", `entry ${index} claims for ${user.toLowerCase()}, not for ${wallet}`);
    }
    if (recipient.toLowerCase() !== wallet) {
      return refuse(
        "recipient_not_wallet",
        `entry ${index} would pay ${recipient.toLowerCase()}, not ${wallet}`
        + (recipient.toLowerCase() === ZERO_ADDRESS
          ? ", and a zero recipient hands the destination back to whatever the distributor was told earlier"
          : ""),
      );
    }
    if (data !== "0x") {
      return refuse(
        "recipient_hook_data_present",
        `entry ${index} carries ${(data.length - 2) / 2} bytes of recipient-hook data; Vex claims to a plain wallet `
        + "and sends none",
      );
    }
    if (token.toLowerCase() !== leaf.tokenAddress.toLowerCase()) {
      return refuse("token_mismatch", `entry ${index} names token ${token.toLowerCase()}, expected ${leaf.tokenAddress}`);
    }
    if (amount !== BigInt(leaf.cumulativeAmountRaw)) {
      return refuse("amount_mismatch", `entry ${index} claims ${amount.toString()}, expected ${leaf.cumulativeAmountRaw}`);
    }
    if (proof.length !== leaf.proof.length || proof.some((node, i) => node.toLowerCase() !== leaf.proof[i])) {
      return refuse("proof_mismatch", `entry ${index} carries a proof that is not the one Merkl published`);
    }
  }

  return OK;
}
