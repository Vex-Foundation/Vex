/**
 * Button primitive: the general key, in VEX Cloud's v99 variants and sizes
 * (docs/design/H3-DESKTOP.md section 5.2; Cloud's `contracts/keys.md` and
 * `apps/web/src/styles/keys.css`, the h3-kit-gaps decisions D2-1 to D2-4).
 *
 * A key is a square with its word in caps (13 at 400, the label tracking),
 * never a shadow and never a radius. On a page there is no cell around it, so
 * it takes a fixed height and wears its own 1px edge. The variants keep
 * their names and their meaning (which action a call site gives them never
 * changes here); only their look follows Cloud's map:
 *
 *   primary  the blue key, the one action of a view (Cloud's `primary`): the
 *            blue fill, white word, a blue edge
 *   ink      the refusing or destructive choice (Decline, Reject, a danger
 *            confirm): Cloud's `strong`, the raised ground at full ink in the
 *            40% control edge. Never red, never blue: red is never a key
 *            (D2-4)
 *   stop     the key that stops work (Stop agent, Stop mission): `strong`
 *            too, as Cloud draws Stop
 *   quiet    toolbars and card actions: Cloud's `outline`, the framed key
 *            (the cell ground in the 7% rule), ink 2 words
 *   ghost    the secondary affirmative: the framed key as well; blue is the
 *            primary's alone
 *   armed    a quiet key whose `data-armed="true"` swaps in the primary blue:
 *            the one control whose ENABLEMENT is the message (the unlock key
 *            lighting up the moment a password is typed)
 *   bare     icon keys in chrome: Cloud's `ghost`, no ground and no edge, ink
 *            2 words
 *
 * Sizes (Cloud's D2-2): `default` is md, 40 high, padding 0 18, gap 10, 13px;
 * `sm` 32, padding 0 14, gap 8, 12px; `lg` 44, padding 0 24; `icon` the 32
 * square glyph key.
 *
 * States: hover lifts the word to ink and raises a fill from the key's foot
 * (white 7%, the blue hover on the blue key) over `--vex-duration-key-fill`,
 * hovering pointers only; a press moves the key down 1px. A key that will not
 * act is HELD, never dimmed: the cell ground, a muted word, the 7% edge, no
 * fill (the safety gates keep native `disabled`). Focus is the 2px ink ring,
 * 2 clear of the key.
 *
 * Every class here is a Tailwind utility, so a call site's own utilities
 * (`h-11`, `w-full`, `px-3`) still win through `cn`'s merge, as before.
 *
 * STYLING CONTRACT: every Button emits `data-vex-button` (the resolved
 * variant) and `data-vex-button-size` (the resolved size), the stable hooks
 * for cross-file rules (the pre-shell CTA in `chronos-gate.css`, the dialog's
 * foot in `ui-primitives/overlays.css`).
 */

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

/**
 * The fill that rises on hover: a `::before` under the word, its own
 * stacking context (`isolate`) so it never paints over the label. Each
 * variant sets `--vex-key-fill`; a held key sets none.
 */
const KEY_FILL =
  "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:origin-bottom before:scale-y-0 before:bg-[var(--vex-key-fill)] before:transition-transform before:duration-[var(--vex-duration-key-fill)] before:ease-[var(--vex-ease-out)] enabled:hover:before:scale-y-100 motion-reduce:before:transition-none";

/** The held look, for every variant: the cell ground, a muted word, the 7% edge. */
const HELD =
  "disabled:cursor-not-allowed disabled:border-rule disabled:bg-surface-3 disabled:text-ink-tertiary disabled:[--vex-key-fill:transparent]";

const buttonVariants = cva(
  cn(
    "relative isolate inline-flex items-center justify-center gap-2.5 whitespace-nowrap border border-transparent bg-transparent font-normal uppercase leading-none tracking-[var(--tracking-label)] text-ink-secondary transition-colors duration-[var(--vex-duration-fast)] ease-[var(--vex-ease-standard)] motion-reduce:transition-none enabled:hover:text-ink-primary enabled:active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [--vex-key-fill:var(--vex-alias-key-fill-hover)]",
    KEY_FILL,
    HELD,
  ),
  {
    variants: {
      variant: {
        primary:
          "border-button-accent bg-button-accent text-ink-on-button-accent enabled:hover:text-ink-on-button-accent [--vex-key-fill:var(--vex-alias-button-accent-hover)]",
        ghost: "border-rule bg-surface-3",
        ink: "border-rule-control bg-interactive-solid text-ink-primary",
        stop: "border-rule-control bg-interactive-solid text-ink-primary",
        quiet:
          "border-rule bg-surface-3 data-[armed=true]:border-button-accent data-[armed=true]:bg-button-accent data-[armed=true]:text-ink-on-button-accent data-[armed=true]:[--vex-key-fill:var(--vex-alias-button-accent-hover)]",
        // `armed` is the quiet recipe under its own seam name: the unlock CTA
        // is asserted by `data-vex-button="armed"`. The arming signal is
        // `data-armed`, which swaps the blue in.
        armed:
          "border-rule bg-surface-3 data-[armed=true]:border-button-accent data-[armed=true]:bg-button-accent data-[armed=true]:text-ink-on-button-accent data-[armed=true]:[--vex-key-fill:var(--vex-alias-button-accent-hover)]",
        bare: "",
      },
      size: {
        default: "h-10 px-[18px] text-[13px]",
        sm: "h-8 gap-2 px-3.5 text-[12px]",
        lg: "h-11 px-6 text-[13px]",
        icon: "h-8 w-8 px-0 text-[13px]",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
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
  ),
);
Button.displayName = "Button";

export { buttonVariants };
