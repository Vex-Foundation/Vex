# Third-party notices

Attribution for third-party work adapted into the Vex desktop app.
Bundled font licenses live alongside the font files in
`src/renderer/public/fonts/licenses/`. The full dependency license posture
is tracked in [`dependency-audit.md`](./dependency-audit.md).

## deepseek-harness

Parts of the renderer UI - component patterns, design-token architecture,
motion choreography, and the inline SVG icon glyph set under
`src/renderer/components/icons/` - are adapted from deepseek-harness
(https://github.com/deepseek-ai/deepseek-harness).

Copyright (c) 2026 DeepSeek

Licensed under the MIT License:

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Lightweight Charts

The board's market chart is rendered by TradingView Lightweight Charts
(https://github.com/tradingview/lightweight-charts), a runtime dependency of
this app (`lightweight-charts@5.2.1`).

Copyright 2023 TradingView, Inc. (the copyright line in the package's own
`LICENSE` appendix; the built bundle's banner, quoted below, says 2026).

Licensed under the Apache License, Version 2.0; the full text ships with the
package at `node_modules/lightweight-charts/LICENSE` and is available at
http://www.apache.org/licenses/LICENSE-2.0.

The license requires naming TradingView as the product creator and linking to
https://www.tradingview.com/ on a page available to users. Vex satisfies this
with a static attribution beside every board chart rather than the library's
own `attributionLogo` widget, which injects an outbound anchor through
`innerHTML` inside a privileged renderer. The link and the external-navigation
allow entry that makes it clickable are one declaration in
`src/shared/chart-attribution.ts`.

The published package carries no separate NOTICE file; its attribution banner,
verbatim from `dist/lightweight-charts.production.mjs` as installed, is:

```text
TradingView Lightweight Charts(TM) v5.2.1
Copyright (c) 2026 TradingView, Inc.
Licensed under Apache License 2.0 https://www.apache.org/licenses/LICENSE-2.0
```
