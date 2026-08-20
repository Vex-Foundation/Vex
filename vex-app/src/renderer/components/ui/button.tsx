/**
 * Button primitive: capsule silhouette (radius = height / 2) on tokens v2.
 * `primary` is INK/PAPER; `accent` marks the main action only. Hover is an
 * immediate color change - no transition, no shadow depth.
 */

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-capsule text-[14px] leading-[22px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40",
  {
    variants: {
      variant: {
        primary:
          "bg-button-primary text-ink-on-primary enabled:hover:bg-button-primary-hover",
        accent:
          "bg-accent-primary text-ink-on-accent enabled:hover:bg-accent-hover",
        ghost:
          "bg-transparent enabled:hover:bg-interactive-hover enabled:active:bg-interactive-active",
        outline:
          "border border-line-2 bg-transparent enabled:hover:bg-interactive-hover",
        toolbar: "bg-surface-overlay/50 text-ink-on-chrome",
        danger: "bg-danger text-ink-on-accent enabled:hover:bg-danger/90",
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
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
);
Button.displayName = "Button";

export { buttonVariants };
