# Element references (V10 "Sepia Counter", the website)

> These crops are the **website**. For the **apps** (VEX Desktop, R3 Minimal) open `../app/INDEX.md` and build from `../../references/APP-R3.md` and `../../references/ELEMENTS.md`.
>
> **No animals since 2026-10-17.** The eagle, flock and horse crops were removed on 2026-10-18; where a remaining crop still shows a bird or a horse (`06-product-cards-row.png`, `20-photo-plate-zones.png`), read its layout only. The product cards now carry dot screen emblems drawn in code (the cloud, a desktop computer, the Vex Inc. office tower) and the band carries dot clouds.

Tightly cropped screenshots of single components from the built site (local dev, Chromium, reduced motion so every moving layer is its composed still frame, 2026-10-09). Every crop sits on its real ground: paper `#F3F4F7` or the graded sepia print. Longest side 1600px or less.

How to use them with an image model (pass each crop as a reference image):
- They steer layout direction only: where a counter sits, how a chip or a table row is built. Never use the output for final text, numbers or the vx logo; those are always real fonts and the real path in HTML.
- Pass 1 to 3 element refs per call, plus one full composition (`../01-v10-hero.jpg` or `20-photo-plate-zones.png`) and the print master (`../12-art-contact-sheet.jpg`). More refs than that and the model averages them into mush.
- Name in the prompt what each ref is for ("ref 2: the status chip style, copy only the fill patterns"), otherwise the model copies the whole crop.

| File | Size | What it shows | Source (route) | Pass it as a reference when |
|---|---|---|---|---|
| `01-giant-counter.png` | 1432x956 | The XL italic counter `(01)` in `#0000FF` on the pale sky zone of the hills print | `/` hero | any section opener, hero or social graphic that needs the giant parenthetical counter at the right weight and slant |
| `02-section-header.png` | 1600x326 | Section header: counter L, mono eyebrow, two line serif title, lead, over the faint world dot map on paper | `/` `#structure` | a new paper section or chapter opener; a deck slide title |
| `03-status-chips-paper.png` | 1600x555 | All five status fills (LIVE solid, BETA dot screen, IN DEVELOPMENT hatch, NEXT target, PLANNED empty), the PROPOSED / OPEN tags, the legend table and the paper status strip | the site kit, status | anything that shows product or feature status; to stop the model from using green, amber or red |
| `03-status-chips-photo.png` | 1600x133 | The status strip on the dark ground zone: white mono labels, chips in paper label boxes, hairline below | `/` hero ground | status rows that sit on a photograph |
| `04-buttons-paper.png` | 1600x491 | Solid blue, ghost and compact buttons (square, no radius, no shadow), an inline text link and mono links with the arrow | the site kit, buttons | app screens, forms, CTAs on paper |
| `04-buttons-photo.png` | 952x224 | Solid blue plus paper button on the sky zone | `/` hero actions | a hero or banner with buttons over a print |
| `04-buttons-ghost-photo.png` | 490x272 | Ghost button for dark ground (white hairline frame) | the site kit, ghost-photo button | a CTA on the dusk footer print or any dark tile |
| `05-spread-caption.png` | 1600x92 | The three group spread caption in white Departure Mono under the hairline, on the dark ground | `/` hero ground | the bottom edge of any print composition, social card or slide |
| `05-spread-caption-paper.png` | 1440x87 | The same caption in blue on paper | the site kit, spread caption on paper | a caption line on a paper layout |
| `06-product-cards-row.png` | 1538x402 | The four cards in a row (2026-10-09), including the unexposed bracket frame for PLANNED (Mobile) and the Cloud dot cloud; the Arena horse plate is retired (that card is now Vex Inc. with an office tower emblem, Desktop a computer emblem, both dot screens drawn in code; the current strip is `../site-home/real-products-strip-light-1440.jpg`) | `/` `#products` | a grid of products or modules, rhythm of a four column row |
| `07-flow-diagram.png` | 1600x492 | Flow fragment: orthogonal blue hairlines with arrowheads, cause in ink above the line, result in blue below, dotted lines for planned flows, sepia square tiles, bracket frames | `/` `#structure` | any mechanism or token flow diagram; to keep connectors straight, never curved |
| `07-structure-map.png` | 1600x682 | The whole structure map: product bus, economy row, legend, footnote | `/` `#structure` | a full system map or an ecosystem overview slide |
| `08-parameter-table-photo.png` | 792x370 | Parameter table on the ground of a print: PROPOSED PARAMETERS tag, mono keys and values, white hairlines, chip in a paper box | `/` `#cloud` opener | token or product spec tables over a photo |
| `08-parameter-table-paper.png` | 948x269 | Parameter table on paper with PROPOSED and OPEN tags | the site kit, parameter table on paper | settings screens, spec sheets, docs tables |
| `09-timeline.png` | 1387x429 | Milestone timeline: status swatch per stop on a hairline, dates in mono, the NOW marker, dotted line after NOW | the site kit, timeline | roadmaps, changelogs, release history |
| `10-release-card.png` | 1384x684 | Three release cards: square sepia crops, mono number, version and date, serif title, short body, mono link | `/` `#releases` | release notes, blog or update cards |
| `11-faq-row.png` | 1232x469 | FAQ rows: serif questions, dotted blue rules, one row open with body text, plus and cross markers | `/` `#faq` | FAQ, accordions, help screens |
| `12-risk-callout.png` | 942x297 | Two risk callouts: ink frame with a hatched left edge, black RISK label, plain sentence (never blue) | `/` `#parameters` | warnings, disclosures, risk notes |
| `13-footer-ghost-vx.png` | 1600x813 | Footer on the dusk print: serif column heads, mono links, status line, legal text, the ghost vx built from pixels behind | `/` footer | footers, end slides, dark closing panels |
| `17-dot-cloud.png` | 1434x690 | The VEX Cloud dot cloud: round white points re-screened from the cumulus density, resting on the ridge | `/cloud` hero | Cloud graphics, any dot screen shape |
| `18-cloud-dial-scene.png` | 1320x1218 | The CLOUD allowance scene: 24 tick dial on the real UTC clock, the sector from 00:00 to now spent as hollow rings, the rest solid points, ice only in the renewing column on the 00:00 line | `/` `#cloud` opener | CLOUD explainers, any daily allowance or quota visual |
| `19-burn-ledger-fields.png` | 1248x829 | Burn ledger at true scale: three zoom fields (1 dot = 1,000,000 / 1,000 / 1 VEX) joined by x1,000 leaders, the key table read from the chain | `/` `#vex` burn ledger | supply, burn or scale explainers; honest number visuals |
| `20-photo-plate-zones.png` | 1600x900 | A whole hero: type and counter in the sky zone, the band left to the scene layer (its birds are retired: dot clouds now), white status strip and spread caption only on the dark ground | `/` hero at 1600x900 | the composition anchor for every new print layout; pair it with one element ref |

Live numbers in `19` (ledger) and the clock in `18` are as read on 2026-10-09; never copy them into a design, read the canon or the chain.
