/**
 * The pools.fun launch form fields. A controlled component: it owns no
 * submission and no IPC, because the payload prepared in stage 1 must be
 * derived from exactly the values on screen.
 *
 * Field grammar: a label over a field, a muted hint under it, and a
 * `role="alert"` line under an unusable one. The fields, labels and hints are
 * the shared dialog vocabulary (`SessionCreator/dialog-fields.ts`: the 42 high
 * field, the 13 / 500 label, the 12.5 muted hint). An exclusive choice (the
 * paired asset, the holder payout, the image source) is a row of square keys:
 * the chosen one takes the blue 1.5px frame and a solid swatch, the others a
 * rule outline and an empty swatch, so the choice never rests on colour alone
 * (docs/design/R3-MINIMAL.md sections 1.5 and 12).
 *
 * ── UNTRUSTED INPUT ───────────────────────────────────────────────────────
 * Every value is user-authored text that ends up in public token metadata.
 * Links are constrained AT THE FIELD to `https:` rather than sanitized later, so
 * a `javascript:` or `data:` URL never becomes a valid form value at all.
 */

import type { JSX, ReactNode } from "react";
import { hasForbiddenTokenMetadataText } from "@vex-lib/token-metadata-text-policy.js";
import { Swatch } from "../../../../components/ui/swatch.js";
import { cn } from "../../../../lib/utils.js";
import {
  TOKEN_METADATA_NAME_MAX as LAUNCH_NAME_MAX,
  TOKEN_METADATA_SYMBOL_MAX as LAUNCH_SYMBOL_MAX,
} from "@vex-lib/token-metadata-limits.js";
import {
  DIALOG_FIELD_CLASS,
  DIALOG_HINT_CLASS,
  DIALOG_LABEL_CLASS,
} from "../../SessionCreator/dialog-fields.js";
import { isAcceptableLaunchLink } from "../../token-launch/launch-display.js";
import { LaunchImagePicker } from "../../token-launch/LaunchImagePicker.js";
import { InkCallout } from "../PhaseNote.js";
import type {
  PoolsHolderRewardsMode,
  PoolsPairedAsset,
} from "@shared/schemas/pools-launch.js";
import {
  feeRecipientNeedsResolution,
  isAcceptableFeeRecipient,
  normalizePoolsAmount,
  HOLDER_REWARDS_MODE_LABEL,
  PAIRED_ASSET_LABEL,
  type PoolsImageSource,
  type PoolsLaunchFormValues,
} from "./form-values.js";

/**
 * The pairing options offered today. Tokenised stocks are deliberately absent:
 * `allowedPairedAsset` is false for them on the live factory, so offering one
 * would be an option that can only ever fail at execute time.
 */
const PAIRED_ASSETS: readonly PoolsPairedAsset[] = ["weth", "usdg", "stock"];
/** The three payout modes the launchpad serves, in its own order. */
const HOLDER_REWARDS_MODES: readonly PoolsHolderRewardsMode[] = ["token", "paired", "both"];

/**
 * The kit checkbox (docs/design/R3-MINIMAL.md section 1.5): 16 x 16, a 1.5px
 * ink border, and when on the blue fill with a paper tick. The native input
 * stays the control, so keyboard, label and assistive technology are unchanged.
 */
const CHECKBOX_CLASS = cn(
  "relative mt-[2px] size-4 shrink-0 cursor-pointer appearance-none border-[1.5px] border-rule-ink bg-transparent",
  "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-focus",
  "checked:border-button-accent-edge checked:bg-button-accent",
  "checked:after:absolute checked:after:left-[3.5px] checked:after:top-0 checked:after:h-2 checked:after:w-1 checked:after:rotate-45",
  "checked:after:border-0 checked:after:border-b-2 checked:after:border-r-2 checked:after:border-ink-on-button-accent checked:after:content-['']",
  "disabled:cursor-not-allowed disabled:border-dotted",
);

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
        <label htmlFor="vex-pools-name" className={DIALOG_LABEL_CLASS}>
          Name
        </label>
        <input
          id="vex-pools-name"
          required
          disabled={disabled}
          maxLength={LAUNCH_NAME_MAX}
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="The token's full name"
          className={DIALOG_FIELD_CLASS}
        />
        <ForbiddenTextWarning value={values.name} />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="vex-pools-symbol" className={DIALOG_LABEL_CLASS}>
          Symbol
        </label>
        <input
          id="vex-pools-symbol"
          required
          disabled={disabled}
          maxLength={LAUNCH_SYMBOL_MAX}
          value={values.symbol}
          // Uppercased as typed rather than only on submit, so what the user
          // reads back is exactly what goes on-chain.
          onChange={(e) => set("symbol", e.target.value.toUpperCase())}
          placeholder="TICKER"
          className={DIALOG_FIELD_CLASS}
        />
        <ForbiddenTextWarning value={values.symbol} />
      </div>

      <fieldset className="flex flex-col gap-2" disabled={disabled}>
        {/* A plain caption, NOT a `<Label htmlFor>`: pointing a label at one of
            the radios makes "Paired with" that button's accessible name and
            hides which asset it actually selects. The group is named by the
            legend and the `aria-label` below. */}
        <legend className="sr-only">Paired asset</legend>
        <span className={DIALOG_LABEL_CLASS}>Paired with</span>
        <div role="radiogroup" aria-label="Paired asset" className="flex flex-wrap gap-2">
          {PAIRED_ASSETS.map((asset) => (
            <ChoiceKey
              key={asset}
              id={`vex-pools-pair-${asset}`}
              selected={values.pairedAsset === asset}
              disabled={disabled}
              onChoose={() => set("pairedAsset", asset)}
            >
              {PAIRED_ASSET_LABEL[asset]}
            </ChoiceKey>
          ))}
        </div>
        <p className={DIALOG_HINT_CLASS}>
          The asset your token trades against.
          {values.pairedAsset === "stock"
            ? " A stock-paired pool may have no liquidity at all once it lists; that is unknown until it does."
            : ""}
        </p>
      </fieldset>

      {values.pairedAsset === "stock" ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="vex-pools-stock-address" className={DIALOG_LABEL_CLASS}>
            Which stock
          </label>
          <input
            id="vex-pools-stock-address"
            required
            disabled={disabled}
            value={values.pairedStockAddress}
            onChange={(e) => set("pairedStockAddress", e.target.value)}
            placeholder="0x… the tokenised stock's address"
            className={cn(DIALOG_FIELD_CLASS, "vex-num")}
          />
          {values.pairedStockAddress.trim().length > 0
          && !/^0x[0-9a-fA-F]{40}$/.test(values.pairedStockAddress.trim()) ? (
            <FieldAlert>
              Enter the tokenised stock&apos;s wallet address, starting 0x.
            </FieldAlert>
          ) : (
            <p className={DIALOG_HINT_CLASS}>
              Which of the launchpad&apos;s tokenised stocks this pool trades
              against. Most of them are priced by a signed quote that is only
              valid for a minute or two, so a stock launch has to be confirmed
              straight after it is prepared.
            </p>
          )}
        </div>
      ) : null}

      {/* THE FEE STREAM'S DESTINATION IS A CHOICE BETWEEN TWO KINDS, and the
          irreversible one is a deliberate switch rather than a value that could
          be typed into the recipient box by accident. */}
      <div className="flex flex-col gap-2">
        <label className="flex cursor-pointer items-start gap-2.5 text-[14px] leading-[1.45] text-ink-primary">
          <input
            type="checkbox"
            disabled={disabled}
            checked={values.holderRewards}
            onChange={(e) => set("holderRewards", e.target.checked)}
            className={CHECKBOX_CLASS}
          />
          <span>Pay the trading fees to this token&apos;s holders</span>
        </label>
        {values.holderRewards ? (
          <>
            <InkCallout>
              This is locked at launch and cannot be undone. You will receive
              nothing from this token&apos;s trading fees, ever. The launchpad
              deploys a rewards distributor during the launch, so there is no
              recipient address to check beforehand.
            </InkCallout>
            <div
              role="radiogroup"
              aria-label="Holders are paid in"
              className="flex flex-wrap gap-2"
            >
              {HOLDER_REWARDS_MODES.map((mode) => (
                <ChoiceKey
                  key={mode}
                  id={`vex-pools-holder-mode-${mode}`}
                  selected={values.holderRewardsMode === mode}
                  disabled={disabled}
                  onChoose={() => set("holderRewardsMode", mode)}
                >
                  {HOLDER_REWARDS_MODE_LABEL[mode]}
                </ChoiceKey>
              ))}
            </div>
            <p className={DIALOG_HINT_CLASS}>
              Which asset the holders are paid in.
            </p>
          </>
        ) : null}
      </div>

      <ImageField values={values} disabled={disabled} onSet={set} />

      <div className="flex flex-col gap-2" hidden={values.holderRewards}>
        <label htmlFor="vex-pools-fee-recipient" className={DIALOG_LABEL_CLASS}>
          Fee recipient
        </label>
        <input
          id="vex-pools-fee-recipient"
          required={!values.holderRewards}
          disabled={disabled || values.holderRewards}
          value={values.feeRecipient}
          onChange={(e) => set("feeRecipient", e.target.value)}
          placeholder="0x… or an X username"
          className={cn(DIALOG_FIELD_CLASS, "vex-num")}
        />
        {values.feeRecipient.trim().length > 0
        && !isAcceptableFeeRecipient(values.feeRecipient) ? (
          <FieldAlert>
            Enter a wallet address starting 0x, or an X username.
          </FieldAlert>
        ) : feeRecipientNeedsResolution(values.feeRecipient) ? (
          <p className={DIALOG_HINT_CLASS}>
            Vex will look this username up and show you the address it resolves
            to before you deploy. This is where the token&apos;s trading fees go.
          </p>
        ) : (
          <p className={DIALOG_HINT_CLASS}>
            Where this token&apos;s trading fees are paid, permanently.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="vex-pools-prebuy" className={DIALOG_LABEL_CLASS}>
          Prebuy ({pairLabel})
        </label>
        <input
          id="vex-pools-prebuy"
          disabled={disabled}
          inputMode="decimal"
          value={values.prebuy}
          onChange={(e) => set("prebuy", e.target.value)}
          placeholder="0"
          className={cn(DIALOG_FIELD_CLASS, "vex-num")}
        />
        {!prebuyIsAmount ? (
          <FieldAlert>Enter a plain {pairLabel} amount, like 0.05.</FieldAlert>
        ) : (
          <p className={DIALOG_HINT_CLASS}>
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
 * One key of an exclusive choice. It stays a `role="radio"` button inside a
 * `role="radiogroup"` (that is the semantics the form and its tests rely on);
 * only its paint is R3. Chosen: the 1.5px blue frame, the blue word and a solid
 * swatch. Not chosen: a 1px rule, ink 2 and an empty swatch. The padding gives
 * back the half pixel the heavier frame takes, so choosing never moves a key.
 */
function ChoiceKey({
  id,
  selected,
  disabled,
  onChoose,
  children,
}: {
  readonly id?: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onChoose: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <button
      id={id}
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onChoose}
      className={cn(
        "inline-flex h-8 items-center gap-2 whitespace-nowrap text-[13px] leading-none transition-colors duration-150 motion-reduce:transition-none",
        "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-focus",
        "disabled:cursor-not-allowed disabled:text-ink-tertiary",
        selected
          ? "border-[1.5px] border-accent-primary px-[11.5px] text-accent-primary"
          : "border border-rule px-3 text-ink-secondary enabled:hover:bg-interactive-hover enabled:hover:text-ink-primary",
      )}
    >
      <Swatch state={selected ? "done" : "idle"} size={10} className="text-accent-primary" />
      {children}
    </button>
  );
}

/** A field refusal: the error swatch beside the sentence in ink, never red. */
function FieldAlert({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <p role="alert" className="flex items-start gap-2 text-[13px] leading-[1.45] text-ink-primary">
      <Swatch state="error" size={10} className="mt-1 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
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
      <div role="radiogroup" aria-label="Image source" className="flex flex-wrap gap-2">
        {(["locker", "url"] as const).map((source) => (
          <ChoiceKey
            key={source}
            selected={values.imageSource === source}
            disabled={disabled}
            onChoose={() => onSet("imageSource", source as PoolsImageSource)}
          >
            {source === "locker" ? "From locker" : "From URL"}
          </ChoiceKey>
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
          <label htmlFor="vex-pools-image-url" className={DIALOG_LABEL_CLASS}>
            Image URL
          </label>
          <input
            id="vex-pools-image-url"
            disabled={disabled}
            value={values.imageUrl}
            onChange={(e) => onSet("imageUrl", e.target.value)}
            placeholder="https://"
            className={DIALOG_FIELD_CLASS}
          />
          {urlInvalid ? <FieldAlert>Only https:// links are accepted.</FieldAlert> : null}
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
      <label htmlFor={id} className={DIALOG_LABEL_CLASS}>
        {label}
      </label>
      <input
        id={id}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="https://"
        className={DIALOG_FIELD_CLASS}
      />
      {!isAcceptableLaunchLink(value) ? (
        <FieldAlert>Only https:// links are accepted.</FieldAlert>
      ) : null}
    </div>
  );
}

/** Renders nothing for clean text, so it is safe under every metadata field. */
function ForbiddenTextWarning({ value }: { readonly value: string }): JSX.Element | null {
  if (!hasForbiddenTokenMetadataText(value)) return null;
  return (
    <FieldAlert>
      Remove control characters, including line breaks and tabs, and double
      quotes. This text is written on-chain permanently and cannot be edited
      later.
    </FieldAlert>
  );
}
