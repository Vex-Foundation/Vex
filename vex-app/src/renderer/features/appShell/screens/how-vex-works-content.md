This page walks the whole app top to bottom, in plain words. Take five minutes here before you move any real money.

## What is Vex

Vex is a desk worker who never sleeps. It sits on your computer, watches crypto markets, does research, and — when you allow it — trades with your own wallets.

Two things to hold onto:

- Vex is self-custodial. Your keys (the secret codes that control your crypto) are created on your machine and stay on your machine. No company holds them for you.
- Vex works with real money. On-chain actions are irreversible — once sent, they cannot be undone. By default, you approve every transaction before it happens.

Vex is preview software (pre-1.0, still evolving — you'll see the PREVIEW badge). Its market calls are directional research (educated reads on which way things might go), never certainty and never a promise of profit. Verify before moving funds.

## Self-custody in one minute

During setup, Vex creates your wallets locally and locks each one in an encrypted keystore (a scrambled file that is useless without a password). The vault (the storage for keys and API credentials) is a safe that only your master password opens. That password lives only in the app's memory while Vex is unlocked — never written to disk, never sent anywhere.

What actually leaves your computer? Exactly two kinds of traffic:

1. Calls to the AI model (the "brain" Vex rents over the internet, via OpenRouter). Text and tool descriptions go out; your keys never do. The model never signs anything.
2. Requests to blockchains and trading venues — price lookups, quotes, and the transactions you approve.

That is the whole list. Chat history, the database, wallet files, and Vex's memory all stay local.

Two honest warnings:

- Every restart re-locks the vault and shows the Unlock screen. Normal, not an error.
- "I forgot my password — set up a new vault" is not recovery. It starts fresh; funds tied to the old vault come back only from a backup or seed phrase you exported earlier. Back up early.

## How the platform runs

Everything important runs on your own computer:

- The agent engine — the part that thinks and calls tools.
- A Postgres database inside Docker (a filing cabinet program that keeps sessions, trades, and memories organized locally).
- A local embeddings model (a small helper that turns text into searchable fingerprints, so memory search works on-device).

To check on this local machinery, open the profile menu (the avatar in the bottom-left corner). Its status row says "Connected" when everything is healthy, next to the Docker and Postgres marks. Any other word there — "Connecting", "Degraded", "Unavailable", "Not ready" — means the machinery is still starting or needs attention. Only the two kinds of traffic above ever leave the machine.

## A tour of the desk

The app is three columns on one screen.

**Left rail — your sessions.** The "New session" button starts a fresh conversation. ALL / AGENT / MISSION tabs filter the list. Rows can be pinned or deleted (deletion is blocked while a mission runs or an approval waits — the app tells you why). A slim $VEX card shows the live token price. The footer avatar opens a menu: Personalize, Memory, Sessions, this very guide, Settings — and the runtime status row at the bottom.

**Center — the conversation.** With no session open you see the Vex mark with its PREVIEW badge, the message box right below, and quick-action chips like "Hunt trending memecoins" or "Scout Pendle yields". Chips only fill the message box; nothing sends until you press send. In a session, this column is the transcript: replies stream live, every tool call appears as a collapsible row with stamps like "Awaiting signature" or "Confirmed", and approval cards appear between the transcript and the composer.

**Right — the BOOK panel.** The instruments dashboard. Top to bottom with a session open: Position (what this session's wallets hold), Moves (real executed trades, each linking to a block explorer), Runtime & Cost (model in use, tokens, how full the conversation is), and Session details. With no session open, BOOK shows your whole Portfolio. Mission setup never lives here — that's the center column.

## Sessions and modes

A session is one conversation notebook. Creating one sets two choices, and both are locked forever once the session exists — to change them, open a new session. Together they form a simple 2x2 grid:

|  | Restricted | Full Autonomous |
| --- | --- | --- |
| **Agent** | Normal chat; every on-chain action pauses for your approval card. | Chat where fund-moving tools execute without asking per call. |
| **Mission** | Autonomous loop, but every trade still stops for your click. | Vex acts alone within the contract. Real money moves without a per-trade confirmation. |

**Session type.**

- **Agent** is a plain conversation. Vex may run several tools inside one turn, but the moment it answers in text, it stops and waits. It cannot keep working between your messages — "keep going" does nothing by itself.
- **Mission** is a contract you both sign that freezes while it runs. Setup is a chat where Vex fills a structured draft: goal, capital, wallets, chains, protocols, risk profile, success criteria, stop conditions. When complete, you review and accept the contract — the app fingerprints the exact terms, so a changed draft can never be accepted stale. Click Start and that run keeps the frozen contract even if you edit the mission later. During a run, your messages do not stop it; only real stop conditions do — goal reached, deadline, capital floor, max loss, no viable opportunity, or you pressing Stop.

**Access level.**

- **Restricted** (the default) is training wheels for the mechanics — and the protection itself is literal: every state-changing action pauses for your approval card. Nothing moves without your click.
- **Full Autonomous** (labelled "Full access" in the New session dialog, marked in caution amber) removes that per-trade stop. Within the session or mission scope, Vex executes without asking each time. Real money moves without a per-trade confirmation. Choose it only when you fully trust the mission contract and understand exactly what that session's wallets can reach.

You can also create a session with no wallets attached — a pure research chat where no funds are reachable at all.

## What Vex can do

Vex reaches real venues under their real names. Here is the map.

### ![Uniswap](/protocols/uniswap.png) Uniswap
One of the oldest token-swap exchanges on Ethereum-style chains. Vex quotes and executes swaps directly on-chain (V2/V3). It stays hidden until KyberSwap cannot route a swap (chain or token unsupported) — then Vex offers it to the agent as the backup venue, with its own fresh quote and its own approval. Example: "Swap 0.1 ETH for USDC" — if KyberSwap has no route, Uniswap catches it.

### ![KyberSwap](/protocols/kyberswap.svg) KyberSwap
An aggregator that shops roughly 19 EVM chains for the best swap price. Vex's primary swap venue: quotes, execution, and basic token-safety checks. Every attempt — pending, confirmed, or failed — is recorded in your activity with its transaction hash. Example: "Swap 250 USDC for ETH on Base" — Vex compares routes and takes the best one.

### ![Jupiter](/protocols/jupiter.jpg) Jupiter
The main swap router on Solana. Vex swaps Solana tokens, looks up prices, searches tokens, earns yield through Jupiter Lend, and can browse Jupiter Predict prediction markets. Example: "Put half my SOL into USDC."

### ![Pendle](/protocols/pendle.jpg) Pendle
A protocol that splits yield-bearing tokens into a principal part and a yield part, on about 11 chains. Vex trades PT and YT tokens, manages LP positions, and claims yield. Example: "Scout Pendle yields and show me the best fixed rates."

### ![DexScreener](/protocols/dexscreener.jpg) DexScreener
A market-data service — read-only, no funds move. Vex pulls pair and token analytics, trending tokens, and live price streams across many chains. Example: "What memecoins are trending in the last hour?"

### ![Khalani](/protocols/khalani.svg) Khalani
An intent bridge: you say what should move where, and Khalani works out the route across EVM chains and Solana. Example: "Bridge 500 USDC from Ethereum to Solana" — you never pick the route yourself.

### ![Virtuals](/logo/virtuals.svg) Virtuals
A launchpad for AI-agent tokens. Vex uses it read-only, to discover new agent-token launches. Example: "Any interesting new agent tokens on Virtuals this week?"

### Relay bridge
A keyless bridge (no wallet-specific signing quirks) used for certain cross-chain moves. Text-only entry — no bundled logo.

### X/Twitter research
Read-only research over public tweets, users, and searches — sentiment and news. Vex cannot post, DM, or act on your social accounts. Also text-only.

Across every venue: read-only calls run freely; anything that moves funds goes through the approval system below unless the session is Full Autonomous.

## Inside Vex's toolbox

Beyond the venues, Vex carries internal tools:

- **Wallet operations** — balances across 40+ chains, and a strict two-step send: "prepare" builds and previews the transaction with nothing signed; "confirm" broadcasts it. You always see what will happen before anything signs.
- **Chain reads** — on-chain lookups for research and portfolio visibility.
- **Web research** — general internet search for anything outside the built-in venues.
- **Memory tools** — proposing lessons and searching past ones (see "How Vex learns").
- **Mission tools** — filling in, checking, and running mission contracts.
- **Autonomy timers** — a mission can deliberately sleep and wake when a price or time condition hits, checked every couple of seconds in the background.
- **Portfolio ledger** — the record of what actually executed, feeding the Moves list in the BOOK panel.
- **Compaction** — when a long conversation nears the model's limit, Vex archives older messages and writes a summary so it can keep going. Nothing is deleted; old messages move to an archive and become searchable session memory. While this happens, fund-moving tools briefly grey out on purpose, so Vex cannot trade "blind."

And the part that makes it feel effortless: Vex finds its own tools. Through two internal helpers, discover_tools and execute_tool, Vex looks up the right tool in its own catalog, like finding the right drawer in a workshop. You describe intent — "bridge some USDC to Solana" — and Vex matches it to the right venue, chain, and exact call. You never memorize tool names or pick a protocol from a menu.

## Approvals — you sign every action

This section stays literal, because it protects your money.

In a Restricted session, every mutating on-chain action pauses the run and shows an approval card in the chat: the action, the amounts, the destination, and a safety verdict. The card is built by the engine from verified data — not from the model's raw words — so a confused or manipulated model cannot disguise what you are approving. Approving signs and executes. Rejecting means nothing happens.

Guards around the card:

- **Prequote.** Every swap or bridge requires a fresh, matching price quote first. No fresh quote, no trade — any error blocks the trade rather than trading anyway. The quote's safety verdict travels with the card so you see it before approving.
- **Two-step confirm.** High-risk approvals need two clicks: the first arms the button, the second (within 4 seconds) fires. Keyboard focus defaults to Reject.
- **Expiry.** An unanswered approval never waits forever. In a mission run it auto-rejects after roughly 5 minutes; other approvals also expire on a timer. Expired means rejected — nothing executes. A prepared wallet send expires after 10 minutes if unconfirmed.
- **The AWAITING badge.** An amber pin in the header counts pending approvals across all sessions, so an approval in a background session never hides from you.
- **Audit trail.** Every mutating attempt — success or failure — is permanently recorded.

In a Full Autonomous session these per-trade cards do not appear. Your safety decision was made when you chose that access level and accepted the contract. Treat that choice with the weight it deserves.

## How Vex learns

Vex keeps a memory — a notebook of lessons whose entries fade unless real trades prove them right.

Vex cannot write into it directly. It can only suggest a lesson, which passes through filters (secrets are refused outright, live prices and balances are refused, duplicates strengthen the existing lesson instead of piling up) and then an AI judge that scores the evidence. Only survivors become long-term memory, and every new lesson starts on probation — it must be confirmed a second time before Vex uses it automatically.

Lessons age. Unused ones fade over weeks; nothing is ever deleted — faded lessons are benched, still searchable, and can earn their way back. When a real trade closes, its outcome re-judges any lesson built on it: a "win" lesson that actually closed at a loss is suppressed immediately.

Most important: memory is advisory only. By the database's own design, a memory can inform what Vex thinks about, but it structurally cannot set a trade size, approve anything, or sign anything. The Memory screen (profile menu → Memory) lets you inspect all of it, read-only.

## Personalize

In the profile menu, Personalize is where you tell Vex about yourself: what to call you, what your work looks like, the tone you want (and a few style traits), how bold or careful its ideas should sound, and any standing instructions. These shape how Vex talks to you. They never loosen safety or approval rules — those are separate on purpose.

## Getting started checklist

1. Finish the setup wizard and write down your master password. Nobody can recover it for you.
2. Make a backup right away through the app's backup flow.
3. Open a New session: Agent type, Restricted, no wallets — a zero-risk research chat. Ask Vex about a token.
4. Attach a wallet holding a small amount and try a tiny swap. Read the approval card slowly: amount, destination, chain.
5. Try the two-step send: prepare, inspect the preview, then confirm.
6. When comfortable, create your first Mission — Restricted — and walk through the contract fields before accepting and starting.
7. Only after real experience, and only for a contract you fully trust, consider Full Autonomous.

## Tips and gotchas

- Session type, access level, and wallets are locked at creation. Wrong pick? Open a new session.
- In Agent sessions, a text reply from Vex ends its turn. Send the next instruction to continue.
- In a Mission run, chatting does not interrupt it. Use Stop or Pause; a pause lands at the next safe checkpoint, never mid-signing.
- If swap and send tools grey out mid-conversation, the context is nearly full and Vex must compact first. It resolves itself within a turn or two.
- Check the AWAITING badge when several sessions are open — an approval may be waiting where you aren't looking.
- Stop-losses, prequotes, and approval cards reduce risk; none of them guarantees profit. Self-custody means the wins and the losses are genuinely yours.
