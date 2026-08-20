/**
 * The launch form fields. A controlled component: it owns no submission and no
 * IPC — `TokenLaunchDialog` holds the values, because the preview and the
 * consent line have to be derived from exactly the values on screen.
 *
 * Field grammar is `ReportIssueDialog`'s verbatim (`flex flex-col gap-2`, Label
 * + Input, a right-aligned mono `aria-live` counter). The description textarea
 * is hand-rolled with the same classes that dialog uses, because no textarea
 * primitive exists in `components/ui` and inventing one for a single consumer
 * would be a worse trade than repeating six utility classes.
 *
 * ── UNTRUSTED INPUT ───────────────────────────────────────────────────────
 * Every value here is user-authored text that ends up in a token's public
 * metadata and, for links, potentially in a renderer sink. Links are therefore
 * constrained AT THE FIELD to `https:` (`isAcceptableLaunchLink`) rather than
 * sanitized downstream — a `javascript:` or `data:` URL never becomes a valid
 * form value in the first place. Length caps are enforced by `maxLength` AND
 * re-checked main-side; the counter exists so the cap is visible before it
 * bites, not as the enforcement.
 */

import type { JSX } from "react";
import { hasForbiddenTokenMetadataText } from "@vex-lib/token-metadata-text-policy.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { cn } from "../../../lib/utils.js";
import type { TokenLaunchForm } from "../../../lib/api/token-launch.js";
import {
  LAUNCH_DESCRIPTION_MAX,
  LAUNCH_LINKS_MAX,
  LAUNCH_LINK_MAX,
  LAUNCH_NAME_MAX,
  LAUNCH_SYMBOL_MAX,
} from "../../../lib/api/token-launch.js";
import { isAcceptableLaunchLink, normalizeEthInput } from "./launch-display.js";
import { LaunchImagePicker } from "./LaunchImagePicker.js";

export interface LaunchFormValues {
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  readonly links: readonly string[];
  readonly imageId: string | null;
  /**
   * As TYPED, in ETH. It travels to main as a plain decimal string and is
   * converted to wei THERE, once — see `launch-display.normalizeEthInput`.
   */
  readonly prebuyEth: string;
}

export const EMPTY_LAUNCH_FORM: LaunchFormValues = {
  name: "",
  symbol: "",
  description: "",
  links: [""],
  imageId: null,
  prebuyEth: "",
};

/**
 * What the user is told when a field carries text `create()` cannot write.
 *
 * Main is authoritative and refuses the same text with its own worded reason;
 * this exists so the user sees WHY the form will not price, next to the field,
 * instead of discovering it after committing.
 */
const FORBIDDEN_TEXT_MESSAGE =
  "Remove control characters, including line breaks and tabs, and double quotes. This text is written on-chain permanently and cannot be edited later.";

/** Does any on-chain metadata field carry forbidden RAW text? */
function formHasForbiddenMetadataText(values: LaunchFormValues): boolean {
  return (
    hasForbiddenTokenMetadataText(values.name)
    || hasForbiddenTokenMetadataText(values.symbol)
    || hasForbiddenTokenMetadataText(values.description)
    || values.links.some((link) => hasForbiddenTokenMetadataText(link))
  );
}

/**
 * Form values → the IPC parameter set, or `null` when the form cannot be
 * priced yet. Returning `null` is what keeps the preview (and therefore
 * Deploy) disarmed, so every rule below is a reason the user is NOT yet able
 * to authorize a spend:
 *
 *  - name and symbol are required and trimmed;
 *  - an image is REQUIRED — our product rule, enforced before we even ask for
 *    a price rather than surfaced as a refusal after the user has committed;
 *  - the prebuy must be a well-formed plain decimal (`normalizeEthInput`
 *    refuses a 19th decimal rather than truncating it, and converts nothing);
 *  - every non-empty link must be `https:`;
 *  - empty link rows are dropped, so an untouched row never travels as `""`.
 *
 * This is deliberately a pure function of the values on screen: the parameters
 * that get priced are the parameters the user can see. It produces the SHARED
 * `TokenLaunchForm` — the exact object main validates — so there is no second,
 * renderer-shaped description of a launch anywhere.
 */
export function launchFormToParameters(
  values: LaunchFormValues,
): TokenLaunchForm | null {
  // BEFORE the trims below. A leading or trailing line break would otherwise be
  // erased here and never reach the policy, and this form is where the user can
  // still see and fix it.
  if (formHasForbiddenMetadataText(values)) return null;

  const name = values.name.trim();
  const symbol = values.symbol.trim();
  if (name.length === 0 || name.length > LAUNCH_NAME_MAX) return null;
  if (symbol.length === 0 || symbol.length > LAUNCH_SYMBOL_MAX) return null;
  if (values.description.length > LAUNCH_DESCRIPTION_MAX) return null;
  if (values.imageId === null) return null;

  const prebuy = normalizeEthInput(values.prebuyEth);
  if (prebuy === null) return null;

  const links = values.links.map((link) => link.trim()).filter((link) => link.length > 0);
  if (links.length > LAUNCH_LINKS_MAX) return null;
  if (links.some((link) => !isAcceptableLaunchLink(link) || link.length > LAUNCH_LINK_MAX)) {
    return null;
  }

  return {
    name,
    symbol,
    description: values.description.trim(),
    links,
    imageId: values.imageId,
    prebuy,
  };
}

interface LaunchFormProps {
  readonly values: LaunchFormValues;
  readonly onChange: (next: LaunchFormValues) => void;
  readonly disabled: boolean;
}

export function LaunchForm({
  values,
  onChange,
  disabled,
}: LaunchFormProps): JSX.Element {
  function set<K extends keyof LaunchFormValues>(
    key: K,
    value: LaunchFormValues[K],
  ): void {
    onChange({ ...values, [key]: value });
  }

  function setLink(index: number, value: string): void {
    const next = values.links.slice();
    next[index] = value;
    set("links", next);
  }

  const prebuyIsAmount = normalizeEthInput(values.prebuyEth) !== null;

  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="vex-launch-name">Name</Label>
        <Input
          id="vex-launch-name"
          required
          disabled={disabled}
          maxLength={LAUNCH_NAME_MAX}
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="The token's full name"
        />
        <FieldCounter length={values.name.length} max={LAUNCH_NAME_MAX} />
        <ForbiddenTextWarning value={values.name} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="vex-launch-symbol">Symbol</Label>
        <Input
          id="vex-launch-symbol"
          required
          disabled={disabled}
          maxLength={LAUNCH_SYMBOL_MAX}
          value={values.symbol}
          // Uppercased as typed rather than only on submit, so what the user
          // reads back is exactly what goes on-chain.
          onChange={(e) => set("symbol", e.target.value.toUpperCase())}
          placeholder="TICKER"
          className="font-mono uppercase"
        />
        <FieldCounter length={values.symbol.length} max={LAUNCH_SYMBOL_MAX} />
        <ForbiddenTextWarning value={values.symbol} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="vex-launch-description">Description</Label>
        <textarea
          id="vex-launch-description"
          disabled={disabled}
          maxLength={LAUNCH_DESCRIPTION_MAX}
          value={values.description}
          onChange={(e) => set("description", e.target.value)}
          rows={3}
          placeholder="What is this token?"
          className={cn(
            "min-h-24 w-full rounded-xl border border-line-3 bg-surface-deep px-3 py-2 text-sm shadow-none",
            "placeholder:text-ink-tertiary",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
            "disabled:opacity-50",
          )}
        />
        <FieldCounter
          length={values.description.length}
          max={LAUNCH_DESCRIPTION_MAX}
        />
        <ForbiddenTextWarning value={values.description} />
      </div>

      <LaunchImagePicker
        selectedImageId={values.imageId}
        onSelect={(imageId) => set("imageId", imageId)}
        disabled={disabled}
      />

      <LinkRows
        links={values.links}
        disabled={disabled}
        onChangeLink={setLink}
        onAddRow={() => set("links", [...values.links, ""])}
      />

      <div className="flex flex-col gap-2">
        <Label htmlFor="vex-launch-prebuy">Prebuy (ETH)</Label>
        <Input
          id="vex-launch-prebuy"
          disabled={disabled}
          inputMode="decimal"
          value={values.prebuyEth}
          onChange={(e) => set("prebuyEth", e.target.value)}
          placeholder="0"
          className="font-mono tabular-nums"
        />
        {!prebuyIsAmount ? (
          <p className="text-sm text-danger" role="alert">
            Enter a plain ETH amount, like 0.05 — up to 18 decimal places.
          </p>
        ) : (
          <p className="text-[11px] leading-relaxed text-ink-tertiary">
            Bought for you in the same transaction that creates the token.
            Leave it at 0 to launch without buying.
          </p>
        )}
      </div>
    </>
  );
}

function LinkRows({
  links,
  disabled,
  onChangeLink,
  onAddRow,
}: {
  readonly links: readonly string[];
  readonly disabled: boolean;
  readonly onChangeLink: (index: number, value: string) => void;
  readonly onAddRow: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="vex-launch-link-0">Links</Label>
      <p className="text-[11px] leading-relaxed text-ink-tertiary">
        Optional, up to {LAUNCH_LINKS_MAX}. Must start with https://
      </p>
      {links.map((link, index) => {
        const invalid = !isAcceptableLaunchLink(link);
        return (
          <div key={index} className="flex flex-col gap-1">
            <Input
              id={`vex-launch-link-${index}`}
              aria-label={`Link ${index + 1}`}
              disabled={disabled}
              maxLength={LAUNCH_LINK_MAX}
              value={link}
              onChange={(e) => onChangeLink(index, e.target.value)}
              placeholder="https://"
            />
            {hasForbiddenTokenMetadataText(link) ? (
              <ForbiddenTextWarning value={link} />
            ) : invalid ? (
              <p className="text-sm text-danger" role="alert">
                Only https:// links are accepted.
              </p>
            ) : null}
          </div>
        );
      })}
      {links.length < LAUNCH_LINKS_MAX ? (
        <button
          type="button"
          onClick={onAddRow}
          disabled={disabled}
          className="w-fit rounded-full border border-line-2 px-3 py-1 font-doto text-[11px] font-medium uppercase tracking-[0.16em] text-ink-secondary transition-colors hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-50"
        >
          Add link
        </button>
      ) : null}
    </div>
  );
}

/**
 * The forbidden-character notice. Renders nothing for clean text, so it is safe
 * to place under every metadata field.
 */
function ForbiddenTextWarning({ value }: { readonly value: string }): JSX.Element | null {
  if (!hasForbiddenTokenMetadataText(value)) return null;
  return (
    <p className="text-sm text-danger" role="alert">
      {FORBIDDEN_TEXT_MESSAGE}
    </p>
  );
}

function FieldCounter({
  length,
  max,
}: {
  readonly length: number;
  readonly max: number;
}): JSX.Element {
  return (
    <div className="flex items-center justify-end font-mono text-[10px] tabular-nums text-ink-tertiary">
      <span aria-live="polite">
        {length} / {max}
      </span>
    </div>
  );
}
