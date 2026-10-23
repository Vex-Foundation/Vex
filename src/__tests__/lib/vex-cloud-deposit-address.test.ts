/**
 * The pinned Vex Cloud deposit address (plan 15.6): the build constant is the
 * production custody wallet (the backend's `DEPOSIT_ADDRESS`, owner decision
 * 2026-10-21), and a packaged build sends there and nowhere else; the
 * development override applies only after main opened the SAME gate the API
 * URL uses, and a malformed override closes deposits instead of falling back.
 */

import { afterEach, describe, expect, it } from "vitest";
import { VEX_CLOUD_DEPOSIT_ADDRESS } from "../../config/store.js";
import { resolveVexCloudDepositAddress, VEX_CLOUD_DEV_DEPOSIT_ADDRESS_ENV } from "../../lib/vex-cloud-deposit-address.js";
import { allowVexCloudDevOverride } from "../../lib/vex-cloud-endpoint.js";

const DEV = "0x00000000000000000000000000000000d3905a11";
/** The production custody wallet, written out here so a changed constant fails this test. */
const PRODUCTION = "0xf36aed1c11A3140594609969DC6646c9F8a981C5";

afterEach(() => {
  allowVexCloudDevOverride(false);
});

describe("resolveVexCloudDepositAddress", () => {
  it("ships the production custody wallet, EIP-55 checksummed", () => {
    expect(VEX_CLOUD_DEPOSIT_ADDRESS).toBe(PRODUCTION);
    expect(resolveVexCloudDepositAddress({})).toBe(PRODUCTION);
  });

  it("ignores the override while main has not allowed it (a packaged build), keeping the production wallet", () => {
    expect(resolveVexCloudDepositAddress({ [VEX_CLOUD_DEV_DEPOSIT_ADDRESS_ENV]: DEV })).toBe(PRODUCTION);
  });

  it("falls back to the production wallet when an allowed override is unset or blank", () => {
    allowVexCloudDevOverride(true);
    expect(resolveVexCloudDepositAddress({})).toBe(PRODUCTION);
    expect(resolveVexCloudDepositAddress({ [VEX_CLOUD_DEV_DEPOSIT_ADDRESS_ENV]: "  " })).toBe(PRODUCTION);
  });

  it("honours the override once main allowed it, checksummed", () => {
    allowVexCloudDevOverride(true);
    expect(resolveVexCloudDepositAddress({ [VEX_CLOUD_DEV_DEPOSIT_ADDRESS_ENV]: DEV })).toBe("0x00000000000000000000000000000000d3905A11");
  });

  it.each(["0x123", "not-an-address", `0x${"0".repeat(40)}`])("a malformed override %s closes deposits", (raw) => {
    allowVexCloudDevOverride(true);
    expect(resolveVexCloudDepositAddress({ [VEX_CLOUD_DEV_DEPOSIT_ADDRESS_ENV]: raw })).toBeNull();
  });
});
