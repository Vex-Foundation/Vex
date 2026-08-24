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
          className="h-11 pr-16"
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-label={visible ? "Hide password" : "Show password"}
          // Tier floor is SECONDARY, not tertiary: this is a CONTROL wearing
          // a micro label, and at the pre-shell's small-caps size tertiary
          // reads as decoration rather than something to click - in celeris
          // especially. Hover lifts to primary.
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-2 py-0.5 vex-micro text-ink-secondary hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
        >
          {visible ? "hide" : "show"}
        </button>
      </div>
    );
  }
);
