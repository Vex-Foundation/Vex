/**
 * Input primitive on tokens v2: r-md, input-tier stroke (one step thinner
 * in dark), accent caret. Deliberately NO focus RING - but the stroke has
 * to carry the state on its own, so `focus-visible` re-points the border to
 * the accent (the deepseek `:focus-within { border-color: brand }`
 * convention). Caret + resting stroke alone left near-no visible focus on
 * light surfaces, where `border-line-input` is rgba(10,13,24,0.1).
 *
 * Disabled pins an ink tier instead of stacking opacity on the text
 * (design-language §2), so a disabled field's value stays readable.
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
        "focus-visible:outline-none focus-visible:border-accent-primary",
        "disabled:cursor-not-allowed disabled:border-line-1 disabled:text-ink-tertiary disabled:placeholder:text-ink-caption",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";
