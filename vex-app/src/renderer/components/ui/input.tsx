/**
 * Input primitive on tokens v2: r-md, input-tier stroke (one step thinner
 * in dark), accent caret. Deliberately NO focus ring - the caret and the
 * stroke are the whole focus treatment.
 *
 * Forwarded ref is the plumbing the wizard's password fields need
 * (uncontrolled `<input type="password">` with React Hook Form's
 * `register("field").ref`, post-submit `inputRef.current.value = ""`).
 */

import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-9 w-full rounded-md border border-line-input bg-transparent px-3 py-1 text-sm text-ink-primary caret-accent-primary",
        "file:border-0 file:bg-transparent file:text-sm file:font-medium",
        "placeholder:text-ink-tertiary",
        "focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-40",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";
