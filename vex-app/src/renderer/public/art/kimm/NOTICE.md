# Kimm's art: notice

Where these files come from, and on what terms they ship in the Vex desktop
app.

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
- **Not here.** Kimm's Live2D model, Live2D Cubism Core, PIXI and any
  WebAssembly were not copied: shipping them in the desktop installer needs its
  own owner decision.

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
through `src/renderer/components/vex/kimm/kimm-assets.ts`.
