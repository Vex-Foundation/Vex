/**
 * shadcn-pattern Label primitive — owned source per skill §2.
 * Pure CSS, no Radix Label (Radix variant only matters when associating
 * with non-native form controls; native `<input>` + `htmlFor` is enough
 * for accessibility and screen readers).
 */

import { forwardRef, type LabelHTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

export type LabelProps = LabelHTMLAttributes<HTMLLabelElement>;

export const Label = forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn(
        "text-sm font-medium leading-none text-ink-secondary peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className
      )}
      {...props}
    />
  )
);
Label.displayName = "Label";
