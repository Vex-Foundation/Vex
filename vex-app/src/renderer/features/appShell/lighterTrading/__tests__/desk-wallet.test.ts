/**
 * The desk knows an account index; the leverage hooks want a wallet. The
 * lookup must match on BOTH environment and index, since one wallet can hold
 * a different account on each environment.
 */

import { expect, it } from "vitest";
import { walletForLighterAccount } from "../desk-wallet.js";

const CONNECTIONS = [
  {
    walletAddress: "0xaaa",
    protected: false,
    scopes: [{ environment: "core" as const, accountIndex: 7, apiKeyIndex: 4, managed: true }],
  },
  {
    walletAddress: "0xbbb",
    protected: false,
    scopes: [{ environment: "rhc" as const, accountIndex: 7, apiKeyIndex: 4, managed: true }],
  },
];

it("finds the wallet whose scope matches the environment and account", () => {
  expect(walletForLighterAccount(CONNECTIONS, "rhc", 7)).toBe("0xbbb");
  expect(walletForLighterAccount(CONNECTIONS, "core", 7)).toBe("0xaaa");
});

it("answers null when no stored scope holds that account", () => {
  expect(walletForLighterAccount(CONNECTIONS, "rhc", 8)).toBeNull();
  expect(walletForLighterAccount([], "rhc", 7)).toBeNull();
});
