/**
 * The H3 shell harness control surface, as the parity spec sees it.
 *
 * The implementation is `src/renderer/dev/h3-shell/harness.tsx`, which
 * defines the property for the renderer program. The two programs never share
 * a `lib.dom` instance, so the shape is declared here for the e2e program
 * rather than in one shared file neither tsconfig includes - the same
 * arrangement as `board-layout-harness.d.ts`.
 */
declare global {
  interface Window {
    readonly __vexH3Harness: {
      /** The loaded state's id, or null on the state index. */
      readonly state: string | null;
      /** Every state id, in capture order. */
      readonly states: readonly string[];
      /** Every bridge member the shell called, in first-call order. */
      readonly calls: () => readonly string[];
      /** Every bridge member the shell called that the state did not answer. */
      readonly unanswered: () => readonly string[];
    };
  }
}

export {};
