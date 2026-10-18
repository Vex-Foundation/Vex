/**
 * Password input with a show/hide eye toggle. Generic primitive — does
 * NOT bake in React Hook Form semantics so it stays reusable for any
 * future password-style field (per codex turn 5 small adjustment).
 *
 * The caller wires `register("field").ref` (or any other ref) directly
 * via `forwardRef`. Submit handlers are responsible for clearing the
 * underlying input via `inputRef.current.value = ""` after IPC success
 * — we keep no internal state for the value (uncontrolled).
 */

import {
  forwardRef,
  useState,
  type InputHTMLAttributes,
  type JSX,
} from "react";
import { Input } from "../ui/input.js";
import { cn } from "../../lib/utils.js";

export interface PasswordFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  readonly visibleByDefault?: boolean;
}

export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(
  function PasswordField(
    { className, visibleByDefault = false, ...props },
    ref
  ): JSX.Element {
    const [visible, setVisible] = useState(visibleByDefault);
    return (
      <div className={cn("relative", className)}>
        <Input
          ref={ref}
          type={visible ? "text" : "password"}
          autoComplete="new-password"
          spellCheck={false}
          className="h-[42px] pr-16"
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-label={visible ? "Hide password" : "Show password"}
          // The R3 wizard render's "Show": a word in the blue at 13 / 500,
          // sentence case, square (radius 0), the kit's 2px focus outline.
          className="absolute right-3 top-1/2 -translate-y-1/2 px-1 py-0.5 text-[13px] font-medium text-accent-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--vex-alias-focus)]"
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
    );
  }
);
