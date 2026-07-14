# Tools — Protocol Clients, Wallet, & Service Integrations

> All protocol-specific SDK wrappers, API clients, and on-chain utilities. Each subfolder is a self-contained integration with its own types, validation, and client layer. Commands (`src/commands/`) delegate here for business logic; vex-agent tools (`src/vex-agent/tools/protocols/`) also consume these clients.
>
> **Last updated: 2026-03-31**
>
> **LLM maintainers:** If you add/remove a protocol or change a module's scope, update this file AND the subfolder's own .md doc.

---

## Module Map

| Folder | Protocol / Service | Chain | Files | Docs |
|--------|--------------------|-------|-------|------|
| `dexscreener/` | DexScreener analytics (REST + WS) | Multi-chain | 5 | [DexScreener.md](dexscreener/DexScreener.md) |
| `hyperliquid/` | HyperCore perps, spot, account, vault, and staking client | Hyperliquid | 11 | [Hyperliquid.md](hyperliquid/Hyperliquid.md) |
| `khalani/` | Khalani cross-chain bridge (40+ chains) | Multi-chain | 7 | [Khalani.md](khalani/Khalani.md) |
| `kyberswap/` | KyberSwap aggregator, limit orders, ZaaS | 18 EVM chains | 22 | [KyberSwap.md](kyberswap/KyberSwap.md) |
| `polymarket/` | Polymarket prediction markets (CLOB, Gamma, Relayer) | Polygon | 22 | [Polymarket.md](polymarket/Polymarket.md) |
| `solana-ecosystem/` | Jupiter (swap, prices, tokens, lend, predict) + shared Solana utils | Solana | 35 | [Jupiter.md](solana-ecosystem/jupiter/Jupiter.md) |
| `wallet/` | Multi-chain keystore, signing, native balances | EVM + Solana | 12 | [WALLET.md](wallet/WALLET.md) |

**Total: ~134 files across 7 modules**

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
- `ws-client.ts` — WebSocket streaming (DexScreener)
- `signing.ts` — Protocol-specific cryptographic signing (Polymarket CLOB)
- `auth.ts` — JWT/HMAC authentication flows (Polymarket)

---

## Chain Coverage

| Chain Family | Chains | Protocols |
|-------------|--------|-----------|
| **EVM** | Ethereum, Polygon, Arbitrum, Optimism, BSC, Avalanche, Base, + 11 more | KyberSwap, Khalani, Polymarket, DexScreener |
| **Solana** | Solana Mainnet | Jupiter (swap, lend, predict, prices, tokens) |

---

## External Docs

| Protocol | Official docs |
|----------|--------------|
| Jupiter | https://dev.jup.ag/docs/llms.txt |
| Khalani | https://khalani.gitbook.io/khalani-docs |
| KyberSwap | https://docs.kyberswap.com/ |
| Polymarket | https://docs.polymarket.com/api-reference/introduction |
| DexScreener | https://docs.dexscreener.com/api/reference |
| Hyperliquid | https://hyperliquid.gitbook.io/hyperliquid-docs |

---

## Dependencies Shared Across Modules

| Dependency | Used by |
|-----------|---------|
| `viem` | Wallet, Khalani, KyberSwap, Polymarket (EVM reads/writes) |
| `@solana/web3.js` | Wallet, Jupiter, Khalani-Solana |
| `config/store.ts` | Every module (service URLs, contract addresses) |
| `utils/http.ts` | Every REST client |
| `utils/rateLimit.ts` | KyberSwap |
| `errors.ts` | Every module (VexError with domain-specific codes) |
