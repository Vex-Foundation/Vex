/**
 * Block-explorer deep links — the single source of truth for the chain →
 * explorer mapping AND the matching external-link allow entries.
 *
 * Pure, dependency-free (no main/renderer/electron imports) so BOTH the
 * untrusted renderer (which RENDERS the links) and the privileged main process
 * (which enforces the open) consume one map and can never drift. The actual
 * open goes `window.open` → main's `setWindowOpenHandler` → `shell.openExternal`,
 * gated by main's external-link allowlist (`src/main/windows/main-window.ts`).
 * That allowlist is spread from `EXPLORER_EXTERNAL_ALLOW` below, so every host
 * these builders can emit is on the allowlist by construction — the builders
 * are a convenience mapper, NOT the security boundary.
 *
 * Chain identifiers come from the engine's `proj_activity.chain` column (and,
 * on the failure/bridge paths, `data._explorerRefs[].chain`) and are tolerant
 * strings, not an enum. Real emitters use three shapes, ALL of which must
 * resolve, so each EVM chain carries three aliases:
 *   - the canonical lowercase slug (KyberSwap `resolveChainSlug` normalizes its
 *     aliases — eth/arb/avax/bera/zk/era — DOWN to the slug BEFORE capture, so
 *     only the slug is ever emitted; the aliases are intentionally NOT keyed
 *     here),
 *   - the CAIP-2 `eip155:<id>` form,
 *   - the BARE decimal chain id (Relay captures emit `chain: String(chainId)`,
 *     e.g. "8453" — see relay/handlers/bridge.ts + relay/execute.ts).
 * Normalization is lowercase + trim. Anything else (unknown chain, `null`/blank
 * ref) resolves to `null` and the UI renders non-interactive — never throw,
 * never emit a half-built URL.
 *
 * Add a chain here only when its explorer host is also added to
 * `EXPLORER_EXTERNAL_ALLOW`. Do NOT grow this into a chain registry — the
 * coverage audit in `__tests__/explorer-links.test.ts` pins that every runtime
 * chain identity (KyberSwap CHAINS, evm-chains activityChainKeys, Solana,
 * HyperCore, HyperEVM) resolves through this map.
 */

/** Normalized chain alias → explorer tx-path base (trailing slash included). */
const EXPLORER_TX_BASE: ReadonlyMap<string, string> = new Map([
  ["solana", "https://explorer.solana.com/tx/"],
  ["ethereum", "https://etherscan.io/tx/"],
  ["mainnet", "https://etherscan.io/tx/"],
  ["eip155:1", "https://etherscan.io/tx/"],
  ["1", "https://etherscan.io/tx/"],
  ["base", "https://basescan.org/tx/"],
  ["eip155:8453", "https://basescan.org/tx/"],
  ["8453", "https://basescan.org/tx/"],
  ["arbitrum", "https://arbiscan.io/tx/"],
  ["eip155:42161", "https://arbiscan.io/tx/"],
  ["42161", "https://arbiscan.io/tx/"],
  ["bsc", "https://bscscan.com/tx/"],
  ["bnb", "https://bscscan.com/tx/"],
  ["eip155:56", "https://bscscan.com/tx/"],
  ["56", "https://bscscan.com/tx/"],
  ["polygon", "https://polygonscan.com/tx/"],
  ["eip155:137", "https://polygonscan.com/tx/"],
  ["137", "https://polygonscan.com/tx/"],
  ["optimism", "https://optimistic.etherscan.io/tx/"],
  ["eip155:10", "https://optimistic.etherscan.io/tx/"],
  ["10", "https://optimistic.etherscan.io/tx/"],
  // Avalanche C-Chain (43114).
  ["avalanche", "https://snowtrace.io/tx/"],
  ["eip155:43114", "https://snowtrace.io/tx/"],
  ["43114", "https://snowtrace.io/tx/"],
  // Linea (59144).
  ["linea", "https://lineascan.build/tx/"],
  ["eip155:59144", "https://lineascan.build/tx/"],
  ["59144", "https://lineascan.build/tx/"],
  // Mantle (5000).
  ["mantle", "https://mantlescan.xyz/tx/"],
  ["eip155:5000", "https://mantlescan.xyz/tx/"],
  ["5000", "https://mantlescan.xyz/tx/"],
  // Sonic (146).
  ["sonic", "https://sonicscan.org/tx/"],
  ["eip155:146", "https://sonicscan.org/tx/"],
  ["146", "https://sonicscan.org/tx/"],
  // Berachain (80094).
  ["berachain", "https://berascan.com/tx/"],
  ["eip155:80094", "https://berascan.com/tx/"],
  ["80094", "https://berascan.com/tx/"],
  // Ronin (2020) — the explorer lives at the app host, path-scoped to /tx/.
  ["ronin", "https://app.roninchain.com/tx/"],
  ["eip155:2020", "https://app.roninchain.com/tx/"],
  ["2020", "https://app.roninchain.com/tx/"],
  // Unichain (130).
  ["unichain", "https://uniscan.xyz/tx/"],
  ["eip155:130", "https://uniscan.xyz/tx/"],
  ["130", "https://uniscan.xyz/tx/"],
  // Plasma (9745).
  ["plasma", "https://plasmascan.to/tx/"],
  ["eip155:9745", "https://plasmascan.to/tx/"],
  ["9745", "https://plasmascan.to/tx/"],
  // Etherlink (42793).
  ["etherlink", "https://explorer.etherlink.com/tx/"],
  ["eip155:42793", "https://explorer.etherlink.com/tx/"],
  ["42793", "https://explorer.etherlink.com/tx/"],
  // Monad (143).
  ["monad", "https://monadscan.com/tx/"],
  ["eip155:143", "https://monadscan.com/tx/"],
  ["143", "https://monadscan.com/tx/"],
  // MegaETH (4326).
  ["megaeth", "https://mega.etherscan.io/tx/"],
  ["eip155:4326", "https://mega.etherscan.io/tx/"],
  ["4326", "https://mega.etherscan.io/tx/"],
  // Scroll (534352).
  ["scroll", "https://scrollscan.com/tx/"],
  ["eip155:534352", "https://scrollscan.com/tx/"],
  ["534352", "https://scrollscan.com/tx/"],
  // zkSync Era (324) — the native zkSync explorer, NOT an etherscan zksync
  // domain (that instance sunset Jan 2026).
  ["zksync", "https://explorer.zksync.io/tx/"],
  ["eip155:324", "https://explorer.zksync.io/tx/"],
  ["324", "https://explorer.zksync.io/tx/"],
  // HyperCore (Hyperliquid L1): tx hash → the app's own explorer.
  ["hyperliquid", "https://app.hyperliquid.xyz/explorer/tx/"],
  // HyperEVM (chain id 999): EVM tx hash → hyperevmscan.
  ["hyperevm", "https://hyperevmscan.io/tx/"],
  ["eip155:999", "https://hyperevmscan.io/tx/"],
  ["999", "https://hyperevmscan.io/tx/"],
  // Robinhood Chain (Arbitrum Orbit L2, id 4663): all the engine's
  // `activityChainKeys` aliases (src/tools/evm-chains/registry.ts) plus the
  // CAIP-2 form → the chain's Blockscout explorer.
  ["robinhood", "https://robinhoodchain.blockscout.com/tx/"],
  ["robinhood chain", "https://robinhoodchain.blockscout.com/tx/"],
  ["robinhoodchain", "https://robinhoodchain.blockscout.com/tx/"],
  ["rhc", "https://robinhoodchain.blockscout.com/tx/"],
  ["4663", "https://robinhoodchain.blockscout.com/tx/"],
  ["eip155:4663", "https://robinhoodchain.blockscout.com/tx/"],
]);

/**
 * Normalized chain alias → explorer address-path base (trailing slash
 * included). Populated ONLY for chains whose activity can lack a tx hash and
 * whose explorer exposes a per-address page. Today that is HyperCore, where a
 * position/fill row carries no single transaction reference, so the UI links to
 * the account page instead. Same allowlist coupling as `EXPLORER_TX_BASE`.
 */
const EXPLORER_ADDRESS_BASE: ReadonlyMap<string, string> = new Map([
  ["hyperliquid", "https://app.hyperliquid.xyz/explorer/address/"],
]);

/**
 * Trim a tolerant scalar and reject blanks — a whitespace-only ref/address
 * would otherwise produce a dead `/tx/` or `/address/` link.
 */
function normalizeRef(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Resolve a row to its block-explorer transaction URL.
 *
 * @param chain tolerant chain identifier (e.g. `solana`, `Ethereum`, `eip155:1`)
 * @param txRef tx hash (EVM) / signature (Solana); `null` when the capture
 *              recorded neither
 * @returns the explorer URL, or `null` for unknown chains / missing refs
 */
export function explorerTxUrl(
  chain: string,
  txRef: string | null,
): string | null {
  const ref = normalizeRef(txRef);
  if (ref === null) return null;
  const base = EXPLORER_TX_BASE.get(chain.trim().toLowerCase());
  if (base === undefined) return null;
  return `${base}${encodeURIComponent(ref)}`;
}

/**
 * Resolve a row to its block-explorer ACCOUNT (address) URL. Used for activity
 * that has no single tx reference (e.g. HyperCore rows), so the UI can still
 * offer a `View account` link. Same tolerant semantics as `explorerTxUrl`.
 *
 * @param chain   tolerant chain identifier
 * @param address the account/wallet address; `null` when absent
 * @returns the explorer account URL, or `null` for unknown chains / no address
 */
export function explorerAccountUrl(
  chain: string,
  address: string | null,
): string | null {
  const addr = normalizeRef(address);
  if (addr === null) return null;
  const base = EXPLORER_ADDRESS_BASE.get(chain.trim().toLowerCase());
  if (base === undefined) return null;
  return `${base}${encodeURIComponent(addr)}`;
}

/**
 * External-link allow entry: `string` = exact-host match; `{host, pathPrefix}`
 * = host + path-boundary match. Structurally identical to main's
 * `ExternalAllowEntry` (`src/main/security/url.ts`) so this list spreads
 * straight into `ALLOWED_EXTERNAL` without an import across the process
 * boundary (shared must not import main).
 */
export type ExplorerAllowEntry =
  | string
  | { readonly host: string; readonly pathPrefix: string };

/**
 * SECURITY-RELEVANT POLICY. The block-explorer hosts these builders can emit,
 * as external-link allow entries — spread verbatim into main's
 * `ALLOWED_EXTERNAL`. Single source of truth: the mapper above and this list
 * cannot drift.
 *
 * The 7 pre-existing explorer hosts keep HOST-WIDE semantics (exact-host match,
 * no path scoping) exactly as before — no silent tightening. The 3 NEW hosts
 * are PATH-SCOPED to the explorer routes the mapper emits, so an allow-listed
 * host cannot double as an open redirect to its app surface (e.g.
 * `app.hyperliquid.xyz/trade` is NOT allowed; only `/explorer/...` is).
 */
export const EXPLORER_EXTERNAL_ALLOW: readonly ExplorerAllowEntry[] = [
  // Pre-existing explorer hosts — host-wide (unchanged semantics).
  "explorer.solana.com",
  "etherscan.io",
  "basescan.org",
  "arbiscan.io",
  "bscscan.com",
  "polygonscan.com",
  "optimistic.etherscan.io",
  // New hosts — path-scoped to the emitted explorer routes only.
  { host: "app.hyperliquid.xyz", pathPrefix: "/explorer/" },
  { host: "hyperevmscan.io", pathPrefix: "/tx/" },
  { host: "robinhoodchain.blockscout.com", pathPrefix: "/tx/" },
  // Full chain coverage — every host below is path-scoped to `/tx/` so an
  // allow-listed explorer host can never double as an open redirect to its app
  // surface. Ronin's explorer shares the `app.roninchain.com` app host, making
  // the `/tx/` scope load-bearing there.
  { host: "snowtrace.io", pathPrefix: "/tx/" },
  { host: "lineascan.build", pathPrefix: "/tx/" },
  { host: "mantlescan.xyz", pathPrefix: "/tx/" },
  { host: "sonicscan.org", pathPrefix: "/tx/" },
  { host: "berascan.com", pathPrefix: "/tx/" },
  { host: "app.roninchain.com", pathPrefix: "/tx/" },
  { host: "uniscan.xyz", pathPrefix: "/tx/" },
  { host: "plasmascan.to", pathPrefix: "/tx/" },
  { host: "explorer.etherlink.com", pathPrefix: "/tx/" },
  { host: "monadscan.com", pathPrefix: "/tx/" },
  { host: "mega.etherscan.io", pathPrefix: "/tx/" },
  { host: "scrollscan.com", pathPrefix: "/tx/" },
  { host: "explorer.zksync.io", pathPrefix: "/tx/" },
];
