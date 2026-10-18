/**
 * Button primitive, R3 (docs/design/R3-MINIMAL.md sections 1.5 and 8.2).
 *
 * Square, no shadow, transparent unless it is the one fill. 40 high with
 * padding 0 18 and 14 / 500 type; the small key is 32 high, 0 12, 13. Six
 * variants plus `armed`:
 *   primary  the one blue fill per view (on-fill type; at night a periwinkle
 *            edge holds the silhouette on night paper; hover lifts to the
 *            numeral blue)
 *   ghost    blue outline, fills on hover
 *   ink      ink outline for the refusing choice (Decline, Reject,
 *            destructive); fills with ink on hover
 *   stop     the ink key that stops work (Stop agent, Stop mission): an ink
 *            fill with paper type
 *   quiet    rule outline for toolbars and card actions
 *   bare     no outline, for icon keys in chrome (32 x 32 at size `icon`)
 *
 * `armed` is a quiet button whose `data-armed="true"` swaps it to the primary fill: the one
 * control whose ENABLEMENT is the message (the unlock CTA lighting up the
 * moment a password is typed). It carries a short colour-only transition,
 * disabled under reduced motion. Every other variant changes colour at once.
 *
 * A disabled primary is drawn as a dotted outline, never a faded fill: the
 * safety gate keeps native `disabled`, and fading reads as "loading".
 *
 * Focus is a 2px outline in the focus blue, 3px clear of the key, never a
 * shadow ring.
 *
 * STYLING CONTRACT: every Button emits `data-vex-button` (the resolved
 * variant) and `data-vex-button-size` (the resolved size), the stable hooks
 * for cross-file rules (see the pre-shell CTA block in `chronos-gate.css`).
 */

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap border border-transparent bg-transparent font-medium focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-focus disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        primary:
          "border-button-accent-edge bg-button-accent text-ink-on-button-accent enabled:hover:bg-button-accent-hover enabled:active:translate-y-px disabled:border-dotted disabled:border-accent-primary disabled:bg-transparent disabled:text-accent-primary",
        ghost:
          "border-accent-primary text-accent-primary enabled:hover:bg-accent-primary enabled:hover:text-ink-on-accent disabled:border-dotted disabled:text-ink-tertiary",
        ink: "border-rule-ink text-ink-primary enabled:hover:bg-rule-ink enabled:hover:text-ink-on-primary disabled:border-dotted disabled:text-ink-tertiary",
        stop: "border-rule-ink bg-rule-ink text-ink-on-primary disabled:border-dotted disabled:bg-transparent disabled:text-ink-tertiary",
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
        default: "h-10 px-[18px] text-[14px] leading-none",
        sm: "h-8 px-3 text-[13px] leading-none",
        lg: "h-12 px-6 text-[15px] leading-none",
        icon: "h-8 w-8 px-0 text-[14px]",
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
