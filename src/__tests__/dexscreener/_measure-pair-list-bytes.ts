/**
 * Byte-matrix printer for the DexScreener pair list.
 *
 * `pnpm exec tsx src/__tests__/dexscreener/_measure-pair-list-bytes.ts`
 *
 * Not a test: the assertions live in `pair-list-byte-budget.test.ts`. This exists
 * so the per-tool / per-mode / per-field breakdown behind those ceilings can be
 * reproduced by a future reader without re-deriving the fixtures, and so a
 * regression in row cost can be attributed to a field rather than guessed at.
 */

import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import {
  pairsWethUsdcPool,
  searchSolUsdc,
  searchUsdc,
  tokenPairsBonk,
  tokenPairsWeth,
  tokensEthereum40,
} from "./_pair-captures.js";

const CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

const client = getDexScreenerClient();
const usdc = searchUsdc();
const solUsdc = searchSolUsdc();
const weth = tokenPairsWeth();
const bonk = tokenPairsBonk();
const batch = tokensEthereum40();

client.search = async (query: string) => (query === "SOL/USDC" ? solUsdc : usdc);
client.getPairs = async () => pairsWethUsdcPool();
client.getTokenPairs = async (_chain: string, address: string) =>
  address === "BONK" ? bonk : weth;
client.getTokens = async () => batch.pairs;

const CASES: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
  ["search q=USDC lean", "dexscreener.search", { query: "USDC" }],
  ["search q=USDC rich", "dexscreener.search", { query: "USDC", fields: "full" }],
  ["search q=SOL/USDC lean", "dexscreener.search", { query: "SOL/USDC" }],
  ["search q=SOL/USDC rich", "dexscreener.search", { query: "SOL/USDC", fields: "full" }],
  ["search +baseName", "dexscreener.search", { query: "SOL/USDC", fields: "baseName" }],
  ["search limit=5", "dexscreener.search", { query: "USDC", limit: 5 }],
  ["tokenPairs WETH lean", "dexscreener.tokenPairs", { chainId: "ethereum", tokenAddress: "WETH" }],
  [
    "tokenPairs WETH rich",
    "dexscreener.tokenPairs",
    { chainId: "ethereum", tokenAddress: "WETH", fields: "full" },
  ],
  ["tokenPairs BONK lean", "dexscreener.tokenPairs", { chainId: "solana", tokenAddress: "BONK" }],
  [
    "tokens 40-req lean",
    "dexscreener.tokens",
    { chainId: "ethereum", tokenAddresses: batch.requestedAddresses },
  ],
  [
    "tokens 40-req rich",
    "dexscreener.tokens",
    { chainId: "ethereum", tokenAddresses: batch.requestedAddresses, fields: "full" },
  ],
  [
    "tokens 40-req limit=15",
    "dexscreener.tokens",
    { chainId: "ethereum", tokenAddresses: batch.requestedAddresses, limit: 15 },
  ],
  ["pairs single lean", "dexscreener.pairs", { chainId: "ethereum", pairAddress: "0x88e6" }],
  [
    "pairs single rich",
    "dexscreener.pairs",
    { chainId: "ethereum", pairAddress: "0x88e6", fields: "full" },
  ],
];

for (const [label, toolId, params] of CASES) {
  const handler = DEXSCREENER_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`no handler for ${toolId}`);
  const result = await handler(params, CTX);
  if (!result.success) {
    console.log(`${label.padEnd(24)} FAILED  ${result.output}`);
    continue;
  }
  const data: unknown = JSON.parse(result.output);
  const total = Buffer.byteLength(result.output, "utf8");
  const entries = typeof data === "object" && data !== null ? Object.entries(data) : [];
  const sizes = entries.map(([key, value]): readonly [string, number] => [
    key,
    Buffer.byteLength(JSON.stringify(value), "utf8"),
  ]);
  const pairsBytes = sizes.find(([key]) => key === "pairs")?.[1] ?? 0;
  const rows = Array.isArray((data as { pairs?: unknown[] }).pairs)
    ? ((data as { pairs: unknown[] }).pairs.length)
    : 0;
  const perRow = rows > 0 ? Math.round((pairsBytes / rows) * 10) / 10 : 0;
  const top = [...sizes]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([key, bytes]) => `${key}=${bytes}`)
    .join(" ");
  console.log(
    `${label.padEnd(24)} ${String(total).padStart(7)}  rows=${String(rows).padEnd(3)} `
    + `B/row=${String(perRow).padEnd(8)} ${top}`,
  );
}
