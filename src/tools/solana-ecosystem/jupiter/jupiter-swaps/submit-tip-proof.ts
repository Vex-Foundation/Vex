/**
 * The unforgeable evidence that a signed transaction actually carries a tip
 * qualifying it for `POST /tx/v1/submit` (design
 * `solana-landing-lanes-design.md` D1).
 *
 * Jupiter's submit endpoint REQUIRES the transaction to contain a SOL transfer
 * of at least `JUPITER_SUBMIT_MIN_TIP_LAMPORTS` to one of the 16 published tip
 * receivers; a tipless transaction is rejected (documented `400` — "missing or
 * insufficient tip") or silently never lands, which is exactly what happened
 * to real funds during the 2026-07-24 funded gate.
 *
 * Lane selection is therefore by PROVEN TIP, not by protocol name, and it is
 * enforced by the COMPILER rather than by convention: `submitPreparedTx`
 * requires a `JupiterSubmitTipProof` argument, and this class cannot be
 * constructed from outside this module — its constructor is `private` and its
 * fields are `private`, so TypeScript treats it nominally and an object
 * literal of the same shape is NOT assignable. There is no boolean flag, no
 * optional parameter defaulting to "trusted", and no cast anywhere in the
 * chain. A caller with only a tipless provider blob (Lend, Borrow,
 * Prediction) has nothing to pass and physically cannot reach `/submit`.
 *
 * `certify` is the ONLY producer, and it re-checks both invariants itself, so
 * it cannot mint dishonest evidence even if called from somewhere new. In
 * practice its one caller is `build-response-guard.ts`, which decodes the tip
 * instruction out of an untrusted `/build` response and has already proven the
 * recipient/amount against the approved policy — the only place in the repo
 * that can honestly speak to what a signed transaction contains.
 */

import { JUPITER_SUBMIT_MIN_TIP_LAMPORTS, JUPITER_TIP_RECEIVER_ADDRESSES } from "./constants.js";

/** Non-secret, log-safe description of a certified tip. Contains no transaction bytes. */
export interface CertifiedJupiterTip {
  readonly tipLamports: number;
  readonly tipReceiver: string;
}

export class JupiterSubmitTipProof {
  private constructor(
    private readonly certifiedTipLamports: number,
    private readonly certifiedTipReceiver: string,
  ) {}

  /**
   * Mint proof for a tip that has been decoded out of the transaction the
   * caller is about to sign. Returns `null` — never a partial or optimistic
   * proof — when the tip does not qualify, which routes the caller to the RPC
   * lane instead of an endpoint that would drop the transaction.
   */
  static certify(tip: { readonly recipient: string; readonly lamports: bigint }): JupiterSubmitTipProof | null {
    if (!JUPITER_TIP_RECEIVER_ADDRESSES.includes(tip.recipient)) return null;
    if (tip.lamports < BigInt(JUPITER_SUBMIT_MIN_TIP_LAMPORTS)) return null;
    // Safe to narrow: bounded above by the owner tip cap the caller enforces,
    // far below Number.MAX_SAFE_INTEGER.
    return new JupiterSubmitTipProof(Number(tip.lamports), tip.recipient);
  }

  /** For disclosure/logging only — never gates anything. */
  describe(): CertifiedJupiterTip {
    return { tipLamports: this.certifiedTipLamports, tipReceiver: this.certifiedTipReceiver };
  }
}
