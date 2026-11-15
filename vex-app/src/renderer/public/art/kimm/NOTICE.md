# Kimm's art: notice

Where these files come from, and on what terms they ship in the Vex desktop
app.

## Her stills

- **Source.** VEX Cloud (the web app), `apps/web/public/kimm/v1/stills/`, on
  its `rebranding-v99-ui` branch. Byte copies under the same names: nothing
  was re-encoded, resized or renamed. Cloud's own notice lists them as renders
  of Kimm and of her glyph field by the VEX mockups (`h3-merged/img/`,
  `h3-shell-gaps/img/`, `landing-r3/stills/`).
- **Owner.** VEX Labs, the owner of both VEX Cloud and this desktop app. The
  owner approved copying this ready-made raster set into the desktop repo on
  8 November 2026.
- **Licence.** VEX Labs' own work. No third-party licence applies; they are not
  licensed for use outside VEX products.

| File | Size in pixels | Bytes |
| --- | --- | --- |
| `chip-hi.webp` | 150 x 150 | 6,138 |
| `chip-think.webp` | 150 x 150 | 6,122 |
| `chip-offer.webp` | 150 x 150 | 5,954 |
| `chip-signed.webp` | 150 x 150 | 5,470 |
| `chip-refused.webp` | 150 x 150 | 5,400 |
| `chip-rest.webp` | 150 x 150 | 5,652 |
| `still-hi.webp` | 720 x 1033 | 75,300 |
| `still-think.webp` | 720 x 1096 | 77,554 |
| `still-offer.webp` | 720 x 1044 | 73,296 |
| `still-signed.webp` | 720 x 1042 | 79,588 |
| `still-refused.webp` | 720 x 1104 | 81,544 |
| `still-rest.webp` | 720 x 1032 | 75,700 |
| `field-still.webp` | 780 x 652 | 20,358 |
| `field-still-wide.webp` | 1536 x 1972 | 43,684 |

Total 561,760 bytes. Each file's size, format and byte budget are pinned in
`scripts/kimm-brand-assets.mjs`, which the build check
(`scripts/check-build-artifacts.mjs`) enforces; the renderer reads them only
through `src/renderer/components/vex/kimm/kimm-assets.ts`. They stay her
fallback wherever the live model does not stand.

## Her live model (`live/`)

- **Decision.** The owner approved, on 15 November 2026, shipping Kimm's
  Live2D model, Live2D Cubism Core, PIXI 6.5.10, `@pixi/unsafe-eval` 6.5.10
  and pixi-live2d-display 0.4.0 inside the desktop app, so she moves on
  desktop as she does on VEX Cloud. Before that decision this folder did not
  exist.
- **Source.** VEX Cloud, `apps/web/public/kimm/v1/lib/` and
  `apps/web/public/kimm/v1/model/`. Byte copies under the same names, in
  `live/lib/` and `live/model/`: nothing was re-encoded, minified, resized or
  renamed. Each file's size and sha256 are the pins of Cloud's own guard
  (`tests/guards/expected/kimm.expected.json`), repeated in
  `scripts/kimm-brand-assets.mjs` (`KIMM_LIVE_FILES`), which the build check
  enforces (gate 6b): the folder must hold exactly these bytes.
- **Served.** From the app's own origin (`app://vex/art/kimm/live/...`), as
  same-origin script files in the order below and model files read by the
  display library. No CDN and no network fetch. The production CSP is
  unchanged (`script-src 'self'`): the `@pixi/unsafe-eval` shim lets PIXI run
  without `'unsafe-eval'`, and Cubism Core 5.0.0 is a wasm2js build (it
  defines its own `WebAssembly` object and compiles no WebAssembly), so it
  needs no `'wasm-unsafe-eval'` either. `kimm.moc.wasm` is her MOC3 file
  under Cloud's name (its first bytes are `MOC3`), not WebAssembly.
- **Licences.**
  - Live2D Cubism Core 5.0.0 (`lib/live2dcubismcore.min.js`): Live2D Inc.'s
    proprietary "Redistributable Code", under the Live2D Proprietary Software
    License Agreement
    (https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html),
    as its header says. Live2D's SDK release terms may require a publication
    licence for a commercial release, depending on the publisher's size; VEX
    Cloud's design notes record that the owner or legal must confirm VEX Labs'
    position before a commercial release.
  - PIXI.js 6.5.10 (`lib/pixi.min.js`) and `@pixi/unsafe-eval` 6.5.10
    (`lib/unsafe-eval.min.js`): MIT, their headers kept.
  - pixi-live2d-display 0.4.0 (`lib/cubism4.min.js`): MIT.
  - The model (`model/`): Kimm, VEX Labs' own work, not licensed for use
    outside VEX products.

| File | What it is | Bytes |
| --- | --- | --- |
| `live/lib/live2dcubismcore.min.js` | Live2D Cubism Core 5.0.0, loaded first | 206,492 |
| `live/lib/pixi.min.js` | PIXI.js 6.5.10, loaded second | 460,333 |
| `live/lib/unsafe-eval.min.js` | `@pixi/unsafe-eval` 6.5.10, loaded third | 3,884 |
| `live/lib/cubism4.min.js` | pixi-live2d-display 0.4.0 (Cubism 4), loaded last | 119,922 |
| `live/model/kimm.model3.json` | her settings | 379 |
| `live/model/kimm.moc.wasm` | her moc (MOC3) | 11,488,768 |
| `live/model/kimm.physics3.json` | her physics | 124,647 |
| `live/model/idle.motion3.json` | her idle loop | 3,964 |
| `live/model/t0_4096.webp` | texture, 4096 x 4096 | 1,004,750 |
| `live/model/t1_4096.webp` | texture, 4096 x 4096 | 1,061,820 |
| `live/model/t2_4096.webp` | texture, 4096 x 2048 | 599,334 |

Total 15,074,293 bytes (libraries 790,631, model 14,283,662). The renderer
names them only in `src/renderer/components/vex/kimm/kimm-assets.ts` and
loads them only through `kimm-embed.ts`, reached by a dynamic import.
