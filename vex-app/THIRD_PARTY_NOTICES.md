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

## go-winio

The Windows named pipe that serves the Vex Studio MCP host is created by
go-winio (https://github.com/Microsoft/go-winio), a Go dependency of the
packaged `vex-pipe-front` binary (`github.com/Microsoft/go-winio@v0.6.2`).
It is linked into the WINDOWS build of that one binary only; the `vex-mcp`
bridge that ships to end users links no third-party package at all, and
`bridge/cmd/vex-pipe-front/imports_test.go` is the gate that keeps both
statements true per target.

Copyright (c) 2015 Microsoft

Licensed under the MIT License; the full text ships with the package at
`LICENSE` in the module:

```text
The MIT License (MIT)

Copyright (c) 2015 Microsoft

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

## golang.org/x/sys

go-winio's pipe, security-descriptor and SID code is written against
golang.org/x/sys/windows, so that package is linked into the Windows
`vex-pipe-front` binary as a transitive dependency
(`golang.org/x/sys@v0.10.0`, the version go-winio v0.6.2 requires). The front
also calls it directly for the descriptor readback that `BOUND` reports.

Copyright (c) 2009 The Go Authors. All rights reserved.

Licensed under the 3-clause BSD license; the full text ships with the package
at `LICENSE` in the module:

```text
Copyright (c) 2009 The Go Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google Inc. nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
