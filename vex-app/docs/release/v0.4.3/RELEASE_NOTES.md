Release 023 · October 2026 · Current

# VEX v0.4.3

## Watch the market. *Pick the brain.*

0.4.3 is about keeping an eye on things and choosing who does the thinking.

Follow the tokens you care about and get told when they move. Read a market's technicals with a chart right in the chat. Pick a different model for each conversation. And plug in tools of your own from any MCP server.

Nothing here trades on its own. Alerts only tell you, and your own tools only read, each call behind a card.

This release covers the work merged after **0.4.2**.

**80 commits · Watchlist and price alerts · A model per chat · Technical analysis · Your own MCP tools · New database tables, added on first launch**

---

## 01 · Watchlist
### Follow a token by its ticker.

![The Watchlist page: followed tokens with price, 24 hour change and pool, an active alert waiting and a fired alert with its time and price](https://raw.githubusercontent.com/Vex-Foundation/Vex/a4a24b207300fc18d7408e8fac5a73fa7ba4e506/vex-app/docs/release/v0.4.3/0.4.3-watchlist.jpg)

**01 · Its own page.** **Watchlist** sits in the sidebar, right after Board. Follow up to 30 tokens on Base, Ethereum, Solana and the other chains VEX knows. Each row shows the price now, the 24 hour change and the pool the price came from.

**02 · Type the ticker, pick the token.** Choose a chain and type a ticker or a name. VEX lists what DexScreener knows on that chain, with each token's short address, price, 24 hour volume and number of pools. Arrow keys and Enter work. Pasting an address still works too.

![The token picker on Solana: typing BONK lists the real Bonk first, with $653k of 24 hour volume across 27 pools, and the copies below it at $2 to $39 in one pool each](https://raw.githubusercontent.com/Vex-Foundation/Vex/a4a24b207300fc18d7408e8fac5a73fa7ba4e506/vex-app/docs/release/v0.4.3/0.4.3-ticker-picker.jpg)

**03 · The real one first.** Many tokens share one ticker. The list puts the token that actually trades first, by 24 hour volume, because a liquidity figure is cheap to fake. Searching BONK on Solana, two copies claiming $50M and $23M of liquidity traded $2 that day. The real BONK, trading about $700k that day across many pools, comes first. The address is always on the row, so you can check.

**04 · Free and keyless.** Prices come from DexScreener's public data. No API key, and the watchlist keeps working while your vault is locked.

## 02 · Price alerts
### Told once, never traded.

**01 · Four kinds.** The price goes **above** a level, goes **below** a level, **rises by** a percentage or **falls by** a percentage from where it was when you set the alert. Add a note of up to 140 characters if you like.

**02 · From the page or from chat.** Use **Set alert** on a row, or just ask: "tell me when SOL is above 250". Both go through the same rules, so the limits and the answers are the same. Up to 20 alerts can wait at once.

**03 · It only tells you.** When an alert fires you get a notice in VEX with **Open watchlist**. If VEX is not the window in front, you also get a system notification, and clicking it brings VEX up on the Watchlist. An alert never buys or sells anything.

![A fired price alert in VEX: "Bonk on Solana rose 0.01%, at $0.000002999." with Open watchlist](https://raw.githubusercontent.com/Vex-Foundation/Vex/a4a24b207300fc18d7408e8fac5a73fa7ba4e506/vex-app/docs/release/v0.4.3/0.4.3-price-alert.jpg)

**04 · Locked screen, quiet notice.** While your vault is locked, the system notification says only "A price alert fired. Unlock Vex to see it.", so your tokens and levels don't show on a locked screen. Prefer no system notifications at all? Turn off **Price alert notifications** in Settings.

**05 · Honest timing.** Prices are checked every 30 seconds, from data that can itself be about 30 seconds old. A notice can come about a minute after the move. It is a heads-up, not a stop-loss.

**06 · While VEX runs.** Alerts are checked while VEX is open. On macOS they keep running with the window closed. On Windows and Linux, closing the window quits VEX, and checks resume at the next launch.

**07 · Fired stays put.** A fired alert moves to **Fired**, with the time and the price it fired at, until you clear it.

## 03 · A model per chat
### Pick the brain for this conversation.

![The composer's model menu open upward: a search field, the Default model first, models grouped by maker with context size and price per million tokens](https://raw.githubusercontent.com/Vex-Foundation/Vex/a4a24b207300fc18d7408e8fac5a73fa7ba4e506/vex-app/docs/release/v0.4.3/0.4.3-model-picker.jpg)

**01 · Right in the composer.** The model name in the composer is now a menu. Search it, then pick. Each model shows its context size and its price per million tokens, input and output. Your Settings model is marked **Default**.

**02 · It sticks to the chat.** The pick belongs to that conversation. Every later turn uses it, including ones nobody typed: wake-ups and resumes after an approval. Your other chats keep their own models, and new chats start on the default.

**03 · OpenRouter or Vex Inference.** The menu lists the models of the provider you use. Switch providers in Settings and a chat whose pick isn't offered there runs on your default model, and says so on the turn.

**04 · Missions keep their model.** Set a mission's model on its contract card. It is part of what you accept and is fixed when the mission starts, so changing your default later doesn't change a running mission. Changing a mission's model after accepting asks you to accept again. The agent can't change it.

**05 · Background work stays put.** Memory and summarising keep using your default model. A long chat moved to a smaller model is summarised first, and the menu warns you when a conversation is longer than a model holds.

## 04 · Technical analysis
### Read the chart, in the chat.

![A technical analysis card in the chat: ETH on Lighter, 4h candles with EMA 20 and EMA 50, the indicator values and the signals in words](https://raw.githubusercontent.com/Vex-Foundation/Vex/a4a24b207300fc18d7408e8fac5a73fa7ba4e506/vex-app/docs/release/v0.4.3/0.4.3-technical-analysis.jpg)

**01 · Ask for the technicals.** "4h technicals on ETH on Lighter", or on any DEX pool on an EVM chain or Solana. You get EMA 20, 50 and 200, RSI 14, MACD 12/26/9, Bollinger 20/2 and ATR 14, and what they say in plain words.

**02 · Closed candles only.** The candle still forming never moves a number. The answer names the candle it ended on.

**03 · A chart under the answer.** The card draws the candles with EMA 20 and EMA 50. Switch between 5m, 15m, 1h, 4h and 1d without asking the agent again.

**04 · Move around in it.** Scroll the chat over the chart and the chat scrolls. Swipe sideways, or hold Shift and scroll, to go back in time; older candles load as you go, all the way to the first one. Pinch to zoom.

**05 · Only a reading.** It is not a buy or sell signal, and the card says so.

## 05 · Your own MCP tools
### Plug in a server. Every call asks first.

![Settings · Tools (MCP): CoinGecko added by its address and connected with no token, its execute tool marked read-only by the server and on for chats, with Run without asking available, and DexPaprika connected below](https://raw.githubusercontent.com/Vex-Foundation/Vex/<SCREENSHOTS_COMMIT>/vex-app/docs/release/v0.4.3/0.4.3-mcp-coingecko.jpg)

**01 · Add a server.** Settings now has **Tools (MCP)**. Add an MCP server by its address, with a token if it needs one. VEX connects, lists its tools, and shows what each one takes. Up to 5 servers. Two market-data servers work with no token at all: CoinGecko at `https://mcp.api.coingecko.com/mcp` and DexPaprika at `https://mcp.dexpaprika.com/streamable-http`.

**02 · Off until you say.** Every tool starts off. Turn on the ones you want, up to 8 at a time.

**03 · Every call asks first.** When the agent wants to use one of your tools, an approval card shows the server, the tool and the exact arguments that will be sent. Nothing leaves until you approve.

![An approval card for a call to the user's own DexPaprika tool: "Call getTopTokens on your MCP server DexPaprika.", with the exact arguments it will send: the top 5 tokens on Base by 24 hour volume](https://raw.githubusercontent.com/Vex-Foundation/Vex/<SCREENSHOTS_COMMIT>/vex-app/docs/release/v0.4.3/0.4.3-mcp-dexpaprika.jpg)

**04 · Read only, by design.** Your tools can only read and return text. They can never prepare a swap, a transfer or any other action. If a server marks a tool as read-only, you may let it **Run without asking**, and only in Settings.

**05 · Where servers can live.** On the internet over HTTPS, or on this computer. Addresses on your local network are refused, and so is a name that points at one.

**06 · Changed tools switch off.** VEX checks your servers again every 6 hours. A tool whose inputs changed is turned off until you look at it again.

**07 · Kept to chats.** Your tools are offered in chats only, not in missions, and never to coding agents connected through Studio. A server token is kept in your vault.

## 06 · Before you update
### What to know.

**New database tables.** This release adds four tables, created on first launch: your MCP servers and their tools, and your watchlist and its alerts. Chats gain three columns for their own model. Nothing existing is changed or removed.

**Everything carries over.** Sessions, missions, memory, wallets, your provider and your settings. Every chat starts on your default model until you pick another.

## 07 · Squashed
### Little things, fixed.

### Composer

- A long model name no longer runs over "Reasoning" when the Stop agent key narrows the composer; it ends with an ellipsis.

### Studio

- The file explorer in the Studio rail starts a little taller, so it keeps its room now that the sidebar has one more page. A size you set by dragging is kept.

### Security

- Dependency updates clear published advisories: zod 4.6 and undici 7.30.1.
