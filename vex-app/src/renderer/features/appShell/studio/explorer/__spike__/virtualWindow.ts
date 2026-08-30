/**
 * SPIKE ONLY (Stage B3 measurement). Not production code.
 *
 * jsdom has no layout: every element measures 0x0, so @tanstack/react-virtual
 * would compute a zero-height viewport and render nothing. These overrides
 * feed it a fixed 600px viewport at scroll offset 0, which is exactly the
 * quantity the acceptance criterion is about ("only the visible window is
 * rendered"). What jsdom CANNOT prove is real measurement, scroll behaviour or
 * paint cost; see the report's "not measured" section.
 */
export const ROW_HEIGHT = 22;
export const VIEWPORT_HEIGHT = 600;
/** 600 / 22 = 27.3 rows + react-virtual's default overscan */
export const OVERSCAN = 5;

export const fixedRect = { width: 300, height: VIEWPORT_HEIGHT };

export const observeElementRect = (
  _instance: unknown,
  cb: (rect: { width: number; height: number }) => void,
): (() => void) => {
  cb(fixedRect);
  return () => {};
};

export const observeElementOffset = (
  _instance: unknown,
  cb: (offset: number, isScrolling: boolean) => void,
): (() => void) => {
  cb(0, false);
  return () => {};
};
