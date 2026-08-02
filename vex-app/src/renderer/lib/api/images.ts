/**
 * Image locker (C2) TanStack Query hooks — the renderer half of the GLOBAL
 * library of pre-staged token-launch images.
 *
 * There is no session parameter anywhere in this file, and that is the
 * contract rather than an omission: the locker belongs to the user, so an
 * image uploaded today is available to a mission started next week.
 *
 * THUMBNAILS ARE FETCHED PER TILE, not prefetched as a batch. `useLockerImages`
 * returns metadata only; each tile calls `useLockerImageThumb` for its own
 * ≤20 KB `data:` URL when it mounts. At locker scale that is a handful of
 * small calls, and it keeps the list read cheap no matter how the locker
 * grows. Thumbnails never go stale on their own — the bytes behind an
 * `imageId` are immutable, so the cache holds them until the image is deleted.
 *
 * `upload` takes no argument: main owns the file picker, so there is nothing
 * for the renderer to pass. A user who dismisses the picker gets
 * `internal.cancelled`, which callers should absorb silently.
 */

import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  ImagesDeleteInput,
  ImagesDeleteResult,
  ImagesListResult,
  ImagesReadThumbResult,
  ImagesUploadResult,
} from "@shared/schemas/images.js";
import { imageKeys } from "./queryKeys.js";

/**
 * The locker only changes through this window's own upload/delete, both of
 * which invalidate explicitly — so there is no background refetch interval
 * and nothing to poll for.
 */
const STALE_MS = 30_000;

function lockerImagesOptions() {
  return queryOptions({
    queryKey: imageKeys.list(),
    queryFn: () => window.vex.images.list({}),
    staleTime: STALE_MS,
  });
}

export function useLockerImages(): UseQueryResult<Result<ImagesListResult>> {
  return useQuery(lockerImagesOptions());
}

/**
 * One tile's thumbnail. `imageId: null` disables the query (nothing selected /
 * not yet rendered). `staleTime: Infinity` is correct rather than lazy: an
 * `imageId` names one immutable set of bytes, so a refetch could only ever
 * return the same `data:` URL.
 */
export function useLockerImageThumb(
  imageId: string | null,
): UseQueryResult<Result<ImagesReadThumbResult>> {
  return useQuery({
    queryKey: imageKeys.thumb(imageId ?? ""),
    queryFn: () => window.vex.images.readThumb({ imageId: imageId ?? "" }),
    enabled: imageId !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/** Open main's file picker and ingest whatever the user chooses. */
export function useUploadLockerImage(): UseMutationResult<
  Result<ImagesUploadResult>,
  Error,
  void
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => window.vex.images.upload({}),
    onSuccess: (result) => {
      if (!result.ok) return;
      void queryClient.invalidateQueries({ queryKey: imageKeys.list() });
    },
  });
}

/**
 * Delete one image. A refusal (`images.in_use` — a live launch still
 * references it) arrives as a failed `Result`, NOT a thrown error, so the
 * caller renders the reason instead of catching an exception.
 *
 * The list is invalidated on success only. Invalidating after a refusal would
 * suggest something changed when the whole point of that refusal is that
 * nothing did.
 */
export function useDeleteLockerImage(): UseMutationResult<
  Result<ImagesDeleteResult>,
  Error,
  ImagesDeleteInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ImagesDeleteInput) => window.vex.images.delete(input),
    onSuccess: (result, variables) => {
      if (!result.ok) return;
      queryClient.removeQueries({ queryKey: imageKeys.thumb(variables.imageId) });
      void queryClient.invalidateQueries({ queryKey: imageKeys.list() });
    },
  });
}
