/**
 * The image field of the launch form — the one genuinely new interaction.
 *
 * A Vex launch REQUIRES an image. That is our product rule, not a contract
 * rule: the Diamond accepts empty image bytes (`launch_preview` proves it), and
 * we refuse to. So this field is not optional decoration — with nothing picked,
 * there is no preview and no Deploy.
 *
 * ── WHY THERE IS NO `<input type="file">` ─────────────────────────────────
 * No renderer filesystem access exists anywhere in this repo, and none is being
 * introduced here. The user picks from the LOCKER (images main already
 * validated and stored), or presses Add, which opens MAIN's own picker
 * (`vex:images:upload`). The renderer never learns, sends, or guesses a
 * filesystem path — the whole traversal class is designed out rather than
 * filtered. Thumbnails arrive as `data:` URLs over already-validated bytes,
 * which `index.html`'s `img-src 'self' data:` already permits.
 *
 * Refusals (over-cap, wrong magic bytes) are main's message rendered verbatim
 * in an inline alert: main knows the actual size and the actual limit, and a
 * sentence invented here could only be vaguer or wrong. A CANCELLED picker is
 * silent — the user closed a dialog they opened, which is not an error.
 */

import { useState, type JSX } from "react";
import type { LockerImage } from "@shared/schemas/images.js";
import type { VexError } from "@shared/ipc/result.js";
import {
  useLockerImageThumb,
  useLockerImages,
  useUploadLockerImage,
} from "../../../lib/api/images.js";
import { Label } from "../../../components/ui/label.js";

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
      <Label htmlFor="vex-launch-image">Image</Label>
      <p className="text-[11px] leading-relaxed text-ink-tertiary">
        Required. Pick one from your Trench photos, or add a new one - the
        picture is written into the token itself, so it can&apos;t be changed
        afterwards.
      </p>

      <div className="flex items-start gap-3">
        <SelectedImageWell image={selected} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {selected !== null ? (
            <>
              <span className="truncate text-[12.5px] text-ink-secondary">
                {selected.label}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-ink-tertiary">
                {selected.width}×{selected.height} · {selected.byteLength} bytes
              </span>
            </>
          ) : (
            <span className="text-[12.5px] text-ink-tertiary">
              No image selected.
            </span>
          )}
          <button
            id="vex-launch-image"
            type="button"
            onClick={runUpload}
            disabled={disabled || upload.isPending}
            className="mt-1 w-fit rounded-full border border-line-3 px-3 py-1 font-doto text-[11px] font-medium uppercase tracking-[0.16em] text-ink-secondary transition-colors hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-50"
          >
            {upload.isPending ? "Adding…" : "Add image"}
          </button>
        </div>
      </div>

      <LockerStrip
        query={query}
        images={images}
        selectedImageId={selectedImageId}
        onSelect={onSelect}
        disabled={disabled}
      />

      {notice !== null ? (
        <p className="text-sm text-danger" role="alert">
          {notice}
        </p>
      ) : null}
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
    return (
      <p className="font-doto text-[11px] font-medium uppercase tracking-[0.14em] text-ink-tertiary">
        Loading your photos…
      </p>
    );
  }

  // A failed locker read is NOT "you have no photos" — saying so would send the
  // user off to re-upload images they already have.
  if (query.isError || (result !== undefined && !result.ok)) {
    return (
      <p className="text-[12px] text-warning">
        Couldn&apos;t read your image locker - add an image to continue.
      </p>
    );
  }

  if (images.length === 0) {
    return (
      <p className="text-[12px] leading-relaxed text-ink-tertiary">
        Your Trench photos are empty. Add one here, or from the Trench Photos
        card in the right-hand panel.
      </p>
    );
  }

  return (
    <ul className="flex flex-row flex-wrap gap-1.5">
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
      className={[
        "size-11 overflow-hidden rounded-xl border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
        "disabled:opacity-50",
        selected
          ? "border-accent-primary/85"
          : "border-line-2 hover:border-line-3",
      ].join(" ")}
    >
      {dataUrl !== null ? (
        // Decorative INSIDE the button: the accessible name is the button's
        // own aria-label, so an empty alt avoids announcing the label twice.
        <img src={dataUrl} alt="" className="size-full object-cover" />
      ) : (
        <span className="block size-full bg-surface-deep" />
      )}
    </button>
  );
}

/** The 64×64 preview well for the chosen image. */
function SelectedImageWell({
  image,
}: {
  readonly image: LockerImage | null;
}): JSX.Element {
  const thumb = useLockerImageThumb(image?.imageId ?? null);
  const dataUrl = thumb.data?.ok === true ? thumb.data.data.dataUrl : null;

  return (
    <div className="size-16 shrink-0 overflow-hidden rounded-xl border border-line-3 bg-surface-deep">
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
 * A cancelled picker must stay silent — the user closed a dialog they opened.
 * Everything else is main's already-redacted message, which names the actual
 * limit and the actual size.
 */
function uploadNotice(error: VexError): string | null {
  return error.code === "internal.cancelled" ? null : error.message;
}
