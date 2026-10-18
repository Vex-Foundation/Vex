/**
 * Pill: small outlined label (view switchers, filters, badges). Interactive
 * when onClick is supplied (renders a button); otherwise a static span.
 * R3 (docs/design/R3-MINIMAL.md section 9): the filter chip, sentence case in
 * the sans, a quiet rule; the active filter is the blue line and type on the
 * selection wash.
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
//
// R3: square, one 1px outline, transparent, no status hue. A variant differs
// by the line it draws (the quiet rule, the one blue, the ink), never by a
// wash; only the active filter takes the selection wash.
const pillVariants = cva(
  "inline-flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap border bg-transparent",
  {
    variants: {
      variant: {
        neutral: "border-rule-quiet text-ink-secondary",
        accent: "border-accent-primary text-accent-primary",
        danger: "border-rule-ink text-ink-primary",
        // STATUS FAMILY (board safety chips): the verdict is the line weight
        // and its colour family, with a Swatch or a word beside it.
        positive: "border-rule-ink text-ink-primary",
        caution: "border-accent-primary text-accent-primary",
        info: "border-rule text-ink-secondary",
      },
      size: {
        md: "h-[26px] px-[9px] text-[12.5px] leading-[18px]",
        sm: "h-5 px-1.5 text-[11px] leading-[14px]",
        // The board card's status chip: a taller pill with room for a
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
 * The ACTIVE treatment of a filter or view pill: the blue line and the blue
 * type on the selection wash, never a solid fill. One string, so a chain
 * filter, a safety filter and the spotlight crumb cannot each invent their
 * own version of "selected".
 */
export const PILL_ACTIVE_CLASS =
  "border-accent-primary bg-interactive-active font-medium text-accent-primary";

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
