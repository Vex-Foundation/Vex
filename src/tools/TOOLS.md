# Tools — Protocol Clients, Wallet, & Service Integrations

> All protocol-specific SDK wrappers, API clients, and on-chain utilities. Each subfolder is a self-contained integration with its own types, validation, and client layer. vex-agent tools (`src/vex-agent/tools/protocols/`) consume these clients.
>
> **Last updated: 2026-07-22 (Agent Scan Phase 1)**
>
> **LLM maintainers:** If you add/remove a protocol or change a module's scope, update this file AND the subfolder's own .md doc.

---

## Module Map

| Folder | Protocol / Service | Chain | Files | Docs |
|--------|--------------------|-------|-------|------|
| `dexscreener/` | DexScreener analytics (REST + WS) | Multi-chain | 5 | [DexScreener.md](dexscreener/DexScreener.md) |
| `trench-express/` | Trench Express launchpad — P1 read client (tokens/token/search/trades/stats) | RBC 4663 | 8 | [TrenchExpress.md](trench-express/TrenchExpress.md) |
| `khalani/` | Khalani cross-chain bridge (40+ chains) | Multi-chain | 7 | [Khalani.md](khalani/Khalani.md) |
| `kyberswap/` | KyberSwap aggregator swaps (limit orders + ZaaS deleted, Agent Scan Phase 1) | 19 EVM chains | 23 | [KyberSwap.md](kyberswap/KyberSwap.md) |
| `uniswap/` | Direct on-chain swap quote/execute — hidden pair, reveal-gated behind KyberSwap | EVM | 12 | (no dedicated doc yet) |
| `solana-ecosystem/` | Jupiter (swap, prices, tokens, lend, predict) + shared Solana utils | Solana | 35 | [Jupiter.md](solana-ecosystem/jupiter/Jupiter.md) |
| `morpho/` | Morpho lending reads (Blue markets, curated vaults V1/V2, wallet positions with health factors, market transaction history) - keyless GraphQL, request budget + 7-day-ban circuit breaker; plus the on-chain balance and Morpho-allowance read (batch 4) over keyless RPC | 9 EVM chains | 21 | [Morpho.md](morpho/Morpho.md) |
| `merkl/` | Merkl reward distribution (the distributor Morpho's reward campaigns settle through, since Morpho's own URD is deprecated) - keyless REST, read-only, per-protocol attribution by `protocol.id` | Multi-chain | 7 | [Merkl.md](merkl/Merkl.md) |
| `indexify/` | Indexify social-index stacks — CUSTODIAL API venue (server-side trades on the linked account's USDC, `INDEXIFY_API_KEY`); public discovery reads keyless; plus the allocation-sync surface (version history, tradability, edit_allocation) for the Z500 workflow | Solana | 5 | [Indexify.md](indexify/Indexify.md) |
| `ansem/` | Ansem Z500 ranking feed — read-only source for the Z500 allocation sync; fail-closed on unavailable/stale/invalid snapshots (site currently challenges non-browser clients) | Solana | 4 | [Ansem.md](ansem/Ansem.md) |
| `wallet/` | Multi-chain keystore, signing, native balances | EVM + Solana | 29 | [WALLET.md](wallet/WALLET.md) |

`polymarket/` (Polymarket prediction markets — CLOB, Gamma, Relayer, 39 files) was removed
entirely in Agent Scan Phase 1 (may return someday as a fresh integration). Its `Polymarket.md`
doc was deleted with it.

**Total: ~120 files across 7 modules** (approximate; `evm-chains/`, `pendle/`, `relay/`,
`twitter-account/`, `virtuals/` are also present under `src/tools/` but predate this table —
not re-audited as part of this pass). `hyperliquid/` (11 files) was removed entirely in
Agent Scan Phase 3 (total Hyperliquid deletion); its `Hyperliquid.md` doc was deleted with it.

---

## Architecture Pattern

Every protocol module follows the same layered pattern:

```
types.ts          — Domain types (response shapes, enums, configs)
validation.ts     — Runtime validators for external data (API responses)
errors.ts         — HTTP/protocol error → VexError mapping
client.ts         — API client (singleton, rate-limited, retry, timeout)
constants.ts      — URLs, limits, addresses, fee tiers
```

Some modules extend this with:
- `abi/` — Contract ABIs for on-chain interaction
- `subgraph/` — GraphQL clients for indexed data

(The Polymarket CLOB's `signing.ts`/`auth.ts` EIP-712/HMAC examples were removed with the
Polymarket integration, Agent Scan Phase 1 — no remaining module in this tree uses that
extension shape.)

---

## Chain Coverage

| Chain Family | Chains | Protocols |
|-------------|--------|-----------|
| **EVM** | Ethereum, Polygon, Arbitrum, Optimism, BSC, Avalanche, Base, + 12 more | KyberSwap, Uniswap, Khalani, DexScreener |
| **Solana** | Solana Mainnet | Jupiter (swap, lend, predict, prices, tokens) |

---

## External Docs

| Protocol | Official docs |
|----------|--------------|
| Jupiter | https://dev.jup.ag/docs/llms.txt |
| Khalani | https://khalani.gitbook.io/khalani-docs |
| KyberSwap | https://docs.kyberswap.com/ |
| DexScreener | https://docs.dexscreener.com/api/reference |

---

## Dependencies Shared Across Modules

| Dependency | Used by |
|-----------|---------|
| `viem` | Wallet, Khalani, KyberSwap, Uniswap (EVM reads/writes) |
| `@solana/web3.js` | Wallet, Jupiter, Khalani-Solana |
| `config/store.ts` | Every module (service URLs, contract addresses) |
| `utils/http.ts` | Every REST client |
| `utils/rateLimit.ts` | KyberSwap |
| `errors.ts` | Every module (VexError with domain-specific codes) |
