# Electron feasibility spike (2026-08-23, electron 42.0.0 / chrome 148, xvfb on WSL2)

Scripts: electron-spike/main.cjs, main2.cjs, main3.cjs (run from vex-app: `xvfb-run -a ./node_modules/.bin/electron --no-sandbox <script>`).

## main process `net.fetch` (Chromium network service)
| target | headers | result |
|---|---|---|
| https://dexscreener.com/robinhood (SSR HTML) | default Electron UA | 403 cf-mitigated=challenge |
| same | Chrome UA only | 403 cf-mitigated=challenge |
| same | Chrome UA + Accept/Accept-Language/Upgrade-Insecure-Requests/Sec-Fetch-*/sec-ch-ua* | 200, 1,452,597 bytes, 1320 ms, pairsCount parsed |
| https://io.dexscreener.com/dex/search/v12/pairs?q=SEMI | Chrome UA + Origin + Referer | 200, 75,137 bytes, 273 ms |
| https://io.dexscreener.com/dex/pair-details/v4/robinhood/0xe356... | Chrome UA + Origin + Referer | 200, 6,097 bytes, 150 ms |

Conclusion: all HTTP endpoints (SSR pages and io.dexscreener.com) are reachable from the Electron main process with plain `net.fetch` and a Chrome-like header set. No third-party TLS library needed. Node `fetch`/undici and Python/curl TLS are blocked (403) - measured separately.

## WebSocket (screener channel wss://io.dexscreener.com/dex/screener/v7/pairs/...)
- main process: no Chromium WebSocket API available (Node WS = blocked TLS fingerprint).
- hidden BrowserWindow, page from `data:` URL: ERROR, close 1006 (Origin "null").
- hidden BrowserWindow navigated to https://dexscreener.com/robinhood (real app page): loads in 943 ms, Cloudflare challenge-platform script loads and passes silently, own `new WebSocket(...)` from page context: OPEN, first pairs frame 91,410 bytes in 737 ms.
- hidden BrowserWindow in an isolated `session.fromPartition(...)`, sandbox+contextIsolation, images off, navigated to lighter same-origin documents:
  | page | load | requests | JS heap | own WS |
  |---|---|---|---|---|
  | https://dexscreener.com/app-util | 2862 ms | 43 | 29 MB | OPEN, 75,317 B in 652 ms |
  | https://dexscreener.com/troubleshooting | 4944 ms | 54 | 34 MB | OPEN, 75,122 B in 633 ms |
  | https://dexscreener.com/robots.txt | 3886 ms | 2 | 1 MB | OPEN, 75,122 B in 730 ms |
- main process RSS for the whole test app: 225 MB.

Conclusion: a hidden sandboxed "bridge" window on the dexscreener.com origin (robots.txt is enough) gives Chromium's WS stack with the right Origin; frames are shipped to main and decoded there (protobuf, schema from the bundle).

## main4.cjs: local bridge page, no remote document
- hidden BrowserWindow (isolated partition, sandbox, contextIsolation, no node) loading a local `data:text/html` document; `partition.webRequest.onBeforeSendHeaders` sets `Origin: https://dexscreener.com` only for `io.dexscreener.com` requests of that partition.
- result: WS OPEN, first pairs frame 106,442 bytes in 648 ms (chainIds=base, rankBy volume). Page load 738 ms.
- Conclusion: the bridge does not need to load anything from dexscreener.com. Chromium's TLS/H2 stack is what passes Cloudflare; the Origin header is the only thing the WS server checks that a local page lacks. This is the preferred production shape (no remote code in the hidden window).
