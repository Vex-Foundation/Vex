/**
 * THE RENDERER'S CONTAINMENT PRIMITIVE.
 *
 * React 19 unmounts the ENTIRE root when a render throws and no boundary
 * catches it: the window goes to the app background colour and stays there,
 * with no message on screen and - before B0.2 - no evidence anywhere. This
 * component is what turns that into a contained, named, reportable failure.
 *
 * ## Two jobs, and both are load-bearing
 *
 * 1. CONTAIN. The failed subtree is replaced by a recovery surface; everything
 *    outside the boundary keeps rendering. Where the boundary is mounted is
 *    therefore a design decision, not a detail: a boundary INSIDE a component
 *    cannot catch that component's own render throw, so it goes around the
 *    subtree it is meant to protect (`App` around the view tree, the Studio
 *    centre around each workspace).
 * 2. CAPTURE. `componentDidCatch` reports through the renderer's single
 *    evidence path (`lib/renderer-error-report`), and the id that path returns
 *    is SHOWN on the recovery surface. The owner can read the id off the
 *    screen and find that exact failure in the local log.
 *
 * ## Recovery is offered, never taken
 *
 * The boundary retries only when a person asks. An automatic retry of a render
 * that just threw usually throws again, and a self-reloading window is how a
 * bad piece of persisted state becomes an unbreakable loop - so callers that
 * have a SECOND way out (return to a known-good screen) pass it as an extra
 * action rather than making reload the only door.
 *
 * ## Pattern sources
 *
 * `deepseek-harness/packages/client/web-react/src/scoped-slots.tsx`
 * (`SlotErrorBoundary`): getDerivedStateFromError for the state flip,
 * componentDidCatch for the report through an injected seam, and identity keys
 * so a boundary that failed on one subject does not black out the next one.
 * Its blank `<div data-slot-error>` face is deliberately NOT adopted: a harness
 * hiding one plugin's crash from an end user is a different product than a
 * self-custodial desktop app whose owner has to be able to see and report what
 * broke.
 */

import {
  Component,
  useEffect,
  useRef,
  type ErrorInfo,
  type JSX,
  type ReactNode,
} from "react";
import { Button } from "./button.js";
import { cn } from "../../lib/utils.js";
import {
  describeThrown,
  reportRendererFailure,
} from "../../lib/renderer-error-report.js";

/** One recovery route offered beside the boundary's own retry. */
export interface ErrorBoundaryAction {
  readonly label: string;
  readonly onSelect: () => void;
}

export interface ErrorBoundaryFallbackProps {
  readonly error: unknown;
  /** The id the failure was reported under; null only if the report path died. */
  readonly correlationId: string | null;
  /** Re-render the boundary's children. Safe to call more than once. */
  readonly retry: () => void;
  readonly actions: readonly ErrorBoundaryAction[];
}

export interface ErrorBoundaryProps {
  /**
   * Stable name of the protected surface, e.g. `"app"` or
   * `"studio.workspace"`. It rides into the report so a log line names WHERE
   * the failure was contained, not only what threw.
   */
  readonly surface: string;
  readonly children: ReactNode;
  /** Extra recovery routes, rendered after the boundary's own "Try again". */
  readonly actions?: readonly ErrorBoundaryAction[];
  /** Replace the default recovery surface entirely. */
  readonly fallback?: (props: ErrorBoundaryFallbackProps) => ReactNode;
  /** Observed after a catch, with the id the failure was reported under. */
  readonly onError?: (error: unknown, correlationId: string) => void;
  /**
   * Clears the failure when its value changes - for a boundary whose subject
   * can be swapped (a different project, a different route). A boundary left
   * failed across a subject change would black out a healthy subtree.
   */
  readonly resetKey?: string | number;
  /** Heading of the default recovery surface. */
  readonly title?: string;
  /** Layout intent: `"screen"` fills the viewport, `"region"` fills its box. */
  readonly extent?: "screen" | "region";
}

interface ErrorBoundaryState {
  readonly error: unknown;
  readonly failed: boolean;
  readonly correlationId: string | null;
}

const CLEARED: ErrorBoundaryState = {
  error: null,
  failed: false,
  correlationId: null,
};

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = CLEARED;

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    // The id is minted in componentDidCatch, where the report happens: this
    // hook is render-phase and must stay pure (StrictMode invokes it twice).
    return { error, failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const correlationId = reportRendererFailure({
      surface: this.props.surface,
      kind: "boundary",
      error,
      componentStack: info.componentStack ?? null,
    });
    this.setState({ correlationId });
    this.props.onError?.(error, correlationId);
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (
      this.state.failed &&
      previous.resetKey !== this.props.resetKey
    ) {
      this.setState(CLEARED);
    }
  }

  private readonly retry = (): void => {
    this.setState(CLEARED);
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const actions = this.props.actions ?? [];
    if (this.props.fallback) {
      return this.props.fallback({
        error: this.state.error,
        correlationId: this.state.correlationId,
        retry: this.retry,
        actions,
      });
    }
    return (
      <ErrorBoundaryFallback
        error={this.state.error}
        correlationId={this.state.correlationId}
        retry={this.retry}
        actions={actions}
        title={this.props.title ?? "Something in Vex stopped rendering"}
        extent={this.props.extent ?? "region"}
      />
    );
  }
}

/**
 * The default recovery surface.
 *
 * It states the failure in the user's terms, names the error, shows the
 * correlation id that ties the screen to the local log, and offers the routes
 * out. `role="alert"` announces it; focus moves to the first action so a
 * keyboard user is not stranded inside the subtree that just died.
 */
export function ErrorBoundaryFallback({
  error,
  correlationId,
  retry,
  actions,
  title,
  extent,
}: ErrorBoundaryFallbackProps & {
  readonly title: string;
  readonly extent: "screen" | "region";
}): JSX.Element {
  const described = describeThrown(error);
  const firstActionRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    firstActionRef.current?.focus();
  }, []);

  return (
    <div
      role="alert"
      data-vex-error-boundary=""
      className={cn(
        "flex w-full flex-col items-center justify-center gap-4 p-8",
        extent === "screen" ? "h-screen" : "h-full min-h-0",
      )}
    >
      {/* The CARD carries the entrance, not the alert container: the container
        * is what `role="alert"` announces and what the focus effect above
        * reaches into, and neither may wait on an animation. The card fading in
        * marks the substitution - a subtree the user was reading has been
        * replaced - which is one of the three jobs MOTION-POLICY gives motion.
        * A single opacity-plus-rise pass, no loop: an error surface that keeps
        * moving is decoration on top of a failure. */}
      <div className="vex-surface-enter flex w-full max-w-lg flex-col gap-3">
        <h2 className="text-[16px] font-medium leading-[24px] text-ink-primary">
          {title}
        </h2>
        <p className="text-[13px] leading-[20px] text-ink-secondary">
          The rest of Vex is still running. Nothing was lost: open terminals,
          running shells and unsaved work in other areas are untouched.
        </p>
        <dl className="flex flex-col gap-1 rounded-md border border-line-1 p-3 font-mono text-[12px] leading-[18px]">
          <div className="flex gap-2">
            <dt className="text-ink-tertiary">error</dt>
            <dd className="min-w-0 break-words text-ink-primary">
              {described.name}
              {described.message === "" ? "" : `: ${described.message}`}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-ink-tertiary">id</dt>
            <dd className="min-w-0 select-all break-all text-ink-primary">
              {correlationId ?? "not reported"}
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button ref={firstActionRef} type="button" onClick={retry}>
            Try again
          </Button>
          {actions.map((action) => (
            <Button
              key={action.label}
              type="button"
              variant="outline"
              onClick={action.onSelect}
            >
              {action.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
