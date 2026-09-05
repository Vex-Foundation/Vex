/**
 * CHARACTERIZATION of the 13-point verifier against the committed V1 prepare
 * capture, written BEFORE the V3 suite repair and kept afterwards as the record
 * of what the change did and did not alter.
 *
 * Why a characterization file rather than an assertion inside the main verifier
 * suite: the main suite builds its own tuples with viem, so it proves the
 * verifier's LOGIC. This one drives the verifier over the exact bytes the
 * provider sent on 2026-08-19 (`launches-prepare-wallet-recipient`), so it
 * proves what the verifier does to a REAL body. Rule 03: a risky refactor
 * begins with characterization of observable behaviour against the old code.
 *
 * THE INTENTIONAL CONTRACT CHANGE, recorded here rather than discovered later:
 * launches target the V3 suite only (owner decision D-suites), the V1 `launch`
 * ABI is deleted, and V1 calldata therefore no longer decodes. The verifier's
 * answer to a V1 body is a NAMED refusal on `selector_and_encoding`, never a
 * pass and never a crash. Everything else this file pins - the response's own
 * mirror relation, the recipient inside the bytes - is behaviour the repair
 * preserves.
 */

import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import { validatePrepareResponse } from "@tools/pools-fun/validation.js";
import { decodeLaunchCalldata } from "@tools/pools-fun/launch/verify-calldata.js";
import { captureResponse, CAPTURES } from "./_captures.js";

const v1 = () => validatePrepareResponse(captureResponse(CAPTURES.prepareWalletRecipient));

describe("the committed V1 prepare capture, as the shipped verifier sees it", () => {
  it("still validates as a prepare body: the response SHAPE is unchanged across suites", () => {
    const parsed = v1();
    expect(parsed.to).toBe("0x3AB42e7dd316aF8854033bc216C657eD34961164");
    expect(parsed.deploymentFeeWei).toBe("1051674002092832");
    expect(parsed.requiresReprepare).toBe(false);
  });

  it("carries the V1 selector 0xb3ee5495, which is what the suite repair retires", () => {
    expect(v1().data.slice(0, 10)).toBe("0xb3ee5495");
  });

  it("PRESERVED: the response mirrors the recipient inside its own calldata", () => {
    // Point 4's relation, checked against real bytes rather than a fixture the
    // test wrote. Whatever happens to the decoder, this fact about the capture
    // does not change.
    const parsed = v1();
    const wallet = getAddress(parsed.feeRecipient.address);
    expect(parsed.data.toLowerCase()).toContain(wallet.slice(2).toLowerCase());
  });

  it("CHANGED: V1 calldata no longer decodes, because launches are V3-only", () => {
    // Before the repair this returned the 12-member tuple. After it, the V1
    // `launch` fragment is deleted (dead: no launch path targets V1), so the
    // decoder declines - and declining is a verdict the verifier reports as
    // `selector_and_encoding`, not an exception.
    expect(decodeLaunchCalldata(v1().data as `0x${string}`)).toBeNull();
  });
});
