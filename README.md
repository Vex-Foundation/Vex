<div align="center">

# Vex

**Your keys. Your machine. Your agent.**

A self-custodial, autonomous on-chain crypto agent for the desktop. It holds
*your* keys locally and acts on-chain on your terms, not a custodian's.

[Website](https://www.projectvex.ai/) | [Studio docs](https://www.projectvex.ai/docs/studio) | [X / Twitter](https://x.com/ProjectVEXai) | [Releases](https://github.com/Vex-Foundation/Vex/releases)

</div>

---

## What it is

Vex is a desktop app that runs an autonomous crypto agent right next to your
wallet, and the wallet is *yours*. Keys are generated and stored on your own
machine, encrypted at rest, and never leave it. The agent can research markets
and take real on-chain actions (swaps, transfers, and more), but by default
every fund-moving move is gated behind an explicit human approval. No custodian
holds your assets. No server signs for you.

Think "a quant that lives on your laptop, asks before it spends, and can't run
off with the bag."

## Highlights

- **Self-custody, for real.** EVM + Solana keys created and kept locally. Signing authority never leaves the privileged process.
- **Approval-gated by default.** The agent proposes; you approve. State-changing actions don't execute just because a model asked.
- **Encrypted at rest.** Vault secured with AES-256-GCM + scrypt; the master password lives only in memory and is never written to disk.
- **Local memory.** Conversation, knowledge, and embeddings in a local Postgres + pgvector store. Your context stays on your box.
- **Hardened desktop.** Sandboxed renderer, strict CSP, locked IPC boundary between the UI and anything that touches keys.
- **Perpetuals on your terms.** Perpetual and spot trading on Lighter Core and Robinhood Chain. Leverage per market and the share of the account's capital the agent may commit are set by you in Settings; the agent only reads them, and Vex enforces the share before any order the agent prepares is signed.
- **Cross-platform.** macOS (Apple Silicon + Intel), Windows and Linux; macOS builds are notarized and Windows builds are Authenticode signed.

## Download

Grab the latest signed build from the [official site](https://www.projectvex.ai/)
or [GitHub Releases](https://github.com/Vex-Foundation/Vex/releases). macOS
builds are Developer ID signed and notarized. The app auto-updates from signed
releases.

## Official sources, read this

Crypto is a target-rich environment for impersonators. Our only official
channels are:

- Website: https://www.projectvex.ai/
- X / Twitter: https://x.com/ProjectVEXai
- Releases: https://github.com/Vex-Foundation/Vex/releases

We will never DM you first, never ask for your seed phrase or master password,
and never distribute Vex through any other link. Anything else is a scam.

## Status

Pre-1.0, shipping in public. Expect sharp edges. This repository is
source-available for transparency and independent security review, because
software that holds your keys should be something you can actually inspect.

## Security

Found something? Please report it responsibly. See [`SECURITY.md`](SECURITY.md)
(or email security@projectvex.ai) rather than opening a public issue.

## License

Vex is source-available, not open-source. You may read, audit, and run it for
personal self-custody; you may not redistribute it, use it commercially, or
ship a fork. See [`LICENSE`](LICENSE) for the exact terms.

---

> **Not financial advice.** Vex is a tool, not a promise. You control your keys
> and your funds, and you are responsible for every action you approve. On-chain
> transactions are irreversible. Agent output is directional and can be wrong.
> Never risk more than you can afford to lose.
