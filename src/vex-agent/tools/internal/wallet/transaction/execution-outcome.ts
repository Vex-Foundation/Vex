/**
 * What a family handler produced - the vocabulary the T3 durable rows are
 * written from.
 *
 * Its own module because BOTH the gate order (`./confirm-shared.js`) and the
 * atomic terminalization (`./terminal-settlement.js`) are written against it,
 * and a type shared by two owners must not live inside one of them. Re-exported
 * from `./confirm-shared.js` so every existing import site is unchanged.
 */

/** What the family handler produced. The vocabulary of the T3 rows. */
export type TransactionExecution =
  | { readonly kind: "confirmed"; readonly txHash: string; readonly data: Record<string, unknown> }
  | {
      readonly kind: "chain_failed";
      readonly txHash: string;
      readonly chain: string;
      readonly errorKind: string;
      readonly errorHash: string;
    }
  | {
      readonly kind: "confirmation_unknown";
      readonly txHash: string;
      readonly chain: string;
      readonly errorKind: string;
      readonly errorHash: string;
    }
  | {
      readonly kind: "pre_broadcast_failed";
      readonly errorKind: string;
      readonly errorHash: string;
      /** The sentence the caller reads. Never raw provider text. */
      readonly message: string;
      /**
       * TRUE when the failure was the STAGED-EVIDENCE write, which happens
       * after the claim committed and before anything reached the network. It
       * is its own durable status (`audit_failed`) so investigation tooling can
       * find "our audit write broke" without trawling every failure.
       */
      readonly auditFailed?: true;
    };
