/**
 * THE WINDOW'S OWN CHROME, STOOD IN FOR - what the operating system draws over
 * the Electron window that a browser page does not have: the macOS traffic
 * lights and the Windows caption overlay.
 *
 * DEV SCAFFOLDING, like everything in this directory. The shell reserves room
 * for both (`window-chrome.css`, the header's logo and reserve cells), but in
 * a plain Chromium nothing is drawn there and `--overlay-w` resolves to 0, so a
 * capture could not show whether a cell clears them. The harness paints a
 * stand-in of each over the page at the place the main process puts the real
 * one (`src/main/windows/chrome-options.ts`), and on Windows it sets
 * `--overlay-w` to the overlay's width, as Window Controls Overlay does in
 * the app. The numbers are copied, not imported (the renderer never imports
 * the main process); `src/main/windows/__tests__/main-window-chrome.test.ts`
 * fails the moment the two disagree.
 */

/** The traffic lights' inset: `TRAFFIC_LIGHT_POSITION` in chrome-options.ts. */
export const STANDIN_TRAFFIC_LIGHTS = { x: 20, y: 32 } as const;

/** Each light's diameter, and the gap between two (section 4.7). */
export const STANDIN_LIGHT_SIZE = 12;
export const STANDIN_LIGHT_GAP = 8;

/**
 * The Windows caption overlay: 138 wide including its gap (the design value
 * `--overlay-w` stands for) and `TITLE_BAR_OVERLAY_HEIGHT` high.
 */
export const STANDIN_CAPTION_OVERLAY = { width: 138, height: 75 } as const;
