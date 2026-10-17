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

## The native runtime

Vex packages its own database and embeddings server: a PostgreSQL tree with
pgvector (`Resources/postgres/` on macOS, `resources/postgres/` elsewhere) and a
llama.cpp `llama-server` tree (`.../llama/`). Both are built by this repository
from the pinned sources in `native-runtime/sources.env` and packaged
byte-for-byte from the release that `native-runtime.lock.json` pins. The trees
carry their own license files, at the paths named below; the notices they do
not carry ship in `licenses/` beside them (`resources/licenses/` in this
repository).

### PostgreSQL

PostgreSQL 18.6 (https://www.postgresql.org/): the server and the `initdb`,
`pg_ctl`, `pg_controldata`, `pg_dump` and `pg_restore` programs, `libpq`, the
server modules and the `share/postgresql` data. Licensed under the PostgreSQL
License; the full text ships at `postgres/share/licenses/postgresql/COPYRIGHT`:

```text
PostgreSQL Database Management System
(also known as Postgres, formerly known as Postgres95)

Portions Copyright (c) 1996-2026, PostgreSQL Global Development Group

Portions Copyright (c) 1994, The Regents of the University of California

Permission to use, copy, modify, and distribute this software and its
documentation for any purpose, without fee, and without a written agreement
is hereby granted, provided that the above copyright notice and this
paragraph and the following two paragraphs appear in all copies.

IN NO EVENT SHALL THE UNIVERSITY OF CALIFORNIA BE LIABLE TO ANY PARTY FOR
DIRECT, INDIRECT, SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, INCLUDING
LOST PROFITS, ARISING OUT OF THE USE OF THIS SOFTWARE AND ITS
DOCUMENTATION, EVEN IF THE UNIVERSITY OF CALIFORNIA HAS BEEN ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

THE UNIVERSITY OF CALIFORNIA SPECIFICALLY DISCLAIMS ANY WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS FOR A PARTICULAR PURPOSE.  THE SOFTWARE PROVIDED HEREUNDER IS
ON AN "AS IS" BASIS, AND THE UNIVERSITY OF CALIFORNIA HAS NO OBLIGATIONS TO
PROVIDE MAINTENANCE, SUPPORT, UPDATES, ENHANCEMENTS, OR MODIFICATIONS.
```

The build disables readline, gettext (`nls`), ICU, OpenSSL, LLVM and every
other optional library except zlib (`native-runtime/postgres/build.sh`), so no
GPL or LGPL code is linked.

### Snowball

PostgreSQL's `dict_snowball` module and the stop-word files under
`share/postgresql/tsearch_data/` are derived from the Snowball project
(https://snowballstem.org), synced by PostgreSQL 18.6 with Snowball commit
`d19326ac6c1b9a417fc872f7c2f845265a5e9ece` (PostgreSQL's
`src/backend/snowball/README`). Licensed under the 3-clause BSD license; the
full text, Snowball's `COPYING` at that commit, ships at
`licenses/snowball-COPYING`:

```text
Copyright (c) 2001, Dr Martin Porter
Copyright (c) 2004,2005, Richard Boulton
Copyright (c) 2013, Yoshiki Shibukawa
Copyright (c) 2006,2007,2009,2010,2011,2014-2019, Olly Betts
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

  1. Redistributions of source code must retain the above copyright notice,
     this list of conditions and the following disclaimer.
  2. Redistributions in binary form must reproduce the above copyright notice,
     this list of conditions and the following disclaimer in the documentation
     and/or other materials provided with the distribution.
  3. Neither the name of the Snowball project nor the names of its contributors
     may be used to endorse or promote products derived from this software
     without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### pgvector

pgvector 0.8.7 (https://github.com/pgvector/pgvector): the `vector` server
module and its `share/postgresql/extension/vector*` files. Licensed under the
PostgreSQL License; the full text ships at
`postgres/share/licenses/pgvector/LICENSE`:

```text
Portions Copyright (c) 1996-2026, PostgreSQL Global Development Group

Portions Copyright (c) 1994, The Regents of the University of California

Permission to use, copy, modify, and distribute this software and its
documentation for any purpose, without fee, and without a written agreement
is hereby granted, provided that the above copyright notice and this
paragraph and the following two paragraphs appear in all copies.

IN NO EVENT SHALL THE UNIVERSITY OF CALIFORNIA BE LIABLE TO ANY PARTY FOR
DIRECT, INDIRECT, SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, INCLUDING
LOST PROFITS, ARISING OUT OF THE USE OF THIS SOFTWARE AND ITS
DOCUMENTATION, EVEN IF THE UNIVERSITY OF CALIFORNIA HAS BEEN ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

THE UNIVERSITY OF CALIFORNIA SPECIFICALLY DISCLAIMS ANY WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS FOR A PARTICULAR PURPOSE.  THE SOFTWARE PROVIDED HEREUNDER IS
ON AN "AS IS" BASIS, AND THE UNIVERSITY OF CALIFORNIA HAS NO OBLIGATIONS TO
PROVIDE MAINTENANCE, SUPPORT, UPDATES, ENHANCEMENTS, OR MODIFICATIONS.
```

### zlib (Windows builds)

On Windows, zlib 1.3.2 (https://zlib.net) is built from the pinned source and
linked statically into the PostgreSQL server, `pg_dump` and `pg_restore`.
(macOS and Linux link the operating system's own zlib; none is shipped.) The
full text, zlib's `LICENSE` from that release, ships at `licenses/zlib-LICENSE`:

```text
Copyright notice:

 (C) 1995-2026 Jean-loup Gailly and Mark Adler

  This software is provided 'as-is', without any express or implied
  warranty.  In no event will the authors be held liable for any damages
  arising from the use of this software.

  Permission is granted to anyone to use this software for any purpose,
  including commercial applications, and to alter it and redistribute it
  freely, subject to the following restrictions:

  1. The origin of this software must not be misrepresented; you must not
     claim that you wrote the original software. If you use this software
     in a product, an acknowledgment in the product documentation would be
     appreciated but is not required.
  2. Altered source versions must be plainly marked as such, and must not be
     misrepresented as being the original software.
  3. This notice may not be removed or altered from any source distribution.

  Jean-loup Gailly        Mark Adler
  jloup@gzip.org          madler@alumni.caltech.edu
```

### llama.cpp and ggml

llama.cpp `llama-server` at tag `b9115` (https://github.com/ggml-org/llama.cpp),
with the ggml tensor library and its CPU backends it is built from. Licensed
under the MIT License; the full text ships at `llama/LICENSE`:

```text
MIT License

Copyright (c) 2023-2026 The ggml authors

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

### cpp-httplib

`llama-server` embeds cpp-httplib 0.44.0 (https://github.com/yhirose/cpp-httplib),
vendored by llama.cpp at `b9115`. Licensed under the MIT License; the full text
ships at `llama/licenses/cpp-httplib-LICENSE`:

```text
The MIT License (MIT)

Copyright (c) 2017 yhirose

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

### JSON for Modern C++ (nlohmann/json)

`llama-server` embeds nlohmann/json 3.12.0 (https://github.com/nlohmann/json),
vendored by llama.cpp at `b9115`. Licensed under the MIT License; the full text
ships at `llama/licenses/nlohmann-json-LICENSE`:

```text
MIT License

Copyright (c) 2013-2025 Niels Lohmann

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

### Microsoft Visual C++ runtime (Windows builds)

The Windows trees carry the Visual C++ runtime DLLs their programs link
(`vcruntime140.dll`, on x64 also `vcruntime140_1.dll`, and `msvcp140.dll` for
`llama-server`), copied from the Visual Studio redistributable that built them,
because a clean Windows has no Visual C++ redistributable. They are Microsoft
Distributable Code, redistributed under the Visual Studio license terms; the
notice, with links to Microsoft's terms and redistribution list, ships at
`licenses/msvc-runtime-NOTICE.txt`. Copyright (c) Microsoft Corporation.

### EmbeddingGemma

Vex's embeddings model, EmbeddingGemma 300M (GGUF, Q8_0, from
https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF), is NOT shipped in the
package: it is downloaded on first run, verified against a pinned sha256
(`src/main/onboarding/embedding-defaults.ts`), and used unmodified. It is
provided under and subject to the Gemma Terms of Use
(https://ai.google.dev/gemma/terms). The package carries the Gemma `NOTICE`,
the Terms of Use and the Prohibited Use Policy those terms incorporate, at
`licenses/gemma/`.
