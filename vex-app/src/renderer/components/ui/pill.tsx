/**
 * Pill: small capsule label chip (view switchers, filters, badges).
 * Interactive when onClick is supplied (renders a button); otherwise a
 * static span. Capsule radius = height / 2.
 */

import type { ButtonHTMLAttributes, JSX, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const pillVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-capsule border-0",
  {
    variants: {
      variant: {
        neutral: "bg-surface-2 text-ink-secondary",
        accent: "bg-accent-wash text-accent-primary",
        danger: "bg-danger-wash text-danger",
      },
      size: {
        md: "h-6 px-2 text-[12px] leading-[18px]",
        sm: "h-5 px-1.5 text-[11px] leading-[14px]",
      },
    },
    defaultVariants: {
      variant: "neutral",
      size: "md",
    },
  },
);

export interface PillProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof pillVariants> {
  readonly children?: ReactNode;
}

export function Pill({
  variant,
  size,
  className,
  children,
  onClick,
  ...rest
}: PillProps): JSX.Element {
  if (onClick === undefined) {
    return (
      <span className={cn(pillVariants({ variant, size }), className)}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
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
