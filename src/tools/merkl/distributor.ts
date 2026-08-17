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
 * `claim(address[],address[],uint256[],bytes32[][])`.
 *
 * Every array is parallel and the contract requires equal lengths. `users[i]` is
 * who the leaf belongs to, NOT who pays gas: the distributor lets anyone submit
 * a proof on another wallet's behalf and pays the wallet in the leaf. That is
 * exactly why this lane asserts every `users[i]` is the session wallet before
 * signing - a claim built for someone else would be a gas donation.
 */
const MERKL_DISTRIBUTOR_ABI = [
  {
    name: "claim",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "users", type: "address[]" },
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "proofs", type: "bytes32[][]" },
    ],
    outputs: [],
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

/** Build `claim(...)` for one wallet's leaves. Encoding only; no assertions. */
export function buildMerklClaimCalldata(
  distributor: Address,
  walletAddress: Address,
  leaves: readonly MerklClaimLeaf[],
): MerklClaimCalldata {
  return {
    to: distributor,
    data: encodeFunctionData({
      abi: MERKL_DISTRIBUTOR_ABI,
      functionName: "claim",
      args: [
        leaves.map(() => walletAddress),
        leaves.map((leaf) => getAddress(leaf.tokenAddress)),
        leaves.map((leaf) => BigInt(leaf.cumulativeAmountRaw)),
        leaves.map((leaf) => leaf.proof.map((node) => node as Hex)),
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
  | "token_mismatch"
  | "amount_mismatch"
  | "proof_mismatch";

export interface MerklClaimAssertion {
  readonly ok: boolean;
  readonly failure: MerklClaimAssertionFailure | null;
  readonly detail: string | null;
}

const OK: MerklClaimAssertion = { ok: true, failure: null, detail: null };

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
  if (decoded.functionName !== "claim") {
    return refuse("not_a_claim_call", `the calldata calls ${decoded.functionName}, not claim`);
  }

  const [users, tokens, amounts, proofs] = decoded.args;
  const expected = leaves.length;
  if (users.length !== expected || tokens.length !== expected || amounts.length !== expected || proofs.length !== expected) {
    return refuse(
      "leaf_count_mismatch",
      `the call carries ${users.length}/${tokens.length}/${amounts.length}/${proofs.length} users/tokens/amounts/proofs `
      + `for ${expected} reward${expected === 1 ? "" : "s"}`,
    );
  }

  const wallet = walletAddress.toLowerCase();
  for (const [index, leaf] of leaves.entries()) {
    const user = users[index];
    const token = tokens[index];
    const amount = amounts[index];
    const proof = proofs[index];
    if (user === undefined || token === undefined || amount === undefined || proof === undefined) {
      return refuse("leaf_count_mismatch", `entry ${index} is missing from the decoded call`);
    }
    if (user.toLowerCase() !== wallet) {
      return refuse("user_not_wallet", `entry ${index} claims for ${user.toLowerCase()}, not for ${wallet}`);
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
