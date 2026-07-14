import { describe, it, expect } from "vitest";
import {
  NATIVE_TOKEN_ADDRESS,
  META_AGGREGATION_ROUTER_V2,
  INPUT_SCALING_HELPER_V2,
  DSLO_PROTOCOL,
  WETH_UNWRAPPER,
  KS_ZAP_ROUTER_POSITION,
  KS_ZAP_VALIDATOR_V2,
  KS_ZAP_ROUTER_PERMIT,
  KYBER_KNOWN_SPENDERS,
  AGGREGATOR_BASE_URL,
  TOKEN_API_BASE_URL,
  COMMON_SERVICE_BASE_URL,
  LIMIT_ORDER_BASE_URL,
  ZAAS_BASE_URL,
  AGGREGATOR_TIMEOUT_MS,
  TOKEN_API_TIMEOUT_MS,
  LIMIT_ORDER_TIMEOUT_MS,
  ZAAS_TIMEOUT_MS,
  COMMON_SERVICE_TIMEOUT_MS,
  KYBERSWAP_FEE_BPS,
  KYBERSWAP_FEE_CHARGE_BY,
  KYBERSWAP_FEE_RECEIVER,
} from "@tools/kyberswap/constants.js";
import { VEX_TREASURY_EVM } from "../../lib/vex-treasury.js";

const HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

describe("contract addresses", () => {
  const addresses = [
    META_AGGREGATION_ROUTER_V2, INPUT_SCALING_HELPER_V2,
    DSLO_PROTOCOL, WETH_UNWRAPPER,
    KS_ZAP_ROUTER_POSITION, KS_ZAP_VALIDATOR_V2, KS_ZAP_ROUTER_PERMIT,
    NATIVE_TOKEN_ADDRESS,
  ];

  for (const addr of addresses) {
    it(`${addr} is valid hex address`, () => {
      expect(addr).toMatch(HEX_ADDR_RE);
    });
  }
});

describe("KYBER_KNOWN_SPENDERS", () => {
  it("contains exactly 4 entries", () => {
    expect(KYBER_KNOWN_SPENDERS.size).toBe(4);
  });

  it("contains all expected addresses (lowercased)", () => {
    expect(KYBER_KNOWN_SPENDERS.has(META_AGGREGATION_ROUTER_V2.toLowerCase())).toBe(true);
    expect(KYBER_KNOWN_SPENDERS.has(DSLO_PROTOCOL.toLowerCase())).toBe(true);
    expect(KYBER_KNOWN_SPENDERS.has(KS_ZAP_ROUTER_POSITION.toLowerCase())).toBe(true);
    expect(KYBER_KNOWN_SPENDERS.has(KS_ZAP_ROUTER_PERMIT.toLowerCase())).toBe(true);
  });
});

describe("Vex integrator fee", () => {
  // Money-affecting pins: a fee that drifts from 25bps, changes the charge
  // currency, or points the receiver anywhere but the treasury is an overcharge
  // / fee-theft vector. These must fail loudly on an accidental edit.
  it("fee is exactly 25 bps (0.25% at Kyber base 10000)", () => {
    expect(KYBERSWAP_FEE_BPS).toBe(25);
  });

  it("fee is charged in the INPUT token (currency_in)", () => {
    expect(KYBERSWAP_FEE_CHARGE_BY).toBe("currency_in");
  });

  it("fee receiver is the EVM treasury (buyback and burn)", () => {
    expect(KYBERSWAP_FEE_RECEIVER).toBe(VEX_TREASURY_EVM);
    expect(KYBERSWAP_FEE_RECEIVER).toBe("0xe341f3da256C38356bce4Afd456d7fa36E356E94");
  });
});

describe("base URLs", () => {
  const urls = [AGGREGATOR_BASE_URL, TOKEN_API_BASE_URL, COMMON_SERVICE_BASE_URL, LIMIT_ORDER_BASE_URL, ZAAS_BASE_URL];

  for (const url of urls) {
    it(`${url} is HTTPS`, () => {
      expect(url).toMatch(/^https:\/\//);
    });
  }
});

describe("timeouts", () => {
  const timeouts = [AGGREGATOR_TIMEOUT_MS, TOKEN_API_TIMEOUT_MS, LIMIT_ORDER_TIMEOUT_MS, ZAAS_TIMEOUT_MS, COMMON_SERVICE_TIMEOUT_MS];

  for (const t of timeouts) {
    it(`timeout ${t} is positive`, () => {
      expect(t).toBeGreaterThan(0);
    });
  }
});
