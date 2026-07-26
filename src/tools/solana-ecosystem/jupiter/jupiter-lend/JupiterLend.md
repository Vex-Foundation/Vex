# Jupiter Lend in `src/tools`

Local source-of-truth for the new Jupiter Lend shelf under `src/tools/solana-ecosystem/jupiter/jupiter-lend`.

## Verified From
- `https://dev.jup.ag/docs/llms.txt`
- `https://dev.jup.ag/docs/lend/index`
- `https://dev.jup.ag/docs/lend/architecture`
- `https://dev.jup.ag/docs/lend/api-vs-sdk`
- `https://dev.jup.ag/docs/lend/earn/index`
- `https://dev.jup.ag/docs/lend/program-addresses`
- `https://dev.jup.ag/api-reference/lend/earn`
- Verified on `2026-03-30`
- `https://developers.jup.ag/docs/lend/borrow/api` — Borrow REST
  (vaults/positions/operate), verified on `2026-07-24` (Agent Scan Phase 3
  Batch 5, card B1 — see `borrow-api/JupiterLendBorrowApi.md`).

## Current Scope
- Implemented now:
  - stable Jupiter Lend Earn REST endpoints under `earn-api/`
  - unsigned transaction requests for deposit, withdraw, mint, and redeem
  - raw instruction requests for the same four Earn operations
  - read endpoints for tokens, positions, and earnings
  - stable Jupiter Lend Borrow REST endpoints under `borrow-api/`: vaults,
    positions, and the full-lifecycle `/operate` (see
    `borrow-api/JupiterLendBorrowApi.md`)
- Explicitly deferred in this pass:
  - Borrow `/operate-instructions` (owner decision, B1 card)
  - Borrow SDK flows (`@jup-ag/lend`, `@jup-ag/lend-read`)
  - Flashloan SDK flows
  - Read SDK integrations (`@jup-ag/lend-read`)
  - Lend SDK integrations (`@jup-ag/lend`)
  - Liquidity analytics helpers
  - Oracle helpers
  - CPI helpers
  - advanced recipes that depend on `https://lite-api.jup.ag`

## Design Notes
- This shelf is Earn REST first and wire-first.
- Upstream responses stay intact. No legacy flattening from `src/tools/chains/*`.
- The new Jupiter shelf must not import `src/tools/chains/solana/*`.
- This pass intentionally does not add `@jup-ag/lend` or `@jup-ag/lend-read`.
- Legacy consumers are not rewired yet.

## Program Addresses
- Lending (Earn): `jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9`
- Liquidity: `jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC`
- Lending Rewards Rate Model: `jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar`
- Oracle: `jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc`
- Vaults (Borrow): `jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi`
- Flashloan: `jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS`

## Folder Layout
```text
src/tools/solana-ecosystem/jupiter/jupiter-lend/
├── index.ts
├── constants.ts
├── JupiterLend.md
├── earn-api/
│   ├── index.ts
│   ├── types.ts
│   ├── validation.ts
│   ├── client.ts
│   ├── service.ts
│   └── JupiterLendEarnApi.md
└── borrow-api/
    ├── index.ts
    ├── types.ts
    ├── validation.ts
    ├── client.ts
    ├── schemas.ts
    ├── service.ts
    └── JupiterLendBorrowApi.md
```

## Upstream Contract Notes
- `/lend/v1/earn/*` requires `x-api-key`.
- The public docs currently show two response ambiguities:
  - `/earn/earnings` is documented once as an array and once as a single object.
  - `*-instructions` endpoints are documented once as a single Solana instruction and once as an `instructions[]` envelope.
- The local client keeps both shapes in the types and the service normalizes them without discarding the raw response.
