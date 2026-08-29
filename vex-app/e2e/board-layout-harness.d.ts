/**
 * The board layout harness control surface, as the spec sees it.
 *
 * The implementation is `src/renderer/dev/board-layout/harness.tsx`, which
 * declares the same shape for the renderer program. The two programs never
 * share a `lib.dom` instance, so the declaration exists on both sides rather
 * than in one shared file neither tsconfig includes.
 */
declare global {
  interface Window {
    readonly __vexBoardLayoutHarness: {
      /** Open or close the Ask VEX drawer without a reload. */
      readonly setDrawer: (open: boolean) => void;
      /** Settle the held safety read on the longest verdict in the table. */
      readonly settleSafety: () => void;
    };
  }
}

export {};
