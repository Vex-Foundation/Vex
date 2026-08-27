/**
 * Pill: small capsule label chip (view switchers, filters, badges).
 * Interactive when onClick is supplied (renders a button); otherwise a
 * static span. Capsule radius = height / 2.
 */

import type { HTMLAttributes, JSX, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

// `min-w-0 max-w-full`: a pill seated in a flex row must be able to concede
// width instead of painting outside it. It stays `whitespace-nowrap`; the
// ellipsis is owned by the call site's label span (`min-w-0 truncate`), which
// is the only element that knows which text is expendable. Deliberately NO
// `overflow-hidden` here - the interactive variant must keep its focus ring
// paintable.
const pillVariants = cva(
  "inline-flex min-w-0 max-w-full items-center gap-1 whitespace-nowrap rounded-capsule border-0",
  {
    variants: {
      variant: {
        neutral: "bg-surface-2 text-ink-secondary",
        accent: "bg-accent-wash text-accent-primary",
        danger: "bg-danger-wash text-danger",
        // STATUS FAMILY (board safety chips). These three carry a hairline
        // the three above do not: a status chip has to read as a verdict on
        // a dark plate where a wash alone is nearly invisible, while the
        // label/filter pills above sit on chrome and must stay quiet. The
        // ring is the LAST class in the string on purpose - `cn` runs
        // tailwind-merge over the whole result, so it resolves the base
        // `border-0` deterministically rather than by source order luck.
        positive: "bg-success-wash text-success border border-success/40",
        caution: "bg-warning-wash text-warning-label border border-warning/40",
        info: "bg-surface-2 text-ink-secondary border border-line-2",
      },
      size: {
        md: "h-6 px-2 text-[12px] leading-[18px]",
        sm: "h-5 px-1.5 text-[11px] leading-[14px]",
        // The board card's status chip: a taller capsule with room for a
        // leading glyph, sized against the 64px token photo beside it.
        lg: "h-7 gap-1.5 px-2.5 text-[12.5px] leading-[20px]",
      },
    },
    defaultVariants: {
      variant: "neutral",
      size: "md",
    },
  },
);

/**
 * The ACTIVE treatment of a filter or view pill: the accent wash under an
 * inset accent ring, never a solid accent fill. One string, so a chain
 * filter, a safety filter and the spotlight crumb cannot each invent their
 * own version of "selected".
 */
export const PILL_ACTIVE_CLASS =
  "bg-accent-wash text-accent-primary ring-1 ring-inset ring-accent-primary/40";

/**
 * ATTRIBUTES REACH BOTH ELEMENTS.
 *
 * The props are typed on `HTMLAttributes<HTMLElement>` rather than on
 * `ButtonHTMLAttributes`, because this primitive renders a `span` OR a
 * `button` and only the shared surface is meaningful on both. The defect that
 * forced the correction was silent and exactly the kind a static pill invites:
 * the button branch spread its extra props and the span branch dropped them,
 * so a static pill carrying a `data-*` hook or a `title` rendered without
 * either and nothing failed to compile. `disabled` is declared explicitly
 * because it is the one button-only attribute callers legitimately pass; it is
 * applied on the interactive branch alone.
 */
export interface PillProps
  extends HTMLAttributes<HTMLElement>,
    VariantProps<typeof pillVariants> {
  readonly children?: ReactNode;
  /** Interactive branch only. A static pill has nothing to disable. */
  readonly disabled?: boolean;
}

export function Pill({
  variant,
  size,
  className,
  children,
  onClick,
  disabled,
  ...rest
}: PillProps): JSX.Element {
  if (onClick === undefined) {
    return (
      <span className={cn(pillVariants({ variant, size }), className)} {...rest}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        pillVariants({ variant, size }),
        "cursor-pointer enabled:hover:bg-interactive-hover",
        className,
      )}
      onClick={onClick}
      {...rest}
    >
      {children}
    </button>
  );
}
