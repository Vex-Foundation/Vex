This page is the whole app in plain words. The first three sections take about five minutes and are the ones to read before you move any real money; everything after them is reference you can come back to.

**Before you start.** You will need: Docker Desktop installed and running (Vex keeps its database inside it, and if it is missing the app will not finish starting); an OpenRouter account with credit and an API key (the AI model is rented per message and **you** pay that bill, not Vex); your master password written down somewhere safe; and, once you attach a wallet, a little of each chain's own coin - ETH on Ethereum and Base, SOL on Solana - to pay network fees. Reading this page costs nothing. A session with no wallets attached costs nothing but model tokens.

## Your first hour

A ladder. Each rung is safe on its own, and each one teaches you the rung above it.

1. **Finish the setup wizard and write down your master password.** Nobody can recover it for you - not Vex, not us.
2. **Save the backup.** Vex writes one automatically when it creates a wallet and tells you where. Move it somewhere safe now, and keep it in a different place from your password. See "Your keys and your backup".
3. **Open a New session: Agent type, Restricted, no wallets.** Zero risk - no funds are reachable at all. Ask Vex about a token. Cost: model tokens only, a few cents.
4. **Attach a wallet holding a small amount, plus gas.** A wallet holding only USDC cannot trade; it needs the chain's native coin too.
5. **Try a tiny swap.** Read the approval card slowly: the amount, the destination, the chain, the Vex fee. Cost: gas + 0.25%.
6. **Try the two-step send:** prepare, inspect the preview, then confirm.
7. **When comfortable, create your first Mission - Restricted** - and walk through every contract field before you accept and start.
8. **Only after real experience, and only for a contract you fully trust,** consider Full Autonomous.

Everything below explains why each rung is safe.

## What is Vex

Vex is a desk worker who never sleeps. It sits on your computer, watches crypto markets, does research, and - when you allow it - trades with your own wallets.

Two things to hold onto:

- Vex is self-custodial. Your keys (the secret codes that control your crypto) are created on your machine and stay on your machine. No company holds them for you.
- Vex works with real money. On-chain actions - anything written to a blockchain, as opposed to a screen in an app - are irreversible. Once sent, they cannot be undone. By default you approve every transaction before it happens; the one exception is launching your own token, where the launch form you fill in yourself *is* the approval.

**What Vex is not.** It is not a custodian and not an exchange account. There is no support desk that can reverse a trade, no deposit insurance, and no password reset. If you send funds to the wrong place, they are gone.

Vex is preview software (pre-1.0, still evolving - you'll see the PREVIEW badge under the mark). Its market calls are directional research (educated reads on which way things might go), never certainty and never a promise of profit. Verify before moving funds.

## What this costs you

Three separate costs, and they are genuinely separate. None of them is refundable.

| What | Who pays | How much | Where you see it |
| --- | --- | --- | --- |
| The AI model | You, on your own OpenRouter key | Per message; a chat is cents, a long mission is more | BOOK panel → Runtime & Cost, as a live dollar figure |
| Network gas | You, in the chain's own coin | Varies by chain and by how busy it is | On the approval card, before you sign |
| The Vex fee | You | 0.25% (25 basis points) of what you spend | Itemised on the approval card, and on every Agent Scan row |

**"Tokens" on the Runtime & Cost card are not crypto tokens.** They are the model's unit of text - roughly, words in and words out. That card is your AI bill, in dollars, on your own key.

**The Vex fee, stated plainly.** Vex charges 0.25% on the operations it executes for you: token swaps on any chain (whichever venue it routed through), cross-chain bridges, and Trench Express launches and trades. **Pendle trades carry no Vex fee.** Three rules govern it:

- It is taken on the **input** - the asset you spend, not the one you receive. (The one exception: selling a Trench token, where the fee comes off the ETH you receive.)
- It is charged **only after the operation succeeds**. A failed, reverted, or never-broadcast attempt is never charged. At very small sizes it rounds to zero and no fee is taken at all.
- It is **Vex's own fee**, separate from network gas, from the venue's own protocol fee, and from bridge relayer costs.

The fee goes to the Vex treasury, which the project uses to buy back and burn $VEX - which is why that token's price sits in a small card in your left rail. You do not need to hold $VEX to use Vex, and Vex will never ask you to.

Read-only actions cost nothing beyond model tokens: quotes, previews, balance reads, research, and every search Vex runs are free. You can always ask Vex "what did that cost?" - every executed move records the exact fee.

## Your keys and your backup

During setup, Vex creates your wallets locally and locks each one in an encrypted keystore (a scrambled file that is useless without a password). The vault (the storage for keys and API credentials) is a safe that only your master password opens. That password lives only in the app's memory while Vex is unlocked - never written to disk, never sent anywhere.

You will be asked for it again after every restart. That is not an error: it is the previous sentence being true.

**The backup, which is the part that matters.** When Vex creates or imports a wallet it also writes a backup archive automatically, and the wallet panel tells you where, with an "Open backup folder" button. The archive holds your encrypted keystores, the vault, and your configuration - everything needed to rebuild this machine somewhere else. You can find it again later under **Settings → Wallets**, which also has "Export all wallets" (writes the key files to a folder you choose) and "Restore from backup".

Three rules:

- **A restore needs both the archive and the master password that sealed it.** If you restore from an older archive, Vex unlocks with *that* archive's password afterwards, and it will tell you so.
- **Store the archive and the password apart.** Together in one place, they are a single point of total loss.
- **"I forgot my password - set up a new vault" is not recovery.** It starts fresh. Funds tied to the old vault come back only from an archive or an exported key you still have.

## What actually leaves your computer

- **Calls to the AI model**, through OpenRouter. Text and tool descriptions go out; your keys never do, and the model never signs anything.
- **Requests to blockchains, trading venues and market-data providers** - price lookups, quotes, token images, web research, and the transactions you approve.
- **The $VEX price ticker**, which keeps polling market APIs in the background so the sidebar card stays live, whether or not Vex is working.
- **A version check** against Vex's release server when the app starts, when its window comes back into focus, and every few minutes while it runs. Updates never download or install by themselves.
- **Downloads during setup** - Docker's installer and the container images for the database and the local embeddings model.
- **Crash reports**, and only if you switch them on. They are off by default, carry no personal data, and are stripped before sending.

Your keys, your chat history, the database, your wallet files and Vex's memory never leave.

## How the platform runs

Everything important runs on your own computer:

- The agent engine - the part that thinks and calls tools.
- A Postgres database inside Docker (a filing cabinet program that keeps sessions, trades, and memories organized locally). **Docker is a real requirement**, not scenery: it must be installed and running.
- A local embeddings model (a small helper that turns text into searchable fingerprints, so memory search works on-device).

Because all of it is local, Vex only works while the app is open. Close it, or let the machine sleep, and a running mission stops making progress until you come back.

To check on this machinery, open the profile menu (the avatar in the bottom-left corner). Its status row says "Connected" when everything is healthy. Any other word - "Connecting", "Degraded", "Unavailable", "Not ready" - means it is still starting or needs attention; see "When something looks wrong".

## Who can move your money, and when

This section stays literal, because it protects your money.

Every session is created with an access level, and it is locked for that session's whole life:

- **Restricted** (the default) - every state-changing action stops and asks you. Nothing moves without your click.
- **Full Autonomous** (labelled "Full access" in the New session dialog, marked in caution amber) - within that session's scope, Vex executes without asking each time. Real money moves without a per-trade confirmation.

### The approval card

In a Restricted session, a fund-moving action pauses the run and shows a card in the chat: the action, the amounts, the destination, the chain, the Vex fee, and a safety verdict.

The card shows exactly the action that will run - the same arguments that get signed, filtered through a fixed list of fields - so it cannot show you one thing and sign another. The safety verdict on it comes from Vex's own stored price-and-safety check, never from anything the model wrote, so a confused or manipulated model cannot disguise what you are approving. If the tool itself changed while the card was waiting (across an app update, say), approving fails safely instead of signing something else.

Approving signs and executes. Rejecting means nothing happens, and you can attach a note saying why.

### The guards around it

- **The price-and-safety check.** Every swap, bridge or Pendle trade must be backed by a matching check taken in the last 15 minutes, from the same venue it will execute on. Missing, stale, mismatched or errored - the trade is blocked rather than sent. This one applies **even in a Full Autonomous session**. "Unverified" is an honest answer it is allowed to give, and a confirmed scam verdict can never be overridden later.
- **Slippage** - the worst price Vex will accept before it walks away, and on a normal trade it is the only thing bounding your loss to the market. Vex uses 1% unless it decides a trade needs more, and it can never go above 10%: a request beyond that is refused by name, never quietly trimmed. You will see the number on the card.
- **Two-step confirm.** High-risk decisions need two clicks: the first arms the button, the second (within 4 seconds) fires. It guards Reject as well as Approve, switching buttons disarms it, and keyboard focus starts on Reject.
- **Expiry.** An unanswered approval auto-rejects after **one hour** - missions and ordinary chats alike. Expired means rejected; nothing executes. The exception is a prepared wallet send, which expires after 10 minutes and takes its approval card with it.
- **The two-step send.** Moving funds out of a wallet is always "prepare" then "confirm": prepare builds and previews the transaction with nothing signed, confirm broadcasts it. This shape survives in Full Autonomous too.
- **The AWAITING badge.** An amber pin in the header counts pending approvals across all sessions. It hides itself while loading or errored, so no badge is not proof that nothing is waiting.
- **The audit trail.** Every fund-moving attempt - success or failure - is recorded permanently, and you read it on the **Agent Scan** screen (profile menu, or "View all activity" on the Activity card).

Approvals survive an app restart and reappear in the AWAITING list. If you stop a run, its pending approval is auto-rejected and can never be approved later.

### In a Full Autonomous session

The per-action cards do not appear at all - including for transfers out of your wallet, which Vex can send on its own. What still applies: the price-and-safety check, the slippage cap, the two-step send shape, the audit trail, and Stop.

### How to stop

**Use Stop.** The send key turns into a Stop key whenever Vex can still be stopped - mid-answer, asleep on a timer, waiting on your approval, or holding a form open. Pressing it always takes: the stop is written down first, under a lock, and applied at the next safe point, so it can never land in the middle of a signature; the model call still in flight is cancelled right after.

### The worst case, plainly

Vex can lose your money, and here is how. A token you swap into can go to zero, and no guard prevents that. A fill can come in worse than the quote, up to your slippage tolerance. A swap into a scam token is unrecoverable once signed. An autonomous run can spend everything you allocated to it. Stop-losses, price checks and approval cards reduce risk; none of them guarantees profit. Self-custody means the wins and the losses are genuinely yours.

## Sessions and modes

A session is one conversation notebook. Creating one sets its type and its access level, and both are locked forever once the session exists - to change them, open a new session. Together they form a 2x2 grid:

|  | Restricted | Full Autonomous |
| --- | --- | --- |
| **Agent** | Normal chat; every fund-moving action pauses for your approval card. | Chat where fund-moving tools execute without asking. **No contract bounds this** - see below. |
| **Mission** | Autonomous loop, but every trade still stops for your click. | Vex acts alone within the accepted contract. Real money moves without a per-trade confirmation. |

**Agent** is a plain conversation. Vex may run several tools inside one turn, but the moment it answers in text it stops and waits - "keep going" does nothing by itself. One exception matters: a **Full Autonomous** agent session can park itself on a timer and pick the work back up without you typing, and it resumes on its own after you answer an approval or submit a form it opened.

**Full Autonomous Agent sessions have no contract.** There is no goal, no capital allocation, no stop conditions - nothing but the wallets you attached to that session. Those wallets, and everything in them, are the entire bound. That cell of the grid is the least constrained thing in the product; do not read the mission cell's safety envelope into it.

**Mission** is a contract you both sign, and it freezes while it runs. Setup is a chat where Vex fills a structured draft:

- title and goal;
- the capital source and starting capital;
- which wallets it may use;
- which chains;
- which protocols;
- the risk profile;
- success criteria;
- stop conditions.

When the draft is complete you review and accept it. The app takes a fingerprint of the exact terms, so if the draft changes after you read it your acceptance no longer counts - you re-read and re-accept. Click Start and that run keeps the frozen contract even if you edit the mission later. Starting is always your click; Vex has no tool that starts a run.

During a run your messages do not stop it - they are queued and read at the next safe point. Only real stop conditions end it: goal reached, deadline, capital floor, max loss, no viable opportunity, an emergency stop, or you pressing Stop. One exception: if the run is asleep on a timer, your message wakes it early and becomes its next turn.

**You can also create a session with no wallets attached - a pure research chat where no funds are reachable at all.** For a first session, or for any question you just want answered, this is the right choice.

## A tour of the desk

Three columns on one screen. Both side columns fold away to a thin strip when you want more room, and the right one folds itself on a small window.

**Left rail - your sessions.** "New session" starts a fresh conversation. ALL / AGENT / MISSION tabs filter the list, and a magnifier filters it by title. Rows can be pinned or deleted (deletion is blocked while a mission runs or an approval waits - the app says which). A slim $VEX card shows the live token price. The footer avatar opens a menu: Personalize, Memory, Sessions, Agent Scan, How Vex works (this page), Settings - and the runtime status row at the bottom.

**Center - the conversation.** With no session open you see the Vex mark with its PREVIEW badge, the message box below it, and three quick-action chips: "Hunt trending memecoins", "Scout Pendle yields", "Explore Trench launchpad". A chip only fills the message box and vanishes while you type; nothing sends until you press send. In a session this column is the transcript: replies stream live, every tool call is a collapsible row, and approval cards appear between the transcript and the message box.

**Right - the BOOK panel.** The instruments dashboard. With a session open it stacks: Position, Wallets, Balances, Activity, Runtime & Cost, Session, and Trench Express. Drag any card by its handle - or focus the handle and press Up or Down - to reorder them; the app remembers your order. With no session open, BOOK shows your whole Portfolio.

### What the states on screen mean

| You see | It means |
| --- | --- |
| **vexing…** with a particle cloud and a timer | Vex is working. It steps aside the moment words start arriving. |
| **Thinking** | The model is reasoning before it speaks. |
| **Awaiting signature** | Something is waiting for your approval. Click the stamp to jump to the card. |
| **AWAITING** (amber pin, header) | How many approvals are pending across *all* sessions. |
| **PREVIEW** (under the mark) | Pre-1.0 software, with its version number. |
| **Quote / Requested** | A price was taken, or a trade was sent. Nothing is settled yet. |
| **PENDING** (amber) | Broadcast, not yet seen to land. Normal. Rows re-check themselves - about every 5 seconds for the first ten minutes, then every 30. |
| **in mempool** | The healthy pending answer: a node has your transaction and it is waiting to be included. |
| **verification stalled** | Repeated checks could not confirm it yet. Still pending - nothing has failed. |
| **tracking delayed** | The checks themselves have fallen behind. Says nothing about the transaction. |
| **appears superseded** / **superseded** | Another transaction from this wallet reused this one's slot. Vex has stopped tracking it and **the outcome is unproven** - that is not the same as failed, and it does not mean retrying is safe. Shown in grey on purpose, never red. |
| **CONFIRMED** | Settled and seen on-chain. |
| **FAILED** | The attempt failed. Amounts are deliberately not shown, because they did not happen. |
| **in flight - no token address yet** (My Launches) | Your launch was broadcast and no token address is proven yet. Vex will not invent one. |

## What Vex can do

Vex reaches real venues under their real names. Read-only calls run freely; anything that moves funds goes through the approval system above unless the session is Full Autonomous.

### Chains at a glance

| Where | What Vex can do there |
| --- | --- |
| Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Avalanche, Linea, Mantle, Sonic, Berachain, Ronin, Unichain, HyperEVM, Plasma, Etherlink, Monad, MegaETH, Robinhood Chain | Swap, via KyberSwap (19 chains) |
| Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Robinhood Chain | Swap directly on Uniswap, as the backup route (7 chains) |
| Ethereum, Optimism, BSC, Base, Arbitrum, Mantle, Sonic, HyperEVM, Berachain, Monad, Plasma | Pendle yield trading (11 chains) |
| Solana | Swap, lend, borrow, prediction markets, via Jupiter |
| Robinhood Chain | Trench Express launches and curve trading |
| More than forty chains, list fetched live from the bridge's own registry | See balances; bridge between them |

### ![Uniswap](/protocols/uniswap.png) Uniswap
One of the oldest token-swap exchanges on Ethereum-style ("EVM") chains. Vex quotes and executes swaps directly on-chain, on Uniswap V2 and V3. It stays hidden from the agent until a KyberSwap attempt fails for a routing reason - no route, an unknown token, a refused build, or the swap itself reverting - and only then is it offered as the backup, with its own fresh quote and its own approval. Example: "Swap 0.1 ETH for USDC" - if KyberSwap has no route, Uniswap catches it.

### ![KyberSwap](/protocols/kyberswap.svg) KyberSwap
An aggregator: it shops 19 EVM chains for the best swap price. This is Vex's primary swap venue - quotes, execution, and basic token-safety checks. Every attempt, pending or confirmed or failed, is recorded with its transaction hash (the receipt id you can look up on a block explorer). Example: "Swap 250 USDC for ETH on Base."

### ![Jupiter](/protocols/jupiter.jpg) Jupiter
The main swap router on Solana. Vex swaps Solana tokens, looks up prices, searches tokens, deposits into and withdraws from Jupiter Lend - it can even borrow against a position - and it can both browse **and trade** Jupiter Predict prediction markets, buying, selling, claiming and closing. Everything except the reads moves real money and goes through approval. Example: "Put half my SOL into USDC."

### ![Pendle](/protocols/pendle.jpg) Pendle
A protocol that splits a yield-bearing token into two: a principal part (**PT**, the principal token) and a yield part (**YT**, the yield token). Vex trades PT and YT, manages LP positions ("liquidity provider" - supplying both sides of a pool and earning from its trades), and claims yield, on 11 chains. Pendle positions can be term-locked; when they are, the approval card says so and names the date. **Pendle is the one venue with no Vex fee.** Example: "Scout Pendle yields and show me the best fixed rates."

### ![DexScreener](/protocols/dexscreener.jpg) DexScreener
A market-data service - read-only, no funds move. Vex pulls pair and token analytics, trending tokens, and current prices across many chains, fetched fresh each time it looks. Example: "What memecoins are trending in the last hour?"

### ![Khalani](/protocols/khalani.svg) Khalani
An intent bridge: you say what should move where, and Khalani works out the route across EVM chains and Solana. Example: "Bridge 500 USDC from Ethereum to Solana" - you never pick the route yourself.

### ![Virtuals](/logo/virtuals.svg) Virtuals
A launchpad (a site where new tokens are first offered) for AI-agent tokens. Vex uses it read-only, to discover new launches. Example: "Any interesting new agent tokens on Virtuals this week?"

### ![Trench Express](/protocols/trench.jpg) Trench Express
A bonding-curve launchpad on Robinhood Chain, where a token's price is set by a formula that moves as people buy and sell. Vex can browse and search new tokens, read their trade tape, buy and sell them on the curve, and launch a token of your own. All three spend real money. On curve trades two separate fees apply: the launchpad's own 1% curve fee (charged by Trench itself, like any venue's protocol fee) and Vex's 0.25% on the ETH side - the quote you approve shows both.

- **Launching** goes: you (or Vex) open the launch form → a preview card shows the exact amount, the Vex fee and the estimated gas → you deploy. **The form is the approval** - there is no second card afterwards, so read it before you submit.
- The picture is stored inside the launch transaction, so its size is gas you pay. Vex optimizes and square-crops every image you add to the **Trench Photos** locker (the Trench Express card in the BOOK panel, which is also where "Launch a token" lives) and tells you the resulting size.
- **My Launches**, inside the launch dialog, lists what you have launched. A launch that has been broadcast but not yet confirmed says "in flight - no token address yet" rather than pretending a token exists.
- Trades on the curve go through the ordinary approval card and the ordinary price check. On a sell, if Vex cannot decode what you actually received, it takes **no fee at all** rather than charging a percentage of a guess.

### ![Relay](/protocols/relay.png) Relay bridge
A bridge that needs no account or key of its own - that is all "keyless" means here. It still moves your money with your wallet's signature, and it still asks for your approval. Used for certain cross-chain moves.

### X/Twitter research
Read-only research over public tweets, users, and searches - sentiment and news. Vex cannot post, DM, or act on your social accounts. Text-only entry - no bundled logo.

## Inside Vex's toolbox

**What Vex can reach.**

- **Wallet operations** - balances on every chain Vex can reach (more than forty today, from the bridge's own live registry, plus local chains like Robinhood Chain), and the two-step send described under approvals.
- **Chain reads** - on-chain lookups for research and portfolio visibility.
- **Web research** - general internet search for anything outside the built-in venues.

**What runs by itself.**

- **Autonomy timers** - Vex can deliberately sleep and wake when a price or time condition hits, checked every couple of seconds in the background. This works in missions and in Full Autonomous agent sessions alike. It only runs while the app is open.
- **Mission tools** - filling in the mission draft, and stopping a run when a stop condition is met. Starting a run is always your click, never Vex's.

**What keeps the record and the conversation.**

- **The activity record** - the log of what actually executed. It feeds the Activity card in the BOOK panel and the Agent Scan screen, which always agree because they read the same source. History from before this record existed no longer appears there.
- **Memory tools** - proposing lessons and searching past ones (see "How Vex learns"), plus a separate search over this conversation's own archived messages once a long chat has been compacted.
- **Compaction** - when a conversation nears the model's limit, Vex archives older messages and writes a summary so it can keep going. Nothing is deleted; old messages move to an archive and become searchable session memory. Near the limit Vex also stops itself from making fund-moving calls until a compaction has happened, so it cannot trade "blind" - quotes and previews still work throughout, and while a summary is being prepared its full tool set comes back. If a summary is ready early you may see an Apply button.

And the part that makes it feel effortless: **Vex finds its own tools.** It searches its own catalog, pulls the full instructions for the ones it picked, and from then on calls them by name like any other tool. You describe intent - "bridge some USDC to Solana" - and Vex works out the venue, the chain and the exact call. You never memorize tool names or pick a protocol from a menu.

## How Vex learns

Vex keeps a memory - a notebook of lessons. **You do not have to do anything here**; it maintains itself.

Vex cannot write into it directly. It can only suggest a lesson, which passes through filters (secrets are refused outright, live prices and balances are refused, duplicates strengthen the existing lesson instead of piling up) and then an AI judge that scores the evidence - so yes, a proposed lesson is text that goes to the model, like everything else in a conversation. Only survivors become long-term memory. Every new lesson starts on probation: Vex can still draw on it, but it carries less weight than a confirmed one until a second, independent confirmation matures it.

Lessons age. Unused ones fade over weeks; nothing is ever deleted - faded lessons are benched, still searchable, and can earn their way back.

One honest limitation: lessons drawn from trades are **not** re-scored against how those trades actually turned out. That automatic correction was removed and is being rebuilt. Treat a trade-derived lesson as Vex's read at the time, not a verified outcome.

Most important: memory is advisory only. A memory only ever reaches Vex as text it reads while thinking. Sizing, approval and signing run on separate paths that never read the memory store - so a lesson can shape what Vex considers, but it cannot size a trade, approve one, or sign anything. The Memory screen (profile menu → Memory) lets you inspect all of it, read-only.

## Personalize

In the profile menu, Personalize is where you tell Vex about yourself: what to call you, what your work looks like, the tone you want (and a few style traits), how bold or careful its ideas should sound, and any standing instructions. These shape how Vex talks to you. They never loosen safety or approval rules - those are separate on purpose.

## Common questions

### How much money do I need to start?
Nothing for a research session with no wallets. For a first real trade: enough of the chain's native coin to pay gas, plus whatever you are actually swapping. Start with an amount you would not mind losing entirely.

### Why did I receive less than the quote said?
Three things, in this order: network gas, the 0.25% Vex fee, and slippage - the market moving between the quote and the moment your transaction landed. All three are visible before you sign: gas and the fee on the approval card, slippage as the tolerance number on the same card.

### Does Vex trade while my computer is off?
No. Everything runs locally, so a mission only progresses while the app is open and the machine is awake. Come back and it picks up where it stopped.

### Can I undo a trade?
No. Before signing, Reject costs nothing. After broadcast there is nothing to undo - that is what "irreversible" means. What you *can* do is Stop, which prevents the next action.

### What happens if I walk away from a pending approval?
It auto-rejects after one hour and nothing executes. A prepared wallet send expires sooner, after 10 minutes. In a mission, the run resumes from the rejection and decides what to do next under its own contract.

### What if Vex says something wrong?
It can. Trust the approval card, not the chat text: the card carries the arguments that will actually be signed, and its safety verdict comes from Vex's own check rather than the model. For anything already executed, open Agent Scan and follow the explorer link - a block explorer is a public website that shows the chain's own record, and it is the one source neither Vex nor the model can influence.

### Why is there a $VEX price in my sidebar?
Because the 0.25% fee you pay funds the treasury that buys back and burns that token. You are not required to hold it and Vex will never route you into it.

### Do I need my own AI subscription?
Yes - an OpenRouter key with credit on it. That bill is yours, and the BOOK panel's Runtime & Cost card shows it accruing in dollars.

## When something looks wrong

### The status row isn't "Connected"
Check that Docker Desktop is running, then give it a minute - "Connecting" and "Not ready" are usually the local database still starting. If it stays "Unavailable" or "Degraded", restart the app; the database and its data are on your disk and survive that.

### A transaction has been PENDING for a long time
That is often normal - a busy chain can take a while. The row keeps re-checking itself and will tell you what it knows: "in mempool" means a node has it, "verification stalled" means the checks have not concluded and nothing has failed. If it ends up marked "superseded", another transaction from the same wallet used its slot: Vex stopped tracking it and the outcome is unproven. Look it up on the explorer before assuming anything, and do not retry blind.

### Vex says it can't execute because the conversation is nearly full
It is compacting first, on purpose, so it does not act on a half-remembered conversation. It resolves itself within a turn or two and you need do nothing.

### A swap failed and the message mentioned slippage
The price moved more than the tolerance allowed, so Vex walked away instead of taking a worse fill. Usually this costs nothing - the refusal happens before signing. Ask for the trade again with more tolerance if you accept the worse price; Vex will never go above 10%.

### A mission stopped early
Look at the stop reason: goal reached, deadline, capital floor, max loss, no viable opportunity, emergency stop, or your own Stop. The contract is frozen per run, so to change the terms you edit the mission and start a new run.

### I closed the app during a mission
Nothing was lost and nothing kept running. Reopen, unlock, and the session is where you left it; pending approvals reappear in the AWAITING list.

### I forgot my master password
There is no reset. Restore from a backup archive whose password you still have. If you have neither, the funds in those wallets are not recoverable by any means.

## Words you'll see

| Word | What it means here |
| --- | --- |
| on-chain | Written to a blockchain, as opposed to shown in an app. Irreversible. |
| gas | The fee a chain charges to process your transaction, paid in that chain's own coin. |
| native token | That coin - ETH on Ethereum and Base, SOL on Solana. You need some to do anything. |
| slippage | How much worse than quoted a fill may be before Vex refuses it. Default 1%, hard cap 10%. |
| basis points (bps) | Hundredths of a percent. 25 bps = 0.25%. |
| quote | A priced route with a short shelf life. Vex requires one no older than 15 minutes to execute. |
| EVM | "Ethereum-style" chains that speak the same language as Ethereum - Base, Arbitrum, Polygon and the rest. |
| PT / YT | Pendle's principal token and yield token - the two halves of a split yield-bearing asset. |
| LP position | Liquidity provider: supplying both sides of a pool and earning a share of its trading. |
| bonding curve | A formula that sets a new token's price directly from how much has been bought. |
| launchpad | A venue where new tokens are first offered. |
| block explorer | A public website showing the chain's own record. The way to check Vex independently. |
| transaction hash | A transaction's unique id - what you paste into an explorer. |
| tokens (model) | Units of text the AI reads and writes. Not crypto tokens. |
| self-custody | You hold the keys. No company can help you, and none can take it from you either. |

## Tips and gotchas

- Session type, access level, and wallets are locked at creation. Wrong pick? Open a new session.
- In Agent sessions, a text reply ends Vex's turn. Send the next instruction to continue.
- Check the AWAITING badge when several sessions are open - an approval may be waiting where you aren't looking.
- The most useful sentence you can type is "what did that cost me?" - Vex can answer it exactly, from the record.
- Stop-losses, price checks, and approval cards reduce risk; none of them guarantees profit. Self-custody means the wins and the losses are genuinely yours.
