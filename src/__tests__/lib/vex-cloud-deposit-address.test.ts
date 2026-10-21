/**
 * The pinned Vex Cloud deposit address (plan 15.6): the build constant is
 * empty, so a packaged build has no deposit address at all; the development
 * override applies only after main opened the SAME gate the API URL uses,
 * and a malformed override closes deposits instead of falling back.
 */

import { afterEach, describe, expect, it } from "vitest";
import { VEX_CLOUD_DEPOSIT_ADDRESS } from "../../config/store.js";
import { resolveVexCloudDepositAddress, VEX_CLOUD_DEV_DEPOSIT_ADDRESS_ENV } from "../../lib/vex-cloud-deposit-address.js";
import { allowVexCloudDevOverride } from "../../lib/vex-cloud-endpoint.js";

const DEV = "0x00000000000000000000000000000000d3905a11";

afterEach(() => {
  allowVexCloudDevOverride(false);
});

describe("resolveVexCloudDepositAddress", () => {
  it("ships empty: no deposit address in a build until the production key exists", () => {
    expect(VEX_CLOUD_DEPOSIT_ADDRESS).toBe("");
    expect(resolveVexCloudDepositAddress({})).toBeNull();
  });

  it("ignores the override while main has not allowed it (a packaged build)", () => {
    expect(resolveVexCloudDepositAddress({ [VEX_CLOUD_DEV_DEPOSIT_ADDRESS_ENV]: DEV })).toBeNull();
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
