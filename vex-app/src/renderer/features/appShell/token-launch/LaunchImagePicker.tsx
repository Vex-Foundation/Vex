/**
 * The image field of the launch form - the one genuinely new interaction.
 *
 * A Vex launch REQUIRES an image. That is our product rule, not a contract
 * rule: the Diamond accepts empty image bytes (`launch_preview` proves it), and
 * we refuse to. So this field is not optional decoration - with nothing picked,
 * there is no preview and no Deploy.
 *
 * ── WHY THERE IS NO `<input type="file">` ─────────────────────────────────
 * No renderer filesystem access exists anywhere in this repo, and none is being
 * introduced here. The user picks from the LOCKER (images main already
 * validated and stored), or presses Add, which opens MAIN's own picker
 * (`vex:images:upload`). The renderer never learns, sends, or guesses a
 * filesystem path - the whole traversal class is designed out rather than
 * filtered. Thumbnails arrive as `data:` URLs over already-validated bytes,
 * which `index.html`'s `img-src 'self' data:` already permits.
 *
 * Refusals (over-cap, wrong magic bytes) are main's message rendered verbatim
 * in an inline alert: main knows the actual size and the actual limit, and a
 * sentence invented here could only be vaguer or wrong. A CANCELLED picker is
 * silent - the user closed a dialog they opened, which is not an error.
 *
 * LOOK (docs/design/R3-MINIMAL.md sections 1.3, 1.5 and 12). The pick area is a
 * 1px dotted rule box holding the chosen picture and the Add image key (the kit
 * `Button`, quiet and small). Every picture is square: the 64px preview and the
 * 44px locker tiles carry a 1px rule, and the chosen tile takes the 1.5px blue
 * frame plus a solid swatch in its corner, so the choice is never colour alone.
 * Notes are a swatch beside the sentence in ink, never red or amber.
 */

import { useState, type JSX, type ReactNode } from "react";
import type { LockerImage } from "@shared/schemas/images.js";
import type { VexError } from "@shared/ipc/result.js";
import {
  useLockerImageThumb,
  useLockerImages,
  useUploadLockerImage,
} from "../../../lib/api/images.js";
import { Button } from "../../../components/ui/button.js";
import { Swatch } from "../../../components/ui/swatch.js";
import { cn } from "../../../lib/utils.js";
import {
  DIALOG_HINT_CLASS,
  DIALOG_LABEL_CLASS,
} from "../SessionCreator/dialog-fields.js";

interface LaunchImagePickerProps {
  readonly selectedImageId: string | null;
  readonly onSelect: (imageId: string) => void;
  readonly disabled: boolean;
}

export function LaunchImagePicker({
  selectedImageId,
  onSelect,
  disabled,
}: LaunchImagePickerProps): JSX.Element {
  const query = useLockerImages();
  const upload = useUploadLockerImage();
  const [notice, setNotice] = useState<string | null>(null);

  const result = query.data;
  const images: readonly LockerImage[] =
    result?.ok === true ? result.data.images : [];
  const selected =
    images.find((image) => image.imageId === selectedImageId) ?? null;

  function runUpload(): void {
    setNotice(null);
    upload.mutate(undefined, {
      onSuccess: (outcome) => {
        if (!outcome.ok) {
          setNotice(uploadNotice(outcome.error));
          return;
        }
        // An in-flight upload is almost always meant for THIS launch, so it
        // selects itself. Saving the user a second click here also removes the
        // failure mode where they add an image, don't notice it wasn't
        // selected, and stare at a Deploy button that stays disabled.
        onSelect(outcome.data.image.imageId);
      },
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="vex-launch-image" className={DIALOG_LABEL_CLASS}>
        Image
      </label>
      <p className={DIALOG_HINT_CLASS}>
        Required. Pick one from your launch photos, or add a new one - the
        picture is published with the token, so it can&apos;t be changed
        afterwards.
      </p>

      <div className="flex items-start gap-3 border border-dotted border-rule p-3">
        <SelectedImageWell image={selected} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {selected !== null ? (
            <>
              <span className="truncate text-[13px] text-ink-secondary">
                {selected.label}
              </span>
              <span className="vex-num text-[12px] text-ink-tertiary">
                {selected.width}×{selected.height} · {selected.byteLength} bytes
              </span>
            </>
          ) : (
            <span className="text-[13px] text-ink-tertiary">
              No image selected.
            </span>
          )}
          <Button
            id="vex-launch-image"
            type="button"
            variant="quiet"
            size="sm"
            onClick={runUpload}
            disabled={disabled || upload.isPending}
            className="mt-1 w-fit"
          >
            {upload.isPending ? "Adding…" : "Add image"}
          </Button>
        </div>
      </div>

      <LockerStrip
        query={query}
        images={images}
        selectedImageId={selectedImageId}
        onSelect={onSelect}
        disabled={disabled}
      />

      {notice !== null ? <PickerNote state="error" role="alert">{notice}</PickerNote> : null}
    </div>
  );
}

function LockerStrip({
  query,
  images,
  selectedImageId,
  onSelect,
  disabled,
}: {
  readonly query: ReturnType<typeof useLockerImages>;
  readonly images: readonly LockerImage[];
  readonly selectedImageId: string | null;
  readonly onSelect: (imageId: string) => void;
  readonly disabled: boolean;
}): JSX.Element {
  const result = query.data;

  if (query.isLoading) {
    return <PickerNote state="ongoing">Loading your photos…</PickerNote>;
  }

  // A failed locker read is NOT "you have no photos" - saying so would send the
  // user off to re-upload images they already have.
  if (query.isError || (result !== undefined && !result.ok)) {
    return (
      <PickerNote state="concerned">
        Couldn&apos;t read your image locker - add an image to continue.
      </PickerNote>
    );
  }

  if (images.length === 0) {
    return (
      <p className={DIALOG_HINT_CLASS}>
        Your launch photos are empty. Add one here, or from the Launchpad card
        in the right-hand panel.
      </p>
    );
  }

  return (
    <ul className="flex flex-row flex-wrap gap-2">
      {images.map((image) => (
        <li key={image.imageId}>
          <LockerTile
            image={image}
            selected={image.imageId === selectedImageId}
            onSelect={onSelect}
            disabled={disabled}
          />
        </li>
      ))}
    </ul>
  );
}

function LockerTile({
  image,
  selected,
  onSelect,
  disabled,
}: {
  readonly image: LockerImage;
  readonly selected: boolean;
  readonly onSelect: (imageId: string) => void;
  readonly disabled: boolean;
}): JSX.Element {
  const thumb = useLockerImageThumb(image.imageId);
  const dataUrl = thumb.data?.ok === true ? thumb.data.data.dataUrl : null;

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`Use ${image.label}`}
      disabled={disabled}
      onClick={() => onSelect(image.imageId)}
      className={cn(
        "relative size-11 overflow-hidden",
        "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-focus",
        "disabled:cursor-not-allowed disabled:border-dotted",
        selected
          ? "border-[1.5px] border-accent-primary"
          : "border border-rule enabled:hover:border-rule-ink",
      )}
    >
      {dataUrl !== null ? (
        // Decorative INSIDE the button: the accessible name is the button's
        // own aria-label, so an empty alt avoids announcing the label twice.
        <img src={dataUrl} alt="" className="size-full object-cover" />
      ) : (
        <span className="block size-full bg-surface-field" />
      )}
      {selected ? (
        // The mark of the chosen tile, on a paper chip so it holds over any
        // picture. Decorative: `aria-pressed` already says it.
        <span
          aria-hidden="true"
          className="absolute bottom-0 right-0 flex bg-surface-2 p-[3px] text-accent-primary"
        >
          <Swatch state="done" size={10} />
        </span>
      ) : null}
    </button>
  );
}

/** The 64×64 preview well for the chosen image: square, a 1px rule. */
function SelectedImageWell({
  image,
}: {
  readonly image: LockerImage | null;
}): JSX.Element {
  const thumb = useLockerImageThumb(image?.imageId ?? null);
  const dataUrl = thumb.data?.ok === true ? thumb.data.data.dataUrl : null;

  return (
    <div className="size-16 shrink-0 overflow-hidden border border-rule bg-surface-field">
      {dataUrl !== null && image !== null ? (
        <img
          src={dataUrl}
          alt={`Selected launch image: ${image.label}`}
          className="size-full object-cover"
        />
      ) : null}
    </div>
  );
}

/**
 * A flat note under the picker: the swatch, then the sentence in ink. The
 * fill carries the state (loading = dot screen, trouble = concerned, a refusal =
 * error) and the sentence says it in words.
 */
function PickerNote({
  state,
  role,
  children,
}: {
  readonly state: "ongoing" | "concerned" | "error";
  readonly role?: "alert";
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <p role={role} className="flex items-start gap-2 text-[13px] leading-[1.45] text-ink-primary">
      <Swatch state={state} size={10} className="mt-1 shrink-0 text-accent-primary" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/**
 * A cancelled picker must stay silent - the user closed a dialog they opened.
 * Everything else is main's already-redacted message, which names the actual
 * limit and the actual size.
 */
function uploadNotice(error: VexError): string | null {
  return error.code === "internal.cancelled" ? null : error.message;
}
