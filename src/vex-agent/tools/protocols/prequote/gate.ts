/**
 * Stage 7 — execute-time prequote gate.
 *
 * Quote-before-transaction: a swap EXECUTE may broadcast ONLY when a fresh
 * matching `swap` prequote exists and that prequote is not a confirmed scam.
 * The gate is the INVERSE of the recorder: the recorder swallows its errors
 * (a missing prequote is safe), but the gate FAILS CLOSED — any error, a
 * missing session, or an un-gateable token identity → BLOCK. The gate runs
 * BEFORE the approval gate in `executeProtocolTool`; an allow carries the
 * matched verdict to the restricted-mode approval preview (R5).
 *
 * NEVER leaks raw provider/DB/wallet text — only a bounded structural reason
 * class reaches the log and the agent-facing message.
 */

import { isAddress } from "viem";

import type { ChainFamily } from "@tools/khalani/types.js";
import { isNativeTokenInput } from "@tools/kyberswap/helpers.js";
import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import { resolveChainSlug, slugToChainId } from "@tools/kyberswap/chains.js";
import { requireJupiterResolvedToken } from "@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js";
import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import type { WalletPolicy } from "@vex-agent/engine/types.js";
import logger from "@utils/logger.js";

import { VexError, ErrorCodes } from "../../../../errors.js";
import type { ProtocolExecutionContext } from "../types.js";
import * as prequoteRepo from "@vex-agent/db/repos/swap-prequotes.js";
import type {
  PrequoteFamily,
  PrequoteKind,
  SafetyVerdict,
} from "@vex-agent/db/repos/swap-prequotes.js";

import { EXECUTE_GATE_TOOLS } from "./registry.js";
import type { ExecuteGateRegistration } from "./registry.js";
import { resolveUniswapChainId } from "@tools/uniswap/chains.js";
import { resolvePendleChainId } from "@tools/pendle/chains.js";
import { computePrequoteMatchHash } from "./identity/hash.js";
import { assertBridgeParamsBindable, buildBridgeIdentity } from "./identity/bridge.js";
import { buildRelayBridgeIdentity } from "./identity/relay-bridge.js";
import { buildPendleRedeemIdentity } from "./identity/pendle-redeem.js";
import { buildPendleMintIdentity, buildPendleRedeemPyIdentity } from "./identity/pendle-py.js";
import { buildPendleLpAddIdentity, buildPendleLpRemoveIdentity } from "./identity/pendle-lp.js";
import { GateIdentityError } from "./gate-errors.js";
import type { GateBlockReason } from "./gate-errors.js";
import { canonSlippageBps, readParamSlippageBps } from "./slippage.js";

/**
 * Single gate decision. `allow` carries the matched prequote's verdict +
 * id (the verdict rides to the approval preview) and, when the matched quote
 * had a fee-on-transfer EVM leg, the bounded `fotTax` (max FoT tax percent
 * across the legs) so the restricted-mode approval preview can disclose it —
 * FoT is no longer a verdict `fail`, so without this a high-tax token would
 * read as a plain "pass". `block` carries a BOUNDED structural `reason` (for
 * the log) and an agent-facing `message`. No row contents, addresses, or raw
 * error text appear in any field.
 */
export type GateDecision =
  | {
      readonly kind: "allow";
      readonly verdict: SafetyVerdict;
      readonly prequoteId: string;
      readonly fotTax?: number;
      /**
       * Pendle term-lock (Wave 5). When a matched swap prequote's bounded
       * `safetyDetail` carries a `termLock`, the maturity date rides this TYPED
       * channel to the approval preview — it is sourced from the persisted
       * prequote, NEVER from raw args, so the LLM cannot inject or override it.
       */
      readonly termLock?: { readonly maturityIso: string };
    }
  | { readonly kind: "block"; readonly reason: GateBlockReason; readonly message: string };

const SWAP_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Swap blocked: could not verify a fresh quote. Re-run the swap quote and retry.",
  no_session:
    "Swap blocked: could not verify a fresh quote (no session). Re-run the swap quote and retry.",
  unresolved_token:
    "Swap blocked: unresolved execute token — pass the exact token address the quote returned, then retry.",
  no_quote:
    "Swap blocked: no fresh quote for these exact params — the execute must use EXACTLY the same params as the quote, including slippageBps (same value, or omitted on both sides). Call the swap quote first with those params, then retry.",
  safety_fail:
    "Swap blocked: the quoted token was flagged unsafe (honeypot/scam). Aborting.",
  wallet_setup:
    "Swap blocked: the mission is still in setup (no active run), so swaps cannot broadcast yet. Accept and start the mission run, then swap — do NOT re-quote.",
  wallet_scope:
    "Swap blocked: the selected wallet can't be used — it may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet (re-accept the mission contract if a mission is active), then retry — do NOT re-quote.",
  wallet_not_selected:
    "Swap blocked: no wallet is selected (or configured) for this swap's chain in the current session. Select a wallet, then retry — do NOT re-quote.",
  // Unreachable on the swap path (only the bridge execute carries these params),
  // but the reason map must be total over GateBlockReason.
  unbindable_param:
    "Swap blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

const BRIDGE_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Bridge blocked: could not verify a fresh bridge quote. Re-run bridge_quote and retry.",
  no_session:
    "Bridge blocked: could not verify a fresh bridge quote (no session). Re-run bridge_quote and retry.",
  // A bridge execute has no bare-symbol leg (addresses are passed through), so
  // this reason is unreachable on the bridge path; keep a coherent message.
  unresolved_token:
    "Bridge blocked: unresolved bridge token — pass the exact token addresses the quote returned, then retry.",
  no_quote:
    "Bridge blocked: no fresh bridge quote for these exact params. Call bridge_quote first, then retry.",
  safety_fail:
    "Bridge blocked: the quoted route was flagged unsafe. Aborting.",
  wallet_setup:
    "Bridge blocked: the mission is still in setup (no active run), so bridges cannot broadcast yet. Accept and start the mission run, then bridge — do NOT re-quote.",
  wallet_scope:
    "Bridge blocked: a wallet for this bridge can't be used — it may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet (re-accept the mission contract if a mission is active), then retry — do NOT re-quote.",
  wallet_not_selected:
    "Bridge blocked: no wallet is selected (or configured) for one of the bridge's chains in the current session. Select a wallet, then retry — do NOT re-quote.",
  unbindable_param:
    "Bridge blocked: routeId/depositMethod cannot be bound to a quote — omit them (the bridge selects the best route) or this execute can't be verified.",
};

const REDEEM_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Redeem blocked: could not verify a fresh redeem quote. Re-run pendle.pt.quote for this PT and retry.",
  no_session:
    "Redeem blocked: could not verify a fresh redeem quote (no session). Re-run pendle.pt.quote and retry.",
  unresolved_token:
    "Redeem blocked: the PT could not be resolved to an active Pendle market. Re-check the PT address, then retry.",
  no_quote:
    "Redeem blocked: no fresh redeem quote for this exact PT/amount. Call pendle.pt.quote first, then retry.",
  safety_fail:
    "Redeem blocked: the quoted redemption was flagged unsafe. Aborting.",
  wallet_setup:
    "Redeem blocked: the mission is still in setup (no active run), so redeems cannot broadcast yet. Accept and start the mission run, then redeem — do NOT re-quote.",
  wallet_scope:
    "Redeem blocked: the selected wallet can't be used — it may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet, then retry — do NOT re-quote.",
  wallet_not_selected:
    "Redeem blocked: no wallet is selected (or configured) for Ethereum in the current session. Select a wallet, then retry — do NOT re-quote.",
  // Unreachable on the redeem path (redeem carries no unbindable params), but the
  // reason map must be total over GateBlockReason.
  unbindable_param:
    "Redeem blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

const MINT_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Mint blocked: could not verify a fresh mint quote. Re-run pendle.py.quote (direction mint) for this PT and retry.",
  no_session:
    "Mint blocked: could not verify a fresh mint quote (no session). Re-run pendle.py.quote and retry.",
  unresolved_token:
    "Mint blocked: the PT could not be resolved to an active Pendle market. Re-check the PT address, then retry.",
  no_quote:
    "Mint blocked: no fresh mint quote for this exact PT/token/amount. Call pendle.py.quote (direction mint) first, then retry.",
  safety_fail:
    "Mint blocked: the quoted mint was flagged unsafe. Aborting.",
  wallet_setup:
    "Mint blocked: the mission is still in setup (no active run), so mints cannot broadcast yet. Accept and start the mission run, then mint — do NOT re-quote.",
  wallet_scope:
    "Mint blocked: the selected wallet can't be used — it may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet, then retry — do NOT re-quote.",
  wallet_not_selected:
    "Mint blocked: no wallet is selected (or configured) for this mint's chain in the current session. Select a wallet, then retry — do NOT re-quote.",
  unbindable_param:
    "Mint blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

const REDEEM_PY_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Redeem blocked: could not verify a fresh redeem quote. Re-run pendle.py.quote (direction redeem) for this PT and retry.",
  no_session:
    "Redeem blocked: could not verify a fresh redeem quote (no session). Re-run pendle.py.quote and retry.",
  unresolved_token:
    "Redeem blocked: the PT could not be resolved to an active Pendle market. Re-check the PT address, then retry.",
  no_quote:
    "Redeem blocked: no fresh redeem quote for this exact PT/output/amount. Call pendle.py.quote (direction redeem) first, then retry. A MATURED PT (PT only, no YT) uses pendle.pt.redeem instead.",
  safety_fail:
    "Redeem blocked: the quoted redemption was flagged unsafe. Aborting.",
  wallet_setup:
    "Redeem blocked: the mission is still in setup (no active run), so redeems cannot broadcast yet. Accept and start the mission run, then redeem — do NOT re-quote.",
  wallet_scope:
    "Redeem blocked: the selected wallet can't be used — it may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet, then retry — do NOT re-quote.",
  wallet_not_selected:
    "Redeem blocked: no wallet is selected (or configured) for this redeem's chain in the current session. Select a wallet, then retry — do NOT re-quote.",
  unbindable_param:
    "Redeem blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

const LP_ADD_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Add liquidity blocked: could not verify a fresh LP quote. Re-run pendle.lp.quote (direction add) for this market and retry.",
  no_session:
    "Add liquidity blocked: could not verify a fresh LP quote (no session). Re-run pendle.lp.quote and retry.",
  unresolved_token:
    "Add liquidity blocked: the market could not be resolved to an active Pendle market. Re-check the market address, then retry.",
  no_quote:
    "Add liquidity blocked: no fresh add quote for this exact market/token/amount. Call pendle.lp.quote (direction add) first, then retry.",
  safety_fail:
    "Add liquidity blocked: the quoted add was flagged unsafe. Aborting.",
  wallet_setup:
    "Add liquidity blocked: the mission is still in setup (no active run), so LP adds cannot broadcast yet. Accept and start the mission run, then add — do NOT re-quote.",
  wallet_scope:
    "Add liquidity blocked: the selected wallet can't be used — it may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet, then retry — do NOT re-quote.",
  wallet_not_selected:
    "Add liquidity blocked: no wallet is selected (or configured) for this add's chain in the current session. Select a wallet, then retry — do NOT re-quote.",
  unbindable_param:
    "Add liquidity blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

const LP_REMOVE_BLOCK_MESSAGES: Record<GateBlockReason, string> = {
  gate_error:
    "Remove liquidity blocked: could not verify a fresh LP quote. Re-run pendle.lp.quote (direction remove) for this market and retry.",
  no_session:
    "Remove liquidity blocked: could not verify a fresh LP quote (no session). Re-run pendle.lp.quote and retry.",
  unresolved_token:
    "Remove liquidity blocked: the market could not be resolved to an active Pendle market. Re-check the market address, then retry.",
  no_quote:
    "Remove liquidity blocked: no fresh remove quote for this exact market/output/amount. Call pendle.lp.quote (direction remove) first, then retry.",
  safety_fail:
    "Remove liquidity blocked: the quoted removal was flagged unsafe. Aborting.",
  wallet_setup:
    "Remove liquidity blocked: the mission is still in setup (no active run), so LP removes cannot broadcast yet. Accept and start the mission run, then remove — do NOT re-quote.",
  wallet_scope:
    "Remove liquidity blocked: the selected wallet can't be used — it may have changed or been removed, or it isn't in the mission's allowed set. Re-select a valid wallet, then retry — do NOT re-quote.",
  wallet_not_selected:
    "Remove liquidity blocked: no wallet is selected (or configured) for this remove's chain in the current session. Select a wallet, then retry — do NOT re-quote.",
  unbindable_param:
    "Remove liquidity blocked: a parameter cannot be bound to a quote. Remove it and retry.",
};

function block(reason: GateBlockReason, kind: PrequoteKind): GateDecision {
  const messages =
    kind === "bridge"
      ? BRIDGE_BLOCK_MESSAGES
      : kind === "redeem"
        ? REDEEM_BLOCK_MESSAGES
        : kind === "mint"
          ? MINT_BLOCK_MESSAGES
          : kind === "redeem_py"
            ? REDEEM_PY_BLOCK_MESSAGES
            : kind === "lp_add"
              ? LP_ADD_BLOCK_MESSAGES
              : kind === "lp_remove"
                ? LP_REMOVE_BLOCK_MESSAGES
                : SWAP_BLOCK_MESSAGES;
  return { kind: "block", reason, message: messages[reason] };
}

/**
 * Extract the Pendle term-lock maturity from a matched swap prequote's bounded
 * `safetyDetail`, for the approval preview. The detail is `Record<string,
 * unknown>` (round-trips through the DB as JSONB), so every field is treated as
 * untrusted and narrowed; a non-Pendle detail naturally yields undefined.
 */
function termLockFromSafetyDetail(
  safetyDetail: Record<string, unknown>,
): { maturityIso: string } | undefined {
  const tl = safetyDetail.termLock;
  if (typeof tl !== "object" || tl === null) return undefined;
  const iso = (tl as Record<string, unknown>).maturityIso;
  if (typeof iso !== "string" || Number.isNaN(Date.parse(iso))) return undefined;
  return { maturityIso: iso };
}

/**
 * Map a caught gate failure to a bounded block reason. Most throws are a genuine
 * fail-closed `gate_error`. A wallet-resolution VexError, however, means the
 * execute is CORRECTLY blocked (no usable signer / not authorized) yet the agent
 * must be told the ACCURATE cause — never the misleading "re-run the quote",
 * which sends it into a re-quote→re-execute loop. `resolveSelectedAddress`
 * (called at `computeGateMatch`, BEFORE any DB read) throws either
 * `WALLET_NOT_SELECTED` (no wallet for the family) or `WALLET_SCOPE_MISMATCH`
 * (invalid policy OR wallet-not-in-allowed-set); the latter splits on the
 * already-structured `walletPolicy` into the mission-SETUP case (a mission with
 * no active run) vs a contract-drift/scope case. Only the bounded reason class
 * flows onward — never raw wallet/DB/policy text — so the gate's no-leak doctrine
 * (and its fail-closed BLOCK outcome) are preserved; only the message becomes
 * truthful.
 */
function classifyGateBlockReason(err: unknown, policy: WalletPolicy): GateBlockReason {
  if (err instanceof GateIdentityError) return err.gateReason;
  if (err instanceof VexError) {
    // No usable wallet for the family: none selected for the session, or none
    // configured at all (default resolution). Both → "select a wallet".
    if (
      err.code === ErrorCodes.WALLET_NOT_SELECTED ||
      err.code === ErrorCodes.WALLET_NOT_CONFIGURED
    ) {
      return "wallet_not_selected";
    }
    // WALLET_SCOPE_MISMATCH is overloaded: it is thrown for a mission-policy
    // rejection (assertWalletPolicy) AND for a selected-wallet drift/removal
    // (resolveSelectedEntry, which runs FIRST). We can only safely call it the
    // SETUP case when the policy itself is the invalid mission-setup one; every
    // other shape (active-run drift, wallet removed/changed, not-in-allowed-set,
    // or a non-mission session whose selected wallet drifted) maps to the
    // generic `wallet_scope`, whose message does NOT falsely assert a mission.
    if (err.code === ErrorCodes.WALLET_SCOPE_MISMATCH) {
      return policy.kind === "invalid" && policy.reason === "mission_without_active_run"
        ? "wallet_setup"
        : "wallet_scope";
    }
  }
  return "gate_error";
}

/**
 * Extract the max fee-on-transfer tax (percent) across a matched prequote's EVM
 * legs from its bounded `safetyDetail`, for the restricted-mode approval preview.
 *
 * The EVM `safetyDetail` shape (built by `recordSwapPrequote`) is
 * `{ tokenIn: leg, tokenOut: leg }`, where a non-native, checked leg is
 * `{ isHoneypot, isFOT, tax }`. Per owner doctrine FoT is no longer a verdict
 * `fail`, so a high-tax token reaches the ALLOW path as `pass`; the human still
 * needs to SEE the tax, so we surface it through the typed channel.
 *
 * Defensive: the row's `safetyDetail` is `Record<string, unknown>` (it round-
 * trips through the DB as JSONB), so every field is treated as untrusted and
 * narrowed. Bridge/Solana details have no `isFOT`/`tax` leg shape, so they
 * naturally yield `undefined`. Returns the MAX FoT tax across legs that are
 * `isFOT === true && tax > 0`, or `undefined` when there is no such leg.
 */
function maxFotTaxFromSafetyDetail(safetyDetail: Record<string, unknown>): number | undefined {
  let max: number | undefined;
  for (const legValue of Object.values(safetyDetail)) {
    if (typeof legValue !== "object" || legValue === null) continue;
    const leg = legValue as Record<string, unknown>;
    if (leg.isFOT !== true) continue;
    const tax = typeof leg.tax === "number" && Number.isFinite(leg.tax) ? leg.tax : 0;
    if (tax > 0 && (max === undefined || tax > max)) max = tax;
  }
  return max;
}

/**
 * Swap execute trade identity for the match-hash. `chainId` is the numeric chain
 * id (null for Solana). `recipient`/`approveExact` are the Stage-9 money/safety
 * leg: the EVM builder reads them from the execute params (mirroring
 * `executeKyberSwap`'s `str(p,"recipient") || signer.address` and
 * `p.approveExact === true`); the Solana builder pins self/false (Jupiter has no
 * such params). `slippageBps` is bound separately in `computeGateMatch` (read
 * uniformly from the execute params for both families, matching the recorder).
 *
 * Etap 4: `approveExact` was REMOVED from the kyberswap swap/zap manifests
 * (approvals are now always exact — see `ensureKyberAllowance`), so the
 * dispatcher rejects it as an unknown param before this gate ever runs. The
 * field is kept in the identity (constant `false` in practice) to keep old
 * match-hashes stable and to document the doctrine; do NOT rely on it as a live
 * execute knob for kyberswap.
 */
interface GateIdentity {
  readonly family: PrequoteFamily;
  readonly chainId: number | null;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amount: string;
  /** Output recipient (execute param if non-empty, else the selected wallet). */
  readonly recipient: string;
  /** Allowance behavior — true iff the execute set `approveExact`. */
  readonly approveExact: boolean;
}

/**
 * Canonicalize one EVM execute-leg token to the identity the quote recorded:
 *   - native input ("ETH"/"native"/sentinel) → `NATIVE_TOKEN_ADDRESS` (the hash
 *     lowercases it; the quote recorded the same sentinel),
 *   - a hex address → used verbatim (the hash lowercases it),
 *   - a bare symbol → un-gateable at execute → BLOCK (Kyber execute is strict
 *     address-only anyway; the gate never network-resolves an EVM symbol).
 */
function evmLegIdentity(param: string): string {
  if (isNativeTokenInput(param)) return NATIVE_TOKEN_ADDRESS;
  if (isAddress(param)) return param;
  throw new GateIdentityError("unresolved_token");
}

/**
 * Build the EVM trade identity from validated execute params. Throws on a bare
 * symbol. `selectedWallet` is the resolved signer (output-to-self default).
 *
 * Stage 9: `recipient` mirrors `executeKyberSwap` — `str(p,"recipient")` if a
 * non-empty string, else the selected wallet (self). `approveExact` mirrors
 * `p.approveExact === true`; since Etap 4 removed it from the kyberswap manifests
 * the dispatcher rejects it upstream, so `params.approveExact` is undefined here
 * and this resolves to constant `false` for kyberswap (recorder pins `false`
 * too → they still collide). `recipient` still flows into the swap hash, so an
 * execute that redirects the output produces a different digest than the quote
 * (which defaulted self) → the gate blocks.
 */
function buildEvmIdentity(
  params: Record<string, unknown>,
  selectedWallet: string,
  provider: string,
): GateIdentity {
  const chainParam = typeof params.chain === "string" ? params.chain : "";
  const tokenInParam = typeof params.tokenIn === "string" ? params.tokenIn : "";
  const tokenOutParam = typeof params.tokenOut === "string" ? params.tokenOut : "";
  const amount = typeof params.amountIn === "string" ? params.amountIn : "";
  // De-kyber-coupled chain resolution (LOCKED #4): uniswap-on-4663 (and any
  // uniswap chain) resolves via the uniswap registry (local + slug map, network-
  // free); kyber resolves byte-identically via its slug map. Both throw on an
  // unsupported chain → caught upstream → gate_error block (fail-closed).
  let chainId: number;
  if (provider === "uniswap") {
    const resolved = resolveUniswapChainId(chainParam);
    if (resolved === undefined) {
      throw new VexError(ErrorCodes.KYBER_UNSUPPORTED_CHAIN, `Uniswap unsupported chain: ${chainParam}`);
    }
    chainId = resolved;
  } else if (provider === "pendle") {
    // Pendle resolves via its own network-free 11-chain registry so the identity
    // is not coupled to another venue's chain map. Throws on an unsupported chain
    // → caught upstream → gate_error block (fail-closed).
    const resolved = resolvePendleChainId(chainParam);
    if (resolved === undefined) {
      throw new VexError(ErrorCodes.PENDLE_API_ERROR, `Pendle unsupported chain: ${chainParam}`);
    }
    chainId = resolved;
  } else {
    chainId = slugToChainId(resolveChainSlug(chainParam));
  }
  const recipientParam = typeof params.recipient === "string" ? params.recipient.trim() : "";
  return {
    family: "eip155",
    chainId,
    tokenIn: evmLegIdentity(tokenInParam),
    tokenOut: evmLegIdentity(tokenOutParam),
    amount,
    recipient: recipientParam !== "" ? recipientParam : selectedWallet,
    approveExact: params.approveExact === true,
  };
}

/**
 * Build the Solana trade identity. `inputToken`/`outputToken` are symbol-OR-mint
 * at execute; resolve BOTH to their mint with the SAME resolver
 * `executeJupiterSwap` uses (`requireJupiterResolvedToken`, which returns
 * `.address` = mint) so the gate mint matches the recorded mint. A resolve
 * failure throws → caught upstream → gate_error block.
 *
 * Stage 9: Jupiter execute has no recipient/approveExact param — pin `recipient`
 * to the selected wallet (self) and `approveExact` to false, matching the
 * recorder's Solana constants. (If Jupiter ever gained such params, treat them
 * like EVM — read from the execute params here.)
 */
async function buildSolanaIdentity(
  params: Record<string, unknown>,
  selectedWallet: string,
): Promise<GateIdentity> {
  const inputParam = typeof params.inputToken === "string" ? params.inputToken : "";
  const outputParam = typeof params.outputToken === "string" ? params.outputToken : "";
  const [inToken, outToken] = await Promise.all([
    requireJupiterResolvedToken(inputParam),
    requireJupiterResolvedToken(outputParam),
  ]);
  return {
    family: "solana",
    chainId: null,
    tokenIn: inToken.address,
    tokenOut: outToken.address,
    amount: String(params.amount),
    recipient: selectedWallet,
    approveExact: false,
  };
}

/**
 * Compute the match-hash + the family label for a gated EXECUTE call. Swap
 * branches on EVM/Solana identity builders (sync EVM, async Solana resolve);
 * bridge uses the SHARED `buildBridgeIdentity` so its hash collides with the
 * recorder's. Throws a `GateIdentityError` / VexError on an un-gateable identity
 * (caught upstream → fail-closed block).
 */
async function computeGateMatch(
  gated: ExecuteGateRegistration,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<{ matchHash: string; family: PrequoteFamily }> {
  if (gated.kind === "bridge") {
    // Relay has its OWN identity path (LOCKED #4) — no Khalani identity reuse and
    // no khalani-only unbindable params. Khalani fail-closes FIRST on execute-
    // only params the quote can never bind, before building the identity.
    if (gated.provider === "relay") {
      const identity = await buildRelayBridgeIdentity(sessionId, params, context);
      return { matchHash: computePrequoteMatchHash(identity), family: identity.sourceFamily };
    }
    assertBridgeParamsBindable(params);
    const identity = await buildBridgeIdentity(sessionId, params, context);
    return { matchHash: computePrequoteMatchHash(identity), family: identity.sourceFamily };
  }

  if (gated.kind === "redeem") {
    // Pendle PT redeem — its OWN identity path (G2#3). Resolves YT from the PT via
    // the SAME market lookup the recorder uses, so the digests collide. A resolve/
    // wallet-scope throw propagates → caught upstream → fail-closed block.
    const identity = await buildPendleRedeemIdentity(sessionId, params, context);
    return { matchHash: computePrequoteMatchHash(identity), family: gated.family };
  }

  if (gated.kind === "mint") {
    // Pendle PY mint — its OWN identity path (P4). Resolves the market (+ YT) from
    // the PT anchor via the SAME lookup the recorder uses, so the digests collide.
    const identity = await buildPendleMintIdentity(sessionId, params, context);
    return { matchHash: computePrequoteMatchHash(identity), family: gated.family };
  }

  if (gated.kind === "redeem_py") {
    // Pendle PRE-EXPIRY PY redeem — its OWN identity path (P4). Binds the output
    // token (default underlying) so a divergent output blocks.
    const identity = await buildPendleRedeemPyIdentity(sessionId, params, context);
    return { matchHash: computePrequoteMatchHash(identity), family: gated.family };
  }

  if (gated.kind === "lp_add") {
    // Pendle LP single-token add — its OWN identity path (P5). Binds the market
    // (validated against active markets) + input token + slippage, so a divergent
    // market/token/slippage blocks. The distinct kind makes an add unmixable from
    // a remove.
    const identity = await buildPendleLpAddIdentity(sessionId, params, context);
    return { matchHash: computePrequoteMatchHash(identity), family: gated.family };
  }

  if (gated.kind === "lp_remove") {
    // Pendle LP single-token remove — its OWN identity path (P5). Binds the output
    // token (default underlying) so a divergent output blocks.
    const identity = await buildPendleLpRemoveIdentity(sessionId, params, context);
    return { matchHash: computePrequoteMatchHash(identity), family: gated.family };
  }

  // Resolve the SELECTED address (never decrypts). A wallet-scope throw
  // propagates → caught upstream → gate_error block (never fabricate). It is
  // both the signer and the output-to-self recipient default.
  const walletAddress = resolveSelectedAddress(
    context.walletResolution,
    context.walletPolicy,
    gated.family as ChainFamily,
  );
  const identity =
    gated.family === "eip155"
      ? buildEvmIdentity(params, walletAddress, gated.provider)
      : await buildSolanaIdentity(params, walletAddress);
  const matchHash = computePrequoteMatchHash({
    kind: "swap",
    sessionId,
    family: gated.family,
    // Venue binding (LOCKED #4) — the execute provider must equal the quote's.
    provider: gated.provider,
    chainId: identity.chainId,
    walletAddress,
    tokenIn: identity.tokenIn,
    tokenOut: identity.tokenOut,
    amount: identity.amount,
    // Stage 9 money/safety leg — read from the EXECUTE params (recipient/
    // approveExact via the identity builder; slippageBps read uniformly here,
    // matching the recorder which reads the quote params).
    recipient: identity.recipient,
    approveExact: identity.approveExact,
    slippageBps: canonSlippageBps(readParamSlippageBps(params)),
  });
  return { matchHash, family: gated.family };
}

/**
 * Evaluate the execute-time prequote gate for a gated EXECUTE (swap OR bridge).
 * Single decision; fail-closed to BLOCK on ANY failure. Guardrail #1: a fresh
 * `fail` row can never slip through — `existsFreshFailByMatch` (kind-scoped) is
 * checked FIRST (a later `pass`/`unknown` for the same identity cannot override
 * it), and the latest-row `fail` is re-checked as belt-and-suspenders. A bridge
 * prequote is always `unknown`, so the bridge path normally allows via the
 * unknown branch; the fail checks are kept for uniformity.
 */
export async function evaluatePrequoteGate(
  toolId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<GateDecision> {
  const gated = EXECUTE_GATE_TOOLS[toolId];
  if (!gated) {
    // Defensive: callers only invoke for gated tools. Treat an unexpected tool
    // as a block rather than silently allowing an ungated execute. Default the
    // wording to the swap variant (the swap path is the historical caller).
    return block("gate_error", "swap");
  }
  const gateKind: PrequoteKind = gated.kind;

  try {
    const sessionId = context.sessionId;
    if (!sessionId) return block("no_session", gateKind);

    const { matchHash, family } = await computeGateMatch(gated, sessionId, params, context);

    // Guardrail #1 — a fresh confirmed-scam row dominates everything else.
    if (await prequoteRepo.existsFreshFailByMatch(sessionId, matchHash, gateKind)) {
      return block("safety_fail", gateKind);
    }

    const latest = await prequoteRepo.findLatestFreshByMatch(sessionId, matchHash, gateKind);
    if (!latest) return block("no_quote", gateKind);

    // Belt-and-suspenders: even though existsFreshFail already ruled out a fresh
    // fail, never allow a `fail` latest row (guardrail #1).
    if (latest.safetyVerdict === "fail") return block("safety_fail", gateKind);

    if (latest.safetyVerdict === "unknown") {
      // Surface that an un-audited identity is being allowed (preview/full-auto
      // see it downstream). Prefix only — never the full hash or any address.
      logger.warn("protocol.prequote.gate.unknown_allowed", {
        toolId,
        family,
        matchHashPrefix: matchHash.slice(0, 8),
      });
    }
    // Surface a fee-on-transfer tax (if any) so the restricted-mode approval
    // preview can disclose it — FoT is no longer a verdict `fail` (only a
    // confirmed honeypot blocks), so without this a high-tax token reads as a
    // plain "pass". Sourced from the matched row's bounded `safetyDetail`, not
    // raw args. Bridge/Solana details have no FoT leg → undefined (omitted).
    const fotTax = maxFotTaxFromSafetyDetail(latest.safetyDetail);
    // Pendle term-lock (Wave 5) — rides the same TYPED channel as FoT for the
    // approval preview; sourced from the persisted prequote, never raw args.
    const termLock = termLockFromSafetyDetail(latest.safetyDetail);
    let allow: GateDecision = { kind: "allow", verdict: latest.safetyVerdict, prequoteId: latest.prequoteId };
    if (fotTax !== undefined) allow = { ...allow, fotTax };
    if (termLock !== undefined) allow = { ...allow, termLock };
    return allow;
  } catch (err) {
    const reason = classifyGateBlockReason(err, context.walletPolicy);
    // Bounded structural log only — never raw provider/DB/wallet text. `reason`
    // now disambiguates the wallet cases (wallet_setup / wallet_scope /
    // wallet_not_selected) that previously all collapsed to `gate_error`.
    logger.warn("protocol.prequote.gate.error", {
      toolId,
      reason,
      errorClass:
        err instanceof VexError
          ? err.code
          : err instanceof Error
            ? err.constructor.name
            : "unknown",
    });
    return block(reason, gateKind);
  }
}

/**
 * Back-compat alias — the historical swap-only entry point. Delegates to the
 * kind-aware `evaluatePrequoteGate` (the gated registry now carries the kind).
 * Retained so existing swap callers/tests keep working unchanged.
 */
export async function evaluateSwapPrequoteGate(
  toolId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<GateDecision> {
  return evaluatePrequoteGate(toolId, params, context);
}
