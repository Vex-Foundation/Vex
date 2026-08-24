/**
 * Button primitive: capsule silhouette (radius = height / 2) on tokens v2.
 * `primary` is INK/PAPER; `accent` marks the main action only. Hover is an
 * immediate color change - no transition, no shadow depth.
 *
 * ONE amendment to that no-transition rule (ratified 2026-08-21): the
 * `armed` variant. It is the only control whose ENABLEMENT is the message
 * (the unlock CTA lighting up the moment a password is typed), so it
 * carries a 150ms `transition-colors`, disabled under reduced motion.
 * Colour only, never opacity: fading a control in reads as "loading", not
 * "ready". Every other variant keeps the immediate change.
 *
 * STYLING CONTRACT: every Button emits `data-vex-button` (the resolved
 * variant) and `data-vex-button-size` (the resolved size). These are the
 * stable hooks for cross-file rules - see the pre-shell CTA block in
 * `styles/global-css/chronos-gate.css`, which broke silently while it was
 * keyed on utility classes instead.
 *
 * Disabled states pin an ink tier instead of stacking opacity on text
 * (design-language §2 bans opacity-stacked text): 40% of the paper fill on
 * ink landed under the readability floor.
 */

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-capsule text-[14px] leading-[22px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:text-ink-tertiary",
  {
    variants: {
      variant: {
        primary:
          "bg-button-primary text-ink-on-primary enabled:hover:bg-button-primary-hover disabled:bg-interactive-solid",
        accent:
          "bg-accent-primary text-ink-on-accent enabled:hover:bg-accent-hover disabled:bg-interactive-solid",
        ghost:
          "bg-transparent enabled:hover:bg-interactive-hover enabled:active:bg-interactive-active",
        outline:
          "border border-line-2 bg-transparent enabled:hover:bg-interactive-hover disabled:border-line-1",
        toolbar: "bg-surface-overlay/50 text-ink-on-chrome",
        danger:
          "bg-danger text-ink-on-accent enabled:hover:bg-danger/90 disabled:bg-interactive-solid",
        // ARMED - the quiet-to-committed pair. Rest is an outline capsule;
        // `data-armed="true"` swaps in the primary ink inversion (chronos:
        // paper fill + ink text, celeris: ink fill + white text - the
        // EXISTING primary tokens, no new colour). The owner of the arming
        // signal passes `data-armed`; it must never carry the value that
        // armed it.
        armed:
          "border border-line-2 bg-transparent text-ink-primary transition-colors duration-150 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none enabled:hover:bg-interactive-hover disabled:border-line-1 data-[armed=true]:border-transparent data-[armed=true]:bg-button-primary data-[armed=true]:text-ink-on-primary data-[armed=true]:enabled:hover:bg-button-primary-hover data-[armed=true]:disabled:bg-interactive-solid",
      },
      size: {
        default: "h-9 px-3.5",
        sm: "h-7 px-2.5 text-[12px] leading-[18px]",
        lg: "h-11 px-5",
        icon: "h-9 w-9 px-0",
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
