/**
 * `parseSolanaTransactionResult` — the combined account-key list
 * (`solana-settlement-decoders.ts`'s `resolveAccountKeys`).
 *
 * THE BUG THIS PINS. In the jsonParsed encoding the RPC already returns the
 * COMBINED list in `message.accountKeys`, with each entry tagged
 * `source: "transaction" | "lookupTable"`. Appending `meta.loadedAddresses`
 * on top of that — which the decoder used to do unconditionally — listed every
 * address-lookup-table key at TWO indices and made `accountKeys.length` exceed
 * `preBalances.length`, so the array no longer meant "the list the balances
 * are indexed against". Index→key reads happened to survive (duplicates land
 * after every real index), but any key→index or entry-identity comparison
 * could bind to the duplicate.
 *
 * Chain evidence: the captured prediction create transaction carries 14
 * `accountKeys`, two of them `lookupTable`-sourced, against exactly 14
 * `preBalances` — the ALT keys are counted once, by the RPC, already.
 *
 * The legacy plain-`string[]` encoding really does carry static keys only, so
 * there the documented static → loaded-writable → loaded-readonly order must
 * still be reconstructed. Both branches are pinned below.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseSolanaTransactionResult } from "@vex-agent/sync/solana-settlement-decoders.js";

/**
 * The real capture with `meta.loadedAddresses` populated from its own
 * `source: "lookupTable"` entries — see the file's own `_derivedFixture`
 * header and the fixture README.
 */
function jsonParsedCaptureWithLoadedAddresses(): unknown {
  const path = fileURLToPath(
    new URL("./fixtures/prediction-fill-settlement/tx-row42-create-with-loaded-addresses.json", import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

const ALT_KEYS = ["11111111111111111111111111111111", "2y9Ad2GD7gwiMkkMu4bBK5216Pv9YJsBkSHAGwN3rBuJ"];

describe("account-key resolution — jsonParsed encoding", () => {
  it("treats the RPC's accountKeys as the COMPLETE combined list and never appends loadedAddresses again", () => {
    const raw = jsonParsedCaptureWithLoadedAddresses();

    const parsed = parseSolanaTransactionResult(raw);

    expect(parsed).not.toBeNull();
    // the invariant that makes an index meaningful at all
    expect(parsed!.accountKeys).toHaveLength(parsed!.preBalancesLamports.length);
    expect(parsed!.accountKeys).toHaveLength(parsed!.postBalancesLamports.length);
    expect(parsed!.accountKeys).toHaveLength(14);
  });

  it("lists every lookup-table key exactly ONCE", () => {
    const parsed = parseSolanaTransactionResult(jsonParsedCaptureWithLoadedAddresses());

    for (const key of ALT_KEYS) {
      expect(parsed!.accountKeys.filter((candidate) => candidate === key)).toHaveLength(1);
    }
    expect(new Set(parsed!.accountKeys).size).toBe(parsed!.accountKeys.length);
  });

  it("keeps every key at the index its balances are reported against", () => {
    const parsed = parseSolanaTransactionResult(jsonParsedCaptureWithLoadedAddresses());

    // The ALT keys sit at the END of the RPC's own combined list (indices
    // 12-13 of 14) — exactly where the loaded addresses belong.
    expect(parsed!.accountKeys.slice(-2)).toEqual(ALT_KEYS);
    // and a key→index lookup resolves to a readable balance rather than off
    // the end of the array
    for (const key of ALT_KEYS) {
      const index = parsed!.accountKeys.indexOf(key);
      expect(parsed!.preBalancesLamports[index]).toBeTypeOf("number");
    }
  });

  it("is unchanged when the provider omits loadedAddresses entirely (the shape actually captured)", () => {
    const raw = jsonParsedCaptureWithLoadedAddresses() as { meta: Record<string, unknown> };
    const withLoaded = parseSolanaTransactionResult(raw);
    delete raw.meta.loadedAddresses;
    const withoutLoaded = parseSolanaTransactionResult(raw);

    expect(withoutLoaded!.accountKeys).toEqual(withLoaded!.accountKeys);
  });
});

describe("account-key resolution — legacy plain-string encoding", () => {
  /** Static keys only, as the non-jsonParsed encoding reports them. */
  function legacyTransaction(loadedAddresses: unknown): unknown {
    return {
      meta: {
        err: null,
        fee: 5000,
        preBalances: [1, 2, 3, 4],
        postBalances: [1, 2, 3, 4],
        preTokenBalances: [],
        postTokenBalances: [],
        loadedAddresses,
        innerInstructions: [],
      },
      transaction: { message: { accountKeys: ["StaticA", "StaticB"], instructions: [] } },
    };
  }

  it("still reconstructs static → loaded-writable → loaded-readonly", () => {
    const parsed = parseSolanaTransactionResult(
      legacyTransaction({ writable: ["LoadedW"], readonly: ["LoadedR"] }),
    );

    expect(parsed!.accountKeys).toEqual(["StaticA", "StaticB", "LoadedW", "LoadedR"]);
  });

  it("returns the static keys alone when there are no loaded addresses", () => {
    const parsed = parseSolanaTransactionResult(legacyTransaction(null));

    expect(parsed!.accountKeys).toEqual(["StaticA", "StaticB"]);
  });

  it("declines an unreadable accountKeys entry rather than guessing an index", () => {
    const parsed = parseSolanaTransactionResult({
      meta: {
        err: null,
        fee: 5000,
        preBalances: [1],
        postBalances: [1],
        preTokenBalances: [],
        postTokenBalances: [],
      },
      transaction: { message: { accountKeys: [{ notAPubkey: true }], instructions: [] } },
    });

    expect(parsed).toBeNull();
  });
});
