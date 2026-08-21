/**
 * The pools.fun launch form fields. A controlled component: it owns no
 * submission and no IPC, because the payload prepared in stage 1 must be
 * derived from exactly the values on screen.
 *
 * Field grammar follows `token-launch/LaunchForm.tsx` verbatim (Label + Input,
 * a `role="alert"` line under an unusable field), so the two launchpads read as
 * one product rather than two.
 *
 * ── UNTRUSTED INPUT ───────────────────────────────────────────────────────
 * Every value is user-authored text that ends up in public token metadata.
 * Links are constrained AT THE FIELD to `https:` rather than sanitized later, so
 * a `javascript:` or `data:` URL never becomes a valid form value at all.
 */

import type { JSX } from "react";
import { hasForbiddenTokenMetadataText } from "@vex-lib/token-metadata-text-policy.js";
import { Input } from "../../../../components/ui/input.js";
import { Label } from "../../../../components/ui/label.js";
import {
  LAUNCH_NAME_MAX,
  LAUNCH_SYMBOL_MAX,
} from "../../../../lib/api/token-launch.js";
import { isAcceptableLaunchLink } from "../../token-launch/launch-display.js";
import { LaunchImagePicker } from "../../token-launch/LaunchImagePicker.js";
import type { PoolsPairedAsset } from "@shared/schemas/pools-launch.js";
import {
  feeRecipientNeedsResolution,
  isAcceptableFeeRecipient,
  normalizePoolsAmount,
  PAIRED_ASSET_LABEL,
  type PoolsImageSource,
  type PoolsLaunchFormValues,
} from "./form-values.js";

/**
 * The pairing options offered today. Tokenised stocks are deliberately absent:
 * `allowedPairedAsset` is false for them on the live factory, so offering one
 * would be an option that can only ever fail at execute time.
 */
const PAIRED_ASSETS: readonly PoolsPairedAsset[] = ["weth", "usdg"];

export function PoolsLaunchForm({
  values,
  onChange,
  disabled,
}: {
  readonly values: PoolsLaunchFormValues;
  readonly onChange: (next: PoolsLaunchFormValues) => void;
  readonly disabled: boolean;
}): JSX.Element {
  function set<K extends keyof PoolsLaunchFormValues>(
    key: K,
    value: PoolsLaunchFormValues[K],
  ): void {
    onChange({ ...values, [key]: value });
  }

  const prebuyIsAmount =
    normalizePoolsAmount(values.prebuy, values.pairedAsset === "weth" ? 18 : 6) !== null;
  const pairLabel = PAIRED_ASSET_LABEL[values.pairedAsset];

  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="vex-pools-name">Name</Label>
        <Input
          id="vex-pools-name"
          required
          disabled={disabled}
          maxLength={LAUNCH_NAME_MAX}
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="The token's full name"
        />
        <ForbiddenTextWarning value={values.name} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="vex-pools-symbol">Symbol</Label>
        <Input
          id="vex-pools-symbol"
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
        <ForbiddenTextWarning value={values.symbol} />
      </div>

      <fieldset className="flex flex-col gap-2" disabled={disabled}>
        {/* A plain caption, NOT a `<Label htmlFor>`: pointing a label at one of
            the radios makes "Paired with" that button's accessible name and
            hides which asset it actually selects. The group is named by the
            legend and the `aria-label` below. */}
        <legend className="sr-only">Paired asset</legend>
        <span className="text-sm font-medium text-ink-primary">Paired with</span>
        <div role="radiogroup" aria-label="Paired asset" className="flex gap-1.5">
          {PAIRED_ASSETS.map((asset) => (
            <button
              key={asset}
              id={`vex-pools-pair-${asset}`}
              type="button"
              role="radio"
              aria-checked={values.pairedAsset === asset}
              disabled={disabled}
              onClick={() => set("pairedAsset", asset)}
              className={
                "rounded-full border px-3 py-1 vex-doto-label vex-doto-label--wide uppercase transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-50 "
                + (values.pairedAsset === asset
                  ? "border-line-3 text-ink-primary"
                  : "border-line-2 text-ink-tertiary hover:text-ink-secondary")
              }
            >
              {PAIRED_ASSET_LABEL[asset]}
            </button>
          ))}
        </div>
        <p className="text-[11px] leading-relaxed text-ink-tertiary">
          The asset your token trades against. Tokenised stocks are not offered:
          the launchpad&apos;s factory does not accept them today.
        </p>
      </fieldset>

      <ImageField values={values} disabled={disabled} onSet={set} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="vex-pools-fee-recipient">Fee recipient</Label>
        <Input
          id="vex-pools-fee-recipient"
          required
          disabled={disabled}
          value={values.feeRecipient}
          onChange={(e) => set("feeRecipient", e.target.value)}
          placeholder="0x… or an X username"
          className="font-mono"
        />
        {values.feeRecipient.trim().length > 0
        && !isAcceptableFeeRecipient(values.feeRecipient) ? (
          <p className="text-sm text-danger" role="alert">
            Enter a wallet address starting 0x, or an X username.
          </p>
        ) : feeRecipientNeedsResolution(values.feeRecipient) ? (
          <p className="text-[11px] leading-relaxed text-ink-tertiary">
            Vex will look this username up and show you the address it resolves
            to before you deploy. This is where the token&apos;s trading fees go.
          </p>
        ) : (
          <p className="text-[11px] leading-relaxed text-ink-tertiary">
            Where this token&apos;s trading fees are paid, permanently.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="vex-pools-prebuy">Prebuy ({pairLabel})</Label>
        <Input
          id="vex-pools-prebuy"
          disabled={disabled}
          inputMode="decimal"
          value={values.prebuy}
          onChange={(e) => set("prebuy", e.target.value)}
          placeholder="0"
          className="font-mono tabular-nums"
        />
        {!prebuyIsAmount ? (
          <p className="text-sm text-danger" role="alert">
            Enter a plain {pairLabel} amount, like 0.05.
          </p>
        ) : (
          <p className="text-[11px] leading-relaxed text-ink-tertiary">
            Bought for you in the same transaction that creates the token. Leave
            it at 0 to launch without buying.
          </p>
        )}
      </div>

      <OptionalLink
        id="vex-pools-website"
        label="Website"
        value={values.websiteUrl}
        disabled={disabled}
        onChange={(next) => set("websiteUrl", next)}
      />
      <OptionalLink
        id="vex-pools-tweet"
        label="X post"
        value={values.tweetUrl}
        disabled={disabled}
        onChange={(next) => set("tweetUrl", next)}
      />
    </>
  );
}

/**
 * The image, from the shared locker OR a URL.
 *
 * Unlike a Trench launch the picture is NOT stored on-chain here, so it costs no
 * gas and a plain link is a legitimate choice. Exactly one source is active at a
 * time, because sending both leaves the provider to pick and drop the other in
 * silence.
 */
function ImageField({
  values,
  disabled,
  onSet,
}: {
  readonly values: PoolsLaunchFormValues;
  readonly disabled: boolean;
  readonly onSet: <K extends keyof PoolsLaunchFormValues>(
    key: K,
    value: PoolsLaunchFormValues[K],
  ) => void;
}): JSX.Element {
  const urlInvalid =
    values.imageUrl.trim().length > 0 && !isAcceptableLaunchLink(values.imageUrl);

  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label="Image source" className="flex gap-1.5">
        {(["locker", "url"] as const).map((source) => (
          <button
            key={source}
            type="button"
            role="radio"
            aria-checked={values.imageSource === source}
            disabled={disabled}
            onClick={() => onSet("imageSource", source as PoolsImageSource)}
            className={
              "rounded-full border px-3 py-1 vex-doto-label vex-doto-label--wide uppercase transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-50 "
              + (values.imageSource === source
                ? "border-line-3 text-ink-primary"
                : "border-line-2 text-ink-tertiary hover:text-ink-secondary")
            }
          >
            {source === "locker" ? "From locker" : "From URL"}
          </button>
        ))}
      </div>

      {values.imageSource === "locker" ? (
        <LaunchImagePicker
          selectedImageId={values.imageId}
          onSelect={(imageId) => onSet("imageId", imageId)}
          disabled={disabled}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="vex-pools-image-url">Image URL</Label>
          <Input
            id="vex-pools-image-url"
            disabled={disabled}
            value={values.imageUrl}
            onChange={(e) => onSet("imageUrl", e.target.value)}
            placeholder="https://"
          />
          {urlInvalid ? (
            <p className="text-sm text-danger" role="alert">
              Only https:// links are accepted.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function OptionalLink({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (next: string) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="https://"
      />
      {!isAcceptableLaunchLink(value) ? (
        <p className="text-sm text-danger" role="alert">
          Only https:// links are accepted.
        </p>
      ) : null}
    </div>
  );
}

/** Renders nothing for clean text, so it is safe under every metadata field. */
function ForbiddenTextWarning({ value }: { readonly value: string }): JSX.Element | null {
  if (!hasForbiddenTokenMetadataText(value)) return null;
  return (
    <p className="text-sm text-danger" role="alert">
      Remove control characters, including line breaks and tabs, and double
      quotes. This text is written on-chain permanently and cannot be edited
      later.
    </p>
  );
}
