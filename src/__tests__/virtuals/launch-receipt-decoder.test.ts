/**
 * The launch receipt decoders, against FOUR REAL RECEIPTS.
 *
 * Every fixture in this file is a transaction that actually happened on a
 * public chain, captured with its full log list and reduced to the
 * `{address, topics, data}` shape the decoder reads. Nothing here is
 * hand-written: a synthetic log proves the ABI matches itself, and the defect
 * this suite exists to catch is the ABI matching itself while disagreeing with
 * the chain.
 *
 *   Base preLaunch          0xd0fbcca8...  16 logs, our own wallet
 *   Base keeper launch()    0x9eca4cb5...  14 logs, sent by the KEEPER
 *   Robinhood preLaunch     0x7cc33439...  15 logs
 *   Robinhood launch()      0x17e401b9...  11 logs, sent by VEX - the incident
 *
 * The Robinhood `launch()` is deliberately included even though sending it was
 * the defect: the RECEIPT is a faithful `Launched` event, and a decoder that
 * could only read the keeper's receipts would be reading the sender rather than
 * the log.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";

import {
  decodeCancelledLaunch,
  decodeLaunched,
  decodePreLaunched,
  type DecodableLaunchLog,
} from "@tools/virtuals/launch/index.js";

interface LaunchFixture {
  readonly _provenance: string;
  readonly bondingV5: string;
  readonly txHash: string;
  readonly expected: Record<string, string>;
  readonly logs: readonly DecodableLaunchLog[];
}

function loadFixture(name: string): LaunchFixture {
  const path = join(__dirname, "fixtures", name);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error(`fixture ${name} is not an object`);
  const fixture = parsed as Partial<LaunchFixture>;
  if (typeof fixture.bondingV5 !== "string" || !Array.isArray(fixture.logs)) {
    throw new Error(`fixture ${name} is missing bondingV5 or logs`);
  }
  if (typeof fixture.expected !== "object" || fixture.expected === null) {
    throw new Error(`fixture ${name} is missing its expected block`);
  }
  return {
    _provenance: typeof fixture._provenance === "string" ? fixture._provenance : "",
    bondingV5: fixture.bondingV5,
    txHash: typeof fixture.txHash === "string" ? fixture.txHash : "",
    expected: fixture.expected,
    logs: fixture.logs,
  };
}

function bondingOf(fixture: LaunchFixture): Address {
  return getAddress(fixture.bondingV5);
}

/** The expected value for `key`, proven present rather than assumed. */
function expected(fixture: LaunchFixture, key: string): string {
  const value = fixture.expected[key];
  expect(value, `fixture is missing expected.${key}`).toBeDefined();
  if (typeof value !== "string") throw new Error(`expected.${key} is not a string`);
  return value;
}

const BASE_PRELAUNCH = loadFixture("launch-prelaunch-base.json");
const BASE_LAUNCHED = loadFixture("launch-launched-base-keeper.json");
const RH_PRELAUNCH = loadFixture("launch-prelaunch-robinhood.json");
const RH_LAUNCHED = loadFixture("launch-launched-robinhood.json");

describe("decodePreLaunched on real receipts", () => {
  for (const [label, fixture] of [
    ["Base 0xd0fbcca8", BASE_PRELAUNCH],
    ["Robinhood 0x7cc33439", RH_PRELAUNCH],
  ] as const) {
    it(`reads the token, pair, virtual id and initial purchase from ${label}`, () => {
      const decoded = decodePreLaunched({ logs: fixture.logs, bondingV5: bondingOf(fixture) });
      expect(decoded).not.toBeNull();
      if (decoded === null) throw new Error("PreLaunched did not decode");

      expect(decoded.token).toBe(getAddress(expected(fixture, "token")));
      expect(decoded.pair).toBe(getAddress(expected(fixture, "pair")));
      expect(decoded.virtualId.toString()).toBe(expected(fixture, "virtualId"));
      expect(decoded.initialPurchaseRaw.toString()).toBe(expected(fixture, "initialPurchaseRaw"));

      // The launch parameters the venue stored. Both launches were normal,
      // immediate, no ACF, no airdrop, anti-sniper type 1 - which is exactly
      // the ONE shape this lane signs, so a change to that shape shows up here.
      expect(decoded.launchParams.launchMode).toBe(0);
      expect(decoded.launchParams.airdropBips).toBe(0);
      expect(decoded.launchParams.needAcf).toBe(false);
      expect(decoded.launchParams.isProject60days).toBe(false);
      expect(decoded.launchParams.antiSniperTaxType).toBe(1);
    });
  }

  it("finds PreLaunched among the other fifteen logs and ignores them", () => {
    // The receipt carries the agent-token factory's, the pair's and the tax
    // vault's logs too. The decoder must skip every one WITHOUT throwing, which
    // is the tolerance the money path depends on: an unreadable neighbour log
    // must not lose the event that names the token.
    expect(BASE_PRELAUNCH.logs.length).toBeGreaterThan(10);
    const foreign = BASE_PRELAUNCH.logs.filter(
      (log) => log.address.toLowerCase() !== BASE_PRELAUNCH.bondingV5.toLowerCase(),
    );
    expect(foreign.length).toBeGreaterThan(0);
    expect(decodePreLaunched({ logs: BASE_PRELAUNCH.logs, bondingV5: bondingOf(BASE_PRELAUNCH) })).not.toBeNull();
  });

  it("refuses a PreLaunched log emitted by any other contract", () => {
    // THE EMITTER CHECK IS THE POINT. Any contract can emit a log whose topic0
    // matches; a decoder that accepted one would let an unrelated contract in
    // the same transaction name the token a launch is recorded against.
    const otherBonding = getAddress("0x00000000000000000000000000000000000000dd");
    expect(decodePreLaunched({ logs: BASE_PRELAUNCH.logs, bondingV5: otherBonding })).toBeNull();
  });

  it("answers null on a receipt that carries no PreLaunched at all", () => {
    // The keeper's `launch()` receipt has a `Launched`, not a `PreLaunched`.
    // Null rather than a throw, so the caller can tell "confirmed but
    // undecodable" from "failed".
    expect(decodePreLaunched({ logs: BASE_LAUNCHED.logs, bondingV5: bondingOf(BASE_LAUNCHED) })).toBeNull();
  });
});

describe("decodeLaunched on real receipts", () => {
  for (const [label, fixture] of [
    ["the Base KEEPER's launch() 0x9eca4cb5", BASE_LAUNCHED],
    ["the Robinhood launch() 0x17e401b9", RH_LAUNCHED],
  ] as const) {
    it(`reads the launch and the tokens the initial purchase bought from ${label}`, () => {
      const decoded = decodeLaunched({ logs: fixture.logs, bondingV5: bondingOf(fixture) });
      expect(decoded).not.toBeNull();
      if (decoded === null) throw new Error("Launched did not decode");

      expect(decoded.token).toBe(getAddress(expected(fixture, "token")));
      expect(decoded.pair).toBe(getAddress(expected(fixture, "pair")));
      expect(decoded.virtualId.toString()).toBe(expected(fixture, "virtualId"));
      expect(decoded.initialPurchaseRaw.toString()).toBe(expected(fixture, "initialPurchaseRaw"));
      // The ONLY field `Launched` carries that `PreLaunched` does not, and the
      // one the launch handler records as the output leg when it observes the
      // keeper: the agent tokens the initial purchase actually bought.
      expect(decoded.initialPurchasedAmountRaw.toString()).toBe(expected(fixture, "initialPurchasedAmountRaw"));
    });
  }

  it("keeps scanning past a Launched for a different token", () => {
    // `token` narrows the search when a log RANGE holds several launches, and a
    // non-matching event must not end the scan - which it would if the filter
    // were applied by returning early.
    const wanted = getAddress(expected(BASE_LAUNCHED, "token"));
    const other = getAddress("0x000000000000000000000000000000000000beef");
    expect(decodeLaunched({ logs: BASE_LAUNCHED.logs, bondingV5: bondingOf(BASE_LAUNCHED), token: other })).toBeNull();
    expect(decodeLaunched({ logs: BASE_LAUNCHED.logs, bondingV5: bondingOf(BASE_LAUNCHED), token: wanted })).not.toBeNull();
  });

  it("does not read a Launched out of a preLaunch receipt", () => {
    // The two events are the two halves of the venue's two-transaction shape.
    // Confusing them would report an agent as LIVE the moment it was created,
    // which is exactly the claim `awaiting_keeper` exists to avoid making.
    expect(decodeLaunched({ logs: BASE_PRELAUNCH.logs, bondingV5: bondingOf(BASE_PRELAUNCH) })).toBeNull();
  });

  it("reads nothing from an empty log list", () => {
    expect(decodeLaunched({ logs: [], bondingV5: bondingOf(BASE_LAUNCHED) })).toBeNull();
    expect(decodePreLaunched({ logs: [], bondingV5: bondingOf(BASE_LAUNCHED) })).toBeNull();
    expect(decodeCancelledLaunch({ logs: [], bondingV5: bondingOf(BASE_LAUNCHED) })).toBeNull();
  });
});

describe("decodeCancelledLaunch", () => {
  it("finds no cancel in a launch receipt", () => {
    // No real `CancelledLaunch` receipt exists to fixture: the owner's launch
    // ban means none has been signed, and inventing one would prove only that
    // the ABI matches itself. What IS proven here is the property that matters
    // for the cancel handler's honesty - it decodes NOTHING from a receipt that
    // does not carry the event, so a confirmed cancel whose event cannot be
    // read reports the contract's owed amount and says the event was not
    // decoded, rather than inventing a refund. Declared gap: the positive path
    // is proven by `simulateContract(cancelLaunch)` in the live ledger.
    for (const fixture of [BASE_PRELAUNCH, BASE_LAUNCHED, RH_PRELAUNCH, RH_LAUNCHED]) {
      expect(decodeCancelledLaunch({ logs: fixture.logs, bondingV5: bondingOf(fixture) })).toBeNull();
    }
  });
});
