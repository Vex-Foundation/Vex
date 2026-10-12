/**
 * Button primitive, V10 (docs/design/V10-SPREAD.md sections 1 and 7).
 *
 * Square, no shadow. Five variants:
 *   primary  the one blue fill per view (true blue with white type in both
 *            rooms; hover lifts to the numeral blue)
 *   ghost    blue outline, fills on hover
 *   ink      ink outline for the refusing choice (Decline, Reject, Stop,
 *            destructive); fills with ink on hover
 *   quiet    rule outline for toolbars and card actions
 *   bare     no outline, for icon buttons in chrome
 *
 * `armed` is a quiet button whose `data-armed="true"` swaps it to the primary fill: the one
 * control whose ENABLEMENT is the message (the unlock CTA lighting up the
 * moment a password is typed). It carries a short colour-only transition,
 * disabled under reduced motion. Every other variant changes colour at once.
 *
 * A disabled primary is drawn as a dotted outline, never a faded fill: the
 * safety gate keeps native `disabled`, and fading reads as "loading".
 *
 * STYLING CONTRACT: every Button emits `data-vex-button` (the resolved
 * variant) and `data-vex-button-size` (the resolved size), the stable hooks
 * for cross-file rules (see the pre-shell CTA block in `chronos-gate.css`).
 */

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2.5 whitespace-nowrap border border-transparent font-medium tracking-[-0.003em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        primary:
          "bg-button-accent text-ink-on-button-accent enabled:hover:bg-button-accent-hover enabled:active:translate-y-px disabled:border-dotted disabled:border-accent-primary disabled:bg-transparent disabled:text-accent-primary",
        ghost:
          "border-accent-primary text-accent-primary enabled:hover:bg-accent-primary enabled:hover:text-ink-on-accent disabled:border-dotted disabled:text-ink-tertiary",
        ink: "border-rule-ink text-ink-primary enabled:hover:bg-rule-ink enabled:hover:text-ink-on-primary disabled:border-dotted disabled:text-ink-tertiary",
        quiet:
          "border-rule text-ink-primary transition-colors duration-150 motion-reduce:transition-none enabled:hover:bg-interactive-hover disabled:text-ink-tertiary data-[armed=true]:border-transparent data-[armed=true]:bg-button-accent data-[armed=true]:text-ink-on-button-accent data-[armed=true]:enabled:hover:bg-button-accent-hover",
        // `armed` is the quiet recipe under its own seam name: the unlock CTA
        // is asserted by `data-vex-button="armed"`. The arming signal is
        // `data-armed`, which swaps the fill in.
        armed:
          "border-rule text-ink-primary transition-colors duration-150 motion-reduce:transition-none enabled:hover:bg-interactive-hover disabled:text-ink-tertiary data-[armed=true]:border-transparent data-[armed=true]:bg-button-accent data-[armed=true]:text-ink-on-button-accent data-[armed=true]:enabled:hover:bg-button-accent-hover",
        bare: "text-ink-secondary enabled:hover:bg-interactive-hover enabled:hover:text-ink-primary disabled:text-ink-tertiary",
      },
      size: {
        default: "h-11 px-[18px] text-[15px] leading-none",
        sm: "h-9 px-3.5 text-[14px] leading-none",
        lg: "h-12 px-6 text-[15px] leading-none",
        icon: "h-11 w-11 px-0 text-[15px]",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      data-vex-button={variant ?? "primary"}
      data-vex-button-size={size ?? "default"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
);
Button.displayName = "Button";

export { buttonVariants };
