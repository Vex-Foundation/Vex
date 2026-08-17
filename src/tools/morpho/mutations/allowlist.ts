/**
 * The CLOSED allowlist of contracts and function selectors a Morpho vault
 * deposit or withdrawal transaction may touch.
 *
 * WHY THIS EXISTS. The Morpho SDK hands back a `to`/`data` pair. For a deposit
 * that `data` is a Bundler3 `multicall` whose payload is an array of further
 * `(target, calldata, value, skipRevert, callbackHash)` tuples - opaque bytes
 * carrying calls to contracts we never named. Rules/90 is explicit that a
 * provider's number is a hint and that opaque calldata is decoded and verified
 * against a bound we computed ourselves before anything is signed. So Vex does
 * not trust the SDK's own spender allowlist as a substitute for its own: it
 * decodes every leg and refuses anything outside this table BY NAME.
 *
 * PROVENANCE OF THE SELECTOR SET, so a future session can re-derive it rather
 * than recall it. Every selector below was OBSERVED in a real build on Base
 * (capture 2026-08-17, `agents_dm/morpho-e3/capture-bundles.ts`, fixtures under
 * `agents_dm/morpho-e3/fixtures/`) and then CONFIRMED against the ABI the SDK
 * itself ships (`@morpho-org/morpho-sdk/abis`, `bundler3Abi` and
 * `generalAdapter1Abi`) rather than transcribed from a signature string. The
 * four observed transaction shapes were:
 *
 *   VaultV2 deposit  -> Bundler3.multicall, two legs, both on GeneralAdapter1:
 *                       erc20TransferFrom(asset, adapter, amount)
 *                       erc4626Deposit(vault, assets, maxSharePrice, receiver)
 *   VaultV1 deposit  -> byte-for-byte the same shape, different vault address.
 *   VaultV2 withdraw -> NOT bundled at all: a DIRECT call on the vault,
 *                       withdraw(assets, receiver, owner).
 *   VaultV1 withdraw -> the same direct call.
 *
 * The withdrawal shape is the finding that most changes the decoder's contract,
 * and it is the SDK's documented intent, not an accident: "Direct vault call -
 * not routed through the bundler. Withdraw has no inflation-attack surface, so
 * skipping the bundler avoids an unnecessary approval." A verifier that insisted
 * `to` is always Bundler3 would refuse every legitimate withdrawal.
 *
 * WHAT IS DELIBERATELY NOT HERE. `permit2TransferFrom`, `approve2`, `wrapNative`
 * and the whole `morpho*` family are real GeneralAdapter1 functions that E3b-2
 * and E3c will need, and they are ABSENT until a capture of the flow that emits
 * them exists. An allowlist widened on the strength of "the adapter has that
 * function" is not an allowlist. Adding an entry means capturing the build that
 * produces it and pinning the fixture beside it.
 */

import { generalAdapter1Abi, bundler3Abi, vaultV2Abi } from "@morpho-org/morpho-sdk/abis";
import { toFunctionSelector, toFunctionSignature, type Abi, type AbiFunction, type Hex } from "viem";

/**
 * The role a decoded address plays in ONE intent. Roles, not a flat address
 * list: the vault and the asset are intent-scoped, so the same decoder refuses a
 * call to some OTHER vault even though that vault is a perfectly real Morpho
 * contract.
 */
export type MorphoBundleTargetRole = "bundler3" | "generalAdapter1" | "permit2" | "vault" | "asset";

/** A selector permitted on a leg, with the ABI that decodes it and its role. */
export interface MorphoAllowedCall {
  readonly selector: Hex;
  readonly functionName: string;
  readonly signature: string;
  /** The only roles this selector may be called on. */
  readonly targetRoles: readonly MorphoBundleTargetRole[];
  readonly abi: Abi;
}

function selectorFor(abi: Abi, functionName: string): { selector: Hex; signature: string } {
  const entry = abi.find(
    (item): item is AbiFunction => item.type === "function" && item.name === functionName,
  );
  if (entry === undefined) {
    // Not a runtime-input failure: the pinned SDK changed shape under us, which
    // must break loudly at module load rather than silently shrink the allowlist.
    throw new Error(
      `@morpho-org/morpho-sdk no longer exposes "${functionName}" in the ABI Vex derives its Morpho `
      + "bundle allowlist from. The allowlist must be re-derived from a fresh capture, not repaired by hand.",
    );
  }
  const signature = toFunctionSignature(entry);
  return { selector: toFunctionSelector(signature), signature };
}

function allowed(
  abi: Abi,
  functionName: string,
  targetRoles: readonly MorphoBundleTargetRole[],
): MorphoAllowedCall {
  const { selector, signature } = selectorFor(abi, functionName);
  return { selector, functionName, signature, targetRoles, abi };
}

/** `Bundler3.multicall`, the only entry point a bundled Morpho action may use. */
export const MORPHO_BUNDLER_ENTRY_CALL: MorphoAllowedCall = allowed(
  bundler3Abi as Abi,
  "multicall",
  ["bundler3"],
);

/**
 * `VaultV2.withdraw(assets, receiver, owner)`, the ERC-4626 entry point a
 * withdrawal calls DIRECTLY. The V1 (MetaMorpho) vault answers the same
 * selector, which the capture confirms byte-for-byte, so one entry covers both
 * generations.
 */
export const MORPHO_VAULT_WITHDRAW_CALL: MorphoAllowedCall = allowed(
  vaultV2Abi as Abi,
  "withdraw",
  ["vault"],
);

/**
 * The inner legs a Bundler3 deposit may contain. Both are GeneralAdapter1 calls:
 * the adapter pulls the asset to itself, then deposits it into the vault under a
 * `maxSharePrice` the adapter enforces on-chain.
 */
export const MORPHO_ALLOWED_BUNDLE_LEGS: readonly MorphoAllowedCall[] = [
  allowed(generalAdapter1Abi as Abi, "erc20TransferFrom", ["generalAdapter1"]),
  allowed(generalAdapter1Abi as Abi, "erc4626Deposit", ["generalAdapter1"]),
];

const LEG_BY_SELECTOR = new Map(
  MORPHO_ALLOWED_BUNDLE_LEGS.map((call) => [call.selector.toLowerCase(), call]),
);

/** The allowed leg for a selector, or `undefined` when it is off the list. */
export function findAllowedLeg(selector: string): MorphoAllowedCall | undefined {
  return LEG_BY_SELECTOR.get(selector.toLowerCase());
}

/** Every selector on the leg allowlist, for a refusal that can name the set. */
export function allowedLegSelectors(): readonly string[] {
  return MORPHO_ALLOWED_BUNDLE_LEGS.map((call) => `${call.selector} ${call.signature}`);
}
