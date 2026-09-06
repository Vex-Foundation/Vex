/**
 * Default-source wallet resolution against a REAL, on-disk wallet inventory.
 *
 * WHY THIS LIVES IN THE INTEGRATION SUITE. The unit suites that drive handlers
 * with `walletResolution: { source: "default" }` used to resolve that source
 * through the real resolver, which reads the MACHINE's configured wallets
 * (`config.json` under `CONFIG_DIR`, plus the derived keystore files). The
 * machine's wallet state is environment, not a unit fixture: a developer with a
 * wallet and a wallet-less CI runner ran different code under the same
 * assertion. Those unit tests now pin the resolver seam, and the real path -
 * config store to inventory to `resolveSelectedEntry` to a handler that reads
 * the wallet - is kept honest HERE instead, over an inventory this file owns
 * end to end and creates itself.
 *
 * Representative surface: `pools.tokens`, the read-only discovery surface whose
 * own-launch flag is the reason default-source resolution reaches a browsing
 * handler at all. It replaced `trench.tokens` here when migration 108 retired
 * that launchpad; the property under test is the same tri-state
 * (`resolveOwnDeployer` -> `applyOwnLaunchFlag`), on the venue that still
 * exists. The pools.fun PROVIDER is stubbed (it is an external HTTP dependency
 * and not the subject); everything between the context and the wallet address
 * is real.
 *
 * The two cases are ordered on purpose and share one config dir: the empty
 * inventory is the state a fresh dir starts in, and the wallet is created
 * between them, so both shapes are proven against real inventory reads rather
 * than one being asserted from a mock.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";

const { testDir, testConfigFile, testKeystoreFile, testSolanaKeystoreFile, testBackupsDir, testEnvFile, testVaultFile } =
  vi.hoisted(() => {
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const dir = join(tmpdir(), `vex-default-resolution-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    return {
      testDir: dir,
      testConfigFile: join(dir, "config.json"),
      testKeystoreFile: join(dir, "keystore.json"),
      testSolanaKeystoreFile: join(dir, "solana-keystore.json"),
      testBackupsDir: join(dir, "backups"),
      testEnvFile: join(dir, ".env"),
      testVaultFile: join(dir, "secrets.vault.json"),
    };
  });

const TEST_PASSWORD = "test-password-default-resolution";

// The fixture boundary: every real module below reads its paths from here, so
// the suite never touches the developer's or the runner's own `~/.config/vex`.
vi.mock("@config/paths.js", () => ({
  CONFIG_DIR: testDir,
  CONFIG_FILE: testConfigFile,
  KEYSTORE_FILE: testKeystoreFile,
  SOLANA_KEYSTORE_FILE: testSolanaKeystoreFile,
  BACKUPS_DIR: testBackupsDir,
  ENV_FILE: testEnvFile,
  SECRETS_VAULT_FILE: testVaultFile,
}));

vi.mock("@utils/env.js", () => ({
  requireKeystorePassword: vi.fn(() => TEST_PASSWORD),
  getKeystorePassword: vi.fn(() => TEST_PASSWORD),
}));

const { POOLS_HANDLERS } = await import("@vex-agent/tools/protocols/pools/handlers.js");
const { getPoolsFunClient } = await import("@tools/pools-fun/client.js");
const { createEvmWalletEntry } = await import("@tools/wallet/inventory-create.js");
const { getPrimaryEvmEntry } = await import("@tools/wallet/inventory.js");

import type { PoolsToken } from "@tools/pools-fun/types.js";
import { definedValue } from "../../_test-value-guards.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const OTHER_CREATOR = "0x9999000000000000000000000000000000009999";

/** The context under test: the same default source the browsing surfaces use. */
const DEFAULT_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

/**
 * One discover row. Only `tokenAddress` and `deployerAddress` matter to this
 * file - the flag is computed from the deployer alone - so everything else is
 * the row's honest "the launchpad said nothing" value rather than invented
 * market data.
 */
function token(over: { token: string; creator: string | null }): PoolsToken {
  return {
    tokenAddress: over.token,
    poolId: "0x0000000000000000000000000000000000000001",
    chain: "robinhood",
    platform: "poolsfun",
    pairedAsset: "weth",
    pairedStock: null,
    name: "Name",
    symbol: "SYM",
    decimals: null,
    totalSupply: null,
    imageUri: null,
    deployerAddress: over.creator,
    deployerXUsername: null,
    feeRecipientAddress: null,
    feeRecipientXUsername: null,
    tweetUrl: null,
    websiteUrl: null,
    deployedAt: new Date(1_700_000_000_000).toISOString(),
    lastTradeAt: null,
    lastPriceEth: null,
    lastPriceUsd: null,
    marketCapUsd: null,
    vol1m: null,
    vol5m: null,
    vol1h: null,
    vol6h: null,
    vol24h: null,
    txCount24h: null,
    priceChange1m: null,
    priceChange5m: null,
    priceChange1h: null,
    priceChange6h: null,
    priceChange24h: null,
    vexAttested: null,
    holderRewardsMode: null,
    holderRewardsDistributor: null,
    poolsFunBrand: null,
    pairedStockIlliquid: null,
  };
}

interface FlaggedRow {
  token: string;
  isOwnLaunch?: boolean;
}

function stubProviderRows(rows: PoolsToken[]): void {
  vi.spyOn(getPoolsFunClient(), "discover").mockResolvedValue({
    results: rows,
    nextCursor: null,
  });
}

async function listTokens(): Promise<FlaggedRow[]> {
  const handler = definedValue(POOLS_HANDLERS["pools.tokens"], "the pools.tokens handler");
  const res = await handler({}, DEFAULT_CTX);
  expect(res.success).toBe(true);
  return (JSON.parse(res.output) as { tokens: FlaggedRow[] }).tokens;
}

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

describe("default-source resolution over a real on-disk wallet inventory", () => {
  it("degrades to unflagged rows when the real inventory holds no EVM wallet", async () => {
    expect(getPrimaryEvmEntry()).toBeNull();
    stubProviderRows([token({ token: "0xA", creator: OTHER_CREATOR })]);

    const rows = await listTokens();

    expect(rows).toHaveLength(1);
    expect(rows.map((row) => "isOwnLaunch" in row)).toEqual([false]);
  });

  it("flags the real primary wallet's own launch once one is configured", async () => {
    // Generated, never a literal key: the fixture owns a fresh wallet whose
    // material lives and dies inside this temp dir.
    const entry = createEvmWalletEntry({ label: "fixture" });
    // The inventory read the handler will perform, performed here first: this
    // assertion is what makes the flag below evidence about REAL resolution.
    expect(getPrimaryEvmEntry()?.address.toLowerCase()).toBe(entry.address.toLowerCase());
    stubProviderRows([
      token({ token: "0xMine", creator: entry.address }),
      token({ token: "0xTheirs", creator: OTHER_CREATOR }),
      token({ token: "0xAnon", creator: null }),
    ]);

    const rows = await listTokens();

    expect(rows.map((row) => row.isOwnLaunch)).toEqual([true, false, undefined]);
    expect(rows.map((row) => "isOwnLaunch" in row)).toEqual([true, true, false]);
  });
});
