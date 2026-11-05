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
      /**
       * Raise a notification through the window's own model (the toast).
       * The input is the renderer's `NotificationInput`; returns its id.
       */
      readonly notify: (input: {
        readonly severity: "info" | "warning" | "error";
        readonly scope: { readonly kind: "global" };
        readonly source: string;
        readonly title?: string;
        readonly message: string;
        readonly sticky?: boolean;
        readonly actions?: readonly {
          readonly id: string;
          readonly label: string;
          readonly rank: "primary" | "secondary";
          readonly run: () => void;
        }[];
      }) => string;
    };
  }
}

export {};
